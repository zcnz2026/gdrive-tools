const $ = id => document.getElementById(id);

const state = {
  token: null,
  email: '',
  files: [],
  newFileIds: new Set(),
  policy: { ...DEFAULT_POLICY },
  logs: [],
  lastScanAt: '',
  activeTab: 'files',
  selectedFileIds: new Set()
};

function toast(message) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => node.classList.remove('show'), 4500);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function formatTime(iso = '') {
  if (!iso) return '尚未扫描';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function setStatus(text, ok = false) {
  const node = $('status');
  node.textContent = text;
  node.classList.toggle('ok', ok);
}

async function ensureToken(interactive = true) {
  if (state.token) return state.token;
  const clientId = chrome.runtime.getManifest().oauth2?.client_id || '';
  if (!clientId || clientId.includes('替换')) {
    throw new Error('请先在 manifest.json 配置 Chrome 扩展类型的 OAuth Client ID。');
  }
  state.token = await getAuthToken(interactive);
  return state.token;
}

function updateTopBadges() {
  const scheduleNode = $('schedule-badge');
  if (state.policy.scheduleEnabled) {
    const modeLabel = state.policy.autoEnforce ? '⚡ 自动守护修正' : '🔔 仅提醒';
    scheduleNode.textContent = `⏱️ 定时巡检：每 ${state.policy.scheduleMinutes} 分钟 · ${modeLabel}`;
    scheduleNode.classList.add('active');
  } else {
    scheduleNode.textContent = '⏱️ 定时巡检：未开启';
    scheduleNode.classList.remove('active');
  }

  const summary = computeSummary(state.files, state.policy, state.email, state.newFileIds);
  $('stat-total').textContent = summary.total;
  $('stat-shared').textContent = summary.shared;
  $('stat-unauthorized').textContent = summary.unauthorizedFiles;
  $('stat-overprivileged').textContent = summary.overprivilegedFiles;
  $('stat-public').textContent = summary.publicFiles;
  $('stat-new').textContent = summary.newFiles;

  const enforceBtn = $('quick-enforce-all');
  enforceBtn.textContent = `⚡ 一键修正全部异常 (${summary.anomalousFiles})`;
  enforceBtn.disabled = summary.anomalousFiles === 0;

  $('export').disabled = state.files.length === 0;
  $('clear-new-flags').classList.toggle('hidden', summary.newFiles === 0);

  // 更新标签页数字徽章
  $('tab-count-files').textContent = state.files.length;
  $('tab-count-collabs').textContent = buildCollaboratorList().length;
  $('tab-count-policy').textContent = state.policy.writers.length + state.policy.readers.length;
  $('tab-count-logs').textContent = state.logs.length;

  updateExtensionBadge(state.files, state.policy, state.email);
}

/* ==================== 筛选与文件表格渲染 (TAB 1) ==================== */

function getFilteredFiles() {
  const query = ($('file-search')?.value || '').trim().toLowerCase();
  const typeFilter = $('file-type-filter')?.value || 'all';
  const statusFilter = $('file-status-filter')?.value || 'all';
  const hidePrivate = $('hide-private')?.checked || false;

  return state.files.filter(file => {
    const evalStat = evaluateFile(file, state.policy, state.email);
    const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));

    if (hidePrivate && !evalStat.hasNonOwner) return false;
    if (typeFilter !== 'all' && fileCategory(file.mimeType) !== typeFilter) return false;

    if (statusFilter === 'anomaly' && !evalStat.hasActionableViolation) return false;
    if (statusFilter === 'unauthorized' && evalStat.removeCount === 0) return false;
    if (statusFilter === 'overprivileged' && evalStat.downgradeCount === 0) return false;
    if (statusFilter === 'public' && !evalStat.hasPublic) return false;
    if (statusFilter === 'shared' && !evalStat.hasNonOwner) return false;
    if (statusFilter === 'new' && !isNew) return false;

    if (query) {
      const nameMatch = (file.name || '').toLowerCase().includes(query);
      const idMatch = (file.id || '').toLowerCase().includes(query);
      const permMatch = (file.permissions || []).some(p =>
        (p.emailAddress || '').toLowerCase().includes(query) ||
        (p.displayName || '').toLowerCase().includes(query) ||
        (p.domain || '').toLowerCase().includes(query)
      );
      if (!nameMatch && !idMatch && !permMatch) return false;
    }

    return true;
  });
}

function renderPermissionChip(file, p) {
  const evalResult = evaluatePermission(p, state.policy, state.email);
  const inherited = permIsInherited(p);
  const label = permissionLabel(p);

  if (evalResult.status === 'owner') {
    return `<span class="perm-chip owner" title="文件所有者">👑 ${escapeHtml(label)} · 所有者</span>`;
  }

  if (inherited) {
    return `<span class="perm-chip inherited" title="${escapeHtml(evalResult.reason || '继承自父文件夹')}">
      📁 ${escapeHtml(label)} · ${escapeHtml(roleLabel(p.role))} (继承)
    </span>`;
  }

  const roleOptions = [
    { value: 'writer', text: '可编辑' },
    { value: 'commenter', text: '可评论' },
    { value: 'reader', text: '仅查看' }
  ]
    .map(opt => `<option value="${opt.value}" ${p.role === opt.value ? 'selected' : ''}>${opt.text}</option>`)
    .join('');

  let quickAllowBtn = '';
  if ((p.type === 'user' || p.type === 'group') && p.emailAddress) {
    if (evalResult.status === 'violation_remove') {
      quickAllowBtn = `
        <button type="button" class="chip-btn" data-action="quick-allow-writer" data-email="${escapeHtml(p.emailAddress)}" title="加入「允许编辑」白名单">+可编辑白名单</button>
        <button type="button" class="chip-btn" data-action="quick-allow-reader" data-email="${escapeHtml(p.emailAddress)}" title="加入「仅限查看」白名单">+只读白名单</button>
      `;
    } else if (evalResult.status === 'violation_downgrade') {
      quickAllowBtn = `
        <button type="button" class="chip-btn" data-action="quick-allow-writer" data-email="${escapeHtml(p.emailAddress)}" title="提升至「允许编辑」白名单">升为可编辑白名单</button>
      `;
    }
  }

  return `<span class="perm-chip ${evalResult.status}" title="${escapeHtml(evalResult.reason)}">
    <span>${escapeHtml(label)}</span>
    <select class="perm-select" data-action="change-role" data-file-id="${escapeHtml(file.id)}" data-perm-id="${escapeHtml(p.id)}">
      ${roleOptions}
    </select>
    ${quickAllowBtn}
    <button type="button" class="chip-btn remove" data-action="remove-perm" data-file-id="${escapeHtml(file.id)}" data-perm-id="${escapeHtml(p.id)}" title="移除此权限">×</button>
  </span>`;
}

function renderFilesTab() {
  const filtered = getFilteredFiles();
  const tbody = $('file-rows');

  if (!state.files.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">尚无扫描数据，请点击顶部「立即扫描全部文件」</td></tr>';
    $('select-all').disabled = true;
    updateBatchButtons();
    return;
  }

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">当前筛选条件下没有匹配的文件</td></tr>';
    $('select-all').disabled = true;
    updateBatchButtons();
    return;
  }

  $('select-all').disabled = false;

  tbody.innerHTML = filtered
    .map(file => {
      const stat = evaluateFile(file, state.policy, state.email);
      const cat = fileCategory(file.mimeType);
      const catLabel = fileCategoryLabel(file.mimeType);
      const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
      const checked = state.selectedFileIds.has(file.id) ? 'checked' : '';

      let statusHtml = '';
      if (!stat.hasNonOwner) {
        statusHtml = '<span class="status-pill private">🔒 仅自己可见</span>';
      } else {
        const pills = [];
        if (stat.removeCount > 0) {
          pills.push(`<span class="status-pill danger">🔴 非白名单 (${stat.removeCount})</span>`);
        }
        if (stat.downgradeCount > 0) {
          pills.push(`<span class="status-pill warning">🟠 越权编辑 (${stat.downgradeCount})</span>`);
        }
        if (stat.removeCount === 0 && stat.downgradeCount === 0) {
          pills.push('<span class="status-pill ok">✅ 合规共享</span>');
        }
        statusHtml = pills.join('<br>');
      }

      const perms = file.permissions || [];
      const chipsHtml = perms.length
        ? `<div class="perm-list">${perms.map(p => renderPermissionChip(file, p)).join('')}</div>`
        : '<span class="muted">仅所有者 / 无共享权限</span>';

      const errorHtml = file.permissionError
        ? `<div class="status-pill danger" style="margin-top:4px;">读取失败：${escapeHtml(file.permissionError)}</div>`
        : '';

      const titleLink = file.webViewLink
        ? `<a class="file-name" href="${escapeHtml(file.webViewLink)}" target="_blank" rel="noreferrer">${escapeHtml(file.name || '(无名称)')}</a>`
        : `<span class="file-name">${escapeHtml(file.name || '(无名称)')}</span>`;

      const enforceBtn = stat.hasActionableViolation
        ? `<button type="button" class="btn warning btn-xs" data-action="enforce-file" data-file-id="${escapeHtml(file.id)}">⚡ 一键修正此文件</button>`
        : '';

      return `<tr>
        <td>
          <input type="checkbox" class="row-check" data-file-id="${escapeHtml(file.id)}" ${checked}>
        </td>
        <td>
          <div class="file-title-row">
            <span class="badge type-${cat}">${catLabel}</span>
            ${isNew ? '<span class="badge new-tag">NEW 新增</span>' : ''}
            ${titleLink}
          </div>
          <div class="file-sub">修改于 ${escapeHtml(formatTime(file.modifiedTime))}</div>
        </td>
        <td>${statusHtml}</td>
        <td>${chipsHtml}${errorHtml}</td>
        <td>
          <div class="row-actions">
            ${enforceBtn}
            <button type="button" class="btn btn-xs" data-action="add-collaborator" data-file-id="${escapeHtml(file.id)}">➕ 添加协作者</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  updateBatchButtons();
}

function updateBatchButtons() {
  const filtered = getFilteredFiles();
  const filteredIds = new Set(filtered.map(f => f.id));
  // 清理不在当前列表或已不存在的选择
  const validSelected = [...state.selectedFileIds].filter(id => state.files.some(f => f.id === id));
  state.selectedFileIds = new Set(validSelected);

  const count = state.selectedFileIds.size;
  $('selected-count').textContent = count;
  $('batch-enforce').disabled = count === 0;
  $('batch-downgrade-all').disabled = count === 0;
  $('batch-remove-public').disabled = count === 0;
  $('batch-revoke-all').disabled = count === 0;

  if (filtered.length > 0) {
    $('select-all').checked = filtered.every(f => state.selectedFileIds.has(f.id));
  } else {
    $('select-all').checked = false;
  }
}

/* ==================== 按协作者聚合视图 (TAB 2) ==================== */

function buildCollaboratorList() {
  const map = new Map();
  const ownerNorm = normalizeEntry(state.email);

  for (const file of state.files) {
    for (const p of file.permissions || []) {
      if (p.role === 'owner') continue;
      if (p.type !== 'user' && p.type !== 'group') continue;
      const email = normalizeEntry(p.emailAddress || '');
      if (!email || email === ownerNorm) continue;

      if (!map.has(email)) {
        map.set(email, {
          email,
          displayName: p.displayName || '',
          type: p.type,
          totalFiles: 0,
          editableFiles: 0,
          readerFiles: 0,
          inheritedFiles: 0,
          directRefs: [] // { file, permission }
        });
      }
      const item = map.get(email);
      item.totalFiles++;
      const inherited = permIsInherited(p);
      if (inherited) {
        item.inheritedFiles++;
      } else {
        item.directRefs.push({ file, permission: p });
      }
      if (p.role === 'reader') {
        item.readerFiles++;
      } else {
        item.editableFiles++;
      }
    }
  }

  return [...map.values()].sort((a, b) => b.totalFiles - a.totalFiles);
}

function renderCollaboratorsTab() {
  const allCollabs = buildCollaboratorList();
  const query = ($('collab-search')?.value || '').trim().toLowerCase();
  const filter = $('collab-filter')?.value || 'all';
  const tbody = $('collab-rows');

  const filtered = allCollabs.filter(c => {
    const inWriters = matchesAllowlist(c.email, state.policy.writers);
    const inReaders = matchesAllowlist(c.email, state.policy.readers);
    const isStranger = !inWriters && !inReaders;
    const isOverprivileged = inReaders && c.editableFiles > 0;

    if (filter === 'stranger' && !isStranger) return false;
    if (filter === 'overprivileged' && !isOverprivileged) return false;
    if (filter === 'writer_list' && !inWriters) return false;
    if (filter === 'reader_list' && !inReaders) return false;

    if (query && !c.email.includes(query) && !(c.displayName || '').toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">没有匹配的协作者</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map(c => {
      const inWriters = matchesAllowlist(c.email, state.policy.writers);
      const inReaders = matchesAllowlist(c.email, state.policy.readers);

      let statusBadge = '';
      if (inWriters) {
        statusBadge = '<span class="status-pill ok">✅ 允许编辑</span>';
      } else if (inReaders) {
        statusBadge = c.editableFiles > 0
          ? `<span class="status-pill warning">🟠 越权（有 ${c.editableFiles} 个文件可编辑）</span>`
          : '<span class="status-pill ok">✅ 合规只读</span>';
      } else {
        statusBadge = '<span class="status-pill danger">🔴 未在白名单</span>';
      }

      return `<tr>
        <td>
          <div class="file-name">${escapeHtml(c.email)}</div>
          <div class="file-sub">${escapeHtml(c.displayName || (c.type === 'group' ? '群组' : '个人账号'))}</div>
        </td>
        <td>
          <div class="batch-actions">
            <button type="button" class="btn btn-xs ${inWriters ? 'primary' : ''}" data-action="set-collab-tier" data-email="${escapeHtml(c.email)}" data-tier="writer">✏️ 允许编辑</button>
            <button type="button" class="btn btn-xs ${inReaders ? 'primary' : ''}" data-action="set-collab-tier" data-email="${escapeHtml(c.email)}" data-tier="reader">👁️ 仅限查看</button>
            ${(inWriters || inReaders) ? `<button type="button" class="btn btn-xs" data-action="set-collab-tier" data-email="${escapeHtml(c.email)}" data-tier="none">移出名单</button>` : ''}
          </div>
        </td>
        <td>
          共 <strong>${c.totalFiles}</strong> 个文件<br>
          <span class="muted">可编辑/评论: ${c.editableFiles} · 只读: ${c.readerFiles}${c.inheritedFiles ? ` · 继承: ${c.inheritedFiles}` : ''}</span>
        </td>
        <td>${statusBadge}</td>
        <td>
          <div class="batch-actions">
            <button type="button" class="btn btn-xs" data-action="filter-by-collab" data-email="${escapeHtml(c.email)}">🔍 查看文件</button>
            <button type="button" class="btn warning btn-xs" data-action="downgrade-collab-all" data-email="${escapeHtml(c.email)}" ${c.editableFiles === 0 ? 'disabled' : ''}>👁️ 全部降为只读</button>
            <button type="button" class="btn danger btn-xs" data-action="revoke-collab-all" data-email="${escapeHtml(c.email)}" ${c.directRefs.length === 0 ? 'disabled' : ''}>🗑️ 移除全部权限</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

/* ==================== 白名单与自动化配置视图 (TAB 3) ==================== */

function renderPolicyTab() {
  $('policy-schedule-enabled').checked = Boolean(state.policy.scheduleEnabled);
  $('policy-schedule-minutes').value = String(state.policy.scheduleMinutes || 60);
  $('policy-public-rule').value = state.policy.publicLinkRule || 'forbid';

  const modeValue = state.policy.autoEnforce ? 'enforce' : 'alert';
  const radio = document.querySelector(`input[name="auto-enforce-mode"][value="${modeValue}"]`);
  if (radio) radio.checked = true;

  $('writers-count').textContent = state.policy.writers.length;
  $('readers-count').textContent = state.policy.readers.length;

  $('writers-list').innerHTML = state.policy.writers.length
    ? state.policy.writers
        .map(
          item => `<div class="allow-item">
          <span>${escapeHtml(item)}</span>
          <div class="allow-item-actions">
            <button type="button" class="chip-btn" data-action="move-to-reader" data-entry="${escapeHtml(item)}" title="转为仅限查看">👁️ 转只读</button>
            <button type="button" class="chip-btn remove" data-action="remove-writer" data-entry="${escapeHtml(item)}" title="移除">×</button>
          </div>
        </div>`
        )
        .join('')
    : '<div class="muted">暂无条目。添加后，这些邮箱可拥有编辑或只读权限。</div>';

  $('readers-list').innerHTML = state.policy.readers.length
    ? state.policy.readers
        .map(
          item => `<div class="allow-item">
          <span>${escapeHtml(item)}</span>
          <div class="allow-item-actions">
            <button type="button" class="chip-btn" data-action="move-to-writer" data-entry="${escapeHtml(item)}" title="转为允许编辑">✏️ 转可编辑</button>
            <button type="button" class="chip-btn remove" data-action="remove-reader" data-entry="${escapeHtml(item)}" title="移除">×</button>
          </div>
        </div>`
        )
        .join('')
    : '<div class="muted">暂无条目。添加后，若这些人拥有编辑权限将被识别为越权并可自动降为只读。</div>';
}

/* ==================== 巡检与操作日志视图 (TAB 4) ==================== */

function renderLogsTab() {
  const filter = $('log-filter')?.value || 'all';
  const tbody = $('log-rows');
  const filtered = state.logs.filter(item => {
    if (filter === 'all') return true;
    return item.source === filter;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无符合条件的操作或巡检记录</td></tr>';
    return;
  }

  const sourceMap = {
    auto: '<span class="badge" style="background:#ffedd5;color:#9a3412;">⚡ 自动守护</span>',
    manual: '<span class="badge" style="background:#dbeafe;color:#1e40af;">👆 手动操作</span>',
    scan: '<span class="badge">⏱️ 定时巡检</span>'
  };

  tbody.innerHTML = filtered
    .map(log => {
      const canRestore =
        !log.restored &&
        (log.actionType === 'revoke' || log.actionType === 'downgrade') &&
        log.fileId &&
        log.previousRole;

      let actionHtml = '—';
      if (log.restored) {
        actionHtml = '<span class="muted">✅ 已恢复原权限</span>';
      } else if (canRestore) {
        actionHtml = `<button type="button" class="btn btn-xs" data-action="restore-log" data-log-id="${escapeHtml(log.id)}">↩️ 恢复原权限</button>`;
      }

      const fileCell = log.webViewLink
        ? `<a class="file-name" href="${escapeHtml(log.webViewLink)}" target="_blank" rel="noreferrer">${escapeHtml(log.fileName || log.fileId)}</a>`
        : escapeHtml(log.fileName || '—');

      return `<tr>
        <td>${escapeHtml(formatTime(log.timestamp))}</td>
        <td>${sourceMap[log.source] || escapeHtml(log.source)}</td>
        <td>${fileCell}</td>
        <td>${escapeHtml(log.targetLabel || log.targetEmail || '—')}</td>
        <td>${escapeHtml(log.message || '')}</td>
        <td>${actionHtml}</td>
      </tr>`;
    })
    .join('');
}

function renderAll() {
  updateTopBadges();
  renderFilesTab();
  renderCollaboratorsTab();
  renderPolicyTab();
  renderLogsTab();
}

/* ==================== 核心交互动作实现 ==================== */

async function handleConnect() {
  $('connect').disabled = true;
  setStatus('授权中…');
  try {
    state.token = null;
    await ensureToken(true);
    const about = await fetchAboutUser(state.token);
    state.email = about.email;
    $('account').textContent = state.email
      ? `已授权账号：${state.email}（上次扫描：${formatTime(state.lastScanAt)}）`
      : '已授权当前账号';
    $('scan').disabled = false;
    setStatus('已连接', true);
    toast('Google Drive 授权成功');
  } catch (error) {
    setStatus('未连接');
    const message = /bad client id|invalid_client/i.test(error.message)
      ? `OAuth Client ID 无效。请在 Google Cloud 创建 Chrome Extension 类型客户端并绑定扩展 ID：${chrome.runtime.id}`
      : error.message;
    toast(message);
  } finally {
    $('connect').disabled = false;
  }
}

async function handleScan() {
  $('scan').disabled = true;
  setStatus('扫描中…');
  $('progress').textContent = '正在准备扫描…';
  try {
    const result = await runFullScan({
      interactive: true,
      source: 'manual',
      onProgress(info) {
        $('progress').textContent = info.message;
      }
    });
    state.token = result.token;
    state.email = result.about.email;
    state.files = result.snapshot.files;
    state.lastScanAt = result.snapshot.lastScanAt;
    state.newFileIds = new Set(result.snapshot.newFileIds || []);
    state.logs = await getAuditLogs();

    $('account').textContent = `已授权账号：${state.email}（上次扫描：${formatTime(state.lastScanAt)}）`;
    const errCount = state.files.filter(f => f.permissionError).length;
    $('progress').textContent = errCount
      ? `扫描完成：共 ${state.files.length} 个文件（新增 ${result.newlyDiscoveredCount} 个），${errCount} 个文件读取权限失败`
      : `扫描完成：共 ${state.files.length} 个文件，发现 ${result.summary.anomalousFiles} 个权限异常文件`;
    setStatus('已连接', true);
    renderAll();
  } catch (error) {
    $('progress').textContent = `扫描失败：${error.message}`;
    setStatus('扫描异常');
    toast(`扫描失败：${error.message}`);
  } finally {
    $('scan').disabled = false;
  }
}

async function persistSnapshotAndLogs() {
  const prev = await getSnapshot();
  await saveSnapshot({
    ...prev,
    accountEmail: state.email,
    files: state.files,
    newFileIds: [...state.newFileIds]
  });
  state.logs = await getAuditLogs();
  renderAll();
}

async function handleEnforceFiles(targetFiles, confirmText) {
  if (!targetFiles.length) {
    toast('没有需要处理的文件');
    return;
  }
  let removeTotal = 0;
  let downgradeTotal = 0;
  for (const f of targetFiles) {
    const st = evaluateFile(f, state.policy, state.email);
    removeTotal += st.removeCount;
    downgradeTotal += st.downgradeCount;
  }
  if (removeTotal === 0 && downgradeTotal === 0) {
    toast('所选文件均符合当前白名单与公开链接策略，无需修正');
    return;
  }
  const msg =
    confirmText ||
    `即将按白名单策略处理 ${targetFiles.length} 个文件：\n• 自动移除非白名单/违规公开权限：${removeTotal} 项\n• 将「仅限查看」名单中的越权编辑降为只读：${downgradeTotal} 项\n\n所有变更都会记录在日志中并支持一键恢复，确定执行吗？`;
  if (!confirm(msg)) return;

  try {
    const token = await ensureToken(true);
    const res = await enforceFilesByPolicy(
      token,
      targetFiles,
      state.policy,
      state.email,
      'manual',
      prog => {
        $('progress').textContent = `正在修正权限 ${prog.done}/${prog.total}（已移除 ${prog.removed}，已降级 ${prog.downgraded}）…`;
      }
    );
    await persistSnapshotAndLogs();
    $('progress').textContent = `修正完成：移除 ${res.removed} 项，降级为只读 ${res.downgraded} 项，失败 ${res.failed} 项`;
    toast(`处理完成：移除 ${res.removed} 项，降为只读 ${res.downgraded} 项`);
  } catch (error) {
    toast(`执行失败：${error.message}`);
  }
}

async function handleInlineRoleChange(fileId, permId, newRole) {
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;
  const prevRole = perm.role;
  if (prevRole === newRole) return;

  try {
    const token = await ensureToken(true);
    await updatePermissionRole(token, fileId, permId, newRole);
    perm.role = newRole;
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'downgrade',
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: file.webViewLink || '',
      permissionId: perm.id,
      targetType: perm.type,
      targetEmail: perm.emailAddress || '',
      domain: perm.domain || '',
      targetLabel: permissionLabel(perm),
      previousRole: prevRole,
      newRole,
      restored: false,
      message: `行内修改权限角色：${roleLabel(prevRole)} → ${roleLabel(newRole)}`
    });
    await persistSnapshotAndLogs();
    toast(`已将 ${permissionLabel(perm)} 的权限更新为「${roleLabel(newRole)}」`);
  } catch (error) {
    toast(`修改角色失败：${error.message}`);
    renderFilesTab();
  }
}

async function handleRemoveSinglePerm(fileId, permId) {
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;
  const label = permissionLabel(perm);
  if (!confirm(`确定从「${file.name}」移除 ${label}（${roleLabel(perm.role)}）的权限吗？`)) return;

  try {
    const token = await ensureToken(true);
    await deletePermission(token, fileId, permId);
    file.permissions = (file.permissions || []).filter(p => p.id !== permId);
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'revoke',
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: file.webViewLink || '',
      permissionId: perm.id,
      targetType: perm.type,
      targetEmail: perm.emailAddress || '',
      domain: perm.domain || '',
      targetLabel: label,
      previousRole: perm.role,
      newRole: '',
      restored: false,
      message: `手动移除权限（原角色：${roleLabel(perm.role)}）`
    });
    await persistSnapshotAndLogs();
    toast(`已移除 ${label} 的权限`);
  } catch (error) {
    toast(`移除失败：${error.message}`);
  }
}

async function handleAddCollaboratorToFile(fileId) {
  const file = state.files.find(f => f.id === fileId);
  if (!file) return;
  const emailInput = prompt(`为「${file.name}」添加协作者邮箱：`);
  if (!emailInput || !emailInput.trim()) return;
  const emailAddress = emailInput.trim().toLowerCase();
  const roleInput = prompt('请输入要授予的角色（输入 w 代表「可编辑」，直接回车或输入 r 代表「仅查看」）：', 'r');
  if (roleInput === null) return;
  const role = roleInput.trim().toLowerCase().startsWith('w') ? 'writer' : 'reader';

  try {
    const token = await ensureToken(true);
    const created = await createPermission(token, fileId, {
      type: 'user',
      role,
      emailAddress
    });
    file.permissions = file.permissions || [];
    file.permissions.push({
      id: created?.id || `temp-${Date.now()}`,
      type: 'user',
      role,
      emailAddress
    });
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'grant',
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: file.webViewLink || '',
      permissionId: created?.id || '',
      targetType: 'user',
      targetEmail: emailAddress,
      targetLabel: emailAddress,
      previousRole: '',
      newRole: role,
      restored: false,
      message: `新增协作者 ${emailAddress}（角色：${roleLabel(role)}）`
    });
    await persistSnapshotAndLogs();
    toast(`已为 ${emailAddress} 授予「${roleLabel(role)}」权限`);
  } catch (error) {
    toast(`添加协作者失败：${error.message}`);
  }
}

/* ==================== 批量特殊操作 ==================== */

async function handleBatchCustomAction(mode) {
  const files = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!files.length) return toast('请先勾选文件');

  if (mode === 'enforce') {
    return handleEnforceFiles(files);
  }

  const tasks = [];
  for (const file of files) {
    for (const p of file.permissions || []) {
      if (p.role === 'owner' || permIsInherited(p)) continue;
      if (p.emailAddress && normalizeEntry(p.emailAddress) === normalizeEntry(state.email)) continue;

      if (mode === 'downgrade_all' && p.role !== 'reader') {
        tasks.push({ file, permission: p, action: 'downgrade' });
      } else if (mode === 'remove_public' && (p.type === 'anyone' || p.type === 'domain')) {
        tasks.push({ file, permission: p, action: 'remove' });
      } else if (mode === 'revoke_all') {
        tasks.push({ file, permission: p, action: 'remove' });
      }
    }
  }

  if (!tasks.length) {
    return toast('所选文件中没有符合该操作的直接权限项');
  }

  const actionDesc = {
    downgrade_all: `将 ${files.length} 个文件中的 ${tasks.length} 项可编辑/可评论权限全部降为「仅查看」`,
    remove_public: `关闭 ${files.length} 个文件中的 ${tasks.length} 项公开/域内链接`,
    revoke_all: `清空 ${files.length} 个文件中的全部 ${tasks.length} 项非所有者共享权限`
  }[mode];

  if (!confirm(`确定${actionDesc}吗？操作将记录在日志中并支持恢复。`)) return;

  try {
    const token = await ensureToken(true);
    let done = 0;
    const logs = [];
    for (const item of tasks) {
      const { file, permission, action } = item;
      const label = permissionLabel(permission);
      if (action === 'remove') {
        await deletePermission(token, file.id, permission.id);
        file.permissions = (file.permissions || []).filter(x => x.id !== permission.id);
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'revoke',
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          permissionId: permission.id,
          targetType: permission.type,
          targetEmail: permission.emailAddress || '',
          domain: permission.domain || '',
          targetLabel: label,
          previousRole: permission.role,
          newRole: '',
          restored: false,
          message: `批量移除权限（原角色：${roleLabel(permission.role)}）`
        });
      } else {
        const prevRole = permission.role;
        await updatePermissionRole(token, file.id, permission.id, 'reader');
        permission.role = 'reader';
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'downgrade',
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          permissionId: permission.id,
          targetType: permission.type,
          targetEmail: permission.emailAddress || '',
          domain: permission.domain || '',
          targetLabel: label,
          previousRole: prevRole,
          newRole: 'reader',
          restored: false,
          message: `批量降为只读（原角色：${roleLabel(prevRole)}）`
        });
      }
      done++;
      $('progress').textContent = `批量处理中 ${done}/${tasks.length}…`;
    }
    await appendAuditLogs(logs);
    await persistSnapshotAndLogs();
    toast(`已完成 ${done} 项权限变更`);
  } catch (error) {
    toast(`批量处理出错：${error.message}`);
  }
}

/* ==================== 协作者维度一键操作 ==================== */

async function setCollaboratorAllowTier(email, tier) {
  const norm = normalizeEntry(email);
  let writers = state.policy.writers.filter(x => x !== norm);
  let readers = state.policy.readers.filter(x => x !== norm);
  if (tier === 'writer') writers.push(norm);
  if (tier === 'reader') readers.push(norm);
  state.policy = await savePolicy({ writers, readers });
  renderAll();
  const tierName = tier === 'writer' ? '允许编辑白名单' : tier === 'reader' ? '仅限查看白名单' : '白名单外';
  toast(`已将 ${norm} 设为：${tierName}`);
}

async function handleCollabBatchOp(email, opType) {
  const norm = normalizeEntry(email);
  const targets = [];
  for (const file of state.files) {
    for (const p of file.permissions || []) {
      if (p.role === 'owner' || permIsInherited(p)) continue;
      if (normalizeEntry(p.emailAddress || '') !== norm) continue;
      if (opType === 'downgrade' && p.role !== 'reader') {
        targets.push({ file, permission: p });
      } else if (opType === 'revoke') {
        targets.push({ file, permission: p });
      }
    }
  }
  if (!targets.length) {
    return toast('该协作者没有可操作的目标直接权限');
  }
  const promptText =
    opType === 'downgrade'
      ? `确定将 ${norm} 在 ${targets.length} 个文件中的权限全部降级为「仅查看」吗？`
      : `确定撤除 ${norm} 在全部 ${targets.length} 个文件中的直接访问权限吗？`;
  if (!confirm(promptText)) return;

  try {
    const token = await ensureToken(true);
    const logs = [];
    for (const { file, permission } of targets) {
      if (opType === 'downgrade') {
        const prevRole = permission.role;
        await updatePermissionRole(token, file.id, permission.id, 'reader');
        permission.role = 'reader';
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'downgrade',
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          permissionId: permission.id,
          targetType: permission.type,
          targetEmail: norm,
          targetLabel: norm,
          previousRole: prevRole,
          newRole: 'reader',
          restored: false,
          message: `按人员批量降级为只读（原角色：${roleLabel(prevRole)}）`
        });
      } else {
        await deletePermission(token, file.id, permission.id);
        file.permissions = (file.permissions || []).filter(x => x.id !== permission.id);
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'revoke',
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          permissionId: permission.id,
          targetType: permission.type,
          targetEmail: norm,
          targetLabel: norm,
          previousRole: permission.role,
          newRole: '',
          restored: false,
          message: `按人员批量移除权限（原角色：${roleLabel(permission.role)}）`
        });
      }
    }
    await appendAuditLogs(logs);
    await persistSnapshotAndLogs();
    toast(`已完成对 ${norm} 的 ${targets.length} 项权限操作`);
  } catch (error) {
    toast(`操作失败：${error.message}`);
  }
}

/* ==================== 日志一键恢复原权限 ==================== */

async function handleRestoreLog(logId) {
  const log = state.logs.find(l => l.id === logId);
  if (!log || log.restored) return;

  try {
    const token = await ensureToken(true);
    const file = state.files.find(f => f.id === log.fileId);

    if (log.actionType === 'downgrade' && log.permissionId) {
      await updatePermissionRole(token, log.fileId, log.permissionId, log.previousRole);
      const perm = file?.permissions?.find(p => p.id === log.permissionId);
      if (perm) perm.role = log.previousRole;
    } else if (log.actionType === 'revoke') {
      const created = await createPermission(token, log.fileId, {
        type: log.targetType || 'user',
        role: log.previousRole || 'reader',
        emailAddress: log.targetEmail || undefined,
        domain: log.domain || undefined
      });
      if (file) {
        file.permissions = file.permissions || [];
        file.permissions.push({
          id: created?.id || `restored-${Date.now()}`,
          type: log.targetType || 'user',
          role: log.previousRole || 'reader',
          emailAddress: log.targetEmail || undefined,
          domain: log.domain || undefined
        });
      }
    }

    await markAuditLogRestored(log.id);
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'grant',
      fileId: log.fileId,
      fileName: log.fileName,
      webViewLink: log.webViewLink || '',
      permissionId: log.permissionId || '',
      targetType: log.targetType,
      targetEmail: log.targetEmail,
      targetLabel: log.targetLabel || log.targetEmail,
      previousRole: log.newRole || '',
      newRole: log.previousRole,
      restored: true,
      message: `已从日志恢复原权限：${roleLabel(log.previousRole)}`
    });
    await persistSnapshotAndLogs();
    toast(`已成功恢复 ${log.targetLabel || log.targetEmail} 在「${log.fileName}」的 ${roleLabel(log.previousRole)} 权限`);
  } catch (error) {
    toast(`恢复权限失败：${error.message}`);
  }
}

/* ==================== 白名单 JSON 导入/导出与 CSV 导出 ==================== */

async function handleImportJson(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.installed || parsed.web)) {
      const clientType = parsed.installed ? '桌面应用（installed）' : 'Web 应用（web）';
      toast(`这是 Google OAuth 凭证文件（${clientType}），不是白名单配置文件`);
      return;
    }

    let writers = [...state.policy.writers];
    let readers = [...state.policy.readers];
    let publicLinkRule = state.policy.publicLinkRule;

    if (Array.isArray(parsed) || Array.isArray(parsed?.keepEmails)) {
      const list = normalizeEmailList(Array.isArray(parsed) ? parsed : parsed.keepEmails);
      const asWriter = confirm(
        `检测到单列表 JSON（共 ${list.length} 个邮箱）。\n点击「确定」导入到【允许编辑白名单】，点击「取消」导入到【仅限查看白名单】。`
      );
      if (asWriter) {
        writers.push(...list);
      } else {
        readers.push(...list);
      }
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.writers)) writers.push(...parsed.writers);
      if (Array.isArray(parsed.readers)) readers.push(...parsed.readers);
      if (['forbid', 'reader_only', 'allow'].includes(parsed.publicLinkRule)) {
        publicLinkRule = parsed.publicLinkRule;
      }
    } else {
      throw new Error('JSON 格式应为 {"writers":[...], "readers":[...]} 或邮箱数组');
    }

    state.policy = await savePolicy({ writers, readers, publicLinkRule });
    renderAll();
    toast(`白名单导入成功：可编辑 ${state.policy.writers.length} 项，仅查看 ${state.policy.readers.length} 项`);
  } catch (error) {
    toast(`JSON 导入失败：${error.message}`);
  }
}

function handleExportPolicyJson() {
  const data = {
    writers: state.policy.writers,
    readers: state.policy.readers,
    publicLinkRule: state.policy.publicLinkRule,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'drive-allowlist-policy.json';
  link.click();
  URL.revokeObjectURL(url);
}

function handleExportCsv() {
  const lines = [['文件名', '文件ID', '分类', '是否新增', '链接', '权限类型', '角色', '邮箱/范围', '是否继承', '合规判定']];
  for (const file of state.files) {
    const perms = file.permissions?.length ? file.permissions : [null];
    const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
    for (const p of perms) {
      const evalRes = p ? evaluatePermission(p, state.policy, state.email) : { reason: '仅自己可见' };
      lines.push([
        file.name || '',
        file.id || '',
        fileCategoryLabel(file.mimeType),
        isNew ? '是' : '否',
        file.webViewLink || '',
        p?.type || '',
        p ? roleLabel(p.role) : '',
        p ? permissionLabel(p) : '',
        p ? (permIsInherited(p) ? '是' : '否') : '',
        evalRes.reason || ''
      ]);
    }
  }
  const csv =
    '\ufeff' +
    lines.map(row => row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'drive-permissions-report.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/* ==================== 事件绑定与初始化 ==================== */

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
}

function parseBatchInput(inputStr = '') {
  return normalizeEmailList(inputStr.split(/[\s,;，；\n]+/));
}

async function init() {
  state.policy = await getPolicy();
  const snapshot = await getSnapshot();
  state.logs = await getAuditLogs();

  if (snapshot.files?.length) {
    state.files = snapshot.files;
    state.email = snapshot.accountEmail || '';
    state.lastScanAt = snapshot.lastScanAt || '';
    state.newFileIds = new Set(snapshot.newFileIds || []);
    $('progress').textContent = `已加载上次扫描结果（${formatTime(state.lastScanAt)}，共 ${state.files.length} 个文件）`;
  }

  renderAll();

  // 静默检查是否已有授权 Token
  try {
    state.token = await getAuthToken(false);
    if (state.token) {
      const about = await fetchAboutUser(state.token);
      state.email = about.email || state.email;
      $('account').textContent = `已授权账号：${state.email}${state.lastScanAt ? `（上次扫描：${formatTime(state.lastScanAt)}）` : ''}`;
      $('scan').disabled = false;
      setStatus('已连接', true);
    }
  } catch (_e) {
    // 尚未静默授权时等待用户点击按钮
  }

  // 顶部与全局事件
  $('connect').addEventListener('click', handleConnect);
  $('scan').addEventListener('click', handleScan);
  $('export').addEventListener('click', handleExportCsv);
  $('quick-enforce-all').addEventListener('click', () => {
    const anomalous = state.files.filter(f => evaluateFile(f, state.policy, state.email).hasActionableViolation);
    handleEnforceFiles(anomalous);
  });

  $('clear-new-flags').addEventListener('click', async () => {
    state.newFileIds.clear();
    for (const f of state.files) f.isNew = false;
    await persistSnapshotAndLogs();
    toast('已清除新增文件的 NEW 标记');
  });

  // 统计看板点击快速过滤
  document.querySelectorAll('.summary-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.summary-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const filterType = card.dataset.cardFilter;
      switchTab('files');
      $('file-status-filter').value = filterType === 'all' ? 'all' : filterType;
      renderFilesTab();
    });
  });

  // 标签页切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 文件列表筛选器
  ['file-search', 'file-type-filter', 'file-status-filter', 'hide-private'].forEach(id => {
    $(id).addEventListener('input', renderFilesTab);
    $(id).addEventListener('change', renderFilesTab);
  });

  // 全选当前筛选
  $('select-all').addEventListener('change', e => {
    const filtered = getFilteredFiles();
    for (const f of filtered) {
      if (e.target.checked) state.selectedFileIds.add(f.id);
      else state.selectedFileIds.delete(f.id);
    }
    renderFilesTab();
  });

  // 批量按钮
  $('batch-enforce').addEventListener('click', () => handleBatchCustomAction('enforce'));
  $('batch-downgrade-all').addEventListener('click', () => handleBatchCustomAction('downgrade_all'));
  $('batch-remove-public').addEventListener('click', () => handleBatchCustomAction('remove_public'));
  $('batch-revoke-all').addEventListener('click', () => handleBatchCustomAction('revoke_all'));

  // 文件表格行内事件委托
  $('file-rows').addEventListener('change', e => {
    const target = e.target;
    if (target.classList.contains('row-check')) {
      const fileId = target.dataset.fileId;
      if (target.checked) state.selectedFileIds.add(fileId);
      else state.selectedFileIds.delete(fileId);
      updateBatchButtons();
    } else if (target.dataset.action === 'change-role') {
      handleInlineRoleChange(target.dataset.fileId, target.dataset.permId, target.value);
    }
  });

  $('file-rows').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'remove-perm') {
      handleRemoveSinglePerm(btn.dataset.fileId, btn.dataset.permId);
    } else if (action === 'quick-allow-writer') {
      setCollaboratorAllowTier(btn.dataset.email, 'writer');
    } else if (action === 'quick-allow-reader') {
      setCollaboratorAllowTier(btn.dataset.email, 'reader');
    } else if (action === 'enforce-file') {
      const file = state.files.find(f => f.id === btn.dataset.fileId);
      if (file) handleEnforceFiles([file]);
    } else if (action === 'add-collaborator') {
      handleAddCollaboratorToFile(btn.dataset.fileId);
    }
  });

  // 协作者面板筛选与事件
  ['collab-search', 'collab-filter'].forEach(id => {
    $(id).addEventListener('input', renderCollaboratorsTab);
    $(id).addEventListener('change', renderCollaboratorsTab);
  });

  $('trust-all-current-writers').addEventListener('click', async () => {
    const collabs = buildCollaboratorList();
    if (!collabs.length) return toast('当前没有协作者可导入');
    if (!confirm(`确定将当前扫描出的 ${collabs.length} 名协作者按其现有权限录入白名单吗？`)) return;
    const writers = [...state.policy.writers];
    const readers = [...state.policy.readers];
    for (const c of collabs) {
      if (c.editableFiles > 0) writers.push(c.email);
      else readers.push(c.email);
    }
    state.policy = await savePolicy({ writers, readers });
    renderAll();
    toast(`已将 ${collabs.length} 名协作者导入白名单`);
  });

  $('collab-rows').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, email, tier } = btn.dataset;
    if (action === 'set-collab-tier') {
      setCollaboratorAllowTier(email, tier);
    } else if (action === 'filter-by-collab') {
      switchTab('files');
      $('file-search').value = email;
      $('file-status-filter').value = 'all';
      renderFilesTab();
    } else if (action === 'downgrade-collab-all') {
      handleCollabBatchOp(email, 'downgrade');
    } else if (action === 'revoke-collab-all') {
      handleCollabBatchOp(email, 'revoke');
    }
  });

  // 白名单与定期扫描设置事件
  $('policy-schedule-enabled').addEventListener('change', async e => {
    state.policy = await savePolicy({ scheduleEnabled: e.target.checked });
    chrome.runtime.sendMessage({ type: 'SYNC_ALARM' }).catch(() => {});
    renderAll();
    toast(e.target.checked ? '已开启后台定期自动扫描' : '已关闭后台定期扫描');
  });

  $('policy-schedule-minutes').addEventListener('change', async e => {
    state.policy = await savePolicy({ scheduleMinutes: Number(e.target.value) || 60 });
    chrome.runtime.sendMessage({ type: 'SYNC_ALARM' }).catch(() => {});
    renderAll();
    toast(`扫描周期已更新为每 ${state.policy.scheduleMinutes} 分钟`);
  });

  document.querySelectorAll('input[name="auto-enforce-mode"]').forEach(radio => {
    radio.addEventListener('change', async e => {
      const autoEnforce = e.target.value === 'enforce';
      state.policy = await savePolicy({ autoEnforce });
      renderAll();
      toast(autoEnforce ? '已切换为：后台全自动修正模式' : '已切换为：仅告警提醒模式');
    });
  });

  $('policy-public-rule').addEventListener('change', async e => {
    state.policy = await savePolicy({ publicLinkRule: e.target.value });
    renderAll();
    toast('已更新公开/域内链接管控策略');
  });

  $('add-writer-btn').addEventListener('click', async () => {
    const entries = parseBatchInput($('add-writer-input').value);
    if (!entries.length) return;
    $('add-writer-input').value = '';
    state.policy = await savePolicy({ writers: [...state.policy.writers, ...entries] });
    renderAll();
    toast(`已添加 ${entries.length} 项到「允许编辑」白名单`);
  });

  $('add-reader-btn').addEventListener('click', async () => {
    const entries = parseBatchInput($('add-reader-input').value);
    if (!entries.length) return;
    $('add-reader-input').value = '';
    const writersSet = new Set(state.policy.writers);
    const filteredReaders = [...state.policy.readers, ...entries];
    // 如果之前在 writers 中，转入 readers
    const nextWriters = state.policy.writers.filter(w => !entries.includes(w));
    state.policy = await savePolicy({ writers: nextWriters, readers: filteredReaders });
    renderAll();
    toast(`已添加 ${entries.length} 项到「仅限查看」白名单`);
  });

  $('panel-policy').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, entry } = btn.dataset;
    if (action === 'remove-writer') {
      state.policy = await savePolicy({ writers: state.policy.writers.filter(x => x !== entry) });
      renderAll();
    } else if (action === 'remove-reader') {
      state.policy = await savePolicy({ readers: state.policy.readers.filter(x => x !== entry) });
      renderAll();
    } else if (action === 'move-to-reader') {
      state.policy = await savePolicy({
        writers: state.policy.writers.filter(x => x !== entry),
        readers: [...state.policy.readers, entry]
      });
      renderAll();
      toast(`已将 ${entry} 转为「仅限查看」`);
    } else if (action === 'move-to-writer') {
      state.policy = await savePolicy({
        readers: state.policy.readers.filter(x => x !== entry),
        writers: [...state.policy.writers, entry]
      });
      renderAll();
      toast(`已将 ${entry} 转为「允许编辑」`);
    }
  });

  $('json-file').addEventListener('change', e => {
    if (e.target.files[0]) {
      handleImportJson(e.target.files[0]);
      e.target.value = '';
    }
  });
  $('export-policy-json').addEventListener('click', handleExportPolicyJson);

  // 日志页事件
  $('log-filter').addEventListener('change', renderLogsTab);
  $('clear-logs-btn').addEventListener('click', async () => {
    if (!confirm('确定清空所有历史巡检与操作日志吗？')) return;
    await clearAuditLogs();
    state.logs = [];
    renderAll();
    toast('日志已清空');
  });

  $('log-rows').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="restore-log"]');
    if (btn) handleRestoreLog(btn.dataset.logId);
  });

  // 监听后台定时扫描完成广播
  chrome.runtime.onMessage.addListener(async msg => {
    if (msg?.type === 'SCAN_UPDATED') {
      const snap = await getSnapshot();
      state.files = snap.files || [];
      state.lastScanAt = snap.lastScanAt || '';
      state.newFileIds = new Set(snap.newFileIds || []);
      state.logs = await getAuditLogs();
      $('progress').textContent = `后台定时扫描已更新（${formatTime(state.lastScanAt)}）`;
      renderAll();
    }
  });
}

init();
