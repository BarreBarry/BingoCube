'use strict';
/*
 * Cube Bingo — central server + database.
 *
 * Serves the game client (the public/ folder) AND stores ONE shared game state
 * that every player reads and the host writes. This single shared row is the
 * "central database" that the clients poll — replacing the browser localStorage
 * the offline version uses.
 *
 * Run:  cd server && npm install && npm start
 * Then open http://localhost:3000
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
// IMPORTANT: set a strong password in production:  HOST_PASSWORD=secret npm start
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'bingo';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'game.db');
const DEFAULT_TEAMS = ['Team Alpha', 'Team Bravo', 'Team Charlie', 'Team Delta'];

// ---------- database: the whole game lives in one JSON row ----------
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
const readStmt = db.prepare('SELECT data FROM game WHERE id = 1');
const writeStmt = db.prepare(
  'INSERT INTO game (id, data) VALUES (1, @data) ON CONFLICT(id) DO UPDATE SET data = @data'
);
function dbLoad() { const row = readStmt.get(); return row ? row.data : null; }
function dbSave(json) { writeStmt.run({ data: json }); }

// Seed a default game the first time the server runs, so players always get a
// valid board (with per-team link tokens already generated server-side).
if (!dbLoad()) {
  const token = () => crypto.randomBytes(9).toString('hex');
  const data = {};
  DEFAULT_TEAMS.forEach(t => { data[t] = { stickers: {}, cube: null, token: token() }; });
  dbSave(JSON.stringify({ teams: DEFAULT_TEAMS, data, cube: null, rowBonus: 0, sideBonus: 0 }));
  console.log('Seeded a fresh default game.');
}

const app = express();
app.use(express.json({ limit: '12mb' }));           // game can carry small base64 images
app.use(express.static(path.join(__dirname, 'public')));

// Anyone may READ the current game — this is what every player polls.
app.get('/api/game', (req, res) => {
  res.type('application/json').send(dbLoad() || 'null');
});

// Host login: checks the password so the client can unlock the host UI.
app.post('/api/login', (req, res) => {
  if (req.body && req.body.password === HOST_PASSWORD) return res.json({ ok: true });
  res.status(403).json({ ok: false });
});

// Only the host (correct password header) may WRITE the game state.
app.post('/api/game', (req, res) => {
  if (req.get('x-host-password') !== HOST_PASSWORD) {
    return res.status(403).json({ error: 'incorrect host password' });
  }
  const game = req.body;
  if (!game || !Array.isArray(game.teams) || typeof game.data !== 'object') {
    return res.status(400).json({ error: 'invalid game payload' });
  }
  dbSave(JSON.stringify(game));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Cube Bingo server running:  http://localhost:${PORT}`);
  if (HOST_PASSWORD === 'bingo') {
    console.log('⚠  Host password is the default "bingo" — set HOST_PASSWORD before going public.');
  }
});
