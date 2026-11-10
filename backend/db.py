"""SQLite 连接、建表与种子数据。"""
from __future__ import annotations

import os
import sqlite3
import hashlib
import secrets
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ROBOTBOARD_DATA", ROOT / "data"))
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "board.db"

# 配色全部参考达芬奇《最后的晚餐》：房间的暗棕、桌布的米白、衣袍的赤陶/赭石/灰蓝。
SUBJECTS = [
    ("humanities", "文科", "Humanities", "#a98cc4", 1),
    ("science", "理科", "Science", "#6f9fd0", 2),
    ("engineering", "工科", "Engineering", "#69a894", 3),
    ("business", "商科", "Business", "#d2914a", 4),
    ("social", "社科", "Social Science", "#d1705a", 5),
    ("ap", "AP 考试", "AP Exams", "#d4bb6b", 6),
    ("activity", "校园活动", "Campus Activities", "#C96FA5", 7),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
    id         TEXT PRIMARY KEY,
    name_zh    TEXT NOT NULL,
    name_en    TEXT NOT NULL,
    color      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recurrences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    freq        TEXT NOT NULL DEFAULT 'none',
    interval    INTEGER NOT NULL DEFAULT 1,
    starts_on   TEXT NOT NULL,
    until_on    TEXT,
    max_count   INTEGER,
    byweekday   INTEGER,
    bynth       INTEGER,
    bymonth     INTEGER,
    bymonthday  INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title_zh      TEXT,
    title_en      TEXT,
    body_zh       TEXT,
    body_en       TEXT,
    location_zh   TEXT,
    location_en   TEXT,
    subject_id    TEXT NOT NULL REFERENCES subjects(id),
    recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE,
    photo_id      INTEGER,
    version       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL DEFAULT 0,
    name_zh          TEXT,
    name_en          TEXT,
    date_mode        TEXT NOT NULL DEFAULT 'offset',
    offset_days      INTEGER NOT NULL DEFAULT 0,
    fixed_md         TEXT,
    fixed_date       TEXT,
    show_on_calendar INTEGER NOT NULL DEFAULT 1,
    show_in_banner   INTEGER NOT NULL DEFAULT 1,
    color            TEXT
);

CREATE TABLE IF NOT EXISTS event_tags (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES subjects(id),
    weight   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, tag_id)
);

CREATE TABLE IF NOT EXISTS announcements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title_zh        TEXT,
    title_en        TEXT,
    body_zh         TEXT,
    body_en         TEXT,
    photo_id        INTEGER,
    starts_on       TEXT,
    ends_on         TEXT,
    show_on_calendar INTEGER NOT NULL DEFAULT 0,
    event_id        INTEGER,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT NOT NULL,
    mime          TEXT NOT NULL,
    width         INTEGER,
    height        INTEGER,
    bytes         INTEGER,
    original_name TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS face_states (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    expression TEXT NOT NULL,
    intensity  REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_recurrence ON events(recurrence_id);
CREATE INDEX IF NOT EXISTS idx_stages_event ON stages(event_id);
CREATE INDEX IF NOT EXISTS idx_tags_event ON event_tags(event_id);
CREATE INDEX IF NOT EXISTS idx_ann_starts ON announcements(starts_on);
"""

DEFAULT_SETTINGS = {
    "academic_year_start": "08-01",
    "ollama_url": "http://127.0.0.1:11434",
    "ai_model": "qwen2.5:1.5b-instruct",
    "ai_num_ctx": "4096",
    "revision": "1",
    "school_name_zh": "学校活动布告板",
    "school_name_en": "School Activity Board",
}


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, _ = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(hash_password(password, salt), stored)


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def bump_revision(conn: sqlite3.Connection) -> int:
    """内容变更后调用。必须与业务写入处于同一事务。"""
    current = int(get_setting(conn, "revision", "1"))
    nxt = current + 1
    set_setting(conn, "revision", str(nxt))
    return nxt


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        for sid, zh, en, color, order in SUBJECTS:
            conn.execute(
                "INSERT INTO subjects(id, name_zh, name_en, color, sort_order) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                "name_zh=excluded.name_zh, name_en=excluded.name_en, "
                "color=excluded.color, sort_order=excluded.sort_order",
                (sid, zh, en, color, order),
            )
        for key, value in DEFAULT_SETTINGS.items():
            if get_setting(conn, key) == "":
                set_setting(conn, key, value)
        if get_setting(conn, "admin_password_hash") == "":
            set_setting(conn, "admin_password_hash", hash_password("admin"))
        if conn.execute("SELECT 1 FROM face_states WHERE id = 1").fetchone() is None:
            conn.execute(
                "INSERT INTO face_states(id, expression, intensity, updated_at) VALUES (1, 'idle', 1.0, ?)",
                (now_iso(),),
            )


def seed_demo() -> None:
    """写入一批示例数据，方便第一次打开就能看到效果。"""
    with db() as conn:
        if conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"] > 0:
            return
        from .seed import seed_events  # 延迟导入避免循环依赖

        seed_events(conn)
