-- French text, word positions and lemmas per subtitle line, keyed by a hash of the
-- line. The English text is never stored.
CREATE TABLE IF NOT EXISTS translations (
  version INTEGER NOT NULL,
  lang TEXT NOT NULL,
  video TEXT NOT NULL,
  hash TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (version, lang, video, hash)
) WITHOUT ROWID;

-- Spending per UTC day, for the daily cap.
CREATE TABLE IF NOT EXISTS spend (
  day TEXT PRIMARY KEY,
  usd REAL NOT NULL
) WITHOUT ROWID;

-- Testers. Only a hash of the invite code is stored, and no name or email: the person
-- who handed out the codes knows who has which. The label is something like "T03".
CREATE TABLE IF NOT EXISTS testers (
  code_hash TEXT PRIMARY KEY,
  label TEXT,
  daily_cap_usd REAL NOT NULL DEFAULT 2,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
) WITHOUT ROWID;

-- Each tester's own spending per day. "tester" is the first 16 characters of code_hash.
CREATE TABLE IF NOT EXISTS tester_spend (
  tester TEXT NOT NULL,
  day TEXT NOT NULL,
  usd REAL NOT NULL,
  PRIMARY KEY (tester, day)
) WITHOUT ROWID;

-- Usage events. Never subtitle text, titles or video IDs (see api/src/events.ts).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tester TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_tester ON events (tester, kind, at);

-- Translations a tester pressed R on. This does keep the English line, so it can be reviewed.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tester TEXT NOT NULL,
  at INTEGER NOT NULL,
  lang TEXT NOT NULL,
  video TEXT NOT NULL,
  hash TEXT NOT NULL,
  unit_start INTEGER NOT NULL,
  unit_end INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  french TEXT NOT NULL,
  english TEXT NOT NULL,
  hour REAL NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS reports_by_unit ON reports (video, hash, unit_start, unit_end);

-- Units hidden for everyone: reported by two testers, or confirmed by a reviewer.
-- unit_end of -1 means the full-sentence line.
CREATE TABLE IF NOT EXISTS suppressed (
  version INTEGER NOT NULL,
  lang TEXT NOT NULL,
  video TEXT NOT NULL,
  hash TEXT NOT NULL,
  unit_start INTEGER NOT NULL,
  unit_end INTEGER NOT NULL,
  PRIMARY KEY (version, lang, video, hash, unit_start, unit_end)
) WITHOUT ROWID;
