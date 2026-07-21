"""md5_list.txt parser and batch importer.

Format per line:
    <32-char-md5>  <absolute-path>
"""

import os
import time
from typing import Optional
from db import get_db

BATCH_SIZE = 1000


def parse_line(line: str) -> Optional[tuple[str, str]]:
    """Parse a single line. Returns (md5, path) or None if invalid / .DS_Store."""
    line = line.strip()
    if not line:
        return None
    # Format: <md5>  <path>  (two spaces between)
    parts = line.split("  ", 1)
    if len(parts) != 2:
        return None
    md5, path = parts
    md5 = md5.strip()
    path = path.strip()

    if len(md5) != 32 or not all(c in "0123456789abcdef" for c in md5):
        return None

    # Skip .DS_Store
    if path.endswith("/.DS_Store") or path.endswith(".DS_Store"):
        return None

    return md5, path


def do_import(file_stream, mode: str = "first") -> dict:
    """Import an uploaded md5_list.txt file.

    mode='first': full import, INSERT ON CONFLICT UPDATE.
    mode='incremental': same as first — import all files regardless of MD5.
        Duplicate MD5 detection is handled after import on the duplicates page.
    """
    start = time.time()
    conn = get_db()

    inserted = 0
    updated = 0
    skipped_ds_store = 0
    errors = 0
    total_lines = 0

    # Phase: collect all parsed lines
    parsed: list[tuple[str, str]] = []

    for raw_line in file_stream:
        # Support both text streams and binary streams
        if isinstance(raw_line, bytes):
            try:
                line = raw_line.decode("utf-8")
            except UnicodeDecodeError:
                line = raw_line.decode("latin-1")
        else:
            line = raw_line

        total_lines += 1
        result = parse_line(line)

        if result is None:
            # Check if it was a .DS_Store line
            stripped = line.strip()
            if ".DS_Store" in stripped:
                skipped_ds_store += 1
            else:
                errors += 1
            continue

        md5, path = result
        parsed.append((md5, path))

    # Batch insert (both first and incremental import all files;
    # duplicate MD5 detection happens on the duplicates page)
    conn.execute("BEGIN TRANSACTION")
    try:
        for i in range(0, len(parsed), BATCH_SIZE):
            batch = parsed[i : i + BATCH_SIZE]
            for md5, path in batch:
                file_name = os.path.basename(path)
                parent_dir = os.path.dirname(path)
                if parent_dir == "":
                    parent_dir = "/"

                cursor = conn.execute(
                    """INSERT INTO files (file_path, file_name, parent_dir, md5)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(file_path) DO UPDATE SET
                           md5 = excluded.md5,
                           file_name = excluded.file_name,
                           parent_dir = excluded.parent_dir,
                           imported_at = CURRENT_TIMESTAMP""",
                    (path, file_name, parent_dir, md5),
                )
                if cursor.rowcount == 1:
                    inserted += 1
                else:
                    updated += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    elapsed_ms = int((time.time() - start) * 1000)

    return {
        "ok": True,
        "inserted": inserted,
        "updated": updated,
        "skipped_ds_store": skipped_ds_store,
        "errors": errors,
        "total_lines": total_lines,
        "elapsed_ms": elapsed_ms,
    }
