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
  /* 体裁：一篇笔记"在干什么"（教程/辨析/趋势/单案…）。
     选题时按语料分布补齐缺的体裁，避免成片都是"为什么…"。 */
  `
  ALTER TABLE topics ADD COLUMN genre TEXT;
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

  /* ---------- 稿件计划与逐页模板族 ---------- */
  `
  CREATE TABLE IF NOT EXISTS draft_plans (
    draft_id     INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
    source_id    INTEGER NOT NULL,
    exemplar_note_id INTEGER,           -- 参照的语料笔记
    skeleton     TEXT,                   -- 正文骨架（语料原句）
    beats        TEXT,                   -- JSON：节拍数组
    roles        TEXT,                   -- JSON：每张卡片的版式
    inner_family TEXT,                   -- 内页模板族
    cover_family TEXT,                   -- 封面模板族
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  ALTER TABLE draft_cards ADD COLUMN family TEXT;         -- 该页的模板族（逐页不同）
  `,
  `
  ALTER TABLE drafts ADD COLUMN plan TEXT;                -- JSON：计划摘要（复现与去重用）
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

  /* ---------- 长任务的进度 ----------
   * 蒸馏一次要跑 30~60 篇、十几分钟，中间只有一句 logger。
   * 没有这张表，界面就只能显示「已蒸馏 116 / 98%」这种**历史累计**数字 ——
   * 看着挺好，其实这一批一篇都没成功过（模型名过期那三天就是这种情况）。
   *
   * 所以进度必须落库：job_id 是行键（一个作业一行，跑完删掉）。
   * done/total 让界面画进度条，note_id/note_title 标出当前在处理哪篇，
   * phase 区分「蒸馏笔记」与「汇总作者画像」两个阶段 —— 后者是一次
   * 200 秒量级的调用，之前全程零反馈。
   */
  `
  CREATE TABLE IF NOT EXISTS job_progress (
    job_id     INTEGER PRIMARY KEY,
    phase      TEXT NOT NULL DEFAULT 'distill',  -- distill|profile
    done       INTEGER NOT NULL DEFAULT 0,
    failed     INTEGER NOT NULL DEFAULT 0,
    total      INTEGER NOT NULL DEFAULT 0,
    note_id    INTEGER,
    note_title TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,

  /* ---------- 逐页视觉证据（阶段 C：模板库的生产者）---------- */
  /*
   * 为什么单独一张表：note_images 记的是「图片存不存在、有多大」，
   * 那是抓取产物；这里记的是「这张图属于哪个模板族、几何证据是什么、
   * 用哪版提取器得到的」—— 那是复刻的生产者。两者生命周期不同：
   * 图片可以重新抓，模板证据一旦被 golden 引用就不能悄悄变。
   *
   * 关键字段：
   *  - extractor_version：证据的算法版本。提取逻辑改了必须换版本号，
   *    否则旧行会被当成新证据（之前 palette 的 5bit 打包 bug 就是
   *    因为没有版本标记，632 行坏数据被当成真值用了很久）。
   *  - family：分类结果；'unknown' 表示「测不出属于哪族」，进校准队列，
   *    不硬塞进已知族。
   *  - evidence：JSON，存该页的像素测量（页脚顶边、编号 bbox、色值…），
   *    golden 验收直接引用它，测试预期不来自 spec。
   *  - verified：是否通过了对应族的 golden 验收。0 表示不可用于生产。
   */
  `
  CREATE TABLE IF NOT EXISTS page_evidence (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id      INTEGER NOT NULL REFERENCES note_images(id) ON DELETE CASCADE,
    source_id     INTEGER NOT NULL,
    note_id       INTEGER NOT NULL,
    page_index    INTEGER NOT NULL,
    sha256        TEXT,               -- 与 note_images.sha256 一致，便于判定「图变了要重提」
    width         INTEGER,
    height        INTEGER,
    family        TEXT NOT NULL DEFAULT 'unknown',
    confidence    REAL NOT NULL DEFAULT 0,
    extractor_version TEXT NOT NULL DEFAULT 'v1',
    evidence      TEXT,               -- JSON：像素测量
    failure       TEXT,               -- 提取失败原因（unknown 队列用）
    verified      INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(image_id, extractor_version)
  );
  CREATE INDEX IF NOT EXISTS idx_page_evidence_source ON page_evidence(source_id, family);
  CREATE INDEX IF NOT EXISTS idx_page_evidence_note ON page_evidence(note_id, page_index);
  `,

  /* ---------- 语料配图池 ---------- */
  `
  CREATE TABLE IF NOT EXISTS corpus_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL,
    note_id     INTEGER NOT NULL,     -- 照片来自哪篇语料（= 题材线索）
    page_index  INTEGER NOT NULL,     -- 该篇的第几页
    file        TEXT NOT NULL,        -- 裁出来的图（绝对路径）
    x           INTEGER NOT NULL,     -- 原图上的裁切框
    y           INTEGER NOT NULL,
    w           INTEGER NOT NULL,
    h           INTEGER NOT NULL,
    tiles       INTEGER NOT NULL,     -- 面积（检测格数），越大越像真照片
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, note_id, page_index, file)
  );
  CREATE INDEX IF NOT EXISTS idx_corpus_photos_source ON corpus_photos(source_id, note_id);
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

  /* ---------- 增量续抓 ---------- */
  // 用 ALTER 而不是 CREATE：已存在的库需要补列。
  // 新建库时这两句会因「列已存在」报错，所以先探测再改。
  `
  ALTER TABLE sources ADD COLUMN available_count INTEGER;
  ALTER TABLE sources ADD COLUMN auto_scrape INTEGER NOT NULL DEFAULT 0;
  `,
];