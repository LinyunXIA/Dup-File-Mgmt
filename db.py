"""SQLite database layer — WAL mode, auto-init, thread-safe connections."""

import sqlite3
import os
import threading

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "files.db")

_local = threading.local()


def get_db() -> sqlite3.Connection:
    """Return a thread-local database connection with WAL mode."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        _local.conn = conn
    return conn


def close_db():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def init_db():
    """Create tables if they don't exist."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            parent_dir TEXT NOT NULL,
            md5 TEXT NOT NULL,
            file_size INTEGER,
            ignored_at TIMESTAMP,
            imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_md5 ON files(md5);
        CREATE INDEX IF NOT EXISTS idx_parent_dir ON files(parent_dir);
        CREATE INDEX IF NOT EXISTS idx_file_name ON files(file_name);

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            md5 TEXT,
            action TEXT NOT NULL,
            new_path TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS staging (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_ids TEXT NOT NULL,
            target_dir TEXT,
            action TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT NOT NULL DEFAULT 'pending',
            command_type TEXT NOT NULL,
            commands TEXT NOT NULL,
            file_count INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            executed_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS task_files (
            task_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            target_dir TEXT,
            PRIMARY KEY (task_id, file_id),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
    """)
    conn.commit()


# ── helpers ──────────────────────────────────────────────────────────────────

def library_locked_info() -> dict:
    """Return locking status: bool locked, count of groups, set of locked md5s."""
    conn = get_db()
    rows = conn.execute(
        "SELECT md5, COUNT(*) as cnt FROM files GROUP BY md5 HAVING cnt > 1"
    ).fetchall()
    locked = len(rows) > 0
    locked_md5_set = [r["md5"] for r in rows]
    return {
        "library_locked": locked,
        "locked_group_count": len(rows),
        "locked_md5_set": locked_md5_set,
    }


def pending_task_exists() -> bool:
    conn = get_db()
    row = conn.execute(
        "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'"
    ).fetchone()
    return row["cnt"] > 0


def pending_task_info() -> dict:
    conn = get_db()
    row = conn.execute(
        "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'"
    ).fetchone()
    return {"pending_task_exists": row["cnt"] > 0, "pending_task_count": row["cnt"]}
