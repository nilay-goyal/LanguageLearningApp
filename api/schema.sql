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
