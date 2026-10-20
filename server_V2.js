// server.js  (simplified: no bcrypt, no uuid)

// 1. DEPENDENCIES  ->  npm install express mysql2 cors
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const crypto = require('crypto');

// 2. SERVER SETUP
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// Short unique ids like "B-3fa9"
const makeId = (prefix, len) => `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, len)}`;

// 3. DATABASE CONNECTION (a pool is more reliable than a single connection)
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'mysql062007',
  database: 'granthalaya',
  waitForConnections: true,
  connectionLimit: 10
}).promise();

// Check the DB connection when the server starts
db.query('SELECT 1')
  .then(() => console.log('MySQL connected to database "granthalaya"'))
  .catch(err => console.error('MySQL connection FAILED:', err.message));

// 4. API ROUTES

// --- Authentication (plain-text password comparison) ---
app.post('/api/login', async (req, res) => {
  const role = (req.body.role || '').trim().toLowerCase();   // 'student' or 'staff'
  const id = (req.body.id || '').trim();
  const password = (req.body.password || '').trim();
  const institution_code = (req.body.institution_code || '').trim();

  if (!id || !password || !role) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  try {
    // MySQL string comparison is case-insensitive, so 'staff' matches 'Staff'
    const [rows] = await db.query('SELECT * FROM members WHERE id = ? AND role = ?', [id, role]);

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid ID or role.' });
    }

    const user = rows[0];

    if (user.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'This account is inactive.' });
    }

    if (user.role === 'Staff' && user.institution_code !== institution_code) {
      return res.status(401).json({ success: false, message: 'Invalid institution code.' });
    }

    if (user.password !== password) {
      return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    const { password: _pw, ...user_info } = user;   // never send the password back
    res.json({ success: true, message: 'Login successful', user: user_info });
  } catch (error) {
    console.error('LOGIN ERROR:', error);
    res.status(500).json({ success: false, message: 'Server/database error: ' + error.message });
  }
});

// --- Catalogue (students and staff) ---
app.get('/api/catalogue', async (req, res) => {
  try {
    const [books] = await db.query('SELECT * FROM books');
    const [issued] = await db.query(
      "SELECT book_id, COUNT(*) AS issued_count FROM transactions WHERE status IN ('issued','overdue') GROUP BY book_id"
    );
    const issuedMap = new Map(issued.map(t => [t.book_id, t.issued_count]));

    res.json(books.map(book => ({
      ...book,
      available_copies: book.total_copies - (issuedMap.get(book.id) || 0)
    })));
  } catch (error) {
    console.error('CATALOGUE ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch catalogue: ' + error.message });
  }
});

// --- Admin: catalogue management ---
app.post('/api/books', async (req, res) => {
  const { title, author, category, total_copies, shelf_location } = req.body;
  const newBook = { id: makeId('B', 4), title, author, category, total_copies, shelf_location };
  try {
    await db.query('INSERT INTO books SET ?', newBook);
    res.status(201).json({ success: true, message: 'Book added successfully', book: newBook });
  } catch (error) {
    console.error('ADD BOOK ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to add book: ' + error.message });
  }
});

app.put('/api/books/:id', async (req, res) => {
  try {
    await db.query('UPDATE books SET ? WHERE id = ?', [req.body, req.params.id]);
    res.json({ success: true, message: 'Book updated successfully' });
  } catch (error) {
    console.error('UPDATE BOOK ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to update book: ' + error.message });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM books WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Book deleted successfully' });
  } catch (error) {
    console.error('DELETE BOOK ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to delete book: ' + error.message });
  }
});

// --- Admin: issue & return desk ---
app.post('/api/transactions/issue', async (req, res) => {
  const { book_id, member_id } = req.body;
  const issue_date = new Date();
  const due_date = new Date();
  due_date.setDate(issue_date.getDate() + 14); // 14-day loan

  const newTransaction = {
    id: makeId('T', 5),
    book_id,
    member_id,
    issue_date,
    due_date,
    status: 'issued'
  };
  try {
    await db.query('INSERT INTO transactions SET ?', newTransaction);
    res.status(201).json({ success: true, message: 'Book issued successfully' });
  } catch (error) {
    console.error('ISSUE ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to issue book: ' + error.message });
  }
});

app.put('/api/transactions/return/:id', async (req, res) => {
  try {
    await db.query("UPDATE transactions SET status = 'returned', return_date = ? WHERE id = ?", [new Date(), req.params.id]);
    res.json({ success: true, message: 'Book returned successfully' });
  } catch (error) {
    console.error('RETURN ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to return book: ' + error.message });
  }
});

// 5. START SERVER
app.listen(port, () => {
  console.log(`Granthalaya backend server running at http://localhost:${port}`);
});