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
  coreNameFilter: ''
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

  $('oauth-clients-info').textContent = `已存凭证: ${state.oauthClients.length}`;

  const listNode = $('accounts-list');
  if (!state.accounts.length) {
    listNode.innerHTML = '<span class="muted">尚未授权任何账号</span>';
    setStatus('待授权', false);
    $('scan').disabled = state.oauthClients.length === 0;
  } else {
    setStatus(`已授权 ${state.accounts.length} 个账号`, true);
    $('scan').disabled = false;
    listNode.innerHTML = state.accounts
      .map(
        acc => `<span class="account-pill">
          <span>${escapeHtml(acc.email)}</span>
          <button type="button" class="remove-acc" data-action="remove-account" data-email="${escapeHtml(acc.email)}" title="移除此账号">×</button>
        </span>`
      )
      .join('');
  }
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

async function handleAuthorizeWithClient(client) {
  setStatus('等待授权…');
  try {
    const account = await authorizeWithOAuthClient(client);
    state.accounts = await getAuthorizedAccounts();
    state.oauthClients = await getOAuthClients();
    renderAll();
    toast(`已授权账号：${account.email}，正在自动扫描…`);
    await handleScan(account.email);
  } catch (error) {
    renderAccountsUI();
    toast(`授权未完成：${error.message}`);
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
      const clients = extractOAuthClientsFromJson(parsed);
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
    toast(`已导入 ${extractedClients.length} 个 OAuth 凭证，正在打开 Google 授权页…`);
    for (const client of extractedClients) {
      await handleAuthorizeWithClient(client);
    }
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
  const chosenClient = state.oauthClients[state.oauthClients.length - 1];
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


// ==================== 左侧文件与权限表格渲染 ====================
function renderPermissionChip(fileId, perm) {
  const check = evaluatePermission(perm, state.policy);
  const contactLookup = buildContactLookup(state.directory);
  const emailNorm = normalizeEntry(perm.emailAddress || '');
  const contact = contactLookup.get(emailNorm);

  let cls = 'owner';
  let statusBadge = '';

  if (perm.role === 'owner') {
    cls = 'owner';
  } else if (check.action === 'remove') {
    cls = 'unauthorized';
    statusBadge = `<span class="perm-action-hint danger">非白名单</span>`;
  } else if (check.action === 'downgrade') {
    cls = 'overprivileged';
    statusBadge = `<span class="perm-action-hint warn">越权→只读</span>`;
  } else if (perm.type === 'anyone' || perm.type === 'domain') {
    cls = 'public';
  } else {
    cls = 'authorized';
  }

  const label = escapeHtml(
    contact?.name
      ? `${contact.name} (${perm.emailAddress})`
      : perm.emailAddress || perm.domain || (perm.type === 'anyone' ? '公开链接' : perm.displayName || perm.id)
  );
  const isOwner = perm.role === 'owner';

  const roleHtml = isOwner
    ? `<span class="perm-role">所有者</span>`
    : `<select class="perm-role-select" data-action="change-role" data-file-id="${escapeHtml(fileId)}" data-perm-id="${escapeHtml(perm.id)}">
        <option value="writer" ${perm.role === 'writer' || perm.role === 'organizer' || perm.role === 'fileOrganizer' ? 'selected' : ''}>编辑者</option>
        <option value="commenter" ${perm.role === 'commenter' ? 'selected' : ''}>评论者</option>
        <option value="reader" ${perm.role === 'reader' ? 'selected' : ''}>查看者</option>
      </select>`;

  const quickTrustBtn =
    !isOwner && perm.emailAddress && check.action !== 'keep'
      ? `<button class="perm-trust-btn" data-action="quick-trust" data-email="${escapeHtml(perm.emailAddress)}" data-role="${escapeHtml(perm.role)}" title="加入对应白名单">+白</button>`
      : '';

  const removeBtn = isOwner
    ? ''
    : `<button class="perm-remove-btn" data-action="remove-perm" data-file-id="${escapeHtml(fileId)}" data-perm-id="${escapeHtml(perm.id)}" title="移除此权限">×</button>`;

  return `<span class="perm-chip ${cls}" title="${escapeHtml(check.reason)}">
    <span class="perm-label">${label}</span>
    ${roleHtml}
    ${statusBadge}
    ${quickTrustBtn}
    ${removeBtn}
  </span>`;
}

function renderFilesTab() {
  const allFiles = state.files;
  const filtered = getFilteredFiles();
  const coreCounts = getCoreNameClusterCounts();

  let sharedCount = 0;
  let unauthorizedPermTotal = 0;
  let downgradePermTotal = 0;
  let publicFileCount = 0;
  const newCount = state.newFileIds.size;

  for (const f of allFiles) {
    const st = evaluateFileSummary(f, state.policy);
    if (st.hasNonOwner) sharedCount++;
    if (st.hasPublic) publicFileCount++;
    unauthorizedPermTotal += st.removeCount;
    downgradePermTotal += st.downgradeCount;
  }

  for (const card of document.querySelectorAll('.summary-card')) {
    const fType = card.dataset.filter;
    card.classList.toggle('active', fType === state.statusFilter);
    const valEl = card.querySelector('.val');
    if (!valEl) continue;
    if (fType === 'all') valEl.textContent = allFiles.length;
    else if (fType === 'shared') valEl.textContent = sharedCount;
    else if (fType === 'unauthorized') valEl.textContent = unauthorizedPermTotal;
    else if (fType === 'overprivileged') valEl.textContent = downgradePermTotal;
    else if (fType === 'public') valEl.textContent = publicFileCount;
    else if (fType === 'new') valEl.textContent = newCount;
  }

  el('clear-new-flags').hidden = newCount === 0;
  el('filtered-count').textContent = `当前筛选 ${filtered.length} / 总计 ${allFiles.length} 个文件`;

  const tbody = el('file-rows');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">${
      allFiles.length === 0 ? '暂无扫描数据，请点击右上角「扫描云端硬盘」' : '当前筛选条件下没有匹配的文件'
    }</td></tr>`;
    updateBatchButtons();
    return;
  }

  tbody.innerHTML = filtered
    .map(file => {
      const evalStat = evaluateFileSummary(file, state.policy);
      const isSelected = state.selectedFileIds.has(file.id);
      const isNew = state.newFileIds.has(file.id);
      const perms = file.permissions || [];
      const coreName = extractCoreFileName(file.name || '');
      const clusterSize = coreCounts.get(coreName) || 1;
      const groupCoverages = getFileGroupCoverage(file, state.directory);

      const groupBadgesHtml = groupCoverages
        .map(cov => {
          const isFull = cov.status === 'full';
          return `<span class="file-group-badge ${isFull ? 'full' : 'partial'}" title="${escapeHtml(cov.groupName)}: 已授权 ${cov.matchedCount}/${cov.total} 人">${escapeHtml(cov.groupName)} (${cov.matchedCount}/${cov.total})</span>`;
        })
        .join('');

      const clusterBadgeHtml =
        clusterSize >= 2
          ? `<span class="cluster-badge" title="核心词「${escapeHtml(coreName)}」共有 ${clusterSize} 个相似文件">相似×${clusterSize}</span>`
          : '';

      const accountTag =
        file.ownerAccount && state.accounts.length > 1
          ? `<span class="account-mini-badge">${escapeHtml(file.ownerAccount)}</span>`
          : '';

      const chipsHtml = perms.length
        ? perms.map(p => renderPermissionChip(file.id, p)).join('')
        : '<span class="muted">未读取到权限明细</span>';

      const enforceBtnHtml = evalStat.hasActionableViolation
        ? `<button class="btn xs danger-outline" data-action="enforce-file" data-file-id="${escapeHtml(file.id)}">一键合规 (${evalStat.removeCount}删/${evalStat.downgradeCount}降)</button>`
        : `<span class="badge ok">✓ 合规</span>`;

      return `<tr class="${evalStat.hasActionableViolation ? 'row-violation' : ''} ${isNew ? 'row-new' : ''}">
        <td class="col-check">
          <input type="checkbox" class="file-check" data-file-id="${escapeHtml(file.id)}" ${isSelected ? 'checked' : ''} />
        </td>
        <td class="col-file">
          <div class="file-title-row">
            ${isNew ? '<span class="new-badge">NEW</span>' : ''}
            <span class="type-tag">${escapeHtml(fileTypeLabel(file.mimeType))}</span>
            ${accountTag}
            <a href="${escapeHtml(file.webViewLink || '#')}" target="_blank" rel="noreferrer" class="file-link" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>
          </div>
          <div class="file-sub-badges">
            ${groupBadgesHtml}
            ${clusterBadgeHtml}
          </div>
        </td>
        <td class="col-perms">
          <div class="perm-list">${chipsHtml}</div>
          <div class="inline-add-row">
            <input type="email" class="inline-email-input" placeholder="输入邮箱添加权限..." data-file-id="${escapeHtml(file.id)}" />
            <select class="inline-role-select" data-file-id="${escapeHtml(file.id)}">
              <option value="reader">查看者</option>
              <option value="commenter">评论者</option>
              <option value="writer">编辑者</option>
            </select>
            <button class="btn xs secondary" data-action="add-perm" data-file-id="${escapeHtml(file.id)}">+添加</button>
          </div>
        </td>
        <td class="col-actions">
          <div class="row-actions">${enforceBtnHtml}</div>
        </td>
      </tr>`;
    })
    .join('');

  const allFilteredSelected = filtered.length > 0 && filtered.every(f => state.selectedFileIds.has(f.id));
  el('select-all').checked = allFilteredSelected;
  updateBatchButtons();
}

function updateBatchButtons() {
  const count = state.selectedFileIds.size;
  el('selected-count').textContent = `已选 ${count} 项`;
  const disabled = count === 0 || state.busy;
  if (el('batch-enforce')) el('batch-enforce').disabled = disabled;
  if (el('batch-apply-btn')) el('batch-apply-btn').disabled = disabled;
  if (el('batch-grant-groups-btn')) el('batch-grant-groups-btn').disabled = disabled;
  if (el('batch-revoke-groups-btn')) el('batch-revoke-groups-btn').disabled = disabled;
}

// ==================== 分组下拉与人员标签页渲染 ====================
function renderGroupSelectorsAndBatchBar() {
  const groups = getGroupStats(state.directory);

  // 1. 文件分组筛选下拉 (#file-group-filter)
  const fileGroupFilter = el('file-group-filter');
  const currentFilterVal = fileGroupFilter.value || 'all';
  fileGroupFilter.innerHTML = [
    `<option value="all">全部文件 (不限分组)</option>`,
    `<option value="__partial__">分组部分授权 (缺漏成员)</option>`,
    ...groups.map(g => `<option value="grp:${escapeHtml(g.name)}">含分组：${escapeHtml(g.name)} (${g.count}人)</option>`)
  ].join('');
  if ([...fileGroupFilter.options].some(o => o.value === currentFilterVal)) {
    fileGroupFilter.value = currentFilterVal;
  }

  // 2. 批量分组下拉菜单 (#batch-group-checkboxes)
  const batchContainer = el('batch-group-checkboxes');
  const labelEl = el('batch-group-dropdown-label');
  for (const gName of [...state.selectedBatchGroups]) {
    if (!groups.some(g => g.name === gName)) state.selectedBatchGroups.delete(gName);
  }

  if (groups.length === 0) {
    batchContainer.innerHTML = `<span class="muted">暂无分组，请去「设置」创建或导入</span>`;
    labelEl.textContent = '暂无分组';
  } else {
    batchContainer.innerHTML = groups
      .map(
        g => `<label class="dropdown-check-item">
          <input type="checkbox" class="batch-group-check" value="${escapeHtml(g.name)}" ${state.selectedBatchGroups.has(g.name) ? 'checked' : ''} />
          <span>${escapeHtml(g.name)}</span>
          <span class="cnt">${g.count}人</span>
        </label>`
      )
      .join('');
    labelEl.textContent =
      state.selectedBatchGroups.size === 0
        ? `点击选择分组 (共${groups.length}组)`
        : `已选 ${state.selectedBatchGroups.size} 个分组`;
  }

  // 3. 设置页的目标导入分组下拉 (#import-target-group-select) & 人员页分组筛选 (#collab-group-filter)
  const importSelect = el('import-target-group-select');
  if (importSelect) {
    const prev = importSelect.value;
    importSelect.innerHTML =
      `<option value="">-- 不额外指定分组 --</option>` +
      groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count}人)</option>`).join('');
    if ([...importSelect.options].some(o => o.value === prev)) importSelect.value = prev;
  }

  const collabGroupFilter = el('collab-group-filter');
  if (collabGroupFilter) {
    const prev = collabGroupFilter.value || 'all';
    collabGroupFilter.innerHTML =
      `<option value="all">全部分组与协作者</option>` +
      groups.map(g => `<option value="${escapeHtml(g.name)}">分组：${escapeHtml(g.name)} (${g.count}人)</option>`).join('');
    if ([...collabGroupFilter.options].some(o => o.value === prev)) collabGroupFilter.value = prev;
  }

  // 4. 设置页分组列表 (#settings-groups-list)
  const settingsGroupsEl = el('settings-groups-list');
  if (settingsGroupsEl) {
    if (groups.length === 0) {
      settingsGroupsEl.innerHTML = `<span class="muted">尚未创建分组</span>`;
    } else {
      settingsGroupsEl.innerHTML = groups
        .map(
          g => `<span class="group-pill">
            <strong>${escapeHtml(g.name)}</strong> (${g.count}人 · ${g.defaultRole === 'writer' ? '编辑' : g.defaultRole === 'commenter' ? '评论' : '查看'})
            <button class="group-del-btn" data-action="delete-group" data-group="${escapeHtml(g.name)}" title="删除分组">×</button>
          </span>`
        )
        .join('');
    }
  }
}

function renderCollaboratorsTab() {
  renderGroupSelectorsAndBatchBar();

  // 更新设置里的云端表格选择器
  const sheetPicker = el('drive-sheet-picker');
  if (sheetPicker) {
    const sheets = state.files.filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
    const prevVal = sheetPicker.value;
    sheetPicker.innerHTML =
      `<option value="">-- 从已扫描表格选择 (${sheets.length}) --</option>` +
      sheets.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    if ([...sheetPicker.options].some(o => o.value === prevVal)) sheetPicker.value = prevVal;
  }

  const groupFilterVal = el('collab-group-filter')?.value || 'all';
  const summaryEl = el('selected-group-summary');
  if (summaryEl) {
    if (groupFilterVal === 'all') {
      summaryEl.innerHTML = '';
    } else {
      const grpStats = getGroupStats(state.directory).find(g => g.name === groupFilterVal);
      summaryEl.innerHTML = `
        <button class="btn xs secondary" data-action="group-trust-writers" data-group="${escapeHtml(groupFilterVal)}">+全组入编辑白名单</button>
        <button class="btn xs secondary" data-action="group-trust-readers" data-group="${escapeHtml(groupFilterVal)}">+全组入只读白名单</button>
        <span class="muted">共 ${grpStats?.count || 0} 人</span>
      `;
    }
  }

  // 汇总扫描到的协作者 + 通讯录联系人
  const map = new Map();
  const contactLookup = buildContactLookup(state.directory);

  for (const c of state.directory.contacts || []) {
    const em = normalizeEntry(c.email);
    if (!em) continue;
    map.set(em, {
      key: em,
      email: em,
      displayName: c.name || em,
      groups: [...(c.groups || [])],
      files: [],
      writerCount: 0,
      readerCount: 0
    });
  }

  for (const file of state.files) {
    for (const p of file.permissions || []) {
      if (p.role === 'owner' || !p.emailAddress) continue;
      const key = normalizeEntry(p.emailAddress);
      const contact = contactLookup.get(key);
      if (!map.has(key)) {
        map.set(key, {
          key,
          email: key,
          displayName: contact?.name || p.displayName || key,
          groups: contact?.groups ? [...contact.groups] : [],
          files: [],
          writerCount: 0,
          readerCount: 0
        });
      }
      const item = map.get(key);
      item.files.push({ fileId: file.id, fileName: file.name, permId: p.id, role: p.role });
      if (isEditRole(p.role)) item.writerCount++;
      else item.readerCount++;
    }
  }

  const search = (el('collab-search')?.value || '').trim().toLowerCase();
  const filter = el('collab-filter')?.value || 'all';
  const allGroups = state.directory.groups || [];

  const list = [...map.values()]
    .map(item => {
      const wTrusted = matchAllowList(item.email, state.policy.writers);
      const rTrusted = matchAllowList(item.email, state.policy.readers);
      let tier = 'unlisted';
      if (wTrusted) tier = 'writer_whitelist';
      else if (rTrusted) tier = 'reader_whitelist';
      return { ...item, tier };
    })
    .filter(item => {
      if (groupFilterVal !== 'all' && !item.groups.includes(groupFilterVal)) return false;
      if (filter !== 'all' && item.tier !== filter) return false;
      if (!search) return true;
      return (
        item.email.includes(search) ||
        item.displayName.toLowerCase().includes(search) ||
        item.groups.some(g => g.toLowerCase().includes(search))
      );
    })
    .sort((a, b) => b.files.length - a.files.length || a.displayName.localeCompare(b.displayName, 'zh-CN'));

  const tbody = el('collab-rows');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无匹配的联系人或协作者</td></tr>';
    return;
  }

  tbody.innerHTML = list
    .map(item => {
      let tierBadge = `<span class="badge danger">非白名单</span>`;
      if (item.tier === 'writer_whitelist') tierBadge = `<span class="badge writer-ok">编辑白名单</span>`;
      else if (item.tier === 'reader_whitelist') tierBadge = `<span class="badge reader-ok">只读白名单</span>`;

      // 当前所属分组胶囊 + 下拉增减分组
      const groupTags = item.groups
        .map(
          g => `<span class="person-group-tag">${escapeHtml(g)} <button class="person-grp-rm" data-action="toggle-contact-group" data-email="${escapeHtml(item.email)}" data-name="${escapeHtml(item.displayName)}" data-group="${escapeHtml(g)}" title="移出该组">×</button></span>`
        )
        .join('');

      const availableGroups = allGroups.filter(g => !item.groups.includes(g.name));
      const groupSelectHtml =
        availableGroups.length > 0
          ? `<select class="person-group-select" data-action="add-contact-group-select" data-email="${escapeHtml(item.email)}" data-name="${escapeHtml(item.displayName)}">
              <option value="">+分组...</option>
              ${availableGroups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('')}
            </select>`
          : '';

      return `<tr>
        <td>
          <div class="collab-email">${escapeHtml(item.displayName)}</div>
          <div class="collab-sub">${escapeHtml(item.email)}</div>
          <div class="person-group-wrap">${groupTags}${groupSelectHtml}</div>
        </td>
        <td>${tierBadge}</td>
        <td>
          <div><strong>${item.files.length}</strong> 文件</div>
          <div class="collab-sub">编辑 ${item.writerCount} / 只读 ${item.readerCount}</div>
        </td>
        <td>
          <div class="row-actions">
            ${item.tier !== 'writer_whitelist' ? `<button class="btn xs secondary" data-action="collab-trust-writer" data-email="${escapeHtml(item.email)}">+编辑白</button>` : ''}
            ${item.tier === 'unlisted' ? `<button class="btn xs secondary" data-action="collab-trust-reader" data-email="${escapeHtml(item.email)}">+只读白</button>` : ''}
            ${item.writerCount > 0 ? `<button class="btn xs warn-outline" data-action="collab-downgrade-all" data-email="${escapeHtml(item.email)}">全降只读</button>` : ''}
            ${item.files.length > 0 ? `<button class="btn xs danger-outline" data-action="collab-revoke-all" data-email="${escapeHtml(item.email)}">全撤</button>` : ''}
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

// ==================== 设置与日志渲染 ====================
function renderPolicyTab() {
  const writers = state.policy.writers || [];
  const readers = state.policy.readers || [];

  el('writers-count').textContent = writers.length;
  el('readers-count').textContent = readers.length;

  el('writers-list').innerHTML = writers.length
    ? writers
        .map(
          item => `<span class="tag-pill writer-pill">
            <span>${escapeHtml(item)}</span>
            <button class="tag-del" data-action="del-writer" data-val="${escapeHtml(item)}">×</button>
          </span>`
        )
        .join('')
    : '<span class="muted">暂无编辑白名单条目</span>';

  el('readers-list').innerHTML = readers.length
    ? readers
        .map(
          item => `<span class="tag-pill reader-pill">
            <span>${escapeHtml(item)}</span>
            <button class="tag-del" data-action="del-reader" data-val="${escapeHtml(item)}">×</button>
          </span>`
        )
        .join('')
    : '<span class="muted">暂无只读白名单条目</span>';

  el('policy-public-rule').value = state.policy.publicAccessRule || 'flag';
  el('policy-schedule-enabled').checked = Boolean(state.policy.schedule?.enabled);
  el('policy-schedule-minutes').value = state.policy.schedule?.intervalMinutes || 60;
  el('auto-enforce-select').value = state.policy.schedule?.autoEnforce ? 'on' : 'off';

  updateTopBadges();
}

function renderLogsTab() {
  const tbody = el('log-rows');
  if (!state.logs.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无操作日志</td></tr>';
    return;
  }

  tbody.innerHTML = state.logs
    .slice(0, 100)
    .map(log => {
      const canRestore =
        log.status === 'success' && !log.restored && log.email && (log.type === 'remove' || log.type === 'downgrade');
      const statusBadge =
        log.status === 'error'
          ? `<span class="badge danger" title="${escapeHtml(log.error || '')}">失败</span>`
          : log.restored
          ? `<span class="badge neutral">已恢复</span>`
          : `<span class="badge ok">成功</span>`;

      const restoreBtn = canRestore
        ? `<button class="btn xs secondary" data-action="restore-log" data-log-id="${escapeHtml(log.id)}">恢复</button>`
        : statusBadge;

      return `<tr>
        <td class="muted">${escapeHtml((log.time || '').slice(5, 19).replace('T', ' '))}</td>
        <td>${escapeHtml(log.actionLabel || log.type)}</td>
        <td title="${escapeHtml(log.fileName || '')}">${escapeHtml(log.targetLabel || log.email || '-')}</td>
        <td>${restoreBtn}</td>
      </tr>`;
    })
    .join('');
}

function renderAll() {
  renderAccountsUI();
  syncTypeDropdownUI();
  renderGroupSelectorsAndBatchBar();
  renderFilesTab();
  renderCollaboratorsTab();
  renderPolicyTab();
  renderLogsTab();
}


// ==================== 扫描与批量执行逻辑 ====================
async function handleScan() {
  if (state.busy) return;
  setBusy(true);
  try {
    setStatus('正在获取授权...');
    const res = await runScanPipeline({
      interactive: true,
      accountFilter: state.currentAccountFilter,
      onProgress(text, pct) {
        setStatus(text);
        setProgress(pct);
      }
    });
    state.files = res.files;
    state.newFileIds = new Set(res.newFileIds);
    state.selectedFileIds.clear();
    state.accounts = await getAuthorizedAccounts();
    setStatus(`扫描完成：共 ${res.files.length} 个文件，新增 ${res.newFileIds.length} 个`);
    renderAll();
  } catch (err) {
    setStatus(`扫描失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function handleEnforceFiles(targetFiles) {
  if (state.busy || !targetFiles.length) return;
  const actionable = targetFiles.filter(f => evaluateFileSummary(f, state.policy).hasActionableViolation);
  if (!actionable.length) {
    setStatus('所选文件均符合当前白名单策略，无需处理');
    return;
  }

  let totalRm = 0;
  let totalDown = 0;
  for (const f of actionable) {
    const s = evaluateFileSummary(f, state.policy);
    totalRm += s.removeCount;
    totalDown += s.downgradeCount;
  }

  if (
    !confirm(
      `确认对 ${actionable.length} 个文件执行白名单合规处理？\n• 移除非白名单权限：${totalRm} 项\n• 越权编辑自动降级为只读：${totalDown} 项`
    )
  ) {
    return;
  }

  setBusy(true);
  try {
    const res = await enforcePolicyOnFiles({
      files: actionable,
      policy: state.policy,
      interactive: true,
      onProgress(text, pct) {
        setStatus(text);
        setProgress(pct);
      }
    });
    await saveScanCache(state.files);
    state.logs = await getLogs();
    setStatus(`执行完成：移除 ${res.removed} 项，降级只读 ${res.downgraded} 项，失败 ${res.errors} 项`);
    renderAll();
  } catch (err) {
    setStatus(`合规执行失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function handleGroupOperationOnFiles(mode) {
  if (state.busy) return;
  const targetFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!targetFiles.length) {
    setStatus('请先在左侧勾选要操作的文件', true);
    return;
  }
  const groupNames = [...state.selectedBatchGroups];
  if (!groupNames.length) {
    setStatus('请先在「按分组批量授权」下拉框中勾选至少一个分组', true);
    return;
  }

  const roleOverride = el('batch-group-role-override').value;
  const sendNotification = el('batch-group-notify').checked;
  const actionText = mode === 'grant' ? '批量授权/同步角色' : '批量撤销分组权限';

  if (!confirm(`确认对已勾选的 ${targetFiles.length} 个文件，按所选分组 [${groupNames.join(', ')}] 执行「${actionText}」？`)) {
    return;
  }

  setBusy(true);
  try {
    const res = await executeGroupBatchOnFiles({
      files: targetFiles,
      groupNames,
      directory: state.directory,
      mode,
      roleOverride,
      sendNotification,
      interactive: true,
      onProgress(text, pct) {
        setStatus(text);
        setProgress(pct);
      }
    });
    await saveScanCache(state.files);
    state.logs = await getLogs();
    setStatus(
      `分组操作完成：新增 ${res.added}，更新 ${res.updated}，移除 ${res.removed}，跳过 ${res.skipped}，失败 ${res.errors}`
    );
    renderAll();
  } catch (err) {
    setStatus(`分组批量操作失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function importParsedContacts(parsed) {
  const { contacts, groups } = parsed;
  if (!contacts.length) {
    setStatus('未识别到有效邮箱（请确保包含邮箱列，如 A列名称、B列邮箱）', true);
    return;
  }

  const existingGroupMap = new Map((state.directory.groups || []).map(g => [g.name, g]));
  for (const gName of groups) {
    if (!existingGroupMap.has(gName)) {
      existingGroupMap.set(gName, { name: gName, defaultRole: 'reader' });
    }
  }
  state.directory.groups = [...existingGroupMap.values()];

  const contactMap = new Map((state.directory.contacts || []).map(c => [normalizeEntry(c.email), c]));
  let added = 0;
  let updated = 0;

  for (const item of contacts) {
    const em = normalizeEntry(item.email);
    if (contactMap.has(em)) {
      const existing = contactMap.get(em);
      if (item.name && (!existing.name || existing.name === em)) existing.name = item.name;
      existing.groups = Array.from(new Set([...(existing.groups || []), ...(item.groups || [])]));
      updated++;
    } else {
      contactMap.set(em, {
        email: em,
        name: item.name || em.split('@')[0],
        groups: item.groups || []
      });
      added++;
    }
  }

  state.directory.contacts = [...contactMap.values()];
  state.directory = await saveDirectory(state.directory);
  setStatus(`导入成功：新增 ${added} 人，更新 ${updated} 人，涉及分组 ${groups.length} 个`);
  renderAll();
}

async function handleInlineRoleChange(fileId, permId, newRole) {
  if (state.busy) return;
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;

  const oldRole = perm.role;
  setBusy(true);
  try {
    const token = await getAuthToken(true, file.ownerAccount);
    setStatus(`正在修改 ${perm.emailAddress || perm.displayName || permId} 的权限为 ${newRole}...`);
    await updatePermissionRole(token, fileId, permId, newRole);
    perm.role = newRole;
    await saveScanCache(state.files);
    await appendLogs([
      {
        type: 'downgrade',
        actionLabel: `修改角色 (${oldRole} → ${newRole})`,
        fileId,
        fileName: file.name,
        permissionId: permId,
        email: perm.emailAddress || '',
        targetLabel: `${perm.emailAddress || perm.displayName || permId} @ ${file.name}`,
        previousRole: oldRole,
        newRole,
        status: 'success'
      }
    ]);
    state.logs = await getLogs();
    setStatus(`已将 ${perm.emailAddress || permId} 修改为 ${newRole}`);
    renderAll();
  } catch (err) {
    setStatus(`修改角色失败：${err.message}`, true);
    renderFilesTab();
  } finally {
    setBusy(false);
  }
}

async function handleRemoveSinglePerm(fileId, permId) {
  if (state.busy) return;
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;

  setBusy(true);
  try {
    const token = await getAuthToken(true, file.ownerAccount);
    setStatus(`正在移除 ${perm.emailAddress || permId}...`);
    await removePermission(token, fileId, permId);
    file.permissions = file.permissions.filter(p => p.id !== permId);
    await saveScanCache(state.files);
    await appendLogs([
      {
        type: 'remove',
        actionLabel: '手动移除权限',
        fileId,
        fileName: file.name,
        permissionId: permId,
        email: perm.emailAddress || '',
        targetLabel: `${perm.emailAddress || perm.displayName || permId} @ ${file.name}`,
        previousRole: perm.role,
        newRole: 'none',
        status: 'success'
      }
    ]);
    state.logs = await getLogs();
    setStatus(`已移除 ${perm.emailAddress || permId}`);
    renderAll();
  } catch (err) {
    setStatus(`移除失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function handleAddCollaboratorToFile(fileId, email, role) {
  if (state.busy) return;
  const cleanEmail = normalizeEntry(email);
  if (!cleanEmail || !cleanEmail.includes('@')) {
    setStatus('请输入有效的邮箱地址', true);
    return;
  }
  const file = state.files.find(f => f.id === fileId);
  if (!file) return;

  setBusy(true);
  try {
    const token = await getAuthToken(true, file.ownerAccount);
    setStatus(`正在为《${file.name}》添加 ${cleanEmail}...`);
    const created = await createPermission(token, fileId, { role, type: 'user', emailAddress: cleanEmail }, false);
    file.permissions = file.permissions || [];
    file.permissions.push(created);
    await saveScanCache(state.files);
    await appendLogs([
      {
        type: 'add',
        actionLabel: `新增权限 (${role})`,
        fileId,
        fileName: file.name,
        permissionId: created.id,
        email: cleanEmail,
        targetLabel: `${cleanEmail} @ ${file.name}`,
        previousRole: 'none',
        newRole: role,
        status: 'success'
      }
    ]);
    state.logs = await getLogs();
    setStatus(`已为《${file.name}》添加 ${cleanEmail}`);
    renderAll();
  } catch (err) {
    setStatus(`添加失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}


async function handleBatchCustomAction() {
  if (state.busy) return;
  const targetFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!targetFiles.length) return;

  const actionType = el('batch-action-type').value;
  const email = normalizeEntry(el('batch-target-email').value);
  const role = el('batch-target-role').value;

  if ((actionType === 'add_user' || actionType === 'remove_user') && !email) {
    setStatus('请在输入框填写目标邮箱或域名', true);
    return;
  }

  if (!confirm(`确认对已勾选的 ${targetFiles.length} 个文件执行此批量操作？`)) return;

  setBusy(true);
  const newLogs = [];
  let successCount = 0;
  let errCount = 0;

  try {
    for (let i = 0; i < targetFiles.length; i++) {
      const file = targetFiles[i];
      const token = await getAuthToken(i === 0, file.ownerAccount);
      setStatus(`正在处理 (${i + 1}/${targetFiles.length})：${file.name}`);
      setProgress(((i + 1) / targetFiles.length) * 100);

      const perms = file.permissions || [];
      if (actionType === 'add_user') {
        try {
          const existing = perms.find(p => normalizeEntry(p.emailAddress) === email);
          if (existing && existing.role !== 'owner') {
            await updatePermissionRole(token, file.id, existing.id, role);
            existing.role = role;
          } else if (!existing) {
            const created = await createPermission(
              token,
              file.id,
              { role, type: 'user', emailAddress: email },
              false
            );
            perms.push(created);
          }
          successCount++;
          newLogs.push({
            type: 'add',
            actionLabel: `批量赋权 (${role})`,
            fileId: file.id,
            fileName: file.name,
            email,
            targetLabel: `${email} @ ${file.name}`,
            newRole: role,
            status: 'success'
          });
        } catch (err) {
          errCount++;
          newLogs.push({
            type: 'add',
            actionLabel: `批量赋权失败`,
            fileId: file.id,
            fileName: file.name,
            email,
            targetLabel: `${email} @ ${file.name}`,
            status: 'error',
            error: err.message
          });
        }
      } else if (actionType === 'remove_user') {
        const matches = perms.filter(
          p =>
            p.role !== 'owner' &&
            (normalizeEntry(p.emailAddress) === email || normalizeEntry(p.domain) === email.replace(/^@/, ''))
        );
        for (const p of matches) {
          try {
            await removePermission(token, file.id, p.id);
            file.permissions = file.permissions.filter(x => x.id !== p.id);
            successCount++;
            newLogs.push({
              type: 'remove',
              actionLabel: '批量移除指定用户',
              fileId: file.id,
              fileName: file.name,
              permissionId: p.id,
              email: p.emailAddress || email,
              targetLabel: `${p.emailAddress || email} @ ${file.name}`,
              previousRole: p.role,
              newRole: 'none',
              status: 'success'
            });
          } catch (err) {
            errCount++;
          }
        }
      } else if (actionType === 'downgrade_all_writers') {
        const writers = perms.filter(p => p.role !== 'owner' && isEditRole(p.role));
        for (const p of writers) {
          try {
            await updatePermissionRole(token, file.id, p.id, 'reader');
            p.role = 'reader';
            successCount++;
            newLogs.push({
              type: 'downgrade',
              actionLabel: '批量降为只读',
              fileId: file.id,
              fileName: file.name,
              permissionId: p.id,
              email: p.emailAddress || '',
              targetLabel: `${p.emailAddress || p.id} @ ${file.name}`,
              previousRole: 'writer',
              newRole: 'reader',
              status: 'success'
            });
          } catch (err) {
            errCount++;
          }
        }
      } else if (actionType === 'remove_public') {
        const pubPerms = perms.filter(p => p.type === 'anyone' || p.type === 'domain');
        for (const p of pubPerms) {
          try {
            await removePermission(token, file.id, p.id);
            file.permissions = file.permissions.filter(x => x.id !== p.id);
            successCount++;
            newLogs.push({
              type: 'remove',
              actionLabel: '移除公开链接',
              fileId: file.id,
              fileName: file.name,
              permissionId: p.id,
              targetLabel: `公开链接 @ ${file.name}`,
              previousRole: p.role,
              newRole: 'none',
              status: 'success'
            });
          } catch (err) {
            errCount++;
          }
        }
      }
    }

    await saveScanCache(state.files);
    if (newLogs.length) await appendLogs(newLogs);
    state.logs = await getLogs();
    setStatus(`批量操作完成：成功 ${successCount} 项，失败 ${errCount} 项`);
    renderAll();
  } catch (err) {
    setStatus(`批量操作异常：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function handleCollabBatchOp(email, mode) {
  if (state.busy) return;
  const targetEmail = normalizeEntry(email);
  const tasks = [];

  for (const file of state.files) {
    for (const p of file.permissions || []) {
      if (p.role === 'owner') continue;
      if (normalizeEntry(p.emailAddress) === targetEmail) {
        if (mode === 'revoke' || (mode === 'downgrade' && isEditRole(p.role))) {
          tasks.push({ file, perm: p });
        }
      }
    }
  }

  if (!tasks.length) {
    setStatus('没有可处理的权限项');
    return;
  }

  const label = mode === 'revoke' ? '全部撤销' : '全部降为只读';
  if (!confirm(`确认对 ${targetEmail} 涉及的 ${tasks.length} 个文件执行「${label}」？`)) return;

  setBusy(true);
  let ok = 0;
  const newLogs = [];
  try {
    for (let i = 0; i < tasks.length; i++) {
      const { file, perm } = tasks[i];
      const token = await getAuthToken(i === 0, file.ownerAccount);
      setStatus(`正在处理 (${i + 1}/${tasks.length})：${file.name}`);
      setProgress(((i + 1) / tasks.length) * 100);
      try {
        if (mode === 'revoke') {
          await removePermission(token, file.id, perm.id);
          file.permissions = file.permissions.filter(x => x.id !== perm.id);
          newLogs.push({
            type: 'remove',
            actionLabel: '按协作者全撤权限',
            fileId: file.id,
            fileName: file.name,
            permissionId: perm.id,
            email: targetEmail,
            targetLabel: `${targetEmail} @ ${file.name}`,
            previousRole: perm.role,
            newRole: 'none',
            status: 'success'
          });
        } else {
          await updatePermissionRole(token, file.id, perm.id, 'reader');
          perm.role = 'reader';
          newLogs.push({
            type: 'downgrade',
            actionLabel: '按协作者全降只读',
            fileId: file.id,
            fileName: file.name,
            permissionId: perm.id,
            email: targetEmail,
            targetLabel: `${targetEmail} @ ${file.name}`,
            previousRole: 'writer',
            newRole: 'reader',
            status: 'success'
          });
        }
        ok++;
      } catch (e) {
        // ignore single error
      }
    }
    await saveScanCache(state.files);
    if (newLogs.length) await appendLogs(newLogs);
    state.logs = await getLogs();
    setStatus(`已对 ${targetEmail} 完成 ${ok}/${tasks.length} 项处理`);
    renderAll();
  } catch (err) {
    setStatus(`操作失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function handleRestoreLog(logId) {
  if (state.busy) return;
  const log = state.logs.find(l => l.id === logId);
  if (!log || !log.email || !log.fileId) return;

  setBusy(true);
  try {
    const file = state.files.find(f => f.id === log.fileId);
    const token = await getAuthToken(true, file?.ownerAccount);
    const restoreRole = log.previousRole && log.previousRole !== 'none' ? log.previousRole : 'reader';
    setStatus(`正在恢复 ${log.email} 在《${log.fileName}》的 ${restoreRole} 权限...`);

    const existing = file?.permissions?.find(p => normalizeEntry(p.emailAddress) === normalizeEntry(log.email));
    if (existing) {
      await updatePermissionRole(token, log.fileId, existing.id, restoreRole);
      existing.role = restoreRole;
    } else {
      const created = await createPermission(
        token,
        log.fileId,
        { role: restoreRole, type: 'user', emailAddress: log.email },
        false
      );
      if (file) {
        file.permissions = file.permissions || [];
        file.permissions.push(created);
      }
    }

    log.restored = true;
    await chrome.storage.local.set({ auditLogs: state.logs });
    await saveScanCache(state.files);
    setStatus(`已成功恢复 ${log.email} 的 ${restoreRole} 权限`);
    renderAll();
  } catch (err) {
    setStatus(`恢复失败：${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

function exportCsv() {
  if (!state.files.length) return;
  const contactLookup = buildContactLookup(state.directory);
  const rows = [
    [
      'File ID',
      'File Name',
      'Core Name',
      'Category',
      'Matched Groups',
      'Permission ID',
      'Role',
      'Type',
      'Email/Domain',
      'Contact Name',
      'Policy Action',
      'Policy Reason'
    ]
  ];

  for (const file of state.files) {
    const coreName = extractCoreFileName(file.name || '');
    const cat = fileDetailedCategory(file);
    const covStr = getFileGroupCoverage(file, state.directory)
      .map(c => `${c.groupName}(${c.matchedCount}/${c.total})`)
      .join('; ');
    for (const p of file.permissions || []) {
      const check = evaluatePermission(p, state.policy);
      const contact = contactLookup.get(normalizeEntry(p.emailAddress || ''));
      rows.push([
        file.id,
        file.name,
        coreName,
        cat,
        covStr,
        p.id,
        p.role,
        p.type,
        p.emailAddress || p.domain || '',
        contact?.name || p.displayName || '',
        check.action,
        check.reason
      ]);
    }
  }

  const csvContent = rows
    .map(r => r.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');

  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drive-permissions-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportPolicyAndDirectoryJson() {
  const payload = {
    writers: state.policy.writers,
    readers: state.policy.readers,
    publicAccessRule: state.policy.publicAccessRule,
    schedule: state.policy.schedule,
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


async function saveAndRefreshPolicy() {
  state.policy = await savePolicy(state.policy);
  chrome.runtime.sendMessage({ type: 'SYNC_ALARM' }).catch(() => {});
  renderAll();
}

// ==================== 初始化与事件绑定 ====================
async function init() {
  state.policy = await getPolicy();
  state.directory = await getDirectory();
  state.logs = await getLogs();
  state.oauthClients = await getOAuthClients();
  state.accounts = await getAuthorizedAccounts();

  const cache = await loadScanCache();
  state.files = cache.files || [];
  state.newFileIds = new Set(cache.newFileIds || []);

  if (cache.lastScanTime) {
    setStatus(`上次扫描：${cache.lastScanTime.slice(0, 19).replace('T', ' ')}（共 ${state.files.length} 个文件）`);
  }

  renderAll();

  // 1. 右侧标签页切换
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.tab-btn')) b.classList.remove('active');
      for (const p of document.querySelectorAll('.tab-panel')) p.classList.remove('active');
      btn.classList.add('active');
      el(`panel-${btn.dataset.tab}`)?.classList.add('active');
    });
  }

  // 2. 顶部按钮与账号切换下拉
  el('scan').addEventListener('click', handleScan);
  el('export').addEventListener('click', exportCsv);
  el('quick-enforce-all').addEventListener('click', () => handleEnforceFiles(state.files));
  el('clear-new-flags').addEventListener('click', async () => {
    await clearNewFileMarkers();
    state.newFileIds.clear();
    renderFilesTab();
    setStatus('已清除新文件标记');
  });

  el('account-switcher').addEventListener('change', e => {
    const val = e.target.value;
    if (val === '__manage__') {
      e.target.value = state.currentAccountFilter;
      // 切换到「设置」标签页
      for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === 'settings');
      for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'panel-settings');
      return;
    }
    state.currentAccountFilter = val;
    renderFilesTab();
  });

  // 3. 下拉多选组件开关与点击外部关闭
  el('type-dropdown-btn').addEventListener('click', e => {
    e.stopPropagation();
    el('batch-group-dropdown-menu').hidden = true;
    el('type-dropdown-menu').hidden = !el('type-dropdown-menu').hidden;
  });

  el('batch-group-dropdown-btn').addEventListener('click', e => {
    e.stopPropagation();
    el('type-dropdown-menu').hidden = true;
    el('batch-group-dropdown-menu').hidden = !el('batch-group-dropdown-menu').hidden;
  });

  el('type-dropdown-menu').addEventListener('click', e => e.stopPropagation());
  el('batch-group-dropdown-menu').addEventListener('click', e => e.stopPropagation());

  document.addEventListener('click', () => {
    if (el('type-dropdown-menu')) el('type-dropdown-menu').hidden = true;
    if (el('batch-group-dropdown-menu')) el('batch-group-dropdown-menu').hidden = true;
  });

  // 4. 文件类型下拉：勾选、全选、反选
  el('type-checkbox-list').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"][data-cat]');
    if (!cb) return;
    if (cb.checked) state.selectedTypeCats.add(cb.dataset.cat);
    else state.selectedTypeCats.delete(cb.dataset.cat);
    syncTypeDropdownUI();
    renderFilesTab();
  });

  el('type-select-all').addEventListener('click', () => {
    state.selectedTypeCats = new Set(ALL_TYPE_CATS);
    syncTypeDropdownUI();
    renderFilesTab();
  });

  el('type-invert-select').addEventListener('click', () => {
    const next = new Set();
    for (const c of ALL_TYPE_CATS) {
      if (!state.selectedTypeCats.has(c)) next.add(c);
    }
    state.selectedTypeCats = next;
    syncTypeDropdownUI();
    renderFilesTab();
  });

  // 5. 批量分组下拉：勾选、全选、反选
  el('batch-group-checkboxes').addEventListener('change', e => {
    const cb = e.target.closest('.batch-group-check');
    if (!cb) return;
    if (cb.checked) state.selectedBatchGroups.add(cb.value);
    else state.selectedBatchGroups.delete(cb.value);
    renderGroupSelectorsAndBatchBar();
  });

  el('batch-grp-select-all').addEventListener('click', () => {
    for (const g of state.directory.groups || []) state.selectedBatchGroups.add(g.name);
    renderGroupSelectorsAndBatchBar();
  });

  el('batch-grp-invert').addEventListener('click', () => {
    const next = new Set();
    for (const g of state.directory.groups || []) {
      if (!state.selectedBatchGroups.has(g.name)) next.add(g.name);
    }
    state.selectedBatchGroups = next;
    renderGroupSelectorsAndBatchBar();
  });

  el('batch-grant-groups-btn').addEventListener('click', () => handleGroupOperationOnFiles('grant'));
  el('batch-revoke-groups-btn').addEventListener('click', () => handleGroupOperationOnFiles('revoke'));

  // 6. 左侧顶部状态筛选卡片
  el('summary').addEventListener('click', e => {
    const card = e.target.closest('.summary-card');
    if (!card) return;
    state.statusFilter = card.dataset.filter || 'all';
    renderFilesTab();
  });

  // 7. 搜索与高级筛选控件
  el('search').addEventListener('input', renderFilesTab);
  el('search-match-mode').addEventListener('change', renderFilesTab);
  el('exclude-keywords-input').addEventListener('input', renderFilesTab);
  el('name-pattern-filter').addEventListener('change', renderFilesTab);
  el('file-group-filter').addEventListener('change', renderFilesTab);

  el('select-messy-duplicates').addEventListener('click', () => {
    const coreCounts = getCoreNameClusterCounts();
    let count = 0;
    for (const f of getFilteredFiles()) {
      const core = extractCoreFileName(f.name || '');
      if ((coreCounts.get(core) || 0) >= 2) {
        state.selectedFileIds.add(f.id);
        count++;
      }
    }
    renderFilesTab();
    setStatus(`已自动勾选 ${count} 个同名/重复版本文件`);
  });

  el('reset-adv-filters').addEventListener('click', () => {
    el('search').value = '';
    el('search-match-mode').value = 'fuzzy';
    el('exclude-keywords-input').value = '';
    el('name-pattern-filter').value = 'all';
    el('file-group-filter').value = 'all';
    state.statusFilter = 'all';
    state.selectedTypeCats = new Set(ALL_TYPE_CATS);
    syncTypeDropdownUI();
    renderFilesTab();
    setStatus('已重置所有筛选条件');
  });

  // 8. 左侧文件表格勾选与行内操作
  el('select-all').addEventListener('change', e => {
    const filtered = getFilteredFiles();
    if (e.target.checked) {
      for (const f of filtered) state.selectedFileIds.add(f.id);
    } else {
      for (const f of filtered) state.selectedFileIds.delete(f.id);
    }
    renderFilesTab();
  });

  el('batch-enforce').addEventListener('click', () => {
    const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
    handleEnforceFiles(selected);
  });

  el('batch-action-type').addEventListener('change', e => {
    const v = e.target.value;
    el('batch-target-email').hidden = v === 'downgrade_all_writers' || v === 'remove_public';
    el('batch-target-role').hidden = v !== 'add_user';
  });

  el('batch-apply-btn').addEventListener('click', handleBatchCustomAction);

  el('file-rows').addEventListener('change', e => {
    const target = e.target;
    if (target.classList.contains('file-check')) {
      const id = target.dataset.fileId;
      if (target.checked) state.selectedFileIds.add(id);
      else state.selectedFileIds.delete(id);
      updateBatchButtons();
    } else if (target.dataset.action === 'change-role') {
      handleInlineRoleChange(target.dataset.fileId, target.dataset.permId, target.value);
    }
  });

  el('file-rows').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'remove-perm') {
      handleRemoveSinglePerm(btn.dataset.fileId, btn.dataset.permId);
    } else if (action === 'quick-trust') {
      const email = normalizeEntry(btn.dataset.email);
      const role = btn.dataset.role;
      if (isEditRole(role)) {
        if (!state.policy.writers.includes(email)) state.policy.writers.push(email);
        setStatus(`已将 ${email} 加入「编辑白名单」`);
      } else {
        if (!state.policy.readers.includes(email)) state.policy.readers.push(email);
        setStatus(`已将 ${email} 加入「只读白名单」`);
      }
      await saveAndRefreshPolicy();
    } else if (action === 'add-perm') {
      const fileId = btn.dataset.fileId;
      const emailInput = document.querySelector(`.inline-email-input[data-file-id="${CSS.escape(fileId)}"]`);
      const roleSelect = document.querySelector(`.inline-role-select[data-file-id="${CSS.escape(fileId)}"]`);
      if (emailInput && roleSelect) {
        await handleAddCollaboratorToFile(fileId, emailInput.value, roleSelect.value);
      }
    } else if (action === 'enforce-file') {
      const file = state.files.find(f => f.id === btn.dataset.fileId);
      if (file) handleEnforceFiles([file]);
    }
  });

  // 9. 「人员与分组」标签页交互
  el('collab-group-filter').addEventListener('change', renderCollaboratorsTab);
  el('collab-search').addEventListener('input', renderCollaboratorsTab);
  el('collab-filter').addEventListener('change', renderCollaboratorsTab);

  el('quick-filter-left-by-group').addEventListener('click', () => {
    const grp = el('collab-group-filter').value;
    el('file-group-filter').value = grp === 'all' ? 'all' : `grp:${grp}`;
    renderFilesTab();
    setStatus(grp === 'all' ? '左侧已显示全部文件' : `左侧已筛选包含分组「${grp}」的文件`);
  });

  el('panel-collaborators').addEventListener('change', async e => {
    const sel = e.target.closest('select[data-action="add-contact-group-select"]');
    if (!sel || !sel.value) return;
    const email = normalizeEntry(sel.dataset.email);
    const name = sel.dataset.name || email;
    const grp = sel.value;

    let contact = (state.directory.contacts || []).find(c => normalizeEntry(c.email) === email);
    if (!contact) {
      contact = { email, name, groups: [grp] };
      state.directory.contacts.push(contact);
    } else if (!contact.groups.includes(grp)) {
      contact.groups.push(grp);
    }
    state.directory = await saveDirectory(state.directory);
    renderAll();
  });

  el('panel-collaborators').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'group-trust-writers' || action === 'group-trust-readers') {
      const grp = btn.dataset.group;
      const members = (state.directory.contacts || []).filter(c => (c.groups || []).includes(grp));
      for (const m of members) {
        const em = normalizeEntry(m.email);
        if (action === 'group-trust-writers') {
          if (!state.policy.writers.includes(em)) state.policy.writers.push(em);
        } else {
          if (!state.policy.readers.includes(em)) state.policy.readers.push(em);
        }
      }
      await saveAndRefreshPolicy();
      setStatus(`已将「${grp}」共 ${members.length} 人加入白名单`);
    } else if (action === 'toggle-contact-group') {
      const email = normalizeEntry(btn.dataset.email);
      const grp = btn.dataset.group;
      const contact = (state.directory.contacts || []).find(c => normalizeEntry(c.email) === email);
      if (contact) {
        contact.groups = (contact.groups || []).filter(g => g !== grp);
        state.directory = await saveDirectory(state.directory);
        renderAll();
      }
    } else if (action === 'collab-trust-writer') {
      const email = normalizeEntry(btn.dataset.email);
      if (!state.policy.writers.includes(email)) state.policy.writers.push(email);
      await saveAndRefreshPolicy();
      setStatus(`已将 ${email} 加入编辑白名单`);
    } else if (action === 'collab-trust-reader') {
      const email = normalizeEntry(btn.dataset.email);
      if (!state.policy.readers.includes(email)) state.policy.readers.push(email);
      await saveAndRefreshPolicy();
      setStatus(`已将 ${email} 加入只读白名单`);
    } else if (action === 'collab-downgrade-all') {
      handleCollabBatchOp(btn.dataset.email, 'downgrade');
    } else if (action === 'collab-revoke-all') {
      handleCollabBatchOp(btn.dataset.email, 'revoke');
    }
  });

  // 10. 「设置」标签页交互：JSON授权、分组、名单导入、白名单、定时
  el('oauth-json-file').addEventListener('change', async e => {
    await handleUploadOAuthJson(e.target.files?.[0]);
    e.target.value = '';
  });

  el('add-account-btn').addEventListener('click', handleAddAccountLogin);

  el('panel-settings').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'delete-account') {
      const email = btn.dataset.email;
      state.accounts = await removeAuthorizedAccount(email);
      if (state.currentAccountFilter === email) state.currentAccountFilter = 'all';
      renderAll();
      setStatus(`已移除账号 ${email}`);
    } else if (action === 'delete-oauth-client') {
      state.oauthClients = await removeOAuthClient(btn.dataset.clientId);
      renderAccountsUI();
      setStatus('已删除 OAuth JSON 配置');
    } else if (action === 'delete-group') {
      const gName = btn.dataset.group;
      if (!confirm(`确定删除分组「${gName}」？（不会删除联系人本身）`)) return;
      state.directory.groups = (state.directory.groups || []).filter(g => g.name !== gName);
      for (const c of state.directory.contacts || []) {
        c.groups = (c.groups || []).filter(g => g !== gName);
      }
      state.selectedBatchGroups.delete(gName);
      state.directory = await saveDirectory(state.directory);
      renderAll();
      setStatus(`已删除分组「${gName}」`);
    } else if (action === 'del-writer') {
      state.policy.writers = state.policy.writers.filter(x => x !== btn.dataset.val);
      await saveAndRefreshPolicy();
    } else if (action === 'del-reader') {
      state.policy.readers = state.policy.readers.filter(x => x !== btn.dataset.val);
      await saveAndRefreshPolicy();
    }
  });

  el('create-group-btn').addEventListener('click', async () => {
    const name = el('new-group-name').value.trim();
    const defaultRole = el('new-group-role').value;
    if (!name) {
      setStatus('请输入分组名称（如：1组、2组）', true);
      return;
    }
    const exists = (state.directory.groups || []).find(g => g.name === name);
    if (exists) exists.defaultRole = defaultRole;
    else state.directory.groups.push({ name, defaultRole });

    el('new-group-name').value = '';
    state.directory = await saveDirectory(state.directory);
    renderAll();
    setStatus(`已保存分组「${name}」`);
  });

  el('import-contacts-csv').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const defaultGroup = el('import-target-group-select').value;
      const parsed = parseTabularContactsText(text, defaultGroup);
      await importParsedContacts(parsed);
    } catch (err) {
      setStatus(`读取表格失败：${err.message}`, true);
    } finally {
      e.target.value = '';
    }
  });

  el('parse-paste-contacts-btn').addEventListener('click', async () => {
    const text = el('paste-contacts-textarea').value.trim();
    if (!text) {
      setStatus('请先粘贴表格内容（A列名称，B列邮箱）', true);
      return;
    }
    const defaultGroup = el('import-target-group-select').value;
    const parsed = parseTabularContactsText(text, defaultGroup);
    await importParsedContacts(parsed);
    el('paste-contacts-textarea').value = '';
  });

  el('fetch-drive-sheet-contacts-btn').addEventListener('click', async () => {
    const urlOrId = el('drive-sheet-url-input').value.trim() || el('drive-sheet-picker').value;
    if (!urlOrId) {
      setStatus('请先选择云端表格或输入 Google 表格链接', true);
      return;
    }
    const defaultGroup = el('import-target-group-select').value;
    setBusy(true);
    try {
      const token = await getAuthToken(true, state.currentAccountFilter);
      setStatus('正在从 Google 表格读取联系人...');
      const parsed = await fetchContactsFromGoogleSheet(token, urlOrId, defaultGroup);
      await importParsedContacts(parsed);
    } catch (err) {
      setStatus(`从 Google 表格导入失败：${err.message}`, true);
    } finally {
      setBusy(false);
    }
  });

  const addPolicyItem = async (tier, inputId) => {
    const input = el(inputId);
    const raw = input.value
      .split(/[,;\s\n]+/)
      .map(normalizeEntry)
      .filter(Boolean);
    if (!raw.length) return;
    state.policy[tier] = Array.from(new Set([...(state.policy[tier] || []), ...raw]));
    input.value = '';
    await saveAndRefreshPolicy();
  };

  el('add-writer-btn').addEventListener('click', () => addPolicyItem('writers', 'add-writer-input'));
  el('add-reader-btn').addEventListener('click', () => addPolicyItem('readers', 'add-reader-input'));

  el('policy-public-rule').addEventListener('change', async e => {
    state.policy.publicAccessRule = e.target.value;
    await saveAndRefreshPolicy();
  });

  el('policy-schedule-enabled').addEventListener('change', async e => {
    state.policy.schedule.enabled = e.target.checked;
    await saveAndRefreshPolicy();
  });

  el('policy-schedule-minutes').addEventListener('change', async e => {
    state.policy.schedule.intervalMinutes = Math.max(5, Number(e.target.value) || 60);
    await saveAndRefreshPolicy();
  });

  el('auto-enforce-select').addEventListener('change', async e => {
    state.policy.schedule.autoEnforce = e.target.value === 'on';
    await saveAndRefreshPolicy();
  });

  el('trust-all-current-writers').addEventListener('click', async () => {
    const addedWriters = new Set(state.policy.writers);
    const addedReaders = new Set(state.policy.readers);
    for (const f of state.files) {
      for (const p of f.permissions || []) {
        if (p.role === 'owner' || !p.emailAddress) continue;
        const em = normalizeEntry(p.emailAddress);
        if (isEditRole(p.role)) addedWriters.add(em);
        else addedReaders.add(em);
      }
    }
    state.policy.writers = [...addedWriters];
    state.policy.readers = [...addedReaders];
    await saveAndRefreshPolicy();
    setStatus('已将当前扫描到的所有协作者按现有角色导入对应白名单');
  });

  el('export-policy-json').addEventListener('click', exportPolicyAndDirectoryJson);

  el('json-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (Array.isArray(parsed)) {
        state.policy.writers = Array.from(new Set([...state.policy.writers, ...parsed.map(normalizeEntry)]));
      } else {
        if (Array.isArray(parsed.writers)) {
          state.policy.writers = Array.from(new Set([...state.policy.writers, ...parsed.writers.map(normalizeEntry)]));
        }
        if (Array.isArray(parsed.readers)) {
          state.policy.readers = Array.from(new Set([...state.policy.readers, ...parsed.readers.map(normalizeEntry)]));
        }
        if (Array.isArray(parsed.allowList)) {
          state.policy.writers = Array.from(new Set([...state.policy.writers, ...parsed.allowList.map(normalizeEntry)]));
        }
        if (Array.isArray(parsed.groups) || Array.isArray(parsed.contacts)) {
          state.directory = await saveDirectory({
            groups: parsed.groups || state.directory.groups,
            contacts: parsed.contacts || state.directory.contacts
          });
        }
      }
      await saveAndRefreshPolicy();
      setStatus('配置 JSON 导入成功');
    } catch (err) {
      setStatus(`JSON 导入失败：${err.message}`, true);
    } finally {
      e.target.value = '';
    }
  });

  // 11. 「日志」标签页交互
  el('clear-logs').addEventListener('click', async () => {
    await clearLogs();
    state.logs = [];
    renderLogsTab();
    setStatus('操作日志已清空');
  });

  el('log-rows').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action="restore-log"]');
    if (btn) handleRestoreLog(btn.dataset.logId);
  });
}

init();
