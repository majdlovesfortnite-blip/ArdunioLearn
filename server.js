'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PROD = process.env.NODE_ENV === 'production';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

// Server is the source of truth for lessons. Add more to this array.
const LESSONS = [
  {
    id: 'l1',
    title: 'Hello, LED',
    text: 'Make the built-in LED blink every 500 ms.',
    wokwi: 'REPLACE_WITH_WOKWI_PROJECT_ID',
    starter: `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`,
  },
  {
    id: 'l2',
    title: 'Button input',
    text: 'Turn the LED on only while the button on pin 2 is pressed. The button is wired to ground, so it reads LOW when pressed.',
    wokwi: 'REPLACE_WITH_WOKWI_PROJECT_ID',
    starter: `const int BUTTON = 2;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  // TODO: LED on when the button is pressed
}
`,
  },
];

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    TEXT NOT NULL,
  completed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);
`);

// Session tokens are random; only their SHA-256 hash is stored, so a leaked DB can't be used to log in.
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 12);

const app = express();
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ['https://wokwi.com'],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
// Only JSON bodies are parsed. Cross-site HTML forms can't send JSON, and we set no CORS headers.
app.use(express.json({ limit: '32kb', type: 'application/json' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function currentUser(req, res, next) {
  const token = req.cookies.sid;
  if (token) {
    req.user = db.prepare(`
      SELECT u.id, u.email FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(token), Date.now());
  }
  next();
}
app.use(currentUser);

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_MS);
  res.cookie('sid', token, {
    httpOnly: true,
    secure: PROD,          // cookie only travels over HTTPS in production
    sameSite: 'strict',
    maxAge: SESSION_MS,
    path: '/',
  });
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const compileLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

function cleanEmail(v) {
  return String(v ?? '').trim().toLowerCase();
}

app.post('/api/register', authLimiter, (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password ?? '');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  // bcrypt only uses the first 72 bytes, so reject longer passwords instead of silently truncating.
  if (password.length < 10 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Password must be 10 to 72 bytes long.' });
  }
  const hash = bcrypt.hashSync(password, 12);
  let userId;
  try {
    userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email, hash).lastInsertRowid;
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Could not create account. Try logging in.' });
    }
    throw e;
  }
  startSession(res, userId);
  res.status(201).json({ ok: true });
});

app.post('/api/login', authLimiter, (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password ?? '');
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  // Always run a bcrypt compare so response timing doesn't reveal whether the email exists.
  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password.' });
  startSession(res, user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(req.cookies.sid));
  }
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ email: req.user.email });
});

app.get('/api/lessons', requireUser, (req, res) => {
  res.json({ lessons: LESSONS });
});

app.get('/api/progress', requireUser, (req, res) => {
  const rows = db.prepare('SELECT lesson_id FROM progress WHERE user_id = ?').all(req.user.id);
  res.json({ completed: rows.map(r => r.lesson_id) });
});

app.post('/api/progress', requireUser, (req, res) => {
  const lessonId = String(req.body.lessonId ?? '');
  if (!LESSONS.some(l => l.id === lessonId)) return res.status(400).json({ error: 'Unknown lesson.' });
  db.prepare('INSERT OR IGNORE INTO progress (user_id, lesson_id) VALUES (?, ?)').run(req.user.id, lessonId);
  res.json({ ok: true });
});

// Compiles student code with arduino-cli. Run this only inside a sandbox (see notes below).
app.post('/api/compile', requireUser, compileLimiter, (req, res) => {
  const code = String(req.body.code ?? '');
  if (code.length === 0 || code.length > 20000) {
    return res.status(400).json({ error: 'Code must be 1 to 20000 characters.' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-'));
  const sketchDir = path.join(dir, 'sketch');   // Arduino requires folder name = .ino name
  fs.mkdirSync(sketchDir);
  fs.writeFileSync(path.join(sketchDir, 'sketch.ino'), code);

  execFile('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', sketchDir],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err && err.code === 'ENOENT') {
        return res.status(503).json({ error: 'Compiler is not installed on the server.' });
      }
      res.json({ success: !err, output: (stdout + stderr).slice(-4000) });
    });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`ArduinoPath running on port ${process.env.PORT || 3000}`);
});
