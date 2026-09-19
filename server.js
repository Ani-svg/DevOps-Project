// server.js

// 1. DEPENDENCIES
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // To generate unique IDs
const bcrypt = require('bcrypt');

// 2. SERVER SETUP
const app = express();
const port = 3000;

// Middleware
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // To parse JSON request bodies

// 3. DATABASE CONNECTION
// Replace with your actual MySQL credentials
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'mysql062007',
  database: 'granthalaya'
}).promise();

// 4. API ROUTES

// --- Authentication ---
// --- Authentication ---
app.post('/api/login', async (req, res) => {
    const { role, id, password, institution_code } = req.body;
    
    // Basic validation
    if (!id || !password || !role) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    try {
        // Find the user by their ID and role
        const [rows] = await db.query('SELECT * FROM members WHERE id = ? AND role = ?', [id, role]);

        // If no user is found
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials or role.' });
        }

        const user = rows[0];

        // For staff, also verify the institution code
        if (role === 'Staff' && user.institution_code !== institution_code) {
            return res.status(401).json({ success: false, message: 'Invalid institution code.' });
        }

        // Securely compare the submitted password with the stored hash
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (isMatch) {
            // Passwords match! Send success response (omitting password hash)
            const { password_hash, ...user_info } = user;
            res.json({ success: true, message: 'Login successful', user: user_info });
        } else {
            // Passwords do not match
            res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});



// --- Catalogue API (for both students and staff) ---
app.get('/api/catalogue', async (req, res) => {
    try {
        const [books] = await db.query('SELECT * FROM books');
        // Calculate availability for each book
        const [transactions] = await db.query("SELECT book_id, COUNT(*) as issued_count FROM transactions WHERE status IN ('issued', 'overdue') GROUP BY book_id");
        const issuedMap = new Map(transactions.map(t => [t.book_id, t.issued_count]));

        const catalogue = books.map(book => ({
            ...book,
            available_copies: book.total_copies - (issuedMap.get(book.id) || 0)
        }));
        res.json(catalogue);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch catalogue', error });
    }
});

// --- Admin: Catalogue Management ---
app.post('/api/books', async (req, res) => {
    const { title, author, category, total_copies, shelf_location } = req.body;
    const newBook = { id: `B-${uuidv4().slice(0, 4)}`, title, author, category, total_copies, shelf_location };
    try {
        await db.query('INSERT INTO books SET ?', newBook);
        res.status(201).json({ success: true, message: 'Book added successfully', book: newBook });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to add book', error });
    }
});

app.put('/api/books/:id', async (req, res) => {
    const { id } = req.params;
    const bookData = req.body;
    try {
        await db.query('UPDATE books SET ? WHERE id = ?', [bookData, id]);
        res.json({ success: true, message: 'Book updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update book', error });
    }
});

app.delete('/api/books/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM books WHERE id = ?', [id]);
        res.json({ success: true, message: 'Book deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete book', error });
    }
});


// --- Admin: Issue & Return Desk ---
app.post('/api/transactions/issue', async (req, res) => {
    const { book_id, member_id } = req.body;
    const issue_date = new Date();
    const due_date = new Date();
    due_date.setDate(issue_date.getDate() + 14); // 14-day loan period

    const newTransaction = {
        id: `T-${uuidv4().slice(0, 5)}`,
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
        res.status(500).json({ success: false, message: 'Failed to issue book', error });
    }
});

app.put('/api/transactions/return/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("UPDATE transactions SET status = 'returned', return_date = ? WHERE id = ?", [new Date(), id]);
        res.json({ success: true, message: 'Book returned successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to return book', error });
    }
});


// 5. START SERVER
app.listen(port, () => {
    console.log(`Granthalaya backend server running at http://localhost:${port}`);
});
