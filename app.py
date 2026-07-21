"""Flask web app — file-dedup: duplicate file management system."""

import json
import os
import shlex
import subprocess
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from db import get_db, init_db, library_locked_info, pending_task_info
from importer import do_import

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
DATA_DIR = BASE_DIR / "data"


# ── config helpers ───────────────────────────────────────────────────────────

def load_config() -> dict:
    """Load config.json; create template if missing."""
    if not CONFIG_PATH.exists():
        DATA_DIR.mkdir(exist_ok=True)
        default = {"smb_server_ip": "0.0.0.0"}
        CONFIG_PATH.write_text(json.dumps(default, indent=2), encoding="utf-8")
        print(f"[config] Created {CONFIG_PATH} — set smb_server_ip before using ▶️")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def get_smb_ip() -> str:
    cfg = load_config()
    ip = cfg.get("smb_server_ip", "0.0.0.0")
    if not ip or ip == "0.0.0.0":
        return None
    return ip


def is_readonly() -> bool:
    """Check if readonly mode is enabled in config."""
    cfg = load_config()
    return cfg.get("readonly", False) is True


# ── locking helpers ──────────────────────────────────────────────────────────

def check_write_permission() -> dict | None:
    """Return a 403 JSON response if pending task exists. (task creation)"""
    if pending_task_info()["pending_task_exists"]:
        return {"error": "有 pending task 未处理，请先到 Task 页面处理", "code": 403}, 403
    return None


def check_readonly() -> dict | None:
    """Return a 403 JSON response if readonly mode is on. (DB modification)"""
    if is_readonly():
        return {"error": "系统当前处于只读模式，请修改 config.json 中 readonly 为 false", "code": 403}, 403
    return None


# ── page routes ──────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/duplicates")
def duplicates():
    return render_template("duplicates.html")


@app.route("/explorer")
def explorer():
    return render_template("explorer.html")


@app.route("/tasks")
def tasks():
    return render_template("tasks.html")


# ── JSON API: duplicates ─────────────────────────────────────────────────────

@app.route("/api/duplicates")
def api_duplicates():
    """List all MD5 duplicate groups (files with same MD5, count > 1)."""
    conn = get_db()
    lock = library_locked_info()
    pending = pending_task_info()

    rows = conn.execute("""
        SELECT id, file_path, file_name, parent_dir, md5, file_size, imported_at
        FROM files
        WHERE md5 IN (
            SELECT md5 FROM files GROUP BY md5 HAVING COUNT(*) > 1
        )
        ORDER BY md5, file_name
    """).fetchall()

    # Group by md5
    groups = {}
    for r in rows:
        md5 = r["md5"]
        if md5 not in groups:
            groups[md5] = []
        groups[md5].append({
            "id": r["id"],
            "file_path": r["file_path"],
            "file_name": r["file_name"],
            "parent_dir": r["parent_dir"],
            "md5": md5,
            "file_size": r["file_size"],
            "imported_at": str(r["imported_at"]) if r["imported_at"] else None,
            "is_locked": md5 in lock["locked_md5_set"],
        })

    result = []
    for md5, files in groups.items():
        total_size = sum(f["file_size"] or 0 for f in files)
        result.append({
            "md5": md5,
            "md5_short": md5[:12],
            "count": len(files),
            "total_size": total_size,
            "files": files,
        })

    return jsonify({
        "groups": result,
        "readonly": is_readonly(),
        "library_locked": lock["library_locked"],
        "locked_group_count": lock["locked_group_count"],
        "pending_task_exists": pending["pending_task_exists"],
        "pending_task_count": pending["pending_task_count"],
    })


# ── JSON API: same-name (Phase 2) ────────────────────────────────────────────

@app.route("/api/same-name")
def api_same_name():
    """List same-name groups (different MD5, same file_name)."""
    conn = get_db()
    pending = pending_task_info()

    rows = conn.execute("""
        SELECT id, file_path, file_name, parent_dir, md5, file_size, ignored_at
        FROM files
        WHERE file_name IN (
            SELECT file_name FROM files
            GROUP BY file_name HAVING COUNT(*) >= 2
        )
        ORDER BY file_name, file_path
    """).fetchall()

    groups = {}
    for r in rows:
        name = r["file_name"]
        if name not in groups:
            groups[name] = {"file_name": name, "files": []}
        groups[name]["files"].append({
            "id": r["id"],
            "file_path": r["file_path"],
            "parent_dir": r["parent_dir"],
            "md5": r["md5"],
            "md5_short": r["md5"][:12] if r["md5"] else "",
            "file_size": r["file_size"],
            "ignored_at": str(r["ignored_at"]) if r["ignored_at"] else None,
        })

    # Apply filtering rules:
    # - Group where ALL ignored_at NOT NULL → skip entirely
    # - Group with at least one NULL ignored_at → list all (including ignored)
    result = []
    for name, grp in groups.items():
        all_ignored = all(f["ignored_at"] is not None for f in grp["files"])
        if all_ignored:
            continue
        has_ignored = any(f["ignored_at"] is not None for f in grp["files"])
        result.append({
            "file_name": name,
            "count": len(grp["files"]),
            "has_ignored": has_ignored,
            "files": grp["files"],
        })

    return jsonify({
        "groups": result,
        "readonly": is_readonly(),
        "pending_task_exists": pending["pending_task_exists"],
        "pending_task_count": pending["pending_task_count"],
    })


@app.route("/api/ignore-same-name", methods=["POST"])
def api_ignore_same_name():
    """Mark same-name group files as ignored (must select ALL in group)."""
    data = request.json or {}
    file_ids = data.get("file_ids", [])
    if not file_ids:
        return jsonify({"error": "请选择文件"}), 400

    rro = check_readonly()
    if rro:
        return rro

    conn = get_db()
    placeholders = ",".join("?" for _ in file_ids)

    # Verify all are in the same-name group (file_name appears >= 2)
    rows = conn.execute(
        f"SELECT file_name FROM files WHERE id IN ({placeholders})", file_ids
    ).fetchall()

    # Check every selected file's file_name still has duplicates
    file_names = [r["file_name"] for r in rows]
    for name in file_names:
        cnt = conn.execute(
            "SELECT COUNT(*) as cnt FROM files WHERE file_name = ?", (name,)
        ).fetchone()["cnt"]
        if cnt < 2:
            return jsonify({"error": f"文件 {name} 不是同名组"}), 400

    # Ensure ALL files in group are selected
    for name in file_names:
        total = conn.execute(
            "SELECT COUNT(*) as cnt FROM files WHERE file_name = ? AND ignored_at IS NULL",
            (name,),
        ).fetchone()["cnt"]
        selected = sum(1 for fn in file_names if fn == name)
        if total > 0 and selected < total:
            return jsonify({"error": "有相同文件没有确认，请全部选中后再次点击忽略"}), 400

    conn.execute(
        f"UPDATE files SET ignored_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
        file_ids,
    )
    conn.commit()
    return jsonify({"ok": True, "ignored": len(file_ids)})


# ── JSON API: tree / files (Explorer) ────────────────────────────────────────

@app.route("/api/tree")
def api_tree():
    """Return directory tree with file counts + lock status."""
    conn = get_db()
    lock = library_locked_info()
    pending = pending_task_info()

    q = request.args.get("q", "").strip()

    if q:
        rows = conn.execute("""
            SELECT parent_dir, COUNT(*) as cnt FROM files
            WHERE file_name LIKE ? OR file_path LIKE ?
            GROUP BY parent_dir ORDER BY parent_dir
        """, (f"%{q}%", f"%{q}%")).fetchall()
    else:
        rows = conn.execute(
            "SELECT parent_dir, COUNT(*) as cnt FROM files GROUP BY parent_dir ORDER BY parent_dir"
        ).fetchall()

    total = conn.execute("SELECT COUNT(*) as cnt FROM files").fetchone()["cnt"]

    directories = [{"path": r["parent_dir"], "count": r["cnt"]} for r in rows]

    return jsonify({
        "directories": directories,
        "total_files": total,
        "readonly": is_readonly(),
        "library_locked": lock["library_locked"],
        "locked_group_count": lock["locked_group_count"],
        "locked_md5_set": lock["locked_md5_set"],
        "pending_task_exists": pending["pending_task_exists"],
        "pending_task_count": pending["pending_task_count"],
    })


@app.route("/api/files")
def api_files():
    """List files with optional parent_dir filter and search query."""
    conn = get_db()
    lock = library_locked_info()
    pending = pending_task_info()
    locked_set = set(lock["locked_md5_set"])

    parent_dir = request.args.get("parent_dir", "")
    q = request.args.get("q", "").strip()
    sort_by = request.args.get("sort_by", "parent_dir")
    sort_order = request.args.get("sort_order", "asc")

    allowed_sort = {"parent_dir", "file_name", "file_size", "md5"}
    if sort_by not in allowed_sort:
        sort_by = "parent_dir"

    order = "ASC" if sort_order.lower() != "desc" else "DESC"

    conditions = []
    params = []

    if parent_dir:
        conditions.append("parent_dir = ?")
        params.append(parent_dir)

    if q:
        conditions.append("(file_name LIKE ? OR file_path LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])

    where = ""
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    rows = conn.execute(
        f"SELECT id, file_path, file_name, parent_dir, md5, file_size FROM files {where} ORDER BY {sort_by} {order}",
        params,
    ).fetchall()

    files = []
    for r in rows:
        files.append({
            "id": r["id"],
            "file_path": r["file_path"],
            "file_name": r["file_name"],
            "parent_dir": r["parent_dir"],
            "md5": r["md5"],
            "md5_short": r["md5"][:12] if r["md5"] else "",
            "file_size": r["file_size"],
            "is_locked": r["md5"] in locked_set,
        })

    return jsonify({
        "files": files,
        "readonly": is_readonly(),
        "library_locked": lock["library_locked"],
        "locked_md5_set": lock["locked_md5_set"],
        "pending_task_exists": pending["pending_task_exists"],
        "pending_task_count": pending["pending_task_count"],
    })


# ── JSON API: rm operations ─────────────────────────────────────────────────

@app.route("/api/generate-rm", methods=["POST"])
def api_generate_rm():
    """Generate rm command from file IDs → creates a pending task."""
    data = request.json or {}
    ids = data.get("ids", [])

    if not ids:
        return jsonify({"error": "请选择至少一个文件"}), 400

    # Check permission
    perm = check_write_permission()
    if perm:
        return perm

    conn = get_db()
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT id, file_path, md5 FROM files WHERE id IN ({placeholders})", ids
    ).fetchall()

    if not rows:
        return jsonify({"error": "文件不存在"}), 404

    if len(rows) != len(ids):
        return jsonify({"error": "部分文件不存在"}), 404

    # Ensure at least 1 file per MD5 group is kept
    md5_groups = {}
    for r in rows:
        md5_groups.setdefault(r["md5"], []).append(r["id"])

    # Check: for each MD5, select ALL files in DB with that md5
    for md5, gids in md5_groups.items():
        all_with_md5 = conn.execute(
            "SELECT COUNT(*) as cnt FROM files WHERE md5 = ?", (md5,)
        ).fetchone()["cnt"]
        selected_count = len(gids)
        if selected_count >= all_with_md5:
            return jsonify({"error": f"MD5 {md5[:12]} 必须至少保留 1 个文件，不能全选"}), 400

    paths = [r["file_path"] for r in rows]
    # One file per line for rm commands
    command_lines = [f"rm {shlex.quote(p)}" for p in paths]
    command_text = "\n".join(command_lines)

    # Create a task (pending)
    cursor = conn.execute(
        "INSERT INTO tasks (status, command_type, commands, file_count) VALUES ('pending', 'rm', ?, ?)",
        (json.dumps(command_lines), len(rows)),
    )
    task_id = cursor.lastrowid

    # Link files to task
    for r in rows:
        conn.execute(
            "INSERT INTO task_files (task_id, file_id) VALUES (?, ?)",
            (task_id, r["id"]),
        )
    conn.commit()

    return jsonify({
        "task_id": task_id,
        "command": command_text,
        "count": len(rows),
        "paths": paths,
    })


@app.route("/api/confirm-rm", methods=["POST"])
def api_confirm_rm():
    """Confirm rm execution → audit log + DELETE files."""
    data = request.json or {}
    task_id = data.get("task_id") or data.get("id")

    if not task_id:
        return jsonify({"error": "缺少 task_id"}), 400

    rro = check_readonly()
    if rro:
        return rro

    conn = get_db()

    # Get task
    task = conn.execute(
        "SELECT * FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()
    if not task:
        return jsonify({"error": "task 不存在"}), 404
    if task["status"] != "pending":
        return jsonify({"error": "task 不是 pending 状态"}), 400

    # Get associated file IDs
    tfiles = conn.execute(
        "SELECT file_id, target_dir FROM task_files WHERE task_id = ?", (task_id,)
    ).fetchall()

    file_ids = [tf["file_id"] for tf in tfiles]

    # Audit log + DELETE
    placeholders = ",".join("?" for _ in file_ids)
    files_to_delete = conn.execute(
        f"SELECT id, file_path, md5 FROM files WHERE id IN ({placeholders})",
        file_ids,
    ).fetchall()

    for f in files_to_delete:
        conn.execute(
            "INSERT INTO audit_log (file_path, md5, action) VALUES (?, ?, 'deleted')",
            (f["file_path"], f["md5"]),
        )

    conn.execute(
        f"DELETE FROM files WHERE id IN ({placeholders})", file_ids
    )

    # Mark task as executed
    conn.execute(
        "UPDATE tasks SET status = 'executed', executed_at = CURRENT_TIMESTAMP WHERE id = ?",
        (task_id,),
    )
    conn.commit()

    lock = library_locked_info()
    return jsonify({
        "deleted": len(files_to_delete),
        "readonly": is_readonly(),
        "library_locked": lock["library_locked"],
        "locked_group_count": lock["locked_group_count"],
    })


# ── JSON API: mv operations ─────────────────────────────────────────────────

@app.route("/api/generate-mv", methods=["POST"])
def api_generate_mv():
    """Generate mv command from file IDs + target_dir → creates a pending task."""
    data = request.json or {}
    ids = data.get("ids", [])
    target_dir = data.get("target_dir", "").strip()

    if not ids:
        return jsonify({"error": "请选择至少一个文件"}), 400
    if not target_dir:
        return jsonify({"error": "请选择目标目录"}), 400

    perm = check_write_permission()
    if perm:
        return perm

    conn = get_db()
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT id, file_path, file_name, md5 FROM files WHERE id IN ({placeholders})", ids
    ).fetchall()

    if not rows:
        return jsonify({"error": "文件不存在"}), 404

    # Verify target_dir exists in DB
    target_exists = conn.execute(
        "SELECT COUNT(*) as cnt FROM files WHERE parent_dir = ?", (target_dir,)
    ).fetchone()["cnt"]
    if target_exists == 0:
        return jsonify({"error": "目标目录在库中不存在"}), 400

    lock = library_locked_info()
    locked_set = set(lock["locked_md5_set"])
    locked_ids = [r["id"] for r in rows if r["md5"] in locked_set]
    if locked_ids:
        return jsonify({"error": "包含处于 md5 重复锁定的文件"}), 403

    # Generate mv commands with -i flag
    command_lines = []
    new_paths = []
    for r in rows:
        src = r["file_path"]
        dst = os.path.join(target_dir, r["file_name"])
        new_paths.append(dst)
        command_lines.append(f"mv -i {shlex.quote(src)} {shlex.quote(dst)}")

    command_text = " && \\\n".join(command_lines)

    # Create task
    cursor = conn.execute(
        "INSERT INTO tasks (status, command_type, commands, file_count) VALUES ('pending', 'mv', ?, ?)",
        (json.dumps(command_lines), len(rows)),
    )
    task_id = cursor.lastrowid

    for r in rows:
        conn.execute(
            "INSERT INTO task_files (task_id, file_id, target_dir) VALUES (?, ?, ?)",
            (task_id, r["id"], target_dir),
        )
    conn.commit()

    return jsonify({
        "task_id": task_id,
        "command": command_text,
        "count": len(rows),
        "new_paths": new_paths,
    })


@app.route("/api/confirm-mv", methods=["POST"])
def api_confirm_mv():
    """Confirm mv execution → audit log + UPDATE file paths."""
    data = request.json or {}
    task_id = data.get("task_id") or data.get("id")

    if not task_id:
        return jsonify({"error": "缺少 task_id"}), 400

    rro = check_readonly()
    if rro:
        return rro

    conn = get_db()

    task = conn.execute(
        "SELECT * FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()
    if not task:
        return jsonify({"error": "task 不存在"}), 404
    if task["status"] != "pending":
        return jsonify({"error": "task 不是 pending 状态"}), 400

    tfiles = conn.execute(
        "SELECT tf.file_id, tf.target_dir, f.file_path, f.file_name, f.md5 "
        "FROM task_files tf JOIN files f ON f.id = tf.file_id WHERE tf.task_id = ?",
        (task_id,),
    ).fetchall()

    moved = 0
    for tf in tfiles:
        new_path = os.path.join(tf["target_dir"], tf["file_name"])
        new_parent = tf["target_dir"]

        conn.execute(
            "INSERT INTO audit_log (file_path, md5, action, new_path) VALUES (?, ?, 'moved', ?)",
            (tf["file_path"], tf["md5"], new_path),
        )

        conn.execute(
            "UPDATE files SET file_path = ?, parent_dir = ? WHERE id = ?",
            (new_path, new_parent, tf["file_id"]),
        )
        moved += 1

    conn.execute(
        "UPDATE tasks SET status = 'executed', executed_at = CURRENT_TIMESTAMP WHERE id = ?",
        (task_id,),
    )
    conn.commit()

    lock = library_locked_info()
    return jsonify({
        "moved": moved,
        "readonly": is_readonly(),
        "library_locked": lock["library_locked"],
        "locked_group_count": lock["locked_group_count"],
    })


# ── JSON API: play ──────────────────────────────────────────────────────────

@app.route("/api/play", methods=["POST"])
def api_play():
    """Play a file via smb:// — system opens default player."""
    data = request.json or {}
    file_id = data.get("file_id")

    if not file_id:
        return jsonify({"error": "缺少 file_id"}), 400

    smb_ip = get_smb_ip()
    if not smb_ip:
        return jsonify({"error": "SMB 未配置，请先设置 config.json 中的 smb_server_ip"}), 503

    conn = get_db()
    row = conn.execute(
        "SELECT file_path FROM files WHERE id = ?", (file_id,)
    ).fetchone()

    if not row:
        return jsonify({"error": "文件不存在"}), 404

    path = row["file_path"]

    # Strip first level: /volume1/GV/a.mp4 → /GV/a.mp4
    parts = path.lstrip("/").split("/", 1)
    if len(parts) < 2:
        return jsonify({"error": "路径格式不正确"}), 400

    relative = "/" + parts[1]
    smb_url = f"smb://{smb_ip}{relative}"

    # Validate protocol (security: only smb:// allowed)
    if not smb_url.startswith("smb://"):
        return jsonify({"error": "仅支持 smb:// 协议"}), 400

    try:
        subprocess.Popen(["open", smb_url])
    except Exception as e:
        return jsonify({"error": f"打开播放器失败: {str(e)}"}), 500

    return jsonify({"ok": True, "smb_url": smb_url})


# ── JSON API: config status ──────────────────────────────────────────────────

@app.route("/api/config-status")
def api_config_status():
    ip = get_smb_ip()
    return jsonify({
        "smb_configured": ip is not None,
        "smb_server_ip": ip or "0.0.0.0",
        "readonly": is_readonly(),
    })


# ── JSON API: import ─────────────────────────────────────────────────────────

@app.route("/api/import", methods=["POST"])
def api_import():
    """Upload and import an md5_list.txt file."""
    if "file" not in request.files:
        return jsonify({"error": "请选择文件"}), 400

    uploaded = request.files["file"]
    if uploaded.filename == "":
        return jsonify({"error": "请选择文件"}), 400

    mode = request.form.get("mode", "first")

    # Read file content as stream
    result = do_import(uploaded.stream, mode=mode)
    return jsonify(result)


# ── JSON API: tasks ──────────────────────────────────────────────────────────

@app.route("/api/tasks")
def api_tasks():
    """List all tasks."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM tasks ORDER BY created_at DESC"
    ).fetchall()

    tasks = []
    for r in rows:
        tasks.append({
            "id": r["id"],
            "status": r["status"],
            "command_type": r["command_type"],
            "file_count": r["file_count"],
            "created_at": str(r["created_at"]) if r["created_at"] else None,
            "executed_at": str(r["executed_at"]) if r["executed_at"] else None,
        })

    return jsonify({"tasks": tasks})


@app.route("/api/task-detail")
def api_task_detail():
    """Get detailed info for a single task."""
    task_id = request.args.get("id", type=int)
    if not task_id:
        return jsonify({"error": "缺少 id"}), 400

    conn = get_db()
    task = conn.execute(
        "SELECT * FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()

    if not task:
        return jsonify({"error": "task 不存在"}), 404

    tfiles = conn.execute(
        "SELECT tf.file_id, tf.target_dir, f.file_path, f.file_name, f.md5 "
        "FROM task_files tf LEFT JOIN files f ON f.id = tf.file_id "
        "WHERE tf.task_id = ?",
        (task_id,),
    ).fetchall()

    files_info = []
    for tf in tfiles:
        files_info.append({
            "file_id": tf["file_id"],
            "file_path": tf["file_path"],
            "file_name": tf["file_name"],
            "md5": tf["md5"],
            "target_dir": tf["target_dir"],
        })

    commands = json.loads(task["commands"]) if isinstance(task["commands"], str) else task["commands"]

    return jsonify({
        "id": task["id"],
        "status": task["status"],
        "command_type": task["command_type"],
        "commands": commands,
        "file_count": task["file_count"],
        "files": files_info,
        "created_at": str(task["created_at"]) if task["created_at"] else None,
        "executed_at": str(task["executed_at"]) if task["executed_at"] else None,
    })


@app.route("/api/cancel-task", methods=["POST"])
def api_cancel_task():
    """Cancel a pending task."""
    data = request.json or {}
    task_id = data.get("task_id") or data.get("id")

    if not task_id:
        return jsonify({"error": "缺少 task_id"}), 400

    rro = check_readonly()
    if rro:
        return rro

    conn = get_db()
    task = conn.execute(
        "SELECT status FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()

    if not task:
        return jsonify({"error": "task 不存在"}), 404
    if task["status"] != "pending":
        return jsonify({"error": "只能取消 pending 状态的 task"}), 400

    conn.execute(
        "UPDATE tasks SET status = 'cancelled' WHERE id = ?", (task_id,)
    )
    conn.commit()

    return jsonify({"ok": True})


# ── startup ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    load_config()
    print("=" * 50)
    print("  文件去重管理系统 — File Dedup Manager")
    print("=" * 50)
    print(f"  Database: {DATA_DIR / 'files.db'}")
    print(f"  Config:   {CONFIG_PATH}")
    print(f"  URL:      http://localhost:5001")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5001, debug=True)
