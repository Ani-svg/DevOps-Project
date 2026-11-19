CREATE DATABASE granthalaya;
USE granthalaya;

CREATE TABLE members (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('Student', 'Staff') NOT NULL,
    status ENUM('Active', 'Inactive') DEFAULT 'Active',
    institution_code VARCHAR(255)
);

CREATE TABLE books (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    isbn VARCHAR(20),
    category VARCHAR(100),
    total_copies INT DEFAULT 1,
    shelf_location VARCHAR(50),
    condition_status ENUM('New', 'Good', 'Worn') DEFAULT 'Good'
);

CREATE TABLE transactions (
    id VARCHAR(255) PRIMARY KEY,
    book_id VARCHAR(255),
    member_id VARCHAR(255),
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    return_date DATE,
    status ENUM('issued', 'returned', 'overdue') NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE book_requests (
    id VARCHAR(255) PRIMARY KEY,
    book_id VARCHAR(255),
    member_id VARCHAR(255),
    request_date DATETIME NOT NULL,
    status ENUM('Pending', 'Approved', 'Rejected') DEFAULT 'Pending',
    FOREIGN KEY (book_id) REFERENCES books(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
);

-- Login accounts ------------------------------------------------
-- Staff   -> ID: LIB-001     | Institution code: 190012345 | Password: Pass@admin
-- Student -> ID: 590023097   | Password: Pass@student
INSERT INTO members (id, name, password, role, institution_code) VALUES
('LIB-001',   'Admin User',   'Pass@admin',   'Staff',   '190012345'),
('590023097', 'Student User', 'Pass@student', 'Student', NULL);

-- Sample books --------------------------------------------------
INSERT INTO books (id, title, author, category, total_copies, shelf_location) VALUES
('B-0001', 'Introduction to Algorithms', 'Thomas H. Cormen', 'Computer Science', 3, 'CS-A1'),
('B-0002', 'Clean Code',                 'Robert C. Martin', 'Computer Science', 2, 'CS-A2'),
('B-0003', 'The Alchemist',              'Paulo Coelho',     'Fiction',          4, 'FI-B1'),
('B-0004', 'A Brief History of Time',    'Stephen Hawking',  'Science',          2, 'SC-C1');

SELECT id, name, password, role, institution_code FROM members;