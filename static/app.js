/* ── file-dedup — Frontend ──────────────────────────────────────────── */

// ── Global State ─────────────────────────────────────────────────────
let libraryLocked = false;
let pendingTaskExists = false;
let readonly = false;
let lockedMd5Set = [];
let selectedFiles = new Set();   // { id: true }
let currentDir = '';
let moveSelectedDir = '';
let currentTaskId = null;

// ── Poll Global Status ───────────────────────────────────────────────
async function pollStatus() {
    try {
        const res = await fetch('/api/tree');
        if (!res.ok) return;
        const data = await res.json();
        libraryLocked = data.library_locked;
        pendingTaskExists = data.pending_task_exists;
        readonly = data.readonly === true;
        lockedMd5Set = data.locked_md5_set || [];
        updateGlobalStatus();
    } catch (e) { /* ignore */ }
}

function updateGlobalStatus() {
    const bar = document.getElementById('global-status');
    const text = document.getElementById('status-text');
    const btn = document.getElementById('status-action-btn');
    let messages = [];

    if (readonly) {
        messages.push('🔒 系统处于只读模式，请修改 config.json 中 readonly 为 false');
        btn.style.display = 'none';
    } else {
        if (libraryLocked) {
            messages.push('⚠️ 库中还有重复组未处理');
            btn.style.display = 'inline-block';
            btn.textContent = '去处理';
            btn.onclick = function() { window.location.href = '/duplicates'; };
        }
        if (pendingTaskExists) {
            messages.push('⚠️ 有 pending task 未处理');
            btn.style.display = 'inline-block';
            btn.textContent = '去处理';
            btn.onclick = function() { window.location.href = '/tasks'; };
        }
    }

    if (messages.length > 0) {
        text.textContent = messages.join('；');
        bar.style.display = 'block';
    } else {
        bar.style.display = 'none';
    }
}

function goAction() {
    const btn = document.getElementById('status-action-btn');
    if (btn) btn.click();
}

function showPendingTaskAlert() {
    showMessage('有 pending task 未处理，请先在重复文件或资源管理器页面完成操作。<br>所有操作按钮已被禁用。');
}

async function checkLockBeforeAction() {
    await pollStatus();
    if (readonly) {
        showMessage('系统处于只读模式，请修改 config.json 中 readonly 为 false');
        return false;
    }
    if (libraryLocked) {
        showMessage('库中还有重复组未处理，请先到重复文件页处理。');
        return false;
    }
    if (pendingTaskExists) {
        showMessage('有 pending task 未处理，请先完成或取消。');
        return false;
    }
    return true;
}

// ── Message Helper ───────────────────────────────────────────────────
function showMessage(html) {
    document.getElementById('generic-modal-title').textContent = '提示';
    document.getElementById('generic-modal-body').innerHTML = html;
    document.getElementById('generic-modal-action-btn').style.display = 'none';
    document.getElementById('generic-modal').style.display = 'flex';
}

function showMessageWithButton(html, btnText, btnCallback) {
    document.getElementById('generic-modal-title').textContent = '提示';
    document.getElementById('generic-modal-body').innerHTML = html;
    const actionBtn = document.getElementById('generic-modal-action-btn');
    actionBtn.textContent = btnText;
    actionBtn.style.display = 'inline-block';
    actionBtn.onclick = btnCallback;
    document.getElementById('generic-modal').style.display = 'flex';
}

function closeGenericModal() {
    document.getElementById('generic-modal').style.display = 'none';
}

// ── Tab Switching ────────────────────────────────────────────────────
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
    if (tab === 'md5-duplicates') loadDuplicates();
    if (tab === 'same-name') loadSameName();
}

// ── Duplicates Page ──────────────────────────────────────────────────

async function loadDuplicates() {
    const container = document.getElementById('duplicates-list');
    const loading = document.getElementById('duplicates-loading');
    loading.style.display = 'block';
    container.innerHTML = '';

    try {
        const res = await fetch('/api/duplicates');
        const data = await res.json();
        loading.style.display = 'none';

        libraryLocked = data.library_locked;
        pendingTaskExists = data.pending_task_exists;
        readonly = data.readonly === true;
        lockedMd5Set = data.locked_md5_set || [];
        updateGlobalStatus();
        updateGenerateRmButton();

        if (data.groups.length === 0) {
            container.innerHTML = '<div class="no-results">🎉 没有 MD5 重复文件</div>';
            return;
        }

        let html = '';
        for (const group of data.groups) {
            html += renderDuplicateGroup(group);
        }
        container.innerHTML = html;
    } catch (e) {
        loading.style.display = 'none';
        container.innerHTML = '<div class="no-results">加载失败</div>';
    }
}

function renderDuplicateGroup(group) {
    let html = `<div class="dup-group">
        <div class="dup-group-header" onclick="toggleGroup(this)">
            <div>
                <h3>MD5: ${group.md5_short}...</h3>
                <span class="dup-group-meta">${group.count} 个文件 · ${formatSize(group.total_size)}</span>
            </div>
            <span>▾</span>
        </div>
        <div class="dup-file-list">`;

    for (const f of group.files) {
        const checked = selectedFiles.has(f.id) ? 'checked' : '';
        html += `<div class="dup-file-row" data-id="${f.id}">
            <input type="checkbox" ${checked} onchange="toggleFileSelect(${f.id}, this.checked)">
            <div class="dup-file-info">
                <div class="dup-file-name">${escHtml(f.file_path)}</div>
            </div>
            <div class="dup-file-size">${formatSize(f.file_size)}</div>
            <div class="file-actions">
                <button class="btn btn-sm" onclick="playFile(${f.id})" title="播放">▶️</button>
                <button class="btn btn-sm" onclick="keepOnly(${f.id}, '${group.md5}')" title="只留这个">⭐</button>
            </div>
        </div>`;
    }

    html += `</div></div>`;
    return html;
}

function toggleGroup(header) {
    const list = header.nextElementSibling;
    if (list.style.display === 'none') {
        list.style.display = 'block';
        header.querySelector('span:last-child').textContent = '▾';
    } else {
        list.style.display = 'none';
        header.querySelector('span:last-child').textContent = '▸';
    }
}

function toggleFileSelect(id, checked) {
    if (checked) {
        selectedFiles.add(id);
    } else {
        selectedFiles.delete(id);
    }
    updateSelectedCount();
    updateGenerateRmButton();
}

function updateSelectedCount() {
    const el = document.getElementById('selected-count');
    if (el) el.textContent = `已选 ${selectedFiles.size} 个`;
}

function updateGenerateRmButton() {
    const btn = document.getElementById('generate-rm-btn');
    if (!btn) return;
    const count = selectedFiles.size;
    // libraryLocked 不影响页面 1 的生成按钮——页面 1 本身就是处理重复组的
    btn.disabled = count === 0 || pendingTaskExists;
}

function updateSameNameSelectedCount() {
    const el = document.getElementById('same-name-selected-count');
    const btn = document.getElementById('same-name-rm-btn');
    if (!el || !btn) return;
    const checked = document.querySelectorAll('#tab-same-name .same-name-cb:checked').length;
    el.textContent = `已选 ${checked} 个`;
    btn.disabled = checked === 0 || pendingTaskExists || readonly;
}

// Called by same-name checkbox onchange
function onSameNameCheckChange() {
    updateSameNameSelectedCount();
}

function keepOnly(fileId, md5) {
    // Select all other files in the same MD5 group
    const rows = document.querySelectorAll(`.dup-file-row`);
    selectedFiles.clear();
    let selectCount = 0;
    rows.forEach(row => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (!cb || cb.disabled) return;
        const id = parseInt(row.dataset.id);
        // Check if this file's group header contains the md5
        const group = row.closest('.dup-group');
        if (group && group.querySelector('.dup-group-header h3').textContent.includes(md5.substring(0, 12))) {
            if (id !== fileId) {
                cb.checked = true;
                selectedFiles.add(id);
                selectCount++;
            } else {
                cb.checked = false;
            }
        }
    });
    updateSelectedCount();
    updateGenerateRmButton();
    showMessage(`已勾选组内 ${selectCount} 个文件（除了选中的那个）`);
}

function copyFilePath(path) {
    navigator.clipboard.writeText(path).then(() => {
        showMessage('路径已复制');
    }).catch(() => {
        showMessage('复制失败，请手动复制');
    });
}

// ── Import ────────────────────────────────────────────────────────────
function showImportModal() {
    document.getElementById('import-modal').style.display = 'flex';
    document.getElementById('import-result').style.display = 'none';
    document.getElementById('import-progress').style.display = 'none';
    document.getElementById('import-btn').disabled = false;
}

function closeImportModal() {
    document.getElementById('import-modal').style.display = 'none';
}

	async function doImport() {
	    const fileInput = document.getElementById('import-file');
	    const mode = document.getElementById('import-mode').value;

	    if (!fileInput.files || fileInput.files.length === 0) {
	        showMessage('请选择 md5_list.txt 文件');
	        return;
	    }

	    const file = fileInput.files[0];
	    const formData = new FormData();
	    formData.append('file', file);
	    formData.append('mode', mode);

	    const btn = document.getElementById('import-btn');
	    const progress = document.getElementById('import-progress');
	    const result = document.getElementById('import-result');
	    progress.style.display = 'block';
	    result.style.display = 'none';
	    btn.disabled = true;
	    document.getElementById('import-progress-fill').style.width = '30%';
	    document.getElementById('import-status-text').textContent = '正在上传并导入...';

	    try {
	        const res = await fetch('/api/import', { method: 'POST', body: formData });
	        const data = await res.json();

	        if (data.error) {
	            showMessage(data.error);
	        } else {
	            // Close modal on success
	            closeImportModal();
	            // Show brief summary as message
	            let msg = `✅ 导入完成：新增 ${data.inserted}，更新 ${data.updated}`;
	            if (data.skipped_ds_store > 0) msg += `，跳过 .DS_Store ${data.skipped_ds_store}`;
	            msg += `（${data.elapsed_ms}ms）`;

	            // If there are MD5 duplicate files, show a delete button
	            const dupIds = data.duplicate_ids || [];
	            if (dupIds.length > 0) {
	                msg += `<br><br>🔁 发现 <strong>${dupIds.length}</strong> 个 MD5 重复文件`;
	                showMessageWithButton(msg, '🗑 删除MD5重复的文件', function() {
	                    closeGenericModal();
	                    generateRmWithIds(dupIds);
	                });
	            } else {
	                showMessage(msg);
	            }
	        }
	    } catch (e) {
	        showMessage('导入失败: ' + e.message);
	    }

	    btn.disabled = false;

	    // Refresh lists
	    if (document.querySelector('.tab-btn.active')?.dataset.tab === 'md5-duplicates') {
	        loadDuplicates();
	    }
	}

// ── Generate & Confirm RM ────────────────────────────────────────────

async function generateRm() {
    if (selectedFiles.size === 0) return;

    // Page 1 duplicates page: only check readonly + pending task.
    // libraryLocked is expected here — the whole point is to handle duplicates.
    await pollStatus();
    if (readonly) {
        showMessage('系统处于只读模式，请修改 config.json 中 readonly 为 false');
        return;
    }
    if (pendingTaskExists) {
        showMessage('有 pending task 未处理，请先完成或取消。');
        return;
    }

    const ids = Array.from(selectedFiles);

    try {
        const res = await fetch('/api/generate-rm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        currentTaskId = data.task_id;
        document.getElementById('command-modal-title').textContent = `🗑 删除命令 (${data.count} 个文件)`;
        document.getElementById('command-text').textContent = data.command;
        document.getElementById('command-task-id').textContent = data.task_id;
        document.getElementById('command-modal').style.display = 'flex';
        document.getElementById('command-execute-btn').disabled = false;
        document.getElementById('command-execute-btn').onclick = confirmExecuted;

        // Poll status after generating
        pollStatus();
    } catch (e) {
        showMessage('生成命令失败: ' + e.message);
    }
}

async function generateRmFromSameName() {
    // Collect checked file IDs from all same-name checkboxes
    const checked = document.querySelectorAll('#tab-same-name .same-name-cb:checked');
    const ids = Array.from(checked).map(cb => parseInt(cb.dataset.id));

    if (ids.length === 0) return;

    await pollStatus();
    if (readonly) {
        showMessage('系统处于只读模式，请修改 config.json 中 readonly 为 false');
        return;
    }
    if (pendingTaskExists) {
        showMessage('有 pending task 未处理，请先完成或取消。');
        return;
    }

    try {
        const res = await fetch('/api/generate-rm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        // Store that this task came from same-name tab, so we refresh correctly
        window._lastTaskFromSameName = true;
        currentTaskId = data.task_id;
        document.getElementById('command-modal-title').textContent = `🗑 删除命令 (${data.count} 个文件)`;
        document.getElementById('command-text').textContent = data.command;
        document.getElementById('command-task-id').textContent = data.task_id;
        document.getElementById('command-modal').style.display = 'flex';
        document.getElementById('command-execute-btn').disabled = false;
        document.getElementById('command-execute-btn').onclick = confirmExecuted;

        pollStatus();
    } catch (e) {
        showMessage('生成命令失败: ' + e.message);
    }
}

function sameNameSingleDelete(fileId) {
    // Check the checkbox and immediately generate
    const cb = document.querySelector(`#tab-same-name .same-name-cb[data-id="${fileId}"]`);
    if (cb) {
        cb.checked = true;
        onSameNameCheckChange();
    }
    generateRmFromSameName();
}

async function generateRmWithIds(ids) {
    if (!ids || ids.length === 0) return;

    await pollStatus();
    if (readonly) {
        showMessage('系统处于只读模式，请修改 config.json 中 readonly 为 false');
        return;
    }
    if (pendingTaskExists) {
        showMessage('有 pending task 未处理，请先完成或取消。');
        return;
    }

    try {
        const res = await fetch('/api/generate-rm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        currentTaskId = data.task_id;
        document.getElementById('command-modal-title').textContent = `🗑 删除命令 (${data.count} 个文件)`;
        document.getElementById('command-text').textContent = data.command;
        document.getElementById('command-task-id').textContent = data.task_id;
        document.getElementById('command-modal').style.display = 'flex';
        document.getElementById('command-execute-btn').disabled = false;
        document.getElementById('command-execute-btn').onclick = confirmExecuted;

        pollStatus();
    } catch (e) {
        showMessage('生成命令失败: ' + e.message);
    }
}

async function confirmExecuted() {
    if (!currentTaskId) return;

    try {
        const res = await fetch('/api/confirm-rm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: currentTaskId }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        // Clear selections
        selectedFiles.clear();
        updateSelectedCount();
        closeCommandModal();

        const msg = `✅ 已删除 ${data.deleted} 个文件` +
            (data.library_locked ? `\n库级锁定: ${data.locked_group_count} 组待处理` : '\n库已解锁');
        showMessage(msg);

        // Refresh — refresh both tabs
        loadDuplicates();
        if (window._lastTaskFromSameName) {
            window._lastTaskFromSameName = false;
            // Uncheck all same-name checkboxes
            document.querySelectorAll('#tab-same-name .same-name-cb').forEach(cb => cb.checked = false);
            updateSameNameSelectedCount();
            scanSameName();
        }
        pollStatus();
    } catch (e) {
        showMessage('确认失败: ' + e.message);
    }
}

function copyCommand() {
    const text = document.getElementById('command-text').textContent;
    navigator.clipboard.writeText(text).then(() => {
        showMessage('命令已复制');
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showMessage('命令已复制');
    });
}

function closeCommandModal() {
    document.getElementById('command-modal').style.display = 'none';
    currentTaskId = null;
}

// ── Play File ────────────────────────────────────────────────────────

async function playFile(fileId) {
    updateStatusText('正在打开...');

    try {
        const res = await fetch('/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: fileId }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
        }
    } catch (e) {
        showMessage('打开失败: ' + e.message);
    }
}

function updateStatusText(text) {
    const bar = document.getElementById('global-status');
    const textEl = document.getElementById('status-text');
    if (bar && textEl) {
        textEl.textContent = text;
        bar.style.display = 'block';
        setTimeout(() => {
            if (textEl.textContent === text) {
                bar.style.display = 'none';
            }
        }, 3000);
    }
}

// ── Same Name ─────────────────────────────────────────────────────────

async function scanSameName() {
    const loading = document.getElementById('same-name-loading');
    const container = document.getElementById('same-name-list');
    loading.style.display = 'block';
    container.innerHTML = '';

    try {
        const res = await fetch('/api/same-name');
        const data = await res.json();
        loading.style.display = 'none';

        pendingTaskExists = data.pending_task_exists;
        readonly = data.readonly === true;
        updateGlobalStatus();

        if (data.groups.length === 0) {
            container.innerHTML = '<div class="no-results">🎉 没有同名文件</div>';
            return;
        }

        let html = '';
        for (const group of data.groups) {
            html += renderSameNameGroup(group);
        }
        container.innerHTML = html;
    } catch (e) {
        loading.style.display = 'none';
        container.innerHTML = '<div class="no-results">扫描失败</div>';
    }
}

function renderSameNameGroup(group) {
    let html = `<div class="same-name-card">
        <div class="same-name-header">
            <h3>📄 ${escHtml(group.file_name)} (${group.count} 个) ${group.has_ignored ? '<span style="color:#888;font-size:0.82em;">部分已忽略</span>' : ''}</h3>
            <button class="btn btn-sm" onclick="ignoreSameName(this)" ${pendingTaskExists || readonly ? 'disabled' : ''}>忽略</button>
        </div>
        <div class="same-name-body">`;

    for (const f of group.files) {
        const ignored = f.ignored_at ? '<span style="color:#aaa;font-size:0.82em;">[已忽略]</span>' : '';
        html += `<div class="dup-file-row" data-name="${escHtml(group.file_name)}" data-id="${f.id}">
            <input type="checkbox" class="same-name-cb" data-id="${f.id}" ${f.ignored_at ? 'disabled' : ''} onchange="onSameNameCheckChange()">
            <div class="dup-file-info">
                <div class="dup-file-name">${escHtml(f.file_name)} ${ignored}</div>
                <div class="dup-file-path">${escHtml(f.file_path)} · MD5 ${f.md5_short}...</div>
            </div>
            <div class="dup-file-size">${formatSize(f.file_size)}</div>
            <div class="file-actions">
                <button class="btn btn-sm" onclick="playFile(${f.id})">▶️</button>
                <button class="btn btn-sm" onclick="sameNameSingleDelete(${f.id})" ${pendingTaskExists || readonly ? 'disabled' : ''} title="删除">🗑</button>
            </div>
        </div>`;
    }

    html += `</div></div>`;
    return html;
}

function ignoreSameName(btn) {
    // Get all checkboxes in this card
    const card = btn.closest('.same-name-card');
    const cbs = card.querySelectorAll('.same-name-cb:not(:disabled)');
    const checked = card.querySelectorAll('.same-name-cb:checked');

    // Must select ALL not-disabled in this group
    if (checked.length < cbs.length) {
        showMessage('有相同文件没有确认，请全部选中后再次点击忽略');
        return;
    }

    // Collect file IDs from checkboxes
    const fileIds = Array.from(checked).map(cb => parseInt(cb.dataset.id));
    doIgnoreSameName(fileIds);
}

async function doIgnoreSameName(fileIds) {
    try {
        const res = await fetch('/api/ignore-same-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_ids: fileIds }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        showMessage(`✅ 已忽略 ${data.ignored} 个文件`);
        scanSameName();
    } catch (e) {
        showMessage('操作失败: ' + e.message);
    }
}

// ── Explorer ──────────────────────────────────────────────────────────

async function loadTree() {
    try {
        const res = await fetch('/api/tree');
        const data = await res.json();
        libraryLocked = data.library_locked;
        pendingTaskExists = data.pending_task_exists;
        readonly = data.readonly === true;
        lockedMd5Set = data.locked_md5_set || [];
        updateGlobalStatus();

        document.getElementById('total-files').textContent = `共 ${data.total_files} 个`;

        const tree = document.getElementById('directory-tree');
        let html = `<div class="dir-item ${currentDir === '' ? 'active' : ''}" onclick="selectDir('')">
            <span class="dir-label">📁 全部</span>
            <span class="dir-count">${data.total_files}</span>
        </div>`;

        // Build tree from flat directories
        const root = buildDirTree(data.directories);
        html += renderDirTree(root, 0, '');

        tree.innerHTML = html;
    } catch (e) {
        document.getElementById('directory-tree').innerHTML = '<div class="no-results">加载失败</div>';
    }
}

function buildDirTree(directories) {
    const root = { name: '', path: '', children: {}, count: 0 };

    for (const dir of directories) {
        const parts = dir.path.split('/').filter(Boolean);
        let node = root;
        let accumulatedPath = '';
        for (const part of parts) {
            accumulatedPath += '/' + part;
            if (!node.children[part]) {
                node.children[part] = { name: part, path: accumulatedPath, children: {}, count: 0 };
            }
            node.children[part].count += dir.count;
            node = node.children[part];
        }
    }
    return root;
}

function renderDirTree(node, depth, parentPath) {
    let html = '';
    // Sort children by name
    const names = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
        const child = node.children[name];
        const active = child.path === currentDir ? 'active' : '';
        // Determine if this path (or any parent) is currently expanded
        // Initially: auto-expand ancestors of currentDir, collapse others
        const isExpanded = currentDir && currentDir.startsWith(child.path) ? 'expanded' : '';
        const hasChildren = Object.keys(child.children).length > 0;

        html += `<div class="tree-branch">`;
        html += `<div class="tree-item ${active}" data-path="${escHtml(child.path)}" style="padding-left:${depth * 20 + 8}px">
            ${hasChildren ? `<span class="tree-toggle ${isExpanded}" onclick="event.stopPropagation();toggleTreeBranch(this)">${isExpanded ? '▾' : '▸'}</span>` : '<span class="tree-toggle-placeholder"></span>'}
            <span class="dir-label" onclick="selectDirTree('${escHtml(child.path)}')">📁 ${escHtml(child.name)}</span>
            <span class="dir-count">${child.count}</span>
        </div>`;
        if (hasChildren) {
            html += `<div class="tree-children" style="display:${isExpanded ? 'block' : 'none'}">`;
            html += renderDirTree(child, depth + 1, child.path);
            html += `</div>`;
        }
        html += `</div>`;
    }
    return html;
}

function toggleTreeBranch(el) {
    const childrenContainer = el.closest('.tree-branch').querySelector('.tree-children');
    if (!childrenContainer) return;
    const isHidden = childrenContainer.style.display === 'none';
    childrenContainer.style.display = isHidden ? 'block' : 'none';
    el.textContent = isHidden ? '▾' : '▸';
    el.classList.toggle('expanded', isHidden);
}

function selectDirTree(path) {
    currentDir = path;
    document.querySelectorAll('.tree-item, .dir-item').forEach(el => el.classList.remove('active'));
    const item = document.querySelector(`.tree-item[data-path="${path}"]`) ||
                 document.querySelector(`.dir-item:first-child`);
    if (item) item.classList.add('active');
    document.getElementById('current-dir-name').textContent = path || '全部文件';
    document.getElementById('file-search').value = '';
    loadFiles();
}

function onSearch() {
    loadFiles();
}

async function loadFiles() {
    const q = document.getElementById('file-search').value.trim();
    const params = new URLSearchParams();
    if (currentDir) params.set('parent_dir', currentDir);
    if (q) params.set('q', q);

    const container = document.getElementById('file-list');
    document.getElementById('file-list-loading').style.display = 'block';
    container.innerHTML = '';

    try {
        const res = await fetch(`/api/files?${params}`);
        const data = await res.json();
        document.getElementById('file-list-loading').style.display = 'none';

        libraryLocked = data.library_locked;
        pendingTaskExists = data.pending_task_exists;
        readonly = data.readonly === true;
        lockedMd5Set = data.locked_md5_set || [];
        updateGlobalStatus();

        if (data.files.length === 0) {
            container.innerHTML = '<div class="no-results">没有文件</div>';
            return;
        }

        let html = '';
        for (const f of data.files) {
            const checked = selectedFiles.has(f.id) ? 'checked' : '';
            const locked = f.is_locked ? '<span class="lock-icon" title="MD5 重复锁定">🔒</span>' : '';
            html += `<div class="file-row ${f.is_locked ? 'locked' : ''}" data-id="${f.id}">
                <input type="checkbox" ${checked} onchange="toggleFileSelect(${f.id}, this.checked)" ${f.is_locked || pendingTaskExists ? 'disabled' : ''}>
                <div class="file-info">
                    <div class="file-name">${escHtml(f.file_name)} ${locked}</div>
                    <div class="file-path">${escHtml(f.file_path)}</div>
                </div>
                <div class="file-meta">
                    <span>${formatSize(f.file_size)}</span>
                    <span>${f.md5_short}...</span>
                </div>
                <div class="file-actions">
                    <button class="btn btn-sm" onclick="playFile(${f.id})" title="播放">▶️</button>
                    <button class="btn btn-sm" onclick="singleDelete(${f.id})" ${pendingTaskExists ? 'disabled' : ''} title="删除">🗑</button>
                    <button class="btn btn-sm" onclick="singleMove(${f.id})" ${pendingTaskExists ? 'disabled' : ''} title="移动">📁</button>
                </div>
            </div>`;
        }
        container.innerHTML = html;
        updateBatchBar();
    } catch (e) {
        document.getElementById('file-list-loading').style.display = 'none';
        container.innerHTML = '<div class="no-results">加载失败</div>';
    }
}

function singleDelete(fileId) {
    selectedFiles.clear();
    selectedFiles.add(fileId);
    const cb = document.querySelector(`.file-row[data-id="${fileId}"] input[type="checkbox"]`);
    if (cb) cb.checked = true;
    updateBatchBar();
    batchDelete();
}

function singleMove(fileId) {
    selectedFiles.clear();
    selectedFiles.add(fileId);
    const cb = document.querySelector(`.file-row[data-id="${fileId}"] input[type="checkbox"]`);
    if (cb) cb.checked = true;
    updateBatchBar();
    batchMove();
}

function updateBatchBar() {
    const count = selectedFiles.size;
    document.getElementById('batch-count').textContent = `已选 ${count} 个`;
    document.getElementById('batch-move-btn').disabled = count === 0 || libraryLocked || pendingTaskExists || readonly;
    document.getElementById('batch-delete-btn').disabled = count === 0 || libraryLocked || pendingTaskExists || readonly;
}

function clearSelection() {
    selectedFiles.clear();
    document.querySelectorAll('.file-row input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateBatchBar();
}

async function batchDelete() {
    if (selectedFiles.size === 0) return;
    if (!await checkLockBeforeAction()) return;

    const ids = Array.from(selectedFiles);

    try {
        const res = await fetch('/api/generate-rm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        currentTaskId = data.task_id;
        document.getElementById('command-modal-title').textContent = `🗑 删除命令 (${data.count} 个文件)`;
        document.getElementById('command-text').textContent = data.command;
        document.getElementById('command-task-id').textContent = data.task_id;
        document.getElementById('command-modal').style.display = 'flex';
        document.getElementById('command-execute-btn').disabled = false;

        pollStatus();
    } catch (e) {
        showMessage('生成命令失败: ' + e.message);
    }
}

// ── Move Operations ──────────────────────────────────────────────────

async function batchMove() {
    if (selectedFiles.size === 0) return;

    moveSelectedDir = '';
    document.getElementById('move-generate-btn').disabled = true;
    document.getElementById('move-target').textContent = '未选择目标目录';

    // Load directories for move modal
    try {
        const res = await fetch('/api/tree');
        const data = await res.json();
        const list = document.getElementById('move-dir-list');
        const root = buildDirTree(data.directories);
        let html = renderMoveDirTree(root, 0);
        list.innerHTML = html || '<div class="no-results">没有可用目录</div>';
    } catch (e) {
        document.getElementById('move-dir-list').innerHTML = '<div class="no-results">加载失败</div>';
    }

    document.getElementById('move-modal').style.display = 'flex';
}

function renderMoveDirTree(node, depth) {
    let html = '';
    const names = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
        const child = node.children[name];
        const hasChildren = Object.keys(child.children).length > 0;
        html += `<div class="move-dir-item" style="padding-left:${depth * 20 + 8}px" onclick="selectMoveDir('${escHtml(child.path)}', this)">
            ${hasChildren ? '<span class="tree-toggle expanded" onclick="event.stopPropagation();toggleMoveTree(this)">▾</span>' : '<span class="tree-toggle-placeholder"></span>'}
            📁 ${escHtml(child.name)} (${child.count})
        </div>`;
        if (hasChildren) {
            html += `<div class="tree-children">`;
            html += renderMoveDirTree(child, depth + 1);
            html += `</div>`;
        }
    }
    return html;
}

function toggleMoveTree(el) {
    const childrenContainer = el.closest('.move-dir-item').nextElementSibling;
    if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) return;
    const isHidden = childrenContainer.style.display === 'none';
    childrenContainer.style.display = isHidden ? 'block' : 'none';
    el.textContent = isHidden ? '▾' : '▸';
}

function selectMoveDir(dir, el) {
    moveSelectedDir = dir;
    document.querySelectorAll('.move-dir-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('move-target').textContent = `目标: ${dir}`;
    document.getElementById('move-generate-btn').disabled = false;
}

function filterMoveDirs() {
    const q = document.getElementById('move-search').value.trim().toLowerCase();

    // First pass: show/hide items based on match
    document.querySelectorAll('.move-dir-item').forEach(el => {
        const text = el.textContent.toLowerCase();
        const match = q === '' || text.includes(q);
        el.style.display = match ? '' : 'none';

        // If item matches and has a tree-children sibling, expand it
        if (match && q !== '') {
            const children = el.nextElementSibling;
            if (children && children.classList.contains('tree-children')) {
                children.style.display = 'block';
                const toggle = el.querySelector('.tree-toggle');
                if (toggle) { toggle.textContent = '▾'; toggle.classList.add('expanded'); }
            }
        }
    });

    // Second pass: ensure parent branches of matching items are visible
    document.querySelectorAll('.move-dir-item').forEach(el => {
        if (el.style.display !== 'none') {
            let parent = el.parentElement;
            while (parent && parent.classList.contains('tree-children')) {
                parent.style.display = 'block';
                // Find the parent move-dir-item that owns this tree-children
                const sibling = parent.previousElementSibling;
                if (sibling && sibling.classList.contains('move-dir-item')) {
                    sibling.style.display = '';
                }
                parent = parent.parentElement;
            }
        }
    });
}

function closeMoveModal() {
    document.getElementById('move-modal').style.display = 'none';
}

async function generateMove() {
    if (!moveSelectedDir || selectedFiles.size === 0) return;

    const ids = Array.from(selectedFiles);

    try {
        const res = await fetch('/api/generate-mv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, target_dir: moveSelectedDir }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        currentTaskId = data.task_id;
        closeMoveModal();

        // Change the command modal title and button for mv
        document.getElementById('command-modal-title').textContent = `📁 移动命令 (${data.count} 个文件)`;
        document.getElementById('command-text').textContent = data.command;
        document.getElementById('command-task-id').textContent = data.task_id;
        document.getElementById('command-modal').style.display = 'flex';

        // Override the confirmExecuted for mv
        document.getElementById('command-execute-btn').disabled = false;
        document.getElementById('command-execute-btn').onclick = confirmMvExecuted;

        pollStatus();
    } catch (e) {
        showMessage('生成命令失败: ' + e.message);
    }
}

async function confirmMvExecuted() {
    if (!currentTaskId) return;

    try {
        const res = await fetch('/api/confirm-mv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: currentTaskId }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        selectedFiles.clear();
        closeCommandModal();

        showMessage(`✅ 已移动 ${data.moved} 个文件`);
        loadFiles();
        loadTree();
        pollStatus();

        // Reset confirm button back to rm
        document.getElementById('command-execute-btn').onclick = confirmExecuted;
    } catch (e) {
        showMessage('确认失败: ' + e.message);
    }
}

// ── Utility ───────────────────────────────────────────────────────────

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Tasks Page ────────────────────────────────────────────────────────

async function loadTasks() {
    const container = document.getElementById('tasks-list');
    const loading = document.getElementById('tasks-loading');
    if (!container || !loading) return;
    loading.style.display = 'block';
    container.innerHTML = '';

    try {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        loading.style.display = 'none';

        if (data.tasks.length === 0) {
            container.innerHTML = '<div class="no-results">没有任务记录</div>';
            return;
        }

        let html = '<table class="task-table"><thead><tr>' +
            '<th>ID</th><th>类型</th><th>文件数</th><th>状态</th><th>创建时间</th><th>执行时间</th><th>操作</th>' +
            '</tr></thead><tbody>';

        for (const t of data.tasks) {
            const statusLabel = t.status === 'pending' ? '🟡 pending' :
                t.status === 'executed' ? '✅ executed' : '❌ cancelled';
            html += `<tr>
                <td>${t.id}</td>
                <td>${t.command_type === 'rm' ? '🗑 删除' : '📁 移动'}</td>
                <td>${t.file_count}</td>
                <td>${statusLabel}</td>
                <td>${t.created_at || '-'}</td>
                <td>${t.executed_at || '-'}</td>
                <td class="task-actions">`;

            if (t.status === 'pending') {
                html += `<button class="btn btn-primary btn-sm" onclick="confirmTask(${t.id}, '${t.command_type}')">✅ 已执行</button> `;
                html += `<button class="btn btn-secondary btn-sm" onclick="cancelTask(${t.id})">❌ 取消</button>`;
            } else {
                html += '<span class="text-muted">—</span>';
            }

            html += `</td></tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;

        // Also update global status bar
        pollStatus();
    } catch (e) {
        loading.style.display = 'none';
        container.innerHTML = '<div class="no-results">加载失败</div>';
    }
}

async function confirmTask(taskId, commandType) {
    const endpoint = commandType === 'rm' ? '/api/confirm-rm' : '/api/confirm-mv';

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: taskId }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        const verb = commandType === 'rm' ? '删除' : '移动';
        const count = commandType === 'rm' ? data.deleted : data.moved;
        showMessage(`✅ 已${verb} ${count} 个文件`);
        loadTasks();
    } catch (e) {
        showMessage('操作失败: ' + e.message);
    }
}

async function cancelTask(taskId) {
    try {
        const res = await fetch('/api/cancel-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: taskId }),
        });
        const data = await res.json();

        if (data.error) {
            showMessage(data.error);
            return;
        }

        showMessage('✅ 任务已取消');
        loadTasks();
        pollStatus();
    } catch (e) {
        showMessage('操作失败: ' + e.message);
    }
}

// ── Init ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    // Page-specific init
    if (document.getElementById('duplicates-list')) {
        loadDuplicates();
    }
    if (document.getElementById('directory-tree')) {
        loadTree();
        loadFiles();
    }
    if (document.getElementById('tasks-list')) {
        loadTasks();
    }

    // Reset confirm button handler
    document.getElementById('command-execute-btn').onclick = confirmExecuted;

    // Periodic status polling
    pollStatus();
    setInterval(pollStatus, 10000);
});
