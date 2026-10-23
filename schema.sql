CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT DEFAULT '',
  series_id INTEGER,
  engine_version TEXT NOT NULL DEFAULT 'cosyvoice2-0.5',
  casting_locked INTEGER NOT NULL DEFAULT 0,
  current_version_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS manuscript_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  source_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'live',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1,
  word_count INTEGER NOT NULL DEFAULT 0,
  render_state TEXT NOT NULL DEFAULT 'not_started',
  approved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paragraphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  display_text TEXT NOT NULL,
  text_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  tier TEXT NOT NULL DEFAULT 'minor',
  gender TEXT NOT NULL DEFAULT '',
  narrator_flag INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  role_note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'CosyVoice 2',
  kind TEXT NOT NULL DEFAULT 'stock',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  ref_text TEXT DEFAULT '',
  provenance TEXT DEFAULT '',
  consent TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS castings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  voice_id INTEGER,
  speed REAL NOT NULL DEFAULT 1.0,
  prompt TEXT DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'base',
  confirmed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(book_id, character_id)
);
CREATE TABLE IF NOT EXISTS casting_notes (
  book_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  why_text TEXT DEFAULT '',
  shaky INTEGER NOT NULL DEFAULT 0,
  collision TEXT DEFAULT '',
  PRIMARY KEY (book_id, character_id)
);
CREATE TABLE IF NOT EXISTS previews (
  book_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  line_text TEXT NOT NULL,
  line_source TEXT DEFAULT '',
  PRIMARY KEY (book_id, character_id)
);
CREATE TABLE IF NOT EXISTS auditions (
  book_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  voice_id INTEGER NOT NULL,
  PRIMARY KEY (book_id, character_id, voice_id)
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  paragraph_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'narration',
  speaker_id INTEGER,
  display_text TEXT NOT NULL,
  spoken_text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending',
  machine_speaker INTEGER,
  machine_conf REAL,
  settled_speaker INTEGER,
  settled_at TEXT
);
CREATE TABLE IF NOT EXISTS pron_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  respelling TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  scope_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  segment_id INTEGER,
  chapter_id INTEGER,
  type TEXT NOT NULL DEFAULT 'note',
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_id INTEGER,
  state TEXT NOT NULL DEFAULT 'queued',
  segment_count INTEGER NOT NULL DEFAULT 0,
  package_hash TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_seg_chapter ON segments(chapter_id, idx);
CREATE INDEX IF NOT EXISTS idx_seg_book ON segments(book_id, version_id);
CREATE INDEX IF NOT EXISTS idx_para_chapter ON paragraphs(chapter_id, idx);
