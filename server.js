const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

// sqlite
const dbFile = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    usn TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    phone TEXT,
    pass_hash TEXT,
    is_admin INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    symbol_url TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usn TEXT,
    candidate_id TEXT,
    time TEXT
  )`);
});

function requireLogin(req, res, next){
  if(req.session && req.session.usn) return next();
  return res.status(401).json({error: 'not_authenticated'});
}
function requireAdmin(req, res, next){
  if(req.session && req.session.isAdmin) return next();
  return res.status(403).json({error: 'admin_required'});
}

// register
app.post('/api/register', async (req, res) => {
  const { name, email, phone, usn, pass } = req.body;
  if(!name || !email || !usn || !pass) return res.status(400).json({error:'missing'});
  db.get('SELECT * FROM users WHERE usn = ?', [usn], async (err, row) => {
    if(err) return res.status(500).json({error:'db'});
    if(row) return res.status(400).json({error:'usn_taken'});
    const pass_hash = await bcrypt.hash(pass, 10);
    db.run('INSERT INTO users (usn,name,email,phone,pass_hash) VALUES (?,?,?,?,?)',
      [usn, name, email, phone || '', pass_hash], function(err){
        if(err) return res.status(500).json({error:'db_insert'});
        return res.json({ok:true});
    });
  });
});

// login
app.post('/api/login', (req, res) => {
  const { usn, pass } = req.body;
  if(!usn || !pass) return res.status(400).json({error:'missing'});
  db.get('SELECT * FROM users WHERE usn = ?', [usn], async (err, user) => {
    if(err) return res.status(500).json({error:'db'});
    if(!user) return res.status(400).json({error:'no_user'});
    const ok = await bcrypt.compare(pass, user.pass_hash);
    if(!ok) return res.status(401).json({error:'bad_creds'});
    req.session.usn = user.usn;
    req.session.name = user.name;
    req.session.isAdmin = user.is_admin === 1;
    return res.json({ok:true, usn:user.usn, isAdmin: req.session.isAdmin});
  });
});

// logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(()=>res.json({ok:true}));
});

// list candidates
app.get('/api/candidates', (req, res) => {
  db.all('SELECT * FROM candidates', [], (err, rows) => {
    if(err) return res.status(500).json({error:'db'});
    return res.json(rows);
  });
});

// add candidate (admin)
app.post('/api/candidates', requireAdmin, upload.single('symbol'), (req, res) => {
  const { name, role, symbol_url } = req.body;
  const symbol = req.file ? '/uploads/' + path.basename(req.file.path) : (symbol_url || '');
  const id = 'c' + Date.now() + Math.random().toString(36).slice(2,6);
  db.run('INSERT INTO candidates (id,name,role,symbol_url) VALUES (?,?,?,?)',
    [id, name, role, symbol], function(err){
      if(err) return res.status(500).json({error:'db_insert'});
      return res.json({ok:true, id});
  });
});

// delete candidate (admin)
app.delete('/api/candidates/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM candidates WHERE id = ?', [req.params.id], function(err){
    if(err) return res.status(500).json({error:'db'});
    return res.json({ok:true});
  });
});

// submit vote
app.post('/api/vote', requireLogin, (req, res) => {
  const usn = req.session.usn;
  const { candidate } = req.body;
  if(!candidate) return res.status(400).json({error:'missing_candidate'});
  db.get('SELECT * FROM votes WHERE usn = ?', [usn], (err, row) => {
    if(err) return res.status(500).json({error:'db'});
    if(row) return res.status(400).json({error:'already_voted'});
    const time = new Date().toISOString();
    db.run('INSERT INTO votes (usn,candidate_id,time) VALUES (?,?,?)', [usn, candidate, time], function(err){
      if(err) return res.status(500).json({error:'db_insert'});
      return res.json({ok:true});
    });
  });
});

// results (admin)
app.get('/api/results', requireAdmin, (req, res) => {
  db.all(
    "SELECT c.id, c.name, c.role, c.symbol_url, COUNT(v.id) as votes " +
    "FROM candidates c LEFT JOIN votes v ON c.id = v.candidate_id GROUP BY c.id",
    [], (err, rows) => {
      if(err) return res.status(500).json({error:'db'});
      res.json(rows);
    }
  );
});

// download votes (admin) -> returns .xlsx
app.get('/api/download', requireAdmin, (req, res) => {
  const sql = "SELECT v.usn, v.candidate_id, v.time, c.name as candidate_name, c.role " +
              "FROM votes v LEFT JOIN candidates c ON v.candidate_id = c.id";
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!rows || rows.length === 0) return res.status(400).json({ error: 'no_votes' });

    const data = rows.map(r => ({
      USN: r.usn,
      Candidate: r.candidate_name || r.candidate_id,
      Role: r.role || '',
      Time: r.time
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Votes');

    const fname = 'votes.xlsx';
    const wbout = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(wbout);
  });
});

// quick admin helper (for testing only)
app.post('/api/_make_admin', (req, res) => {
  const { usn } = req.body;
  if(!usn) return res.status(400).json({error:'missing'});
  db.run('UPDATE users SET is_admin=1 WHERE usn = ?', [usn], function(err){
    if(err) return res.status(500).json({error:'db'});
    res.json({ok:true});
  });
});

app.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
