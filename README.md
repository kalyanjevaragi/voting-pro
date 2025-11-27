Voting Backend - Express + SQLite
=================================

What's included:
- server.js            : Express server with REST endpoints
- package.json         : npm metadata and dependencies
- public/index.html    : updated front-end (Register/Login/Vote)
- uploads/             : directory for candidate images (empty)
- db.sqlite            : will be created automatically on first run

Quick start (local):
1. Unzip the folder and open a terminal in the project root.
2. Run: npm install
3. Run: npm start
4. Open: http://localhost:3000

Notes:
- This setup uses express-session with an in-memory session store (suitable for testing only).
- For production: enable HTTPS, secure cookies, use a persistent session store, and a production DB.
- To make a user an admin for testing:
  POST /api/_make_admin with JSON { "usn": "<user-usn>" }

Endpoints summary:
- POST /api/register   { name,email,phone,usn,pass }
- POST /api/login      { usn, pass }
- POST /api/logout
- GET  /api/candidates
- POST /api/candidates (admin) multipart/form-data with 'symbol' file or symbol_url
- DELETE /api/candidates/:id (admin)
- POST /api/vote       { candidate }
- GET  /api/results    (admin)
- GET  /api/download   (admin) -> .xlsx
