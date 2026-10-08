/**
 * 建表 / 迁移。全部走 node:sqlite 内置的 DatabaseSync（Node >= 22.5，Node 24 已稳定），
 * 零依赖零编译 —— better-sqlite3 在 Windows 上需要 MSVC，我们不要那个税。
 */
export const MIGRATIONS: string[] = [
  /* ---------- 语料源 ---------- */
  `
  CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_url   TEXT NOT NULL UNIQUE,
    user_id       TEXT,
    xsec_token    TEXT,
    nickname      TEXT,
    avatar_url    TEXT,
    red_id        TEXT,
    note_count    INTEGER NOT NULL DEFAULT 0,
    followers     INTEGER,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending|active|error|blocked
    last_error    TEXT,
    last_scraped_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
  `,

  /* ---------- 原始笔记 ---------- */
  `
  CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id      INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    note_id        TEXT NOT NULL,
    xsec_token     TEXT,
    url            TEXT,
    type           TEXT NOT NULL DEFAULT 'normal',    -- normal(图文)|video
    title          TEXT,
    desc           TEXT NOT NULL DEFAULT '',
    tags           TEXT NOT NULL DEFAULT '[]',        -- JSON array
    ip_location    TEXT,
    published_at   INTEGER,                           -- ms epoch
    liked_count    INTEGER NOT NULL DEFAULT 0,
    collected_count INTEGER NOT NULL DEFAULT 0,
    comment_count  INTEGER NOT NULL DEFAULT 0,
    share_count    INTEGER NOT NULL DEFAULT 0,
    image_count    INTEGER NOT NULL DEFAULT 0,
    raw            TEXT,                              -- 原始 JSON，留作日后重解析
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, note_id)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_id);
  CREATE INDEX IF NOT EXISTS idx_notes_published ON notes(source_id, published_at DESC);
  `,

  /* ---------- 笔记图片 ---------- */
  `
  CREATE TABLE IF NOT EXISTS note_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    remote_url  TEXT NOT NULL,
    local_path  TEXT,
    width       INTEGER,
    height      INTEGER,
    bytes       INTEGER,
    sha256      TEXT,
    palette     TEXT,      -- JSON: [{hex,weight}] 离线算的主色板
    brightness  REAL,      -- 0..1 均值亮度，用于判断「深色底 + 亮字」还是反之
    is_cover    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(note_id, idx)
  );
  CREATE INDEX IF NOT EXISTS idx_note_images_note ON note_images(note_id);
  `,

  /* ---------- 单篇蒸馏结果 ---------- */
  `
  CREATE TABLE IF NOT EXISTS note_styles (
    note_id     INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    analysis    TEXT NOT NULL,          -- JSON，见 corpus/analyze.ts 的 NoteStyle
    model       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,

  /* ---------- 作者级风格画像 ---------- */
  `
  CREATE TABLE IF NOT EXISTS style_profiles (
    source_id     INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    profile       TEXT NOT NULL,        -- JSON，见 corpus/profile.ts 的 StyleProfile
    sample_count  INTEGER NOT NULL DEFAULT 0,
    model         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,

  /* ---------- FTS5 全文索引（中文用 trigram）---------- */
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, desc, tags,
    content='',
    tokenize='trigram'
  );
  CREATE TABLE IF NOT EXISTS notes_fts_map (
    rowid    INTEGER PRIMARY KEY,
    note_pk  INTEGER NOT NULL UNIQUE
  );
  `,

  /* ---------- 选题 ---------- */
  `
  CREATE TABLE IF NOT EXISTS topics (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    angle        TEXT,
    brief        TEXT,
    status       TEXT NOT NULL DEFAULT 'open',   -- open|queued|used|dropped
    origin       TEXT NOT NULL DEFAULT 'manual', -- manual|ai
    used_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(source_id, status);
  `,

  /* ---------- 草稿 ---------- */
  `
  CREATE TABLE IF NOT EXISTS drafts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    topic_id      INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'draft',  -- draft|pending|approved|rejected|publishing|published|failed
    ref_note_ids  TEXT NOT NULL DEFAULT '[]',     -- 参考了哪些语料样稿
    rendered      INTEGER NOT NULL DEFAULT 0,
    review_note   TEXT,                           -- 审核备注
    published_url TEXT,
    published_at  TEXT,
    publish_error TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, id DESC);
  `,

  /* ---------- 草稿卡片 ---------- */
  `
  CREATE TABLE IF NOT EXISTS draft_cards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id    INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    layout      TEXT NOT NULL,          -- cover|quote|list|steps|compare|photo_text|cta
    content     TEXT NOT NULL DEFAULT '{}',  -- JSON：该版式的文案块
    photo_url   TEXT,                   -- photo_text 用的底图（已下载到本地）
    image_path  TEXT,                   -- 渲染产物
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(draft_id, idx)
  );
  `,

  /* ---------- 任务队列 ---------- */
  `
  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|canceled
    run_at       TEXT NOT NULL DEFAULT (datetime('now')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error   TEXT,
    dedupe_key   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at   TEXT,
    finished_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `,

  /* ---------- 运行日志 ---------- */
  `
  CREATE TABLE IF NOT EXISTS run_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    level      TEXT NOT NULL,
    scope      TEXT NOT NULL,
    message    TEXT NOT NULL,
    detail     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_run_logs_ts ON run_logs(id DESC);
  `,

  /* ---------- 降级 / 诊断事件（操作台可见）---------- */
  `
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    kind       TEXT NOT NULL,     -- fallback|signature|cookie|risk|publish|error
    severity   TEXT NOT NULL DEFAULT 'info',
    message    TEXT NOT NULL,
    detail     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(id DESC);
  `,

  /* ---------- 设置（UI 可改，覆盖 .env）---------- */
  `
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];