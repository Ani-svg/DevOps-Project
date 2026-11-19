// server.js — Granthalaya backend (student + admin portals share this one database)
// Install:  npm install express mysql2 cors
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

// ---------- Library rules (change here, both portals follow) ----------
const LOAN_DAYS = 14, RENEW_DAYS = 7, MAX_ACTIVE = 5, FINE_PER_DAY = 2; // fine in rupees per overdue day

// ---------- Database ----------
const db = mysql.createPool({
  host: 'localhost', user: 'root', password: 'mysql062007', database: 'granthalaya',
  dateStrings: true, waitForConnections: true, connectionLimit: 10
}).promise();
db.query('SELECT 1').then(() => console.log('MySQL connected to "granthalaya"'))
  .catch(e => console.error('MySQL connection FAILED:', e.message));

// ---------- Helpers ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ success: false, message: e.message });
    console.error(e); res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
};
async function withTx(fn) {
  const c = await db.getConnection();
  try { await c.beginTransaction(); const r = await fn(c); await c.commit(); return r; }
  catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}
const BOOKS_SQL = `SELECT b.*, b.total_copies - COALESCE(i.n,0) AS available_copies FROM books b
  LEFT JOIN (SELECT book_id, COUNT(*) AS n FROM transactions WHERE status IN ('issued','overdue') GROUP BY book_id) i ON i.book_id = b.id`;
const newId = (p, len) => `${p}-${crypto.randomBytes(8).toString('hex').slice(0, len)}`;

// ---------- Sessions (login token) ----------
const sessions = new Map(); // token -> user
const auth = (...roles) => (req, res, next) => {
  const user = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  if (!user) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  if (roles.length && !roles.includes(user.role)) return res.status(403).json({ success: false, message: 'Not allowed for your account type.' });
  req.user = user; next();
};
const staffOnly = auth('Staff');

app.post('/api/login', wrap(async (req, res) => {
  const role = (req.body.role || '').trim().toLowerCase();
  const id = (req.body.id || '').trim();
  const password = (req.body.password || '').trim();
  const institution_code = (req.body.institution_code || '').trim();
  if (!id || !password || !role) throw httpErr(400, 'Missing required fields.');

  const [rows] = await db.query('SELECT * FROM members WHERE id = ? AND role = ?', [id, role]);
  if (!rows.length) throw httpErr(401, 'Invalid ID or role.');
  const user = rows[0];
  if (user.status !== 'Active') throw httpErr(403, 'This account is inactive. Please contact the library.');
  if (user.role === 'Staff' && user.institution_code !== institution_code) throw httpErr(401, 'Invalid institution code.');
  if (user.password !== password) throw httpErr(401, 'Incorrect password.');

  const { password: _pw, ...user_info } = user;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, user_info);
  res.json({ success: true, message: 'Login successful', user: user_info, token });
}));

app.post('/api/logout', (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ success: true });
});

// ---------- Shared: catalogue ----------
app.get('/api/catalogue', auth(), wrap(async (req, res) => {
  const [books] = await db.query(BOOKS_SQL + ' ORDER BY b.title');
  res.json(books);
}));

// =====================================================================
//  STUDENT PORTAL
// =====================================================================
app.get('/api/members/:id/dashboard', auth(), wrap(async (req, res) => {
  const id = req.params.id;
  if (req.user.id !== id && req.user.role !== 'Staff') throw httpErr(403, 'Not allowed.');
  const [issued] = await db.query(
    `SELECT t.id, t.book_id, b.title, b.author, b.shelf_location, t.issue_date, t.due_date, t.renewed,
            IF(t.status='issued' AND t.due_date < CURDATE(), 'overdue', t.status) AS status,
            DATEDIFF(t.due_date, CURDATE()) AS days_left,
            GREATEST(DATEDIFF(CURDATE(), t.due_date), 0) * ${FINE_PER_DAY} AS fine_accrued
     FROM transactions t JOIN books b ON b.id = t.book_id
     WHERE t.member_id = ? AND t.status IN ('issued','overdue') ORDER BY t.due_date`, [id]);
  const [history] = await db.query(
    `SELECT t.id, b.title, b.author, t.issue_date, t.return_date, t.fine
     FROM transactions t JOIN books b ON b.id = t.book_id
     WHERE t.member_id = ? AND t.status = 'returned' ORDER BY t.return_date DESC, t.issue_date DESC LIMIT 20`, [id]);
  const [requests] = await db.query(
    `SELECT r.id, r.book_id, b.title, r.request_date, r.status, r.handled_on,
            IF(r.handled_on IS NULL, NULL, DATEDIFF(CURDATE(), DATE(r.handled_on))) AS handled_days_ago
     FROM book_requests r JOIN books b ON b.id = r.book_id
     WHERE r.member_id = ? ORDER BY r.request_date DESC LIMIT 15`, [id]);
  res.json({ issued, history, requests, rules: { LOAN_DAYS, RENEW_DAYS, MAX_ACTIVE, FINE_PER_DAY } });
}));

app.post('/api/requests', auth(), wrap(async (req, res) => {
  const member_id = req.user.id, { book_id } = req.body;
  const [[book]] = await db.query(BOOKS_SQL + ' WHERE b.id = ?', [book_id]);
  if (!book) throw httpErr(404, 'Book not found.');
  const [[held]] = await db.query("SELECT COUNT(*) n FROM transactions WHERE member_id=? AND book_id=? AND status IN ('issued','overdue')", [member_id, book_id]);
  if (held.n) throw httpErr(400, 'This book is already issued to you.');
  const [[pend]] = await db.query("SELECT COUNT(*) n FROM book_requests WHERE member_id=? AND book_id=? AND status='Pending'", [member_id, book_id]);
  if (pend.n) throw httpErr(400, 'You have already requested this book.');
  const [[active]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE member_id=? AND status IN ('issued','overdue')) +
            (SELECT COUNT(*) FROM book_requests WHERE member_id=? AND status='Pending') AS n`, [member_id, member_id]);
  if (active.n >= MAX_ACTIVE) throw httpErr(400, `Limit reached: you can hold/request at most ${MAX_ACTIVE} books.`);
  if (book.available_copies <= 0) throw httpErr(400, 'All copies are currently issued.');
  await db.query('INSERT INTO book_requests (id, book_id, member_id, request_date, status) VALUES (?,?,?,NOW(),?)',
    [newId('R', 6), book_id, member_id, 'Pending']);
  res.status(201).json({ success: true, message: `Requested "${book.title}". Staff will review it shortly.` });
}));

app.delete('/api/requests/:id', auth(), wrap(async (req, res) => {
  const [r] = await db.query("DELETE FROM book_requests WHERE id=? AND member_id=? AND status='Pending'", [req.params.id, req.user.id]);
  if (!r.affectedRows) throw httpErr(400, 'Request cannot be cancelled.');
  res.json({ success: true, message: 'Request cancelled.' });
}));

app.put('/api/transactions/renew/:id', auth(), wrap(async (req, res) => {
  const [r] = await db.query(
    `UPDATE transactions SET due_date = DATE_ADD(due_date, INTERVAL ${RENEW_DAYS} DAY), renewed = 1
     WHERE id=? AND member_id=? AND status='issued' AND renewed=0 AND due_date >= CURDATE()`, [req.params.id, req.user.id]);
  if (!r.affectedRows) throw httpErr(400, 'This book cannot be renewed (already renewed or overdue).');
  res.json({ success: true, message: `Renewed for ${RENEW_DAYS} more days.` });
}));

// =====================================================================
//  ADMIN PORTAL  (staff only)
// =====================================================================

// ----- Issue logic shared by the desk and by request approval -----
async function issueBook(conn, book_id, member_id) {
  const [[book]] = await conn.query('SELECT * FROM books WHERE id=? FOR UPDATE', [book_id]);
  if (!book) throw httpErr(404, 'Book not found.');
  const [[m]] = await conn.query('SELECT * FROM members WHERE id=?', [member_id]);
  if (!m) throw httpErr(404, 'Member not found.');
  if (m.status !== 'Active') throw httpErr(400, `${m.name}'s account is inactive.`);
  const [[dup]] = await conn.query("SELECT COUNT(*) n FROM transactions WHERE member_id=? AND book_id=? AND status IN ('issued','overdue')", [member_id, book_id]);
  if (dup.n) throw httpErr(400, `${m.name} already has this book.`);
  const [[cnt]] = await conn.query("SELECT COUNT(*) n FROM transactions WHERE member_id=? AND status IN ('issued','overdue')", [member_id]);
  if (cnt.n >= MAX_ACTIVE) throw httpErr(400, `${m.name} already holds ${MAX_ACTIVE} books (the limit).`);
  const [[out]] = await conn.query("SELECT COUNT(*) n FROM transactions WHERE book_id=? AND status IN ('issued','overdue')", [book_id]);
  if (book.total_copies - out.n <= 0) throw httpErr(400, 'No copies available — all are issued.');
  const id = newId('T', 6);
  await conn.query(
    `INSERT INTO transactions (id, book_id, member_id, issue_date, due_date, status)
     VALUES (?,?,?,CURDATE(),DATE_ADD(CURDATE(), INTERVAL ${LOAN_DAYS} DAY),'issued')`, [id, book_id, member_id]);
  const [[tx]] = await conn.query('SELECT due_date FROM transactions WHERE id=?', [id]);
  return { id, title: book.title, member: m.name, due_date: tx.due_date };
}

app.post('/api/transactions/issue', staffOnly, wrap(async (req, res) => {
  const { book_id, member_id } = req.body;
  if (!book_id || !member_id) throw httpErr(400, 'Choose a book and a member.');
  const r = await withTx(c => issueBook(c, book_id, member_id));
  res.status(201).json({ success: true, message: `Issued "${r.title}" to ${r.member}.`, ...r });
}));

app.put('/api/transactions/return/:id', staffOnly, wrap(async (req, res) => {
  const [[t]] = await db.query(
    `SELECT t.*, b.title, m.name AS member_name, GREATEST(DATEDIFF(CURDATE(), t.due_date), 0) AS days_late
     FROM transactions t JOIN books b ON b.id=t.book_id JOIN members m ON m.id=t.member_id
     WHERE t.id=? AND t.status IN ('issued','overdue')`, [req.params.id]);
  if (!t) throw httpErr(404, 'Active transaction not found (already returned?).');
  const fine = t.days_late * FINE_PER_DAY;
  await db.query("UPDATE transactions SET status='returned', return_date=CURDATE(), fine=? WHERE id=?", [fine, t.id]);
  res.json({ success: true, message: `"${t.title}" returned by ${t.member_name}.`, fine, days_late: t.days_late, title: t.title, member: t.member_name });
}));

// ----- Overview -----
app.get('/api/admin/overview', staffOnly, wrap(async (req, res) => {
  const one = async (sql) => (await db.query(sql))[0][0];
  const titles = await one('SELECT COUNT(*) n, COALESCE(SUM(total_copies),0) copies FROM books');
  const issued = await one("SELECT COUNT(*) n FROM transactions WHERE status IN ('issued','overdue')");
  const overdue = await one("SELECT COUNT(*) n FROM transactions WHERE status IN ('issued','overdue') AND due_date < CURDATE()");
  const pending = await one("SELECT COUNT(*) n FROM book_requests WHERE status='Pending'");
  const students = await one("SELECT COUNT(*) n FROM members WHERE role='Student' AND status='Active'");
  const low = await one(`SELECT COUNT(*) n FROM (${BOOKS_SQL}) x WHERE available_copies <= CEIL(total_copies * 0.2)`);
  const fines = await one('SELECT COALESCE(SUM(fine),0) n FROM transactions');
  const [activity] = await db.query(
    `(SELECT t.issue_date AS d, 'Issued' AS action, b.title, m.name AS member FROM transactions t JOIN books b ON b.id=t.book_id JOIN members m ON m.id=t.member_id)
     UNION ALL
     (SELECT t.return_date, 'Returned', b.title, m.name FROM transactions t JOIN books b ON b.id=t.book_id JOIN members m ON m.id=t.member_id WHERE t.status='returned')
     ORDER BY d DESC LIMIT 8`);
  const [overdueList] = await db.query(
    `SELECT t.id, b.title, m.name AS member, m.id AS member_id, t.due_date,
            DATEDIFF(CURDATE(), t.due_date) AS days_late, DATEDIFF(CURDATE(), t.due_date) * ${FINE_PER_DAY} AS fine
     FROM transactions t JOIN books b ON b.id=t.book_id JOIN members m ON m.id=t.member_id
     WHERE t.status IN ('issued','overdue') AND t.due_date < CURDATE() ORDER BY t.due_date LIMIT 10`);
  res.json({
    stats: { titles: titles.n, copies: Number(titles.copies), issued: issued.n, overdue: overdue.n, pending: pending.n,
             students: students.n, lowStock: low.n, finesCollected: Number(fines.n) },
    activity, overdueList, rules: { LOAN_DAYS, RENEW_DAYS, MAX_ACTIVE, FINE_PER_DAY }
  });
}));

// ----- Requests (approve = issue the book right away) -----
app.get('/api/admin/requests', staffOnly, wrap(async (req, res) => {
  const [rows] = await db.query(
    `SELECT r.id, r.request_date, r.status, r.handled_on, b.id AS book_id, b.title, b.author, b.shelf_location,
            m.id AS member_id, m.name AS member_name,
            b.total_copies - (SELECT COUNT(*) FROM transactions t WHERE t.book_id=b.id AND t.status IN ('issued','overdue')) AS available
     FROM book_requests r JOIN books b ON b.id=r.book_id JOIN members m ON m.id=r.member_id
     ORDER BY (r.status='Pending') DESC, r.request_date DESC LIMIT 150`);
  res.json(rows);
}));

app.post('/api/admin/requests/:id/approve', staffOnly, wrap(async (req, res) => {
  const r = await withTx(async c => {
    const [[rq]] = await c.query("SELECT * FROM book_requests WHERE id=? AND status='Pending' FOR UPDATE", [req.params.id]);
    if (!rq) throw httpErr(400, 'This request was already handled or cancelled by the student.');
    const out = await issueBook(c, rq.book_id, rq.member_id);
    await c.query("UPDATE book_requests SET status='Approved', handled_on=NOW() WHERE id=?", [rq.id]);
    return out;
  });
  res.json({ success: true, message: `Approved — "${r.title}" issued to ${r.member}, due ${r.due_date}.` });
}));

app.post('/api/admin/requests/:id/reject', staffOnly, wrap(async (req, res) => {
  const [r] = await db.query("UPDATE book_requests SET status='Rejected', handled_on=NOW() WHERE id=? AND status='Pending'", [req.params.id]);
  if (!r.affectedRows) throw httpErr(400, 'This request was already handled or cancelled.');
  res.json({ success: true, message: 'Request rejected.' });
}));

// ----- Catalogue management -----
function cleanBook(b, partial) {
  const out = {};
  for (const k of ['title', 'author', 'category', 'shelf_location']) {
    if (b[k] !== undefined) { out[k] = String(b[k]).trim(); if (!out[k]) throw httpErr(400, `${k.replace('_', ' ')} is required.`); }
    else if (!partial) throw httpErr(400, `${k.replace('_', ' ')} is required.`);
  }
  if (b.isbn !== undefined) out.isbn = String(b.isbn).trim().slice(0, 20) || null;
  if (b.condition_status !== undefined) {
    if (!['New', 'Good', 'Worn'].includes(b.condition_status)) throw httpErr(400, 'Invalid condition.');
    out.condition_status = b.condition_status;
  }
  if (b.total_copies !== undefined || !partial) {
    const n = parseInt(b.total_copies, 10);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw httpErr(400, 'Copies must be a number from 1 to 500.');
    out.total_copies = n;
  }
  return out;
}

app.post('/api/books', staffOnly, wrap(async (req, res) => {
  const book = cleanBook(req.body, false);
  const [[last]] = await db.query("SELECT COALESCE(MAX(CAST(SUBSTRING(id,3) AS UNSIGNED)),0) n FROM books WHERE id REGEXP '^B-[0-9]+$'");
  book.id = 'B-' + String(Number(last.n) + 1).padStart(4, '0');
  await db.query('INSERT INTO books SET ?', book);
  res.status(201).json({ success: true, message: `Added "${book.title}" (${book.id}).`, book });
}));

app.put('/api/books/:id', staffOnly, wrap(async (req, res) => {
  const upd = cleanBook(req.body, true);
  if (!Object.keys(upd).length) throw httpErr(400, 'Nothing to update.');
  if (upd.total_copies !== undefined) {
    const [[out]] = await db.query("SELECT COUNT(*) n FROM transactions WHERE book_id=? AND status IN ('issued','overdue')", [req.params.id]);
    if (upd.total_copies < out.n) throw httpErr(400, `${out.n} copies are currently issued — total can't be lower than that.`);
  }
  const [r] = await db.query('UPDATE books SET ? WHERE id=?', [upd, req.params.id]);
  if (!r.affectedRows) throw httpErr(404, 'Book not found.');
  res.json({ success: true, message: 'Book updated.' });
}));

app.delete('/api/books/:id', staffOnly, wrap(async (req, res) => {
  try {
    await db.query("DELETE FROM book_requests WHERE book_id=? AND status='Pending'", [req.params.id]);
    const [r] = await db.query('DELETE FROM books WHERE id=?', [req.params.id]);
    if (!r.affectedRows) throw httpErr(404, 'Book not found.');
    res.json({ success: true, message: 'Title removed from the catalogue.' });
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2') throw httpErr(400, 'This title has borrowing history, so it can\'t be deleted. Set its copies lower or edit it instead.');
    throw e;
  }
}));

// ----- Desk data: active loans (for return dropdown) + recent transactions -----
app.get('/api/admin/desk', staffOnly, wrap(async (req, res) => {
  const base = `SELECT t.id, t.book_id, b.title, m.id AS member_id, m.name AS member_name, t.issue_date, t.due_date, t.return_date, t.fine,
      IF(t.status='issued' AND t.due_date < CURDATE(), 'overdue', t.status) AS status
      FROM transactions t JOIN books b ON b.id=t.book_id JOIN members m ON m.id=t.member_id`;
  const [active] = await db.query(base + " WHERE t.status IN ('issued','overdue') ORDER BY t.due_date");
  const [recent] = await db.query(base + ' ORDER BY t.issue_date DESC, t.id DESC LIMIT 25');
  res.json({ active, recent });
}));

// ----- Members -----
app.get('/api/admin/members', staffOnly, wrap(async (req, res) => {
  const [rows] = await db.query(
    `SELECT m.id, m.name, m.role, m.status, m.institution_code, m.joined_on,
       (SELECT COUNT(*) FROM transactions t WHERE t.member_id=m.id AND t.status IN ('issued','overdue')) AS held,
       (SELECT COUNT(*) FROM transactions t WHERE t.member_id=m.id AND t.status IN ('issued','overdue') AND t.due_date < CURDATE()) AS overdue,
       (SELECT COALESCE(SUM(t.fine),0) FROM transactions t WHERE t.member_id=m.id) AS fines_paid
     FROM members m ORDER BY m.role DESC, m.name`);
  res.json(rows);
}));

app.post('/api/admin/members', staffOnly, wrap(async (req, res) => {
  const id = String(req.body.id || '').trim(), name = String(req.body.name || '').trim();
  const password = String(req.body.password || '').trim(), role = req.body.role;
  const code = String(req.body.institution_code || '').trim();
  if (!id || !name || !password) throw httpErr(400, 'ID, name and password are required.');
  if (!['Student', 'Staff'].includes(role)) throw httpErr(400, 'Choose Student or Staff.');
  if (role === 'Staff' && !code) throw httpErr(400, 'Staff members need an institution code.');
  const [[dup]] = await db.query('SELECT COUNT(*) n FROM members WHERE id=?', [id]);
  if (dup.n) throw httpErr(409, `ID ${id} is already registered.`);
  await db.query('INSERT INTO members (id, name, password, role, institution_code) VALUES (?,?,?,?,?)',
    [id, name, password, role, role === 'Staff' ? code : null]);
  res.status(201).json({ success: true, message: `${name} registered.` });
}));

app.put('/api/admin/members/:id', staffOnly, wrap(async (req, res) => {
  const upd = {};
  if (req.body.name !== undefined) { upd.name = String(req.body.name).trim(); if (!upd.name) throw httpErr(400, 'Name is required.'); }
  if (req.body.password) upd.password = String(req.body.password).trim();
  if (req.body.institution_code !== undefined) upd.institution_code = String(req.body.institution_code).trim() || null;
  if (req.body.status !== undefined) {
    if (!['Active', 'Inactive'].includes(req.body.status)) throw httpErr(400, 'Invalid status.');
    if (req.body.status === 'Inactive' && req.params.id === req.user.id) throw httpErr(400, "You can't deactivate your own account.");
    upd.status = req.body.status;
  }
  if (!Object.keys(upd).length) throw httpErr(400, 'Nothing to update.');
  const [r] = await db.query('UPDATE members SET ? WHERE id=?', [upd, req.params.id]);
  if (!r.affectedRows) throw httpErr(404, 'Member not found.');
  if (upd.status === 'Inactive' || upd.password) {   // force re-login
    for (const [t, u] of sessions) if (u.id === req.params.id) sessions.delete(t);
  }
  res.json({ success: true, message: 'Member updated.' });
}));

// ----- Reports -----
app.get('/api/admin/reports', staffOnly, wrap(async (req, res) => {
  const [byCategory] = await db.query(
    `SELECT b.category, COUNT(*) AS n FROM transactions t JOIN books b ON b.id=t.book_id
     WHERE t.issue_date >= CURDATE() - INTERVAL 30 DAY GROUP BY b.category ORDER BY n DESC LIMIT 8`);
  const [topBooks] = await db.query(
    `SELECT b.title, b.author, COUNT(*) AS n FROM transactions t JOIN books b ON b.id=t.book_id GROUP BY b.id ORDER BY n DESC, b.title LIMIT 5`);
  const [topMembers] = await db.query(
    `SELECT m.name, m.id, COUNT(*) AS n FROM transactions t JOIN members m ON m.id=t.member_id GROUP BY m.id ORDER BY n DESC, m.name LIMIT 5`);
  const [[cond]] = await db.query("SELECT COUNT(*) n, SUM(condition_status <> 'Worn') ok FROM books");
  const [[stock]] = await db.query(`SELECT COUNT(*) n, SUM(available_copies > CEIL(total_copies * 0.2)) ok FROM (${BOOKS_SQL}) x`);
  const [[ret]] = await db.query("SELECT COUNT(*) n, COALESCE(SUM(return_date <= due_date),0) ok FROM transactions WHERE status='returned'");
  const [[fin]] = await db.query(
    `SELECT COALESCE(SUM(fine),0) AS collected,
            (SELECT COALESCE(SUM(GREATEST(DATEDIFF(CURDATE(), due_date),0)),0) * ${FINE_PER_DAY} FROM transactions WHERE status IN ('issued','overdue')) AS outstanding
     FROM transactions`);
  const pct = (ok, n) => n ? Math.round(Number(ok) / n * 100) : 100;
  res.json({
    byCategory, topBooks, topMembers,
    health: { condition: pct(cond.ok, cond.n), stock: pct(stock.ok, stock.n), onTime: pct(ret.ok, ret.n) },
    fines: { collected: Number(fin.collected), outstanding: Number(fin.outstanding) }
  });
}));

app.listen(port, () => console.log(`Granthalaya backend running at http://localhost:${port}`));