'use strict';
// SQLite storage (node:sqlite, no native dependency). Every row that belongs to
// someone carries user_id and every query filters on it: accounts never see
// each other's Glyphs, messages, tokens or files.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let db;
const now = () => Date.now();
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, picture TEXT,
  settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS google_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_enc TEXT, access_enc TEXT, expires_at INTEGER, scopes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS model_creds (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL,
  label TEXT, data_enc TEXT NOT NULL, models TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider));
CREATE TABLE IF NOT EXISTS glyphs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, variant TEXT NOT NULL, mode TEXT NOT NULL, model TEXT,
  instructions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle', task_label TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS glyphs_user ON glyphs(user_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, glyph_id TEXT NOT NULL REFERENCES glyphs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', data TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_glyph ON messages(glyph_id, created_at);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, glyph_id TEXT NOT NULL REFERENCES glyphs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, summary TEXT NOT NULL,
  irreversible INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, result TEXT,
  call_id TEXT, run_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE INDEX IF NOT EXISTS actions_user ON actions(user_id, status);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  glyph_id TEXT NOT NULL REFERENCES glyphs(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  payload TEXT NOT NULL, due_at INTEGER NOT NULL, repeat TEXT, status TEXT NOT NULL DEFAULT 'scheduled',
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due_at);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS locations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY, label TEXT, status TEXT NOT NULL, user_id TEXT, token TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, model));
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'glyphes.db'));
  db.exec(SCHEMA);
  return db;
}
const q = (sql) => db.prepare(sql);
const all = (sql, ...args) => q(sql).all(...args);
const get = (sql, ...args) => q(sql).get(...args);
const run = (sql, ...args) => q(sql).run(...args);
const json = (value, fallback) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function kvGet(k) { const row = get('SELECT v FROM kv WHERE k = ?', k); return row ? row.v : null; }
function kvSet(k, v) { run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v); }

module.exports = { open, all, get, run, tx, json, now, newId, kvGet, kvSet, get db() { return db; } };
