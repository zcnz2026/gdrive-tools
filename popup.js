const $ = id => document.getElementById(id);

const ALL_TYPE_CATS = ['sheet', 'excel', 'doc', 'word_pdf', 'slide', 'folder', 'media', 'other'];

const state = {
  accounts: [],
  oauthClients: [],
  activeAccount: 'all',
  files: [],
  newFileIds: new Set(),
  policy: { ...DEFAULT_POLICY },
  directory: JSON.parse(JSON.stringify(DEFAULT_DIRECTORY)),
  filterPresets: [],
  logs: [],
  lastScanAt: '',
  activeTab: 'ops',
  selectedFileIds: new Set(),
  selectedTypeCats: new Set(ALL_TYPE_CATS), // 默认全选所有文件类型
  selectedBatchGroups: new Set(),
  expandedPermFileIds: new Set(), // 记录哪些文件展开了完整权限明细（默认全部收起为单行统计）
  coreNameFilter: '',
  scanSheet: null,
  scanSheetFileIds: [],
  isUpdatingScanSheet: false,
  scanDetailView: false,
  batchLinksSheet: null,
  isUpdatingBatchSheet: false
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
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('ok', ok);
}

async function resolveTokenForFile(file, interactive = true) {
  const owner =
    file?.ownerAccount ||
    file?.owners?.[0]?.emailAddress ||
    (state.activeAccount !== 'all' ? state.activeAccount : '');
  return getValidTokenForAccount(owner, interactive);
}

function getScopedFilesByAccount() {
  if (state.activeAccount === 'all') return state.files;
  const target = normalizeEntry(state.activeAccount);
  return state.files.filter(f => normalizeEntry(f.ownerAccount || f.owners?.[0]?.emailAddress || '') === target);
}

/* ==================== 顶部状态、账号下拉与设置内账号列表 ==================== */

function renderAccountsUI() {
  const switcher = $('account-switcher');
  const prevVal = state.activeAccount || 'all';
  switcher.innerHTML =
    `<option value="all">全部已授权账号 (${state.accounts.length})</option>` +
    state.accounts.map(a => `<option value="${escapeHtml(a.email)}">账号: ${escapeHtml(a.email)}</option>`).join('');
  if ([...switcher.options].some(o => o.value === prevVal)) {
    switcher.value = prevVal;
  } else {
    state.activeAccount = 'all';
  }

  $('oauth-clients-info').textContent = `已存凭证: ${state.oauthClients.length} · 已授权账号: ${state.accounts.length}`;

  const listNode = $('accounts-list');
  if (!state.accounts.length && !state.oauthClients.length) {
    listNode.innerHTML = '<span class="muted">尚未导入 JSON 凭证或授权账号</span>';
    setStatus('待授权', false);
    $('scan').disabled = true;
    return;
  }

  if (state.accounts.length > 0) {
    setStatus(`已授权 ${state.accounts.length} 个账号`, true);
    $('scan').disabled = false;
  } else {
    setStatus(`已导入 ${state.oauthClients.length} 个凭证 (待授权)`, false);
    $('scan').disabled = false;
  }

  const clientRowsHtml = state.oauthClients
    .map((c, idx) => {
      const uid = c.uid || c.client_id;
      const name = c.fileName || `凭证 #${idx + 1}`;
      const bound = c.boundEmail ? `已绑: ${c.boundEmail}` : '未授权';
      const statusCls = c.boundEmail ? 'ok' : 'warning';
      return `<div class="allow-item" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(c.client_id)}">
          📄 <strong>${escapeHtml(name)}</strong>
          <span class="status-pill ${statusCls}" style="margin-left:4px;">${escapeHtml(bound)}</span>
        </span>
        <span class="row-flex" style="flex-shrink:0;">
          <button type="button" class="btn btn-xs primary" data-action="auth-oauth-client" data-uid="${escapeHtml(uid)}">${c.boundEmail ? '重新授权' : '点击授权'}</button>
          <button type="button" class="btn-text" style="color:#dc2626;" data-action="remove-oauth-client" data-uid="${escapeHtml(uid)}" title="删除此 JSON 凭证">×</button>
        </span>
      </div>`;
    })
    .join('');

  const accountPillsHtml = state.accounts.length
    ? `<div style="width:100%;margin-top:4px;display:flex;flex-wrap:wrap;gap:5px;">` +
      state.accounts
        .map(
          acc => `<span class="account-pill">
            <span>✅ ${escapeHtml(acc.email)}</span>
            <button type="button" class="remove-acc" data-action="remove-account" data-email="${escapeHtml(acc.email)}" title="移除此账号">×</button>
          </span>`
        )
        .join('') +
      `</div>`
    : '';

  listNode.innerHTML = clientRowsHtml + accountPillsHtml;
}

function updateTopBadges() {
  renderAccountsUI();

  const scheduleNode = $('schedule-badge');
  if (state.policy.scheduleEnabled) {
    const modeLabel = state.policy.autoEnforce ? '自动修正' : '仅提醒';
    scheduleNode.textContent = `巡检：每${state.policy.scheduleMinutes}分 (${modeLabel})`;
    scheduleNode.classList.add('active');
  } else {
    scheduleNode.textContent = '定时巡检：未开启';
    scheduleNode.classList.remove('active');
  }

  const scopedFiles = getScopedFilesByAccount();
  const summary = computeSummary(scopedFiles, state.policy, '', state.newFileIds);
  $('stat-total').textContent = summary.total;
  $('stat-shared').textContent = summary.shared;
  $('stat-unauthorized').textContent = summary.unauthorizedFiles;
  $('stat-overprivileged').textContent = summary.overprivilegedFiles;
  $('stat-public').textContent = summary.publicFiles;
  $('stat-new').textContent = summary.newFiles;

  const enforceBtn = $('quick-enforce-all');
  enforceBtn.textContent = `一键修正异常 (${summary.anomalousFiles})`;
  enforceBtn.disabled = summary.anomalousFiles === 0;

  $('export').disabled = scopedFiles.length === 0;
  $('clear-new-flags').classList.toggle('hidden', summary.newFiles === 0);

  $('tab-count-collabs').textContent = buildMergedPersonList().length;
  $('tab-count-logs').textContent = state.logs.length;

  updateExtensionBadge(state.files, state.policy, '');
}

/* ==================== 导入 OAuth 桌面 JSON 凭证与多账号授权 ==================== */

async function handleAuthorizeWithClient(client, prefixLabel = '') {
  setStatus(`${prefixLabel}等待 Google 授权…`);
  $('progress').textContent = `${prefixLabel}请在弹出的 Google 页面完成登录授权（${client.fileName || client.client_id.slice(0, 12)}）…`;
  try {
    const account = await authorizeWithOAuthClient(client);
    state.accounts = await getAuthorizedAccounts();
    state.oauthClients = await getOAuthClients();
    renderAll();
    $('progress').textContent = `已授权账号：${account.email}（请点击右上角「立即扫描」开始扫描）`;
    toast(`${prefixLabel}已成功授权账号：${account.email}`);
    return account;
  } catch (error) {
    state.accounts = await getAuthorizedAccounts();
    state.oauthClients = await getOAuthClients();
    renderAccountsUI();
    $('progress').textContent = `${prefixLabel}授权未完成：${error.message}`;
    toast(`${prefixLabel}授权未完成：${error.message}`);
    return null;
  }
}

async function handleOAuthFilesUpload(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  const extractedClients = [];
  let allowlistImported = false;

  for (const file of files) {
    try {
      const parsed = JSON.parse(await file.text());
      const clients = extractOAuthClientsFromJson(parsed, file.name);
      if (clients.length > 0) {
        extractedClients.push(...clients);
      } else {
        await importAllowlistFromObject(parsed);
        allowlistImported = true;
      }
    } catch (error) {
      toast(`读取 ${file.name} 失败：${error.message}`);
    }
  }

  if (extractedClients.length > 0) {
    state.oauthClients = await saveOAuthClients(extractedClients);
    renderAccountsUI();
    toast(`已导入 ${extractedClients.length} 个 JSON 授权文件，开始逐一打开 Google 授权页…`);
    let successCount = 0;
    for (let i = 0; i < extractedClients.length; i++) {
      const prefix = extractedClients.length > 1 ? `[${i + 1}/${extractedClients.length}] ` : '';
      const acc = await handleAuthorizeWithClient(extractedClients[i], prefix);
      if (acc) successCount++;
    }
    $('progress').textContent = `已完成 ${successCount}/${extractedClients.length} 个凭证授权。请点击右上角「立即扫描」开始扫描。`;
  } else if (!allowlistImported) {
    toast('未识别到有效的 Google OAuth 凭证');
  }
}

async function handleAddMoreAccount() {
  state.oauthClients = await getOAuthClients();
  if (!state.oauthClients.length) {
    $('oauth-json-file').click();
    return;
  }
  // 优先找尚未绑定账号的凭证，否则使用最后一个凭证
  const unboundClient = state.oauthClients.find(c => !c.boundEmail);
  const chosenClient = unboundClient || state.oauthClients[state.oauthClients.length - 1];
  await handleAuthorizeWithClient(chosenClient);
}

/* ==================== 左侧文件列表与右侧筛选控制 ==================== */

function parseKeywords(str = '') {
  return String(str)
    .toLowerCase()
    .split(/[\s,，;；]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function syncTypeDropdownUI() {
  const checks = document.querySelectorAll('#type-checkbox-list input[type="checkbox"]');
  checks.forEach(chk => {
    chk.checked = state.selectedTypeCats.has(chk.value);
  });
  const count = state.selectedTypeCats.size;
  $('type-dropdown-label').textContent =
    count === ALL_TYPE_CATS.length ? `全部类型 (${count}/${ALL_TYPE_CATS.length})` : `已选类型 (${count}/${ALL_TYPE_CATS.length})`;
}

function syncQuickExcludeButtons() {
  const exTerms = new Set(parseKeywords($('file-exclude-search')?.value || ''));
  document.querySelectorAll('.quick-kw-btn').forEach(btn => {
    const kw = (btn.dataset.exKw || '').toLowerCase();
    btn.classList.toggle('active', exTerms.has(kw));
  });
}

function renderSavedPresetsBar() {
  const bar = $('saved-presets-bar');
  if (!state.filterPresets.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = state.filterPresets
    .map(
      p => `<span class="preset-pill" data-action="apply-preset" data-preset-id="${escapeHtml(p.id)}">
        <span>${escapeHtml(p.name)}</span>
        <button type="button" class="del-preset" data-action="delete-preset" data-preset-id="${escapeHtml(p.id)}">×</button>
      </span>`
    )
    .join('');
}

function buildCoreNameCounts(files) {
  const counts = new Map();
  for (const f of files) {
    const core = extractCoreFileName(f.name || '');
    counts.set(core, (counts.get(core) || 0) + 1);
  }
  return counts;
}

function getFilteredFiles() {
  const baseFiles = getScopedFilesByAccount();
  const contactLookup = buildContactLookup(state.directory);
  const coreCounts = buildCoreNameCounts(baseFiles);

  const includeTerms = parseKeywords($('file-search')?.value || '');
  const matchMode = $('search-match-mode')?.value || 'or';
  const excludeTerms = parseKeywords($('file-exclude-search')?.value || '');

  const groupFilter = $('file-group-filter')?.value || 'all';
  const patternMode = $('file-name-pattern')?.value || 'default';
  const statusFilter = $('file-status-filter')?.value || 'all';
  const hidePrivate = $('hide-private')?.checked || false;

  let result = baseFiles.filter(file => {
    const evalStat = evaluateFile(file, state.policy, file.ownerAccount);
    const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
    const detCat = fileDetailedCategory(file.mimeType, file.name);
    const coreName = extractCoreFileName(file.name || '');

    if (state.coreNameFilter && coreName !== state.coreNameFilter) return false;
    if (hidePrivate && !evalStat.hasNonOwner) return false;

    // 文件类型下拉勾选过滤
    if (!state.selectedTypeCats.has(detCat)) return false;

    // 权限状态过滤
    if (statusFilter === 'anomaly' && !evalStat.hasActionableViolation) return false;
    if (statusFilter === 'unauthorized' && evalStat.removeCount === 0) return false;
    if (statusFilter === 'overprivileged' && evalStat.downgradeCount === 0) return false;
    if (statusFilter === 'public' && !evalStat.hasPublic) return false;
    if (statusFilter === 'shared' && !evalStat.hasNonOwner) return false;
    if (statusFilter === 'new' && !isNew) return false;

    // 邮箱分组覆盖过滤
    if (groupFilter !== 'all') {
      const cov = getFileGroupCoverage(file, state.directory);
      if (groupFilter === '__partial__') {
        if (!cov.some(c => c.status === 'partial')) return false;
      } else if (groupFilter.startsWith('grp:')) {
        const gName = groupFilter.slice(4);
        if (!cov.some(c => c.groupName === gName)) return false;
      }
    }

    if (patternMode === 'duplicates_only' && (coreCounts.get(coreName) || 0) < 2) return false;
    if (patternMode === 'messy_only' && !analyzeMessyFileName(file.name || '').isMessy) return false;

    const fileNameLower = (file.name || '').toLowerCase();
    if (excludeTerms.length > 0 && excludeTerms.some(term => fileNameLower.includes(term))) {
      return false;
    }

    if (includeTerms.length > 0) {
      const cov = getFileGroupCoverage(file, state.directory);
      const searchableChunks = [
        fileNameLower,
        coreName,
        (file.id || '').toLowerCase(),
        (file.ownerAccount || '').toLowerCase(),
        ...cov.map(c => c.groupName.toLowerCase()),
        ...(file.permissions || []).map(p => {
          const em = normalizeEntry(p.emailAddress || '');
          const contact = contactLookup.get(em);
          return [
            em,
            (p.displayName || '').toLowerCase(),
            (p.domain || '').toLowerCase(),
            (contact?.name || '').toLowerCase(),
            ...(contact?.groups || []).map(g => g.toLowerCase())
          ].join(' ');
        })
      ];
      const fullSearchText = searchableChunks.join(' ');
      const checkSingleTerm = term =>
        matchMode === 'fuzzy' ? fuzzyMatchTerm(fullSearchText, term) : fullSearchText.includes(term);

      if (matchMode === 'and' ? !includeTerms.every(checkSingleTerm) : !includeTerms.some(checkSingleTerm)) {
        return false;
      }
    }

    return true;
  });

  if (patternMode === 'cluster_sort' || patternMode === 'duplicates_only') {
    result = [...result].sort((a, b) => {
      const ca = extractCoreFileName(a.name || '');
      const cb = extractCoreFileName(b.name || '');
      const countDiff = (coreCounts.get(cb) || 0) - (coreCounts.get(ca) || 0);
      if (countDiff !== 0) return countDiff;
      const cmp = ca.localeCompare(cb, 'zh-CN');
      if (cmp !== 0) return cmp;
      return String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''));
    });
  }

  return result;
}

/* ==================== 左侧文件与权限表格渲染 ==================== */

function renderPermissionChip(fileId, perm, ownerAccount = '') {
  const evalResult = evaluatePermission(perm, state.policy, ownerAccount);
  const contactLookup = buildContactLookup(state.directory);
  const label = escapeHtml(permissionLabel(perm, contactLookup));
  const inherited = permIsInherited(perm);

  if (evalResult.status === 'owner') {
    return `<span class="perm-chip owner" title="文件所有者">👑 ${label}</span>`;
  }

  let chipClass = evalResult.status || 'compliant';
  if (inherited && evalResult.inheritedViolation) {
    chipClass = 'inherited';
  }

  const roleSelect = inherited
    ? `<span class="muted">(${escapeHtml(roleLabel(perm.role))}·继承)</span>`
    : `<select class="perm-select" data-action="change-role" data-file-id="${escapeHtml(fileId)}" data-perm-id="${escapeHtml(perm.id)}">
        <option value="writer" ${perm.role === 'writer' || perm.role === 'organizer' || perm.role === 'fileOrganizer' ? 'selected' : ''}>可编辑</option>
        <option value="commenter" ${perm.role === 'commenter' ? 'selected' : ''}>可评论</option>
        <option value="reader" ${perm.role === 'reader' ? 'selected' : ''}>仅查看</option>
      </select>`;

  const quickTrustBtn =
    (perm.type === 'user' || perm.type === 'group') &&
    perm.emailAddress &&
    (evalResult.status === 'violation_remove' || evalResult.status === 'violation_downgrade')
      ? `<button type="button" class="chip-btn" data-action="quick-trust" data-email="${escapeHtml(perm.emailAddress)}" data-role="${escapeHtml(perm.role)}" title="加入对应白名单">+白名单</button>`
      : '';

  const removeBtn = inherited
    ? ''
    : `<button type="button" class="chip-btn remove" data-action="remove-perm" data-file-id="${escapeHtml(fileId)}" data-perm-id="${escapeHtml(perm.id)}" title="移除该权限">×</button>`;

  return `<span class="perm-chip ${chipClass}" title="${escapeHtml(evalResult.reason || '')}">
    <span>${label}</span>
    ${roleSelect}
    ${quickTrustBtn}
    ${removeBtn}
  </span>`;
}

const PUBLIC_LINK_DROPDOWN_SOURCE = [
  { id: 'anyone_off', name: '🔒 受限 (仅指定邮箱)' },
  { id: 'anyone_reader', name: '🌐 任何人可查看' },
  { id: 'anyone_commenter', name: '🌐 任何人可评论' },
  { id: 'anyone_writer', name: '🌐 任何人可编辑' }
];

function getFilePublicModeId(file) {
  const perms = file?.permissions || [];
  const anyone = perms.find(p => p.type === 'anyone');
  if (!anyone) return 'anyone_off';
  if (anyone.role === 'writer' || anyone.role === 'organizer' || anyone.role === 'fileOrganizer') {
    return 'anyone_writer';
  }
  if (anyone.role === 'commenter') return 'anyone_commenter';
  return 'anyone_reader';
}

function summarizeFileCollaborators(file, ownerEmail = '') {
  if (file?.permissionsLoading) return '⏳ 正在读取权限…';
  if (file?.permissionError) return `❌ ${file.permissionError}`;
  const perms = file?.permissions || [];
  const nonOwners = perms.filter(
    p => p.role !== 'owner' && normalizeEntry(p.emailAddress || '') !== normalizeEntry(ownerEmail)
  );
  if (!nonOwners.length) return '仅自己 (0人)';
  let w = 0;
  let r = 0;
  for (const p of nonOwners) {
    if (p.role === 'reader' || p.role === 'commenter') r++;
    else w++;
  }
  return `共 ${nonOwners.length} 项 (编辑 ${w} / 查看 ${r})`;
}

function initSpreadsheets() {
  if (typeof jspreadsheet !== 'function') return;

  const scanHost = $('scan-spreadsheet-grid');
  if (scanHost && !state.scanSheet) {
    state.scanSheet = jspreadsheet(scanHost, {
      data: [[false, '-', '请先在右侧「设置」导入 OAuth JSON 授权后点击「立即扫描」', '', '', 'anyone_off', '', '']],
      columns: [
        { type: 'checkbox', title: '勾选', width: 44 },
        { type: 'text', title: '类型', width: 105, readOnly: true, align: 'left' },
        { type: 'text', title: '文件/文件夹名称', width: 240, readOnly: true, align: 'left' },
        { type: 'text', title: '我的权限 / 所属账号', width: 165, readOnly: true, align: 'left' },
        { type: 'text', title: '分组 / 合规状态', width: 155, readOnly: true, align: 'left' },
        { type: 'dropdown', title: '当前链接权限 (可下拉改)', width: 170, source: PUBLIC_LINK_DROPDOWN_SOURCE, align: 'left' },
        { type: 'text', title: '已授权统计', width: 155, readOnly: true, align: 'left' },
        { type: 'text', title: '链接 / 状态', width: 190, readOnly: true, align: 'left' }
      ],
      pagination: 100,
      paginationOptions: [50, 100, 200, 500],
      tableOverflow: true,
      tableWidth: '100%',
      tableHeight: '100%',
      allowInsertRow: false,
      allowInsertColumn: false,
      allowDeleteRow: false,
      allowDeleteColumn: false,
      columnSorting: true,
      onchange(instance, cell, x, y, value) {
        if (state.isUpdatingScanSheet) return;
        const col = Number(x);
        const row = Number(y);
        const fileId = state.scanSheetFileIds[row];
        if (!fileId) return;

        if (col === 0) {
          const checked = value === true || value === 'true' || value === '1' || value === 1;
          if (checked) state.selectedFileIds.add(fileId);
          else state.selectedFileIds.delete(fileId);
          const filtered = getFilteredFiles();
          $('selected-count').textContent = state.selectedFileIds.size;
          const selectAllEl = $('select-all');
          if (selectAllEl) {
            selectAllEl.checked = filtered.length > 0 && filtered.every(f => state.selectedFileIds.has(f.id));
          }
          updateBatchButtons();
        } else if (col === 5 && value) {
          handleScanSheetPublicChange(fileId, row, value);
        }
      }
    });
  }

  const batchHost = $('batch-links-spreadsheet-grid');
  if (batchHost && !state.batchLinksSheet) {
    const initialRows = Array.from({ length: 25 }, () => ['', '', '', '', '', '', '', '']);
    state.batchLinksSheet = jspreadsheet(batchHost, {
      data: initialRows,
      columns: [
        { type: 'text', title: 'A. 文件/文件夹链接 (Ctrl+V粘贴)', width: 235, align: 'left' },
        { type: 'text', title: 'B. 目标邮箱 (可选·可粘贴)', width: 185, align: 'left' },
        { type: 'text', title: 'C. 类型', width: 100, readOnly: true, align: 'left' },
        { type: 'text', title: 'D. 文件/文件夹名称', width: 195, readOnly: true, align: 'left' },
        { type: 'text', title: 'E. 我对它的权限', width: 135, readOnly: true, align: 'left' },
        { type: 'dropdown', title: 'F. 当前链接权限 (可下拉改)', width: 170, source: PUBLIC_LINK_DROPDOWN_SOURCE, align: 'left' },
        { type: 'text', title: 'G. 已授权人数', width: 150, readOnly: true, align: 'left' },
        { type: 'text', title: 'H. 执行状态 / 结果', width: 185, readOnly: true, align: 'left' }
      ],
      minDimensions: [8, 25],
      tableOverflow: true,
      tableWidth: '100%',
      tableHeight: '100%',
      allowInsertColumn: false,
      allowDeleteColumn: false,
      onchange(instance, cell, x, y, value) {
        if (state.isUpdatingBatchSheet) return;
        const col = Number(x);
        const row = Number(y);
        if (col === 0 || col === 1) {
          syncBatchSheetToInputs();
        } else if (col === 5 && value) {
          const rows = state.batchLinksSheet.getData();
          const rawLink = rows[row]?.[0] || '';
          const parsedIds = parseDriveLinksInput(rawLink);
          if (parsedIds.length > 0) {
            handleBatchRowPublicModeChange(parsedIds[0], row, value);
          }
        }
      },
      onpaste() {
        if (!state.isUpdatingBatchSheet) {
          setTimeout(syncBatchSheetToInputs, 20);
        }
      }
    });
  }
}

async function handleScanSheetPublicChange(fileId, rowIndex, publicMode) {
  if (!fileId || !state.scanSheet) return;
  try {
    state.isUpdatingScanSheet = true;
    state.scanSheet.setValueFromCoords(7, rowIndex, '⏳ 正在修改公开权限…', true);
    state.isUpdatingScanSheet = false;

    await executeBatchLinksPublicAccess({
      fileIds: [fileId],
      publicMode,
      existingFiles: state.files,
      targetAccount: state.activeAccount
    });
    await saveCurrentFilesSnapshot();
    state.logs = await getAuditLogs();
    renderAll();
    toast('已更新该项的公开链接权限');
  } catch (err) {
    toast(`修改公开权限失败：${err.message}`);
    renderFilesTab();
  } finally {
    state.isUpdatingScanSheet = false;
  }
}

async function handleBatchRowPublicModeChange(fileId, rowIndex, publicMode) {
  if (!fileId || !state.batchLinksSheet) return;
  try {
    state.isUpdatingBatchSheet = true;
    state.batchLinksSheet.setValueFromCoords(7, rowIndex, '⏳ 正在修改公开权限…', true);
    state.isUpdatingBatchSheet = false;

    const res = await executeBatchLinksPublicAccess({
      fileIds: [fileId],
      publicMode,
      existingFiles: state.files,
      targetAccount: state.activeAccount
    });
    await saveCurrentFilesSnapshot();
    state.logs = await getAuditLogs();
    const item = res.results?.[0];
    state.isUpdatingBatchSheet = true;
    if (item?.ok) {
      if (item.fileName) state.batchLinksSheet.setValueFromCoords(3, rowIndex, item.fileName, true);
      state.batchLinksSheet.setValueFromCoords(7, rowIndex, `✅ ${item.status}`, true);
      toast(`已更新链接权限：${item.status}`);
    } else {
      state.batchLinksSheet.setValueFromCoords(7, rowIndex, `❌ ${item?.status || '修改失败'}`, true);
      toast(`修改失败：${item?.status || '未知错误'}`);
    }
  } catch (err) {
    state.isUpdatingBatchSheet = true;
    state.batchLinksSheet.setValueFromCoords(7, rowIndex, `❌ ${err.message}`, true);
    toast(`修改失败：${err.message}`);
  } finally {
    state.isUpdatingBatchSheet = false;
  }
}

function renderScanSpreadsheet(filtered = []) {
  if (!state.scanSheet) return;
  state.isUpdatingScanSheet = true;
  try {
    if (!filtered.length) {
      state.scanSheetFileIds = [];
      const emptyMsg =
        state.files.length === 0
          ? '请先在右侧「设置」中导入桌面 OAuth JSON 完成账号授权，然后点击右上角「立即扫描」'
          : '当前筛选条件下没有匹配的文件或文件夹';
      state.scanSheet.setData([[false, '-', emptyMsg, '', '', 'anyone_off', '', '']]);
      return;
    }

    state.scanSheetFileIds = filtered.map(f => f.id);
    const rows = filtered.map(file => {
      const ownerEmail = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
      const isSelected = state.selectedFileIds.has(file.id);
      const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
      const typeLabel = fileCategoryLabel(file.mimeType, file.name);
      const nameCell = `${isNew ? '[新] ' : ''}${file.name || '(无名称)'}`;

      let myAccessRole = '👑 所有者';
      if (file.ownedByMe === false) {
        if (file.capabilities?.canShare || file.capabilities?.canEdit) {
          myAccessRole = '✏️ 可编辑';
        } else if (file.capabilities?.canComment) {
          myAccessRole = '💬 可评论';
        } else {
          myAccessRole = '👁️ 仅查看';
        }
      }
      const ownerCell = ownerEmail ? `${myAccessRole} (${ownerEmail})` : myAccessRole;

      let statusText = '⏳ 待读取';
      if (!file.permissionsLoading) {
        const stat = evaluateFile(file, state.policy, ownerEmail);
        const coverages = getFileGroupCoverage(file, state.directory)
          .map(c => `${c.groupName}(${c.grantedCount}/${c.totalCount})`)
          .join(' ');
        const parts = [];
        if (coverages) parts.push(coverages);
        if (!stat.hasNonOwner && file.shared !== true) {
          parts.push('仅自己');
        } else {
          if (stat.removeCount > 0) parts.push(`违规:${stat.removeCount}`);
          if (stat.downgradeCount > 0) parts.push(`越权:${stat.downgradeCount}`);
          if (!stat.hasActionableViolation) parts.push('✓合规');
        }
        statusText = parts.join(' · ') || '✓合规';
      }

      const pubMode = getFilePublicModeId(file);
      const collabSummary = summarizeFileCollaborators(file, ownerEmail);
      const linkText = file.webViewLink || `https://drive.google.com/open?id=${file.id}`;

      return [isSelected, typeLabel, nameCell, ownerCell, statusText, pubMode, collabSummary, linkText];
    });

    state.scanSheet.setData(rows);
  } finally {
    state.isUpdatingScanSheet = false;
  }
}

function syncBatchSheetToInputs() {
  if (!state.batchLinksSheet) return;
  const rows = state.batchLinksSheet.getData() || [];
  const linksLines = [];
  const emailLines = [];
  for (const r of rows) {
    if (r[0] && String(r[0]).trim()) linksLines.push(String(r[0]).trim());
    if (r[1] && String(r[1]).trim()) emailLines.push(String(r[1]).trim());
  }
  const linksInput = $('batch-links-input');
  const emailsInput = $('batch-emails-input');
  if (linksInput) linksInput.value = linksLines.join('\n');
  if (emailsInput) emailsInput.value = emailLines.join('\n');

  const fileIds = parseDriveLinksInput(linksLines.join('\n'));
  const emails = parseEmailsInput(emailLines.join('\n'));
  if ($('batch-links-parsed-info')) {
    $('batch-links-parsed-info').textContent = `${fileIds.length} 链接 · ${emails.length} 邮箱`;
  }
  if ($('batch-links-count-label')) {
    $('batch-links-count-label').textContent = `已识别 ${fileIds.length} 个链接`;
  }
  if ($('batch-emails-count-label')) {
    $('batch-emails-count-label').textContent = `已识别 ${emails.length} 个邮箱`;
  }
}

function syncInputsToBatchSheet() {
  if (!state.batchLinksSheet) return;
  const linksLines = ($('batch-links-input')?.value || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  const emailLines = ($('batch-emails-input')?.value || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const curRows = state.batchLinksSheet.getData() || [];
  const totalRows = Math.max(25, linksLines.length, emailLines.length, curRows.length);
  const nextRows = Array.from({ length: totalRows }, (_, i) => {
    const prev = curRows[i] || ['', '', '', '', '', '', '', ''];
    return [
      linksLines[i] !== undefined ? linksLines[i] : '',
      emailLines[i] !== undefined ? emailLines[i] : '',
      linksLines[i] ? prev[2] || '' : '',
      linksLines[i] ? prev[3] || '' : '',
      linksLines[i] ? prev[4] || '' : '',
      linksLines[i] ? prev[5] || '' : '',
      linksLines[i] ? prev[6] || '' : '',
      linksLines[i] ? prev[7] || '' : ''
    ];
  });

  state.isUpdatingBatchSheet = true;
  try {
    state.batchLinksSheet.setData(nextRows);
  } finally {
    state.isUpdatingBatchSheet = false;
  }
  syncBatchSheetToInputs();
}

function renderFilesTab() {
  const filtered = getFilteredFiles();

  // 清理已不存在的选中项
  const validIds = new Set(state.files.map(f => f.id));
  for (const id of [...state.selectedFileIds]) {
    if (!validIds.has(id)) state.selectedFileIds.delete(id);
  }

  const curStatusFilter = $('file-status-filter')?.value || 'all';
  document.querySelectorAll('#summary .summary-card').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cardFilter === curStatusFilter);
  });

  $('filtered-count').textContent = filtered.length;
  $('selected-count').textContent = state.selectedFileIds.size;

  const selectAllEl = $('select-all');
  selectAllEl.disabled = filtered.length === 0;
  selectAllEl.checked = filtered.length > 0 && filtered.every(f => state.selectedFileIds.has(f.id));

  updateBatchButtons();
  renderScanSpreadsheet(filtered);
}

function updateBatchButtons() {
  const hasSelected = state.selectedFileIds.size > 0;
  const hasGroups = state.selectedBatchGroups.size > 0;

  $('batch-grant-groups').disabled = !hasSelected || !hasGroups;
  $('batch-keep-only-groups').disabled = !hasSelected || !hasGroups;
  $('batch-revoke-groups').disabled = !hasSelected || !hasGroups;

  $('batch-enforce').disabled = !hasSelected;
  $('batch-downgrade-all').disabled = !hasSelected;
  $('batch-remove-public').disabled = !hasSelected;
  $('batch-revoke-all').disabled = !hasSelected;
}

/* ==================== 分组下拉与人员标签页渲染 ==================== */

function renderGroupSelectorsAndBatchBar() {
  const groups = state.directory.groups || [];
  const contacts = state.directory.contacts || [];
  const groupCountMap = new Map();
  for (const g of groups) groupCountMap.set(g.name, 0);
  for (const c of contacts) {
    for (const gName of c.groups || []) {
      groupCountMap.set(gName, (groupCountMap.get(gName) || 0) + 1);
    }
  }

  // 1. #file-group-filter
  const fileGrpSel = $('file-group-filter');
  const prevFileGrp = fileGrpSel.value || 'all';
  fileGrpSel.innerHTML = [
    `<option value="all">全部邮箱分组</option>`,
    `<option value="__partial__">分组未完全覆盖 (缺人)</option>`,
    ...groups.map(
      g => `<option value="grp:${escapeHtml(g.name)}">${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人)</option>`
    )
  ].join('');
  if ([...fileGrpSel.options].some(o => o.value === prevFileGrp)) {
    fileGrpSel.value = prevFileGrp;
  }

  // 2. #batch-group-checkboxes
  const validGroupNames = new Set(groups.map(g => g.name));
  for (const gName of [...state.selectedBatchGroups]) {
    if (!validGroupNames.has(gName)) state.selectedBatchGroups.delete(gName);
  }
  const batchBox = $('batch-group-checkboxes');
  if (!groups.length) {
    batchBox.innerHTML = `<span class="muted" style="padding:4px;">暂无分组，请在「设置」中新建</span>`;
    $('batch-group-dropdown-label').textContent = '暂无分组 (0)';
  } else {
    batchBox.innerHTML = groups
      .map(
        g => `<label class="drop-item">
          <input type="checkbox" class="batch-grp-chk" value="${escapeHtml(g.name)}" ${state.selectedBatchGroups.has(g.name) ? 'checked' : ''}>
          <span>${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人 · 默认${g.defaultRole === 'writer' ? '可编辑' : '只读'})</span>
        </label>`
      )
      .join('');
    $('batch-group-dropdown-label').textContent =
      state.selectedBatchGroups.size > 0
        ? `已选分组: ${[...state.selectedBatchGroups].join(', ')}`
        : `请选择分组 (共${groups.length}组)`;
  }

  // 3. #collab-group-filter
  const collabGrpSel = $('collab-group-filter');
  const prevCollabGrp = collabGrpSel.value || 'all';
  collabGrpSel.innerHTML = [
    `<option value="all">查看全部人员的分组对应 (${contacts.length}人)</option>`,
    ...groups.map(
      g => `<option value="${escapeHtml(g.name)}">分组：${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人)</option>`
    )
  ].join('');
  if ([...collabGrpSel.options].some(o => o.value === prevCollabGrp)) {
    collabGrpSel.value = prevCollabGrp;
  }

  // 4. #import-target-group-select
  const impSel = $('import-target-group-select');
  const prevImp = impSel.value;
  impSel.innerHTML = [
    `<option value="">-- 按表格C列或暂不归组 --</option>`,
    ...groups.map(g => `<option value="${escapeHtml(g.name)}">归入：${escapeHtml(g.name)}</option>`)
  ].join('');
  if ([...impSel.options].some(o => o.value === prevImp)) {
    impSel.value = prevImp;
  }

  // 5. #settings-groups-list
  const settingsGrpList = $('settings-groups-list');
  settingsGrpList.innerHTML = groups.length
    ? groups
        .map(
          g => `<span class="account-pill">
            <span>${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人 · ${g.defaultRole === 'writer' ? '可编辑' : '只读'})</span>
            <button type="button" class="remove-acc" data-action="delete-group" data-group="${escapeHtml(g.name)}" title="删除该组">×</button>
          </span>`
        )
        .join('')
    : '<span class="muted">暂无分组</span>';

  // 6. #drive-sheet-picker
  const sheetPicker = $('drive-sheet-picker');
  const sheets = state.files.filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
  const prevSheet = sheetPicker.value;
  sheetPicker.innerHTML = [
    `<option value="">-- 或从已扫描的云端 Google 表格同步名单 (${sheets.length}) --</option>`,
    ...sheets.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
  ].join('');
  if ([...sheetPicker.options].some(o => o.value === prevSheet)) {
    sheetPicker.value = prevSheet;
  }

  // 7. #batch-links-fill-group（批量链接授权区的分组快捷带入）
  const fillGrpSel = $('batch-links-fill-group');
  if (fillGrpSel) {
    fillGrpSel.innerHTML = [
      `<option value="">+从分组带入邮箱…</option>`,
      ...groups.map(
        g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人)</option>`
      )
    ].join('');
  }

  updateBatchButtons();
}

function buildMergedPersonList() {
  const map = new Map();
  const contactLookup = buildContactLookup(state.directory);

  for (const c of state.directory.contacts || []) {
    const email = normalizeEntry(c.email);
    if (!email) continue;
    map.set(email, {
      email,
      name: c.name || '',
      groups: [...(c.groups || [])],
      inDirectory: true,
      fileCount: 0,
      writerCount: 0,
      readerCount: 0,
      overprivilegedCount: 0
    });
  }

  for (const file of getScopedFilesByAccount()) {
    const owner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    const seenInFile = new Set();
    for (const p of file.permissions || []) {
      if (p.role === 'owner' || (p.type !== 'user' && p.type !== 'group')) continue;
      const email = normalizeEntry(p.emailAddress || '');
      if (!email || email === owner) continue;

      if (!map.has(email)) {
        const contact = contactLookup.get(email);
        map.set(email, {
          email,
          name: contact?.name || p.displayName || '',
          groups: contact?.groups ? [...contact.groups] : [],
          inDirectory: Boolean(contact),
          fileCount: 0,
          writerCount: 0,
          readerCount: 0,
          overprivilegedCount: 0
        });
      }
      const item = map.get(email);
      if (!seenInFile.has(email)) {
        seenInFile.add(email);
        item.fileCount++;
      }
      if (p.role === 'reader') item.readerCount++;
      else item.writerCount++;

      const ev = evaluatePermission(p, state.policy, owner);
      if (ev.status === 'violation_downgrade') item.overprivilegedCount++;
    }
  }

  return [...map.values()].map(item => {
    const inW = matchesAllowlist(item.email, state.policy.writers);
    const inR = matchesAllowlist(item.email, state.policy.readers);
    return {
      ...item,
      inWriters: inW,
      inReaders: inR,
      isStranger: !inW && !inR
    };
  });
}

function renderCollaboratorsTab() {
  renderGroupSelectorsAndBatchBar();

  const selectedGroup = $('collab-group-filter')?.value || 'all';
  const summaryBar = $('selected-group-summary');
  if (selectedGroup === 'all') {
    summaryBar.classList.add('hidden');
    summaryBar.innerHTML = '';
  } else {
    const grpObj = (state.directory.groups || []).find(g => g.name === selectedGroup);
    const members = (state.directory.contacts || []).filter(c => (c.groups || []).includes(selectedGroup));
    summaryBar.classList.remove('hidden');
    summaryBar.innerHTML = `
      <span><strong>${escapeHtml(selectedGroup)}</strong>：共 ${members.length} 人（默认${grpObj?.defaultRole === 'writer' ? '可编辑' : '只读'}）</span>
      <div class="row-flex">
        <button type="button" class="btn btn-xs" data-action="group-sync-writers" data-group="${escapeHtml(selectedGroup)}">全组入编辑白名单</button>
        <button type="button" class="btn btn-xs" data-action="group-sync-readers" data-group="${escapeHtml(selectedGroup)}">全组入只读白名单</button>
      </div>
    `;
  }

  const query = ($('collab-search')?.value || '').trim().toLowerCase();
  const filterMode = $('collab-filter')?.value || 'all';
  const allGroups = state.directory.groups || [];

  const list = buildMergedPersonList()
    .filter(p => {
      if (selectedGroup !== 'all' && !p.groups.includes(selectedGroup)) return false;
      if (filterMode === 'in_directory' && !p.inDirectory) return false;
      if (filterMode === 'stranger' && !p.isStranger) return false;
      if (filterMode === 'overprivileged' && p.overprivilegedCount === 0) return false;
      if (filterMode === 'writer_list' && !p.inWriters) return false;
      if (filterMode === 'reader_list' && !p.inReaders) return false;
      if (!query) return true;
      return (
        p.email.includes(query) ||
        p.name.toLowerCase().includes(query) ||
        p.groups.some(g => g.toLowerCase().includes(query))
      );
    })
    .sort((a, b) => b.fileCount - a.fileCount || (a.name || a.email).localeCompare(b.name || b.email, 'zh-CN'));

  const tbody = $('collab-rows');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无匹配的人员数据</td></tr>';
    return;
  }

  tbody.innerHTML = list
    .map(p => {
      let tierBadge = `<span class="status-pill danger">非白名单</span>`;
      if (p.inWriters) tierBadge = `<span class="status-pill ok">允许编辑</span>`;
      else if (p.inReaders) tierBadge = `<span class="status-pill warning">仅限查看</span>`;

      const currentGrpTags = p.groups
        .map(
          g => `<span class="badge" style="margin:0 3px 3px 0;">
            ${escapeHtml(g)}
            <button type="button" class="btn-text" style="padding:0 2px;color:#dc2626;" data-action="remove-person-group" data-email="${escapeHtml(p.email)}" data-group="${escapeHtml(g)}" title="从该组移除">×</button>
          </span>`
        )
        .join('');

      const unjoinedGroups = allGroups.filter(g => !p.groups.includes(g.name));
      const addGrpSelect = unjoinedGroups.length
        ? `<select class="perm-select" data-action="add-person-group" data-email="${escapeHtml(p.email)}" data-name="${escapeHtml(p.name)}">
            <option value="">+归入组…</option>
            ${unjoinedGroups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('')}
          </select>`
        : '';

      return `<tr>
        <td>
          <div style="font-weight:600;">${escapeHtml(p.name || '未填姓名')}</div>
          <div class="muted">${escapeHtml(p.email)}</div>
        </td>
        <td>
          <div style="margin-bottom:3px;">${tierBadge}</div>
          <div>${currentGrpTags}${addGrpSelect}</div>
        </td>
        <td>
          <div><strong>${p.fileCount}</strong> 个文件</div>
          <div class="muted">编辑 ${p.writerCount} / 只读 ${p.readerCount}</div>
        </td>
        <td>
          <div class="row-actions">
            ${!p.inWriters ? `<button type="button" class="btn btn-xs" data-action="person-trust-writer" data-email="${escapeHtml(p.email)}">+允许编辑</button>` : ''}
            ${p.isStranger ? `<button type="button" class="btn btn-xs" data-action="person-trust-reader" data-email="${escapeHtml(p.email)}">+仅限查看</button>` : ''}
            ${p.writerCount > 0 ? `<button type="button" class="btn warning btn-xs" data-action="person-downgrade-all" data-email="${escapeHtml(p.email)}">全降只读</button>` : ''}
            ${p.fileCount > 0 ? `<button type="button" class="btn danger btn-xs" data-action="person-revoke-all" data-email="${escapeHtml(p.email)}">全部撤权</button>` : ''}
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

/* ==================== 设置与日志渲染 ==================== */

function renderPolicyTab() {
  const writers = state.policy.writers || [];
  const readers = state.policy.readers || [];

  $('writers-count').textContent = writers.length;
  $('readers-count').textContent = readers.length;

  $('writers-list').innerHTML = writers.length
    ? writers
        .map(
          item => `<div class="allow-item">
            <span>${escapeHtml(item)}</span>
            <button type="button" class="btn-text" style="color:#dc2626;" data-action="del-writer" data-val="${escapeHtml(item)}">移除</button>
          </div>`
        )
        .join('')
    : '<span class="muted">暂无允许编辑名单</span>';

  $('readers-list').innerHTML = readers.length
    ? readers
        .map(
          item => `<div class="allow-item">
            <span>${escapeHtml(item)}</span>
            <button type="button" class="btn-text" style="color:#dc2626;" data-action="del-reader" data-val="${escapeHtml(item)}">移除</button>
          </div>`
        )
        .join('')
    : '<span class="muted">暂无仅限查看名单</span>';

  $('policy-schedule-enabled').checked = Boolean(state.policy.scheduleEnabled);
  $('policy-schedule-minutes').value = String(state.policy.scheduleMinutes || 60);
  $('auto-enforce-select').value = state.policy.autoEnforce ? 'enforce' : 'alert';
  $('policy-public-rule').value = state.policy.publicLinkRule || 'forbid';
}

function renderLogsTab() {
  const filterVal = $('log-filter')?.value || 'all';
  const filtered = state.logs.filter(item => {
    if (filterVal === 'all') return true;
    return item.source === filterVal;
  });

  const tbody = $('log-rows');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无匹配的日志记录</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .slice(0, 150)
    .map(log => {
      const canRestore =
        !log.restored &&
        (log.actionType === 'revoke' || log.actionType === 'downgrade') &&
        log.fileId &&
        (log.targetEmail || log.domain || log.targetType === 'anyone');

      const actionHtml = log.restored
        ? '<span class="muted">已回滚</span>'
        : canRestore
        ? `<button type="button" class="btn btn-xs" data-action="restore-log" data-log-id="${escapeHtml(log.id)}">一键回滚</button>`
        : '<span class="muted">-</span>';

      return `<tr>
        <td>
          <div style="font-weight:600;">${escapeHtml(log.fileName || '-')}</div>
          <div class="muted">${escapeHtml(formatTime(log.timestamp))}</div>
        </td>
        <td>
          <div><strong>${escapeHtml(log.targetLabel || log.targetEmail || '-')}</strong></div>
          <div class="muted">${escapeHtml(log.message || '')}</div>
        </td>
        <td>${actionHtml}</td>
      </tr>`;
    })
    .join('');
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
}

function renderAll() {
  updateTopBadges();
  syncTypeDropdownUI();
  syncQuickExcludeButtons();
  renderSavedPresetsBar();
  renderGroupSelectorsAndBatchBar();
  renderFilesTab();
  renderCollaboratorsTab();
  renderPolicyTab();
  renderLogsTab();
}

async function importAllowlistFromObject(parsed) {
  if (!parsed) return;
  if (Array.isArray(parsed)) {
    state.policy = await savePolicy({
      writers: [...state.policy.writers, ...parsed.map(normalizeEntry)]
    });
  } else if (typeof parsed === 'object') {
    const nextWriters = [...state.policy.writers];
    const nextReaders = [...state.policy.readers];
    if (Array.isArray(parsed.writers)) nextWriters.push(...parsed.writers.map(normalizeEntry));
    if (Array.isArray(parsed.allowList)) nextWriters.push(...parsed.allowList.map(normalizeEntry));
    if (Array.isArray(parsed.readers)) nextReaders.push(...parsed.readers.map(normalizeEntry));

    state.policy = await savePolicy({
      writers: nextWriters,
      readers: nextReaders,
      publicLinkRule: parsed.publicLinkRule || state.policy.publicLinkRule
    });

    if (Array.isArray(parsed.groups) || Array.isArray(parsed.contacts)) {
      state.directory = await saveDirectory({
        groups: parsed.groups || state.directory.groups,
        contacts: parsed.contacts || state.directory.contacts
      });
    }
  }
  renderAll();
  toast('已成功导入白名单/分组配置');
}

async function importParsedContacts(rows) {
  if (!rows || !rows.length) {
    toast('未识别到有效邮箱（请确认包含邮箱列，如 A列姓名、B列邮箱）');
    return;
  }

  const nextContacts = [...(state.directory.contacts || [])];
  for (const r of rows) {
    nextContacts.push({
      email: r.email,
      name: r.name || '',
      groups: r.group ? [r.group] : []
    });
  }

  state.directory = await saveDirectory({
    groups: state.directory.groups,
    contacts: nextContacts
  });
  state.policy = await getPolicy();
  renderAll();
  toast(`已成功导入 ${rows.length} 条人员邮箱记录`);
}

/* ==================== 扫描、批量执行与单项权限操作 ==================== */

async function handleScan(targetAccount = state.activeAccount, overrideScope = '') {
  const scanBtn = $('scan');
  const customScanBtn = $('scan-custom-folders-btn');
  const scanScope = overrideScope || $('scan-scope-select')?.value || 'all_drive';
  let customFolderIds = [];
  const recursive = Boolean($('custom-folders-recursive')?.checked ?? true);

  if (scanScope === 'custom_folders') {
    $('custom-folders-scan-bar')?.classList.remove('hidden');
    customFolderIds = parseDriveLinksInput($('custom-folders-input')?.value || '');
    if (!customFolderIds.length) {
      $('custom-folders-input')?.focus?.();
      toast('请先在上方输入框粘贴 1 个或多个 Google Drive 文件夹链接或文件夹 ID');
      return;
    }
  }

  scanBtn.disabled = true;
  if (customScanBtn) customScanBtn.disabled = true;
  $('progress').textContent =
    scanScope === 'custom_folders'
      ? `正在扫描指定的 ${customFolderIds.length} 个文件夹…`
      : '正在启动全网盘极速扫描…';

  try {
    const res = await runFullScan({
      interactive: true,
      source: 'manual',
      targetAccount: targetAccount || 'all',
      scanScope,
      customFolderIds,
      recursive,
      onProgress(info) {
        if (info?.message) $('progress').textContent = info.message;
      },
      onPartialFiles(liveFiles) {
        state.files = liveFiles;
        updateTopBadges();
        renderFilesTab();
      }
    });
    state.accounts = res.accounts;
    state.oauthClients = await getOAuthClients();
    state.policy = res.policy;
    state.files = res.snapshot.files || [];
    state.newFileIds = new Set(res.snapshot.newFileIds || []);
    state.lastScanAt = res.snapshot.lastScanAt || '';
    state.selectedFileIds.clear();
    const folderCount = state.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder').length;
    $('progress').textContent = `扫描完成：共 ${state.files.length} 项（文件夹 ${folderCount} 个 / 新增 ${res.newlyDiscoveredCount} 项）`;
    renderAll();
    toast(`扫描完成：共 ${state.files.length} 项（含 ${folderCount} 个文件夹）`);
  } catch (error) {
    $('progress').textContent = `扫描失败：${error.message}`;
    toast(`扫描失败：${error.message}`);
  } finally {
    scanBtn.disabled = false;
    if (customScanBtn) customScanBtn.disabled = false;
  }
}

async function saveCurrentFilesSnapshot() {
  const prev = await getSnapshot();
  await saveSnapshot({
    ...prev,
    files: state.files,
    newFileIds: [...state.newFileIds]
  });
}

async function handleEnforceFiles(targetFiles) {
  const actionable = (targetFiles || []).filter(
    f => evaluateFile(f, state.policy, f.ownerAccount).hasActionableViolation
  );
  if (!actionable.length) {
    toast('所选文件均符合当前白名单策略，无需处理');
    return;
  }

  let rmTotal = 0;
  let downTotal = 0;
  for (const f of actionable) {
    const st = evaluateFile(f, state.policy, f.ownerAccount);
    rmTotal += st.removeCount;
    downTotal += st.downgradeCount;
  }

  if (
    !confirm(
      `确认对 ${actionable.length} 个文件按白名单修正？\n• 移除非白名单权限：${rmTotal} 项\n• 越权编辑降为只读：${downTotal} 项`
    )
  ) {
    return;
  }

  $('progress').textContent = '正在执行白名单合规修正…';
  try {
    const res = await enforceFilesByPolicy(null, actionable, state.policy, '', 'manual', p => {
      $('progress').textContent = `正在修正 ${p.done}/${p.total}…`;
    });
    await saveCurrentFilesSnapshot();
    state.logs = await getAuditLogs();
    $('progress').textContent = `修正完成：移除 ${res.removed} 项，降为只读 ${res.downgraded} 项，失败 ${res.failed} 项`;
    renderAll();
    toast(`修正完成：移除 ${res.removed} 项，降为只读 ${res.downgraded} 项`);
  } catch (error) {
    toast(`执行失败：${error.message}`);
  }
}

async function handleGroupBatchOperation(mode) {
  const targetFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  const groupNames = [...state.selectedBatchGroups];
  if (!targetFiles.length || !groupNames.length) {
    toast('请先勾选左侧文件并选择至少一个目标分组');
    return;
  }

  const roleOption = $('batch-group-role')?.value || 'group_default';
  const modeTitle =
    mode === 'grant'
      ? '开通所选分组权限'
      : mode === 'keep_only_groups'
      ? '仅保留所选分组（移除组外人员）'
      : '移除所选分组权限';

  if (!confirm(`确认对已勾选的 ${targetFiles.length} 个文件执行「${modeTitle}」？\n目标分组：${groupNames.join('、')}`)) {
    return;
  }

  $('progress').textContent = `正在执行分组批量操作…`;
  try {
    const res = await executeGroupBatchOnFiles({
      files: targetFiles,
      groupNames,
      mode,
      roleOption,
      directory: state.directory,
      onProgress(p) {
        $('progress').textContent = `正在处理分组权限 ${p.done}/${p.total}…`;
      }
    });
    await saveCurrentFilesSnapshot();
    state.logs = await getAuditLogs();
    $('progress').textContent = `分组操作完成：新增 ${res.createdCount}，调整 ${res.updatedCount}，移除 ${res.removedCount}`;
    renderAll();
    toast(`分组操作完成：新增 ${res.createdCount}，调整 ${res.updatedCount}，移除 ${res.removedCount}`);
  } catch (error) {
    toast(`分组操作失败：${error.message}`);
  }
}

async function handleBatchQuickAction(actionType) {
  const targetFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!targetFiles.length) return;

  const titleMap = {
    downgrade_all: '将所选文件的全部协作者降为只读',
    remove_public: '关闭所选文件的公开/域内共享链接',
    revoke_all: '清空所选文件的所有非所有者权限'
  };
  if (!confirm(`确认对已勾选的 ${targetFiles.length} 个文件执行：\n「${titleMap[actionType]}」？`)) return;

  let okCount = 0;
  let failCount = 0;
  const newLogs = [];

  for (let i = 0; i < targetFiles.length; i++) {
    const file = targetFiles[i];
    const owner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
    $('progress').textContent = `正在处理 (${i + 1}/${targetFiles.length}): ${file.name}`;

    try {
      const token = await resolveTokenForFile(file, i === 0);
      const perms = [...(file.permissions || [])];
      for (const p of perms) {
        if (p.role === 'owner' || permIsInherited(p)) continue;

        if (actionType === 'downgrade_all' && p.role !== 'reader') {
          const prevRole = p.role;
          await updatePermissionRole(token, file.id, p.id, 'reader');
          p.role = 'reader';
          okCount++;
          newLogs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'downgrade',
            accountEmail: owner,
            fileId: file.id,
            fileName: file.name,
            permissionId: p.id,
            targetType: p.type,
            targetEmail: p.emailAddress || '',
            targetLabel: permissionLabel(p),
            previousRole: prevRole,
            newRole: 'reader',
            restored: false,
            message: `批量降为只读（原角色：${roleLabel(prevRole)}）`
          });
        } else if (actionType === 'remove_public' && (p.type === 'anyone' || p.type === 'domain')) {
          await deletePermission(token, file.id, p.id);
          file.permissions = (file.permissions || []).filter(x => x.id !== p.id);
          okCount++;
          newLogs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: owner,
            fileId: file.id,
            fileName: file.name,
            permissionId: p.id,
            targetType: p.type,
            domain: p.domain || '',
            targetLabel: permissionLabel(p),
            previousRole: p.role,
            restored: false,
            message: `批量关闭公开/域内链接`
          });
        } else if (actionType === 'revoke_all') {
          await deletePermission(token, file.id, p.id);
          file.permissions = (file.permissions || []).filter(x => x.id !== p.id);
          okCount++;
          newLogs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: owner,
            fileId: file.id,
            fileName: file.name,
            permissionId: p.id,
            targetType: p.type,
            targetEmail: p.emailAddress || '',
            domain: p.domain || '',
            targetLabel: permissionLabel(p),
            previousRole: p.role,
            restored: false,
            message: `批量清空共享权限`
          });
        }
      }
    } catch (_e) {
      failCount++;
    }
  }

  await saveCurrentFilesSnapshot();
  if (newLogs.length) await appendAuditLogs(newLogs);
  state.logs = await getAuditLogs();
  $('progress').textContent = `批量处理完成：成功 ${okCount} 项，失败 ${failCount} 项`;
  renderAll();
  toast(`处理完成：成功 ${okCount} 项`);
}

async function handleInlineRoleChange(fileId, permId, newRole) {
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;

  const prevRole = perm.role;
  try {
    const token = await resolveTokenForFile(file, true);
    await updatePermissionRole(token, fileId, permId, newRole);
    perm.role = newRole;
    await saveCurrentFilesSnapshot();
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'downgrade',
      accountEmail: file.ownerAccount || '',
      fileId,
      fileName: file.name,
      permissionId: permId,
      targetType: perm.type,
      targetEmail: perm.emailAddress || '',
      targetLabel: permissionLabel(perm),
      previousRole: prevRole,
      newRole,
      restored: false,
      message: `手动修改角色：${roleLabel(prevRole)} → ${roleLabel(newRole)}`
    });
    state.logs = await getAuditLogs();
    renderAll();
    toast(`已将 ${permissionLabel(perm)} 设为 ${roleLabel(newRole)}`);
  } catch (error) {
    toast(`修改角色失败：${error.message}`);
    renderFilesTab();
  }
}

async function handleRemoveSinglePerm(fileId, permId) {
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;

  try {
    const token = await resolveTokenForFile(file, true);
    await deletePermission(token, fileId, permId);
    file.permissions = (file.permissions || []).filter(p => p.id !== permId);
    await saveCurrentFilesSnapshot();
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'revoke',
      accountEmail: file.ownerAccount || '',
      fileId,
      fileName: file.name,
      permissionId: permId,
      targetType: perm.type,
      targetEmail: perm.emailAddress || '',
      domain: perm.domain || '',
      targetLabel: permissionLabel(perm),
      previousRole: perm.role,
      restored: false,
      message: `手动移除权限（原角色：${roleLabel(perm.role)}）`
    });
    state.logs = await getAuditLogs();
    renderAll();
    toast(`已移除 ${permissionLabel(perm)}`);
  } catch (error) {
    toast(`移除失败：${error.message}`);
  }
}

async function handleAddSinglePermPrompt(fileId) {
  const file = state.files.find(f => f.id === fileId);
  if (!file) return;
  const email = normalizeEntry(prompt(`为《${file.name}》添加协作者邮箱：`) || '');
  if (!email || !email.includes('@')) return;
  const roleInput = (prompt('请输入角色：writer (可编辑) 或 reader (仅查看)', 'reader') || 'reader').trim();
  const role = roleInput === 'writer' ? 'writer' : 'reader';

  try {
    const token = await resolveTokenForFile(file, true);
    const created = await createPermission(token, file.id, { type: 'user', role, emailAddress: email });
    file.permissions = file.permissions || [];
    file.permissions.push({
      id: created?.id || `perm-${Date.now()}`,
      type: 'user',
      role,
      emailAddress: email
    });
    await saveCurrentFilesSnapshot();
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'grant',
      accountEmail: file.ownerAccount || '',
      fileId: file.id,
      fileName: file.name,
      permissionId: created?.id || '',
      targetType: 'user',
      targetEmail: email,
      targetLabel: email,
      newRole: role,
      restored: false,
      message: `手动授予 ${roleLabel(role)} 权限`
    });
    state.logs = await getAuditLogs();
    renderAll();
    toast(`已为《${file.name}》添加 ${email}`);
  } catch (error) {
    toast(`添加失败：${error.message}`);
  }
}


async function handlePersonBatchOp(email, mode) {
  const targetEmail = normalizeEntry(email);
  const tasks = [];

  for (const file of getScopedFilesByAccount()) {
    for (const p of file.permissions || []) {
      if (p.role === 'owner' || permIsInherited(p)) continue;
      if (normalizeEntry(p.emailAddress) === targetEmail) {
        if (mode === 'revoke' || (mode === 'downgrade' && p.role !== 'reader')) {
          tasks.push({ file, perm: p });
        }
      }
    }
  }

  if (!tasks.length) {
    toast('该人员在当前文件范围内无可处理的直接权限');
    return;
  }

  const label = mode === 'revoke' ? '全部撤权' : '全部降为只读';
  if (!confirm(`确认对 ${targetEmail} 涉及的 ${tasks.length} 处权限执行「${label}」？`)) return;

  let ok = 0;
  const newLogs = [];
  for (let i = 0; i < tasks.length; i++) {
    const { file, perm } = tasks[i];
    $('progress').textContent = `正在处理 (${i + 1}/${tasks.length}): ${file.name}`;
    try {
      const token = await resolveTokenForFile(file, i === 0);
      if (mode === 'revoke') {
        await deletePermission(token, file.id, perm.id);
        file.permissions = (file.permissions || []).filter(x => x.id !== perm.id);
        newLogs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'revoke',
          accountEmail: file.ownerAccount || '',
          fileId: file.id,
          fileName: file.name,
          permissionId: perm.id,
          targetType: perm.type,
          targetEmail,
          targetLabel: targetEmail,
          previousRole: perm.role,
          restored: false,
          message: `按人员批量撤权（原角色：${roleLabel(perm.role)}）`
        });
      } else {
        const prevRole = perm.role;
        await updatePermissionRole(token, file.id, perm.id, 'reader');
        perm.role = 'reader';
        newLogs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'downgrade',
          accountEmail: file.ownerAccount || '',
          fileId: file.id,
          fileName: file.name,
          permissionId: perm.id,
          targetType: perm.type,
          targetEmail,
          targetLabel: targetEmail,
          previousRole: prevRole,
          newRole: 'reader',
          restored: false,
          message: `按人员批量降为只读（原角色：${roleLabel(prevRole)}）`
        });
      }
      ok++;
    } catch (_e) {
      // ignore single failure
    }
  }

  await saveCurrentFilesSnapshot();
  if (newLogs.length) await appendAuditLogs(newLogs);
  state.logs = await getAuditLogs();
  $('progress').textContent = `已完成 ${targetEmail} 的 ${ok}/${tasks.length} 项权限处理`;
  renderAll();
  toast(`已处理 ${ok} 项权限`);
}

async function handleRestoreLog(logId) {
  const log = state.logs.find(l => l.id === logId);
  if (!log || log.restored || !log.fileId) return;

  try {
    const file = state.files.find(f => f.id === log.fileId) || {
      id: log.fileId,
      name: log.fileName,
      ownerAccount: log.accountEmail
    };
    const token = await resolveTokenForFile(file, true);
    const restoreRole = log.previousRole || 'reader';

    if (log.actionType === 'downgrade' && log.permissionId) {
      await updatePermissionRole(token, log.fileId, log.permissionId, restoreRole);
      const perm = file.permissions?.find(p => p.id === log.permissionId);
      if (perm) perm.role = restoreRole;
    } else {
      const created = await createPermission(token, log.fileId, {
        type: log.targetType || 'user',
        role: restoreRole,
        emailAddress: log.targetEmail || undefined,
        domain: log.domain || undefined
      });
      if (file.permissions) {
        file.permissions.push({
          id: created?.id || `restored-${Date.now()}`,
          type: log.targetType || 'user',
          role: restoreRole,
          emailAddress: log.targetEmail || '',
          domain: log.domain || ''
        });
      }
    }

    await saveCurrentFilesSnapshot();
    state.logs = await markAuditLogRestored(logId);
    renderAll();
    toast(`已回滚恢复 ${log.targetLabel || log.targetEmail} 的 ${roleLabel(restoreRole)} 权限`);
  } catch (error) {
    toast(`回滚失败：${error.message}`);
  }
}

function exportCsv() {
  const scoped = getScopedFilesByAccount();
  if (!scoped.length) return;
  const contactLookup = buildContactLookup(state.directory);
  const rows = [
    [
      'File ID',
      'File Name',
      'Core Series',
      'Category',
      'Owner Account',
      'Group Coverage',
      'Permission ID',
      'Role',
      'Type',
      'Email/Domain',
      'Contact Name',
      'Status',
      'Reason'
    ]
  ];

  for (const file of scoped) {
    const core = extractCoreFileName(file.name || '');
    const cat = fileDetailedCategory(file.mimeType, file.name);
    const owner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
    const covStr = getFileGroupCoverage(file, state.directory)
      .map(c => `${c.groupName}(${c.grantedCount}/${c.totalCount})`)
      .join('; ');

    for (const p of file.permissions || []) {
      const ev = evaluatePermission(p, state.policy, owner);
      const contact = contactLookup.get(normalizeEntry(p.emailAddress || ''));
      rows.push([
        file.id,
        file.name,
        core,
        cat,
        owner,
        covStr,
        p.id,
        p.role,
        p.type,
        p.emailAddress || p.domain || '',
        contact?.name || p.displayName || '',
        ev.status,
        ev.reason
      ]);
    }
  }

  const csvContent = rows
    .map(r => r.map(c => `"${String(c ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drive-permissions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportPolicyAndDirectoryJson() {
  const payload = {
    writers: state.policy.writers,
    readers: state.policy.readers,
    publicLinkRule: state.policy.publicLinkRule,
    scheduleEnabled: state.policy.scheduleEnabled,
    scheduleMinutes: state.policy.scheduleMinutes,
    autoEnforce: state.policy.autoEnforce,
    groups: state.directory.groups,
    contacts: state.directory.contacts
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'drive-policy-and-groups.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function syncPolicyAndSchedule(partial) {
  state.policy = await savePolicy(partial);
  try {
    await chrome.runtime.sendMessage({ type: 'SYNC_SCHEDULE' });
  } catch (_e) {
    // ignore in tests
  }
  renderAll();
}


/* ==================== 初始化与全局事件绑定 ==================== */

async function init() {
  initSpreadsheets();

  // 1. 立即绑定右侧标签页切换与左侧主工作区标签页切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  document.querySelectorAll('.left-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.leftTab;
      document.querySelectorAll('.left-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.leftTab === targetTab);
      });
      document.querySelectorAll('.left-tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `left-panel-${targetTab}`);
      });
    });
  });

  // 2. 下拉多选菜单（文件类型 & 批量分组）展开/收起与全选/反选
  $('type-dropdown-btn').addEventListener('click', e => {
    e.stopPropagation();
    $('batch-group-dropdown-menu').classList.add('hidden');
    $('type-dropdown-menu').classList.toggle('hidden');
  });

  $('batch-group-dropdown-btn').addEventListener('click', e => {
    e.stopPropagation();
    $('type-dropdown-menu').classList.add('hidden');
    $('batch-group-dropdown-menu').classList.toggle('hidden');
  });

  $('type-dropdown-menu').addEventListener('click', e => e.stopPropagation());
  $('batch-group-dropdown-menu').addEventListener('click', e => e.stopPropagation());

  document.addEventListener('click', () => {
    $('type-dropdown-menu')?.classList.add('hidden');
    $('batch-group-dropdown-menu')?.classList.add('hidden');
  });

  $('type-checkbox-list').addEventListener('change', e => {
    const chk = e.target.closest('input[type="checkbox"]');
    if (!chk) return;
    if (chk.checked) state.selectedTypeCats.add(chk.value);
    else state.selectedTypeCats.delete(chk.value);
    syncTypeDropdownUI();
    renderFilesTab();
  });

  $('type-select-all').addEventListener('click', () => {
    state.selectedTypeCats = new Set(ALL_TYPE_CATS);
    syncTypeDropdownUI();
    renderFilesTab();
  });

  $('type-invert-select').addEventListener('click', () => {
    const next = new Set();
    for (const cat of ALL_TYPE_CATS) {
      if (!state.selectedTypeCats.has(cat)) next.add(cat);
    }
    state.selectedTypeCats = next;
    syncTypeDropdownUI();
    renderFilesTab();
  });

  $('batch-group-checkboxes').addEventListener('change', e => {
    const chk = e.target.closest('.batch-grp-chk');
    if (!chk) return;
    if (chk.checked) state.selectedBatchGroups.add(chk.value);
    else state.selectedBatchGroups.delete(chk.value);
    renderGroupSelectorsAndBatchBar();
  });

  $('batch-grp-select-all').addEventListener('click', () => {
    for (const g of state.directory.groups || []) state.selectedBatchGroups.add(g.name);
    renderGroupSelectorsAndBatchBar();
  });

  $('batch-grp-invert').addEventListener('click', () => {
    const next = new Set();
    for (const g of state.directory.groups || []) {
      if (!state.selectedBatchGroups.has(g.name)) next.add(g.name);
    }
    state.selectedBatchGroups = next;
    renderGroupSelectorsAndBatchBar();
  });

  // 3. 顶部栏按钮与账号切换 & 指定文件夹扫描栏
  $('scan').addEventListener('click', () => handleScan(state.activeAccount));
  $('export').addEventListener('click', exportCsv);
  $('quick-enforce-all').addEventListener('click', () => handleEnforceFiles(getScopedFilesByAccount()));

  const updateCustomFoldersBadge = () => {
    const ids = parseDriveLinksInput($('custom-folders-input')?.value || '');
    if ($('custom-folders-count-badge')) {
      $('custom-folders-count-badge').textContent = `已识别 ${ids.length} 个文件夹ID`;
    }
  };

  $('scan-scope-select')?.addEventListener('change', e => {
    const isCustom = e.target.value === 'custom_folders';
    $('custom-folders-scan-bar')?.classList.toggle('hidden', !isCustom);
    if (isCustom) {
      $('custom-folders-input')?.focus?.();
    }
  });

  $('toggle-custom-folder-bar-btn')?.addEventListener('click', () => {
    const bar = $('custom-folders-scan-bar');
    if (!bar) return;
    const willShow = bar.classList.contains('hidden');
    bar.classList.toggle('hidden', !willShow);
    if (willShow) {
      if ($('scan-scope-select')) $('scan-scope-select').value = 'custom_folders';
      $('custom-folders-input')?.focus?.();
    }
  });

  $('close-custom-folders-bar-btn')?.addEventListener('click', () => {
    $('custom-folders-scan-bar')?.classList.add('hidden');
    if ($('scan-scope-select')?.value === 'custom_folders') {
      $('scan-scope-select').value = 'all_drive';
    }
  });

  $('custom-folders-input')?.addEventListener('input', updateCustomFoldersBadge);

  $('clear-custom-folders-btn')?.addEventListener('click', () => {
    if ($('custom-folders-input')) $('custom-folders-input').value = '';
    updateCustomFoldersBadge();
    toast('已清空指定文件夹输入');
  });

  $('scan-custom-folders-btn')?.addEventListener('click', () => {
    if ($('scan-scope-select')) $('scan-scope-select').value = 'custom_folders';
    handleScan(state.activeAccount, 'custom_folders');
  });

  $('clear-new-flags').addEventListener('click', async () => {
    state.newFileIds.clear();
    for (const f of state.files) f.isNew = false;
    await saveCurrentFilesSnapshot();
    renderAll();
    toast('已清除新增文件标记');
  });

  $('account-switcher').addEventListener('change', e => {
    state.activeAccount = e.target.value || 'all';
    state.selectedFileIds.clear();
    renderAll();
  });

  // 4. 左侧统计胶囊与表格交互
  $('summary').addEventListener('click', e => {
    const card = e.target.closest('.summary-card');
    if (!card) return;
    $('file-status-filter').value = card.dataset.cardFilter || 'all';
    renderFilesTab();
  });

  $('select-all').addEventListener('change', e => {
    const filtered = getFilteredFiles();
    if (e.target.checked) {
      for (const f of filtered) state.selectedFileIds.add(f.id);
    } else {
      for (const f of filtered) state.selectedFileIds.delete(f.id);
    }
    renderFilesTab();
  });

  // 5. 右侧 TAB 1：筛选与批量操作（搜索框输入防抖优化，避免大数据量输入卡顿）
  let searchDebounceTimer = null;
  ['file-search', 'file-exclude-search'].forEach(id => {
    $(id).addEventListener('input', () => {
      syncQuickExcludeButtons();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        renderFilesTab();
      }, 120);
    });
  });

  ['search-match-mode', 'file-group-filter', 'file-status-filter', 'file-name-pattern', 'hide-private'].forEach(id => {
    $(id).addEventListener('change', renderFilesTab);
  });

  document.querySelectorAll('.quick-kw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kw = (btn.dataset.exKw || '').toLowerCase();
      const input = $('file-exclude-search');
      const terms = parseKeywords(input.value);
      const next = terms.includes(kw) ? terms.filter(t => t !== kw) : [...terms, kw];
      input.value = next.join(' ');
      syncQuickExcludeButtons();
      renderFilesTab();
    });
  });

  $('reset-all-filters-btn').addEventListener('click', () => {
    $('file-search').value = '';
    $('search-match-mode').value = 'or';
    $('file-exclude-search').value = '';
    $('file-group-filter').value = 'all';
    $('file-status-filter').value = 'all';
    $('file-name-pattern').value = 'default';
    $('hide-private').checked = false;
    state.coreNameFilter = '';
    state.selectedTypeCats = new Set(ALL_TYPE_CATS);
    syncTypeDropdownUI();
    syncQuickExcludeButtons();
    renderFilesTab();
    toast('已重置所有筛选条件');
  });

  $('save-filter-preset-btn').addEventListener('click', async () => {
    const name = (prompt('请输入筛选预设名称（如：财务月报排查）：') || '').trim();
    if (!name) return;
    const preset = {
      id: `p_${Date.now()}`,
      name,
      search: $('file-search').value,
      matchMode: $('search-match-mode').value,
      excludeSearch: $('file-exclude-search').value,
      types: [...state.selectedTypeCats],
      groupFilter: $('file-group-filter').value,
      statusFilter: $('file-status-filter').value,
      pattern: $('file-name-pattern').value,
      hidePrivate: $('hide-private').checked
    };
    state.filterPresets = await saveFilterPresets([...state.filterPresets, preset]);
    renderSavedPresetsBar();
    toast(`已保存筛选预设「${name}」`);
  });

  $('saved-presets-bar').addEventListener('click', async e => {
    const delBtn = e.target.closest('[data-action="delete-preset"]');
    if (delBtn) {
      e.stopPropagation();
      const pid = delBtn.dataset.presetId;
      state.filterPresets = await saveFilterPresets(state.filterPresets.filter(p => p.id !== pid));
      renderSavedPresetsBar();
      return;
    }
    const pill = e.target.closest('[data-action="apply-preset"]');
    if (pill) {
      const p = state.filterPresets.find(x => x.id === pill.dataset.presetId);
      if (!p) return;
      $('file-search').value = p.search || '';
      $('search-match-mode').value = p.matchMode || 'or';
      $('file-exclude-search').value = p.excludeSearch || '';
      state.selectedTypeCats = new Set(p.types || ALL_TYPE_CATS);
      $('file-group-filter').value = p.groupFilter || 'all';
      $('file-status-filter').value = p.statusFilter || 'all';
      $('file-name-pattern').value = p.pattern || 'default';
      $('hide-private').checked = Boolean(p.hidePrivate);
      syncTypeDropdownUI();
      syncQuickExcludeButtons();
      renderFilesTab();
      toast(`已应用预设「${p.name}」`);
    }
  });

  $('batch-grant-groups').addEventListener('click', () => handleGroupBatchOperation('grant'));
  $('batch-keep-only-groups').addEventListener('click', () => handleGroupBatchOperation('keep_only_groups'));
  $('batch-revoke-groups').addEventListener('click', () => handleGroupBatchOperation('revoke_groups'));

  $('batch-enforce').addEventListener('click', () => {
    const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
    handleEnforceFiles(selected);
  });
  $('batch-downgrade-all').addEventListener('click', () => handleBatchQuickAction('downgrade_all'));
  $('batch-remove-public').addEventListener('click', () => handleBatchQuickAction('remove_public'));
  $('batch-revoke-all').addEventListener('click', () => handleBatchQuickAction('revoke_all'));

  // 5.5 批量输入链接 + 批量邮箱直通授权/关闭权限（左侧第二标签页大工作台）
  const updateBatchLinksParsedInfo = () => {
    const fileIds = parseDriveLinksInput($('batch-links-input')?.value || '');
    const emails = parseEmailsInput($('batch-emails-input')?.value || '');
    if ($('batch-links-parsed-info')) {
      $('batch-links-parsed-info').textContent = `${fileIds.length} 链接 · ${emails.length} 邮箱`;
    }
    if ($('batch-links-count-label')) {
      $('batch-links-count-label').textContent = `已识别 ${fileIds.length} 个链接`;
    }
    if ($('batch-emails-count-label')) {
      $('batch-emails-count-label').textContent = `已识别 ${emails.length} 个邮箱`;
    }
  };

  $('batch-links-input').addEventListener('input', () => {
    syncInputsToBatchSheet();
    updateBatchLinksParsedInfo();
  });
  $('batch-emails-input').addEventListener('input', () => {
    syncInputsToBatchSheet();
    updateBatchLinksParsedInfo();
  });

  $('batch-links-add-rows-btn')?.addEventListener('click', () => {
    if (state.batchLinksSheet) {
      const cur = state.batchLinksSheet.getData() || [];
      const extra = Array.from({ length: 20 }, () => ['', '', '', '', '', '', '', '']);
      state.isUpdatingBatchSheet = true;
      state.batchLinksSheet.setData([...cur, ...extra]);
      state.isUpdatingBatchSheet = false;
      toast('已在表格底部增加 20 行');
    }
  });

  $('batch-links-clear-btn').addEventListener('click', () => {
    $('batch-links-input').value = '';
    $('batch-emails-input').value = '';
    if (state.batchLinksSheet) {
      state.isUpdatingBatchSheet = true;
      state.batchLinksSheet.setData(Array.from({ length: 25 }, () => ['', '', '', '', '', '', '', '']));
      state.isUpdatingBatchSheet = false;
    }
    updateBatchLinksParsedInfo();
    toast('已清空表格中的链接与邮箱');
  });

  const renderBatchLinksScanTable = (results = []) => {
    // 同步更新 Jspreadsheet 表格行（C列类型、D列文件名称、E列我的权限、F列公开权限下拉、G列已授权人数、H列状态）
    if (state.batchLinksSheet) {
      const byFileId = new Map(results.map(r => [r.fileId, r]));
      const rows = state.batchLinksSheet.getData() || [];
      state.isUpdatingBatchSheet = true;
      try {
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const parsed = parseDriveLinksInput(rows[rIdx]?.[0] || '');
          if (!parsed.length) continue;
          const item = byFileId.get(parsed[0]);
          if (!item) continue;

          const typeLabel = item.mimeType ? fileCategoryLabel(item.mimeType, item.name) : '🔗 链接';
          let pubDropdownId = 'anyone_off';
          if (item.linkPublicRole === 'writer' || item.linkPublicRole === 'organizer' || item.linkPublicRole === 'fileOrganizer') {
            pubDropdownId = 'anyone_writer';
          } else if (item.linkPublicRole === 'commenter') {
            pubDropdownId = 'anyone_commenter';
          } else if (item.linkPublicRole === 'reader') {
            pubDropdownId = 'anyone_reader';
          }

          const nonOwners = (item.permissions || []).filter(
            p => p.role !== 'owner' && normalizeEntry(p.emailAddress || '') !== normalizeEntry(item.ownerEmail || '')
          );
          let wCount = 0;
          let rCount = 0;
          for (const p of nonOwners) {
            if (p.role === 'reader' || p.role === 'commenter') rCount++;
            else wCount++;
          }
          const countSummary = item.loading
            ? '⏳ 统计中…'
            : item.permissions?.length
            ? `共 ${nonOwners.length} 项 (编辑 ${wCount} / 查看 ${rCount})`
            : item.linkStatusLabel;

          const execStatus = item.loading
            ? '⏳ 正在检测…'
            : item.error
            ? `❌ ${item.error}`
            : `✅ 已检测 (${item.linkStatusLabel})`;

          rows[rIdx][2] = typeLabel;
          rows[rIdx][3] = item.name || item.fileId;
          rows[rIdx][4] = item.myAccessLabel || '';
          rows[rIdx][5] = pubDropdownId;
          rows[rIdx][6] = countSummary;
          rows[rIdx][7] = execStatus;
        }
        state.batchLinksSheet.setData(rows);
      } finally {
        state.isUpdatingBatchSheet = false;
      }
    }
  };

  const handleScanBatchLinks = async () => {
    syncBatchSheetToInputs();
    const fileIds = parseDriveLinksInput($('batch-links-input').value || '');
    if (!fileIds.length) {
      toast('请先在表格 A 列粘贴至少 1 个 Google 文件或文件夹链接');
      return;
    }

    $('batch-links-scan-btn').disabled = true;
    $('progress').textContent = `正在扫描 ${fileIds.length} 个链接的权限…`;
    try {
      const results = await scanBatchLinksStatus({
        fileIds,
        targetAccount: state.activeAccount,
        onProgress(p) {
          if (p?.message) $('progress').textContent = p.message;
        },
        onPartialResults(liveResults) {
          renderBatchLinksScanTable(liveResults);
        }
      });
      renderBatchLinksScanTable(results);
      $('progress').textContent = `链接权限扫描完成：共检测 ${results.length} 个链接`;
      toast(`已扫描 ${results.length} 个链接的权限状态`);
    } catch (error) {
      $('progress').textContent = `扫描链接权限失败：${error.message}`;
      toast(`扫描失败：${error.message}`);
    } finally {
      $('batch-links-scan-btn').disabled = false;
    }
  };

  $('batch-links-scan-btn').addEventListener('click', handleScanBatchLinks);

  const handleApplyPublicModeToLinks = async (targetFileIds, publicMode) => {
    if (!targetFileIds.length) {
      toast('请先在表格 A 列粘贴至少 1 个 Google 文件或文件夹链接');
      return;
    }

    const modeMap = {
      anyone_writer: '🌐 所有人可编辑（知道链接的任何人均可编辑）',
      anyone_reader: '🌐 所有人可查看（知道链接的任何人仅可查看）',
      anyone_commenter: '🌐 所有人可评论（知道链接的任何人可评论）',
      anyone_off: '🔒 关闭公开链接（恢复仅指定邮箱可访问）'
    };

    if (
      targetFileIds.length > 1 &&
      !confirm(`确认对 ${targetFileIds.length} 个链接直接设置为：\n「${modeMap[publicMode] || publicMode}」？\n（无需填写邮箱，直接修改链接公开权限）`)
    ) {
      return;
    }

    $('batch-links-public-apply-btn').disabled = true;
    $('progress').textContent = `正在批量设置链接公开权限…`;
    try {
      const res = await executeBatchLinksPublicAccess({
        fileIds: targetFileIds,
        publicMode,
        existingFiles: state.files,
        targetAccount: state.activeAccount,
        onProgress(p) {
          if (p?.message) $('progress').textContent = p.message;
        }
      });
      await saveCurrentFilesSnapshot();
      state.logs = await getAuditLogs();
      renderAll();

      if (state.batchLinksSheet && Array.isArray(res.results)) {
        const resById = new Map(res.results.map(r => [r.fileId, r]));
        const rows = state.batchLinksSheet.getData() || [];
        state.isUpdatingBatchSheet = true;
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const parsed = parseDriveLinksInput(rows[rIdx]?.[0] || '');
          if (!parsed.length) continue;
          const item = resById.get(parsed[0]);
          if (!item) continue;
          if (item.fileName && !rows[rIdx][3]) rows[rIdx][3] = item.fileName;
          if (item.ok) {
            rows[rIdx][5] = publicMode;
            rows[rIdx][7] = `✅ ${item.status}`;
          } else {
            rows[rIdx][7] = `❌ ${item.status}`;
          }
        }
        state.batchLinksSheet.setData(rows);
        state.isUpdatingBatchSheet = false;
      }

      $('progress').textContent = `公开权限设置完成：成功 ${res.successCount} 个链接，失败 ${res.failCount} 个`;
      toast(`完成：成功设置 ${res.successCount} 个链接，失败 ${res.failCount} 个`);
    } catch (error) {
      toast(`设置失败：${error.message}`);
    } finally {
      $('batch-links-public-apply-btn').disabled = false;
    }
  };

  $('batch-links-public-apply-btn').addEventListener('click', () => {
    syncBatchSheetToInputs();
    const fileIds = parseDriveLinksInput($('batch-links-input').value || '');
    const publicMode = $('batch-links-public-mode').value || 'anyone_writer';
    handleApplyPublicModeToLinks(fileIds, publicMode);
  });

  $('batch-links-fill-group').addEventListener('change', e => {
    const gName = e.target.value;
    if (!gName) return;
    const members = (state.directory.contacts || [])
      .filter(c => (c.groups || []).includes(gName))
      .map(c => normalizeEntry(c.email));
    if (!members.length) {
      toast(`分组「${gName}」暂无成员邮箱`);
      e.target.value = '';
      return;
    }
    syncBatchSheetToInputs();
    const existingEmails = parseEmailsInput($('batch-emails-input').value || '');
    const merged = [...new Set([...existingEmails, ...members])];
    $('batch-emails-input').value = merged.join('\n');
    e.target.value = '';
    syncInputsToBatchSheet();
    updateBatchLinksParsedInfo();
    toast(`已带入「${gName}」共 ${members.length} 个邮箱到 B 列`);
  });

  const handleBatchLinksAction = async (mode = 'grant') => {
    syncBatchSheetToInputs();
    const fileIds = parseDriveLinksInput($('batch-links-input').value || '');
    const emails = parseEmailsInput($('batch-emails-input').value || '');
    const role = $('batch-links-role').value || 'reader';

    if (!fileIds.length) {
      toast('请先在表格 A 列粘贴至少 1 个 Google 文件或文件夹链接');
      return;
    }
    if (!emails.length) {
      toast('请先在表格 B 列输入至少 1 个目标邮箱（或从分组带入）');
      return;
    }

    const actionDesc =
      mode === 'grant'
        ? `批量开通「${roleLabel(role)}」权限`
        : '批量关闭/移除这些邮箱的权限';

    if (
      !confirm(
        `确认对已识别的 ${fileIds.length} 个链接、${emails.length} 个邮箱执行：\n「${actionDesc}」？\n（全程静默处理，不发送骚扰邮件通知）`
      )
    ) {
      return;
    }

    $('batch-links-grant-btn').disabled = true;
    $('batch-links-revoke-btn').disabled = true;
    $('progress').textContent = `正在启动批量链接权限处理…`;

    try {
      const res = await executeBatchLinksPermissions({
        fileIds,
        emails,
        role,
        mode,
        existingFiles: state.files,
        targetAccount: state.activeAccount,
        onProgress(p) {
          if (p?.message) $('progress').textContent = p.message;
        }
      });
      await saveCurrentFilesSnapshot();
      state.logs = await getAuditLogs();
      renderAll();

      if (state.batchLinksSheet) {
        const rows = state.batchLinksSheet.getData() || [];
        state.isUpdatingBatchSheet = true;
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const parsed = parseDriveLinksInput(rows[rIdx]?.[0] || '');
          if (!parsed.length) continue;
          rows[rIdx][7] =
            mode === 'grant'
              ? `✅ 已对 ${emails.length} 个邮箱开通${roleLabel(role)}`
              : `✅ 已移除 ${emails.length} 个邮箱权限`;
        }
        state.batchLinksSheet.setData(rows);
        state.isUpdatingBatchSheet = false;
      }

      $('progress').textContent = `批量链接处理完成：成功 ${res.successCount} 项，失败 ${res.failCount} 项`;
      toast(`完成：${res.fileCount} 个链接 × ${res.emailCount} 个邮箱，成功 ${res.successCount} 项，失败 ${res.failCount} 项`);
    } catch (error) {
      $('progress').textContent = `批量链接处理失败：${error.message}`;
      toast(`处理失败：${error.message}`);
    } finally {
      $('batch-links-grant-btn').disabled = false;
      $('batch-links-revoke-btn').disabled = false;
    }
  };

  $('batch-links-grant-btn').addEventListener('click', () => handleBatchLinksAction('grant'));
  $('batch-links-revoke-btn').addEventListener('click', () => handleBatchLinksAction('revoke'));

  // 6. 右侧 TAB 2：人员与分组
  $('collab-group-filter').addEventListener('change', renderCollaboratorsTab);
  $('collab-search').addEventListener('input', renderCollaboratorsTab);
  $('collab-filter').addEventListener('change', renderCollaboratorsTab);

  $('quick-filter-left-by-group').addEventListener('click', () => {
    const g = $('collab-group-filter').value;
    $('file-group-filter').value = g === 'all' ? 'all' : `grp:${g}`;
    renderFilesTab();
    toast(g === 'all' ? '左侧已显示全部文件' : `左侧已筛选含「${g}」的文件`);
  });

  $('panel-collaborators').addEventListener('change', async e => {
    const sel = e.target.closest('select[data-action="add-person-group"]');
    if (!sel || !sel.value) return;
    const email = normalizeEntry(sel.dataset.email);
    const name = sel.dataset.name || '';
    const grp = sel.value;

    const contacts = [...(state.directory.contacts || [])];
    const existing = contacts.find(c => normalizeEntry(c.email) === email);
    if (existing) {
      existing.groups = [...new Set([...(existing.groups || []), grp])];
    } else {
      contacts.push({ email, name, groups: [grp] });
    }
    state.directory = await saveDirectory({ groups: state.directory.groups, contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已将 ${name || email} 归入「${grp}」`);
  });

  $('panel-collaborators').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'remove-person-group') {
      const email = normalizeEntry(btn.dataset.email);
      const grp = btn.dataset.group;
      const contacts = (state.directory.contacts || []).map(c =>
        normalizeEntry(c.email) === email ? { ...c, groups: (c.groups || []).filter(g => g !== grp) } : c
      );
      state.directory = await saveDirectory({ groups: state.directory.groups, contacts });
      renderAll();
    } else if (action === 'group-sync-writers' || action === 'group-sync-readers') {
      const grp = btn.dataset.group;
      const members = (state.directory.contacts || [])
        .filter(c => (c.groups || []).includes(grp))
        .map(c => normalizeEntry(c.email));
      if (action === 'group-sync-writers') {
        await syncPolicyAndSchedule({ writers: [...state.policy.writers, ...members] });
      } else {
        await syncPolicyAndSchedule({ readers: [...state.policy.readers, ...members] });
      }
      toast(`已将「${grp}」共 ${members.length} 人同步至白名单`);
    } else if (action === 'person-trust-writer') {
      await syncPolicyAndSchedule({ writers: [...state.policy.writers, btn.dataset.email] });
      toast(`已将 ${btn.dataset.email} 加入允许编辑白名单`);
    } else if (action === 'person-trust-reader') {
      await syncPolicyAndSchedule({ readers: [...state.policy.readers, btn.dataset.email] });
      toast(`已将 ${btn.dataset.email} 加入仅限查看白名单`);
    } else if (action === 'person-downgrade-all') {
      handlePersonBatchOp(btn.dataset.email, 'downgrade');
    } else if (action === 'person-revoke-all') {
      handlePersonBatchOp(btn.dataset.email, 'revoke');
    }
  });

  // 7. 右侧 TAB 3：日志
  $('log-filter').addEventListener('change', renderLogsTab);
  $('clear-logs-btn').addEventListener('click', async () => {
    await clearAuditLogs();
    state.logs = [];
    renderAll();
    toast('已清空操作日志');
  });
  $('log-rows').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="restore-log"]');
    if (btn) handleRestoreLog(btn.dataset.logId);
  });

  // 8. 右侧 TAB 4：设置
  $('oauth-json-file').addEventListener('change', async e => {
    await handleOAuthFilesUpload(e.target.files || []);
    e.target.value = '';
  });
  $('add-account-btn').addEventListener('click', handleAddMoreAccount);

  $('create-group-btn').addEventListener('click', async () => {
    const name = ($('new-group-name').value || '').trim();
    const defaultRole = $('new-group-role').value || 'reader';
    if (!name) {
      toast('请输入新分组名称（如：1组、2组）');
      return;
    }
    const groups = [...(state.directory.groups || [])];
    const existing = groups.find(g => g.name === name);
    if (existing) {
      existing.defaultRole = defaultRole;
    } else {
      groups.push({ name, defaultRole, policyTier: defaultRole });
    }
    $('new-group-name').value = '';
    state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已保存分组「${name}」`);
  });

  $('import-contacts-csv').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseTabularContactsText(text, $('import-target-group-select').value);
      await importParsedContacts(rows);
    } catch (error) {
      toast(`读取 CSV 失败：${error.message}`);
    } finally {
      e.target.value = '';
    }
  });

  $('parse-paste-contacts-btn').addEventListener('click', async () => {
    const text = ($('paste-contacts-textarea').value || '').trim();
    if (!text) {
      toast('请先粘贴表格内容（A列姓名，B列邮箱）');
      return;
    }
    const rows = parseTabularContactsText(text, $('import-target-group-select').value);
    await importParsedContacts(rows);
    $('paste-contacts-textarea').value = '';
  });

  $('fetch-drive-sheet-contacts-btn').addEventListener('click', async () => {
    const idOrUrl = ($('drive-sheet-url-input').value || '').trim() || $('drive-sheet-picker').value;
    if (!idOrUrl) {
      toast('请先选择云端表格或输入表格链接');
      return;
    }
    try {
      const token = await getValidTokenForAccount(state.activeAccount !== 'all' ? state.activeAccount : '', true);
      const rows = await fetchContactsFromGoogleSheet(token, idOrUrl, $('import-target-group-select').value);
      await importParsedContacts(rows);
    } catch (error) {
      toast(`同步云端表格失败：${error.message}`);
    }
  });

  $('policy-schedule-enabled').addEventListener('change', e => {
    syncPolicyAndSchedule({ scheduleEnabled: e.target.checked });
  });
  $('policy-schedule-minutes').addEventListener('change', e => {
    syncPolicyAndSchedule({ scheduleMinutes: Number(e.target.value) || 60 });
  });
  $('auto-enforce-select').addEventListener('change', e => {
    syncPolicyAndSchedule({ autoEnforce: e.target.value === 'enforce' });
  });
  $('policy-public-rule').addEventListener('change', e => {
    syncPolicyAndSchedule({ publicLinkRule: e.target.value });
  });

  $('add-writer-btn').addEventListener('click', async () => {
    const items = parseKeywords($('add-writer-input').value);
    if (!items.length) return;
    $('add-writer-input').value = '';
    await syncPolicyAndSchedule({ writers: [...state.policy.writers, ...items] });
  });

  $('add-reader-btn').addEventListener('click', async () => {
    const items = parseKeywords($('add-reader-input').value);
    if (!items.length) return;
    $('add-reader-input').value = '';
    await syncPolicyAndSchedule({ readers: [...state.policy.readers, ...items] });
  });

  $('trust-all-current-writers').addEventListener('click', async () => {
    const writers = new Set(state.policy.writers);
    const readers = new Set(state.policy.readers);
    for (const f of state.files) {
      for (const p of f.permissions || []) {
        if (p.role === 'owner' || !p.emailAddress) continue;
        const em = normalizeEntry(p.emailAddress);
        if (p.role === 'reader') readers.add(em);
        else writers.add(em);
      }
    }
    await syncPolicyAndSchedule({ writers: [...writers], readers: [...readers] });
    toast('已将当前扫描到的所有协作者加入对应白名单');
  });

  $('json-file').addEventListener('change', async e => {
    await handleOAuthFilesUpload(e.target.files || []);
    e.target.value = '';
  });
  $('export-policy-json').addEventListener('click', exportPolicyAndDirectoryJson);

  $('panel-settings').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'auth-oauth-client') {
      const uid = btn.dataset.uid;
      const client = state.oauthClients.find(c => (c.uid || c.client_id) === uid);
      if (client) {
        await handleAuthorizeWithClient(client);
      }
    } else if (action === 'remove-oauth-client') {
      const uid = btn.dataset.uid;
      state.oauthClients = await removeOAuthClient(uid);
      renderAll();
      toast('已移除该 OAuth JSON 凭证');
    } else if (action === 'remove-account') {
      state.accounts = await removeAuthorizedAccount(btn.dataset.email);
      if (state.activeAccount === btn.dataset.email) state.activeAccount = 'all';
      renderAll();
      toast(`已移除账号 ${btn.dataset.email}`);
    } else if (action === 'delete-group') {
      const gName = btn.dataset.group;
      const groups = (state.directory.groups || []).filter(g => g.name !== gName);
      const contacts = (state.directory.contacts || []).map(c => ({
        ...c,
        groups: (c.groups || []).filter(g => g !== gName)
      }));
      state.selectedBatchGroups.delete(gName);
      state.directory = await saveDirectory({ groups, contacts });
      renderAll();
      toast(`已删除分组「${gName}」`);
    } else if (action === 'del-writer') {
      await syncPolicyAndSchedule({
        writers: state.policy.writers.filter(x => x !== btn.dataset.val)
      });
    } else if (action === 'del-reader') {
      await syncPolicyAndSchedule({
        readers: state.policy.readers.filter(x => x !== btn.dataset.val)
      });
    }
  });

  // 9. 加载存储数据并首次渲染
  try {
    const [policy, directory, presets, logs, oauthClients, accounts, snapshot] = await Promise.all([
      getPolicy(),
      getDirectory(),
      getFilterPresets(),
      getAuditLogs(),
      getOAuthClients(),
      getAuthorizedAccounts(),
      getSnapshot()
    ]);

    state.policy = policy;
    state.directory = directory;
    state.filterPresets = presets;
    state.logs = logs;
    state.oauthClients = oauthClients;
    state.accounts = accounts;
    state.files = snapshot.files || [];
    state.newFileIds = new Set(snapshot.newFileIds || []);
    state.lastScanAt = snapshot.lastScanAt || '';

    if (state.lastScanAt) {
      $('progress').textContent = `上次扫描：${formatTime(state.lastScanAt)}（共 ${state.files.length} 个文件）`;
    }
  } catch (error) {
    console.error('加载缓存失败:', error);
  }

  renderAll();
}

init();
