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
  isUpdatingBatchSheet: false,
  batchMasterRows: Array.from({ length: 25 }, () => ['', '', '', '', '', '', '', '']),
  batchVisibleRowMap: Array.from({ length: 25 }, (_, i) => i),
  transferSheet: null,
  isUpdatingTransferSheet: false,
  transferRunning: false,
  transferPauseRequested: false,
  transferState: {
    sourceEmail: '',
    targetEmail: '',
    autoAccept: true,
    lastScannedAt: '',
    lastUpdatedAt: '',
    items: [],
    logs: []
  }
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
      const isSa = c.client_type === 'service_account' || Boolean(c.client_email && c.private_key);
      const typeIcon = isSa ? '🤖 服务账号' : '🖥️ OAuth客户端';
      const boundList = Array.isArray(c.boundEmails) && c.boundEmails.length
        ? c.boundEmails.join(', ')
        : c.boundEmail || '';
      const bound = boundList ? `已授权: ${boundList}` : '未授权';
      const statusCls = boundList ? 'ok' : 'warning';
      const btnText = isSa
        ? '刷新令牌'
        : boundList
        ? '🌐 再登录其他邮箱 / 重授'
        : '🌐 弹出浏览器登录';
      return `<div class="allow-item" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(c.client_id)}">
          <strong>${escapeHtml(name)}</strong>
          <span class="badge" style="margin-left:4px;">${typeIcon}</span>
          <span class="status-pill ${statusCls}" style="margin-left:4px;">${escapeHtml(bound)}</span>
        </span>
        <span class="row-flex" style="flex-shrink:0;">
          <button type="button" class="btn btn-xs primary" data-action="auth-oauth-client" data-uid="${escapeHtml(uid)}" title="使用此 JSON 凭证弹出浏览器选择任意 Google 邮箱登录（同一个桌面 OAuth 凭证可连续登录多个浏览器邮箱）">${btnText}</button>
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
            <button type="button" class="btn-text" style="padding:0 3px;font-size:11px;color:#0284c7;" data-action="export-single-account" data-email="${escapeHtml(acc.email)}" title="单独导出此账号的免登录授权 JSON 文件（复制到其他电脑导入即可直接用）">💾导出</button>
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

async function handleAuthorizeWithClient(client, prefixLabel = '', loginHint = '') {
  setStatus(`${prefixLabel}等待 Google 授权…`);
  $('progress').textContent = `${prefixLabel}请在弹出的 Google 页面选择要授权的邮箱完成登录（凭证：${client.fileName || client.client_id.slice(0, 12)}）…`;
  try {
    const account = await authorizeWithOAuthClient(client, loginHint);
    state.accounts = await getAuthorizedAccounts();
    state.oauthClients = await getOAuthClients();
    renderAll();
    $('progress').textContent = `已成功授权账号：${account.email}（当前共已授权 ${state.accounts.length} 个账号）`;
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
  let passportAccountCount = 0;
  let passportRestoredTransfer = 0;

  for (const file of files) {
    try {
      const parsed = JSON.parse(await file.text());
      // 1. 优先识别「已授权免登录通行证 JSON」或含 refresh_token 的 token.json
      const passportRes = await importAuthorizedPassportFromObject(parsed);
      if (passportRes.imported) {
        passportAccountCount += passportRes.accountCount;
        passportRestoredTransfer += passportRes.restoredTransferCount;
        if (parsed.policy || parsed.groups || parsed.contacts) {
          await importAllowlistFromObject(parsed);
        }
        continue;
      }

      // 2. 识别常规未授权的 Google OAuth 桌面客户端 JSON 或 Service Account JSON
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

  if (passportAccountCount > 0) {
    state.accounts = await getAuthorizedAccounts();
    state.oauthClients = await getOAuthClients();
    state.transferState = await getOwnershipTransferState();
    renderAll();
    const tfMsg = passportRestoredTransfer > 0 ? `，并恢复 ${passportRestoredTransfer} 条全盘转移断点进度` : '';
    $('progress').textContent = `已免登录导入 ${passportAccountCount} 个已授权账号${tfMsg}（无需浏览器登录，可直接操作）`;
    toast(`✅ 已成功导入 ${passportAccountCount} 个免登录授权账号${tfMsg}！`);
  }

  if (extractedClients.length > 0) {
    state.oauthClients = await saveOAuthClients(extractedClients);
    renderAccountsUI();
    toast(`已导入 ${extractedClients.length} 个 JSON 授权文件，开始逐一完成授权…`);
    let successCount = 0;
    for (let i = 0; i < extractedClients.length; i++) {
      const prefix = extractedClients.length > 1 ? `[${i + 1}/${extractedClients.length}] ` : '';
      const acc = await handleAuthorizeWithClient(extractedClients[i], prefix);
      if (acc) successCount++;
    }
    $('progress').textContent = `已完成 ${successCount}/${extractedClients.length} 个凭证授权（当前共 ${state.accounts.length} 个已授权账号）。`;
  } else if (!allowlistImported && passportAccountCount === 0) {
    toast('未识别到有效的 Google OAuth 凭证或免登录授权文件');
  }
}

async function exportAuthorizedPassportJson(onlyEmail = '', includeTransferState = true) {
  const bundle = await buildAuthorizedPassportBundle({ onlyEmail, includeTransferState });
  if (!bundle.authorizedAccounts.length && !bundle.oauthClients.length) {
    toast('当前还没有已授权的账号可导出，请先完成账号授权');
    return;
  }
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  const suffix = onlyEmail ? `-${onlyEmail.split('@')[0]}` : `-all-${bundle.authorizedAccounts.length}accounts`;
  a.download = `drive-auth-passport${suffix}-${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(
    onlyEmail
      ? `💾 已导出账号 ${onlyEmail} 的免登录授权文件（复制到其他电脑导入即可直接用）`
      : `💾 已导出全部 ${bundle.authorizedAccounts.length} 个已授权账号的免登录通行证 JSON（复制到其他电脑导入即可免登录直接使用）`
  );
}

async function handleAddMoreAccount(loginHint = '', roleTarget = '') {
  state.oauthClients = await getOAuthClients();
  // 只筛选支持弹出浏览器登录的桌面/Web OAuth 客户端凭证（排除 Service Account JSON）
  const interactiveClients = state.oauthClients.filter(
    c => c.client_type !== 'service_account' && c.client_id && c.client_secret
  );

  if (!interactiveClients.length) {
    if (state.oauthClients.length > 0) {
      toast('当前仅导入了 Service Account 服务账号 JSON（免登录机器人号）。如需授权浏览器登录的个人邮箱，请导入桌面端 OAuth Client JSON 文件！');
    }
    $('oauth-json-file').click();
    return null;
  }

  // 轮询选择可用 OAuth 凭证（支持同一个凭证登录第2个邮箱，也支持在多个导入的凭证间自动切换尝试）
  state.lastUsedOAuthIdx = ((state.lastUsedOAuthIdx ?? -1) + 1) % interactiveClients.length;
  const unboundClient = interactiveClients.find(c => !c.boundEmail && !c._attemptedOnce);
  let chosenClient = unboundClient || interactiveClients[state.lastUsedOAuthIdx];
  chosenClient._attemptedOnce = true;

  const cleanHint = typeof loginHint === 'string' ? normalizeEntry(loginHint) : '';
  let acc = await handleAuthorizeWithClient(chosenClient, '', cleanHint);

  // 如果用户导入了多个不同的 OAuth JSON 文件（如每个邮箱来自不同 Google Cloud 项目），当前凭证报错时自动尝试下一个凭证
  if (!acc && interactiveClients.length > 1) {
    for (const altClient of interactiveClients) {
      if (altClient.uid === chosenClient.uid) continue;
      toast(`正在自动切换尝试另一个 JSON 凭证（${altClient.fileName}）进行浏览器授权…`);
      acc = await handleAuthorizeWithClient(altClient, `[切换凭证 ${altClient.fileName}] `, cleanHint);
      if (acc) break;
    }
  }

  if (acc && roleTarget === 'source') {
    state.transferState.sourceEmail = normalizeEntry(acc.email);
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
  } else if (acc && roleTarget === 'target') {
    state.transferState.targetEmail = normalizeEntry(acc.email);
    if ($('transfer-target-email-input')) $('transfer-target-email-input').value = normalizeEntry(acc.email);
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
  }
  return acc;
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
    state.batchMasterRows = initialRows.map(r => [...r]);
    state.batchVisibleRowMap = initialRows.map((_, i) => i);
    state.batchLinksSheet = jspreadsheet(batchHost, {
      data: initialRows,
      columns: [
        { type: 'text', title: 'A. 文件/文件夹链接 (Ctrl+V粘贴)', width: 225, align: 'left' },
        { type: 'text', title: 'B. 待核查/授权邮箱 (如 sa-140@...)', width: 195, align: 'left' },
        { type: 'text', title: 'C. 类型', width: 95, readOnly: true, align: 'left' },
        { type: 'text', title: 'D. 文件/文件夹名称', width: 185, readOnly: true, align: 'left' },
        { type: 'text', title: 'E. 我对它的权限', width: 135, readOnly: true, align: 'left' },
        { type: 'dropdown', title: 'F. 当前链接权限 (可下拉改)', width: 165, source: PUBLIC_LINK_DROPDOWN_SOURCE, align: 'left' },
        { type: 'text', title: 'G. B列可读性 / 授权人数', width: 180, readOnly: true, align: 'left' },
        { type: 'text', title: 'H. 执行状态 / 缺失账号明细', width: 225, readOnly: true, align: 'left' }
      ],
      minDimensions: [8, 25],
      columnSorting: true,
      tableOverflow: true,
      tableWidth: '100%',
      tableHeight: '100%',
      allowInsertColumn: false,
      allowDeleteColumn: false,
      onchange(instance, cell, x, y, value) {
        if (state.isUpdatingBatchSheet) return;
        const col = Number(x);
        const row = Number(y);
        const masterIdx = state.batchVisibleRowMap[row] ?? row;
        while (state.batchMasterRows.length <= masterIdx) {
          state.batchMasterRows.push(['', '', '', '', '', '', '', '']);
        }
        state.batchMasterRows[masterIdx][col] = value ?? '';

        if (col === 0 || col === 1) {
          syncBatchSheetToInputs();
        } else if (col === 5 && value) {
          const rawLink = state.batchMasterRows[masterIdx]?.[0] || '';
          const parsedIds = parseDriveLinksInput(rawLink);
          if (parsedIds.length > 0) {
            handleBatchRowPublicModeChange(parsedIds[0], row, masterIdx, value);
          }
        }
      },
      onpaste() {
        if (!state.isUpdatingBatchSheet) {
          setTimeout(() => {
            if (!isBatchFilterActive()) {
              const sheetRows = state.batchLinksSheet.getData() || [];
              state.batchMasterRows = sheetRows.map(r => [...r]);
              state.batchVisibleRowMap = sheetRows.map((_, i) => i);
            }
            syncBatchSheetToInputs();
          }, 20);
        }
      }
    });
  }

  const transferHost = $('transfer-spreadsheet-grid');
  if (transferHost && !state.transferSheet) {
    state.transferSheet = jspreadsheet(transferHost, {
      data: [['-', '尚未扫描来源邮箱，请先在上方左侧选择来源邮箱并点击「🔍 扫描来源全盘所有权文件」', '', '', '', '', '', '']],
      columns: [
        { type: 'text', title: 'A. 类型', width: 95, readOnly: true, align: 'left' },
        { type: 'text', title: 'B. 文件夹/文件名称', width: 220, readOnly: true, align: 'left' },
        { type: 'text', title: 'C. 来源邮箱 (左)', width: 170, readOnly: true, align: 'left' },
        { type: 'text', title: 'D. 接收邮箱 (右)', width: 170, readOnly: true, align: 'left' },
        { type: 'text', title: 'E. 当前实际所有者 (对比)', width: 175, readOnly: true, align: 'left' },
        { type: 'text', title: 'F. 转移阶段状态', width: 215, readOnly: true, align: 'left' },
        { type: 'text', title: 'G. 更新时间 / 错误详情', width: 185, readOnly: true, align: 'left' },
        { type: 'text', title: 'H. 文件链接 / ID', width: 175, readOnly: true, align: 'left' }
      ],
      minDimensions: [8, 12],
      columnSorting: true,
      tableOverflow: true,
      tableWidth: '100%',
      tableHeight: '100%',
      pagination: 100,
      paginationOptions: [50, 100, 200, 500],
      allowInsertRow: false,
      allowInsertColumn: false,
      allowDeleteRow: false,
      allowDeleteColumn: false
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

async function handleBatchRowPublicModeChange(fileId, visibleRowIndex, masterRowIndex, publicMode) {
  if (!fileId || !state.batchLinksSheet) return;
  try {
    state.isUpdatingBatchSheet = true;
    state.batchLinksSheet.setValueFromCoords(7, visibleRowIndex, '⏳ 正在修改公开权限…', true);
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
      if (item.fileName) {
        state.batchLinksSheet.setValueFromCoords(3, visibleRowIndex, item.fileName, true);
        if (state.batchMasterRows[masterRowIndex]) state.batchMasterRows[masterRowIndex][3] = item.fileName;
      }
      const statusMsg = `✅ ${item.status}`;
      state.batchLinksSheet.setValueFromCoords(7, visibleRowIndex, statusMsg, true);
      if (state.batchMasterRows[masterRowIndex]) {
        state.batchMasterRows[masterRowIndex][5] = publicMode;
        state.batchMasterRows[masterRowIndex][7] = statusMsg;
      }
      toast(`已更新链接权限：${item.status}`);
    } else {
      const failMsg = `❌ ${item?.status || '修改失败'}`;
      state.batchLinksSheet.setValueFromCoords(7, visibleRowIndex, failMsg, true);
      if (state.batchMasterRows[masterRowIndex]) state.batchMasterRows[masterRowIndex][7] = failMsg;
      toast(`修改失败：${item?.status || '未知错误'}`);
    }
  } catch (err) {
    state.isUpdatingBatchSheet = true;
    const errMsg = `❌ ${err.message}`;
    state.batchLinksSheet.setValueFromCoords(7, visibleRowIndex, errMsg, true);
    if (state.batchMasterRows[masterRowIndex]) state.batchMasterRows[masterRowIndex][7] = errMsg;
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

function isBatchFilterActive() {
  const kw = ($('batch-filter-keyword')?.value || '').trim();
  const myAccess = $('batch-filter-my-access')?.value || 'all';
  const linkPerm = $('batch-filter-link-perm')?.value || 'all';
  const typeVal = $('batch-filter-type')?.value || 'all';
  const execVal = $('batch-filter-exec-status')?.value || 'all';
  return Boolean(kw || myAccess !== 'all' || linkPerm !== 'all' || typeVal !== 'all' || execVal !== 'all');
}

function matchesBatchRowFilter(row = []) {
  const linkStr = String(row[0] || '').trim();
  const emailStr = String(row[1] || '').trim();
  if (!linkStr && !emailStr) return false;

  const kw = ($('batch-filter-keyword')?.value || '').trim().toLowerCase();
  if (kw) {
    const joined = row.map(c => String(c || '').toLowerCase()).join(' ');
    if (!joined.includes(kw)) return false;
  }

  const myAccess = $('batch-filter-my-access')?.value || 'all';
  const colMy = String(row[4] || '');
  if (myAccess !== 'all') {
    if (myAccess === 'can_manage') {
      if (!colMy.includes('所有者') && !(colMy.includes('可编辑') && !colMy.includes('不可改权限'))) return false;
    } else if (myAccess === 'owner') {
      if (!colMy.includes('所有者')) return false;
    } else if (myAccess === 'writer') {
      if (!colMy.includes('可编辑')) return false;
    } else if (myAccess === 'commenter') {
      if (!colMy.includes('可评论')) return false;
    } else if (myAccess === 'reader') {
      if (!colMy.includes('仅可查看') && !colMy.includes('只读')) return false;
    } else if (myAccess === 'no_access') {
      if (!colMy.includes('无权限') && !colMy.includes('无效')) return false;
    } else if (myAccess === 'unscanned') {
      if (colMy && !colMy.includes('检测中')) return false;
    }
  }

  const linkPerm = $('batch-filter-link-perm')?.value || 'all';
  const colPub = String(row[5] || '');
  if (linkPerm !== 'all') {
    if (linkPerm === 'anyone_writer' && colPub !== 'anyone_writer') return false;
    if (linkPerm === 'anyone_commenter' && colPub !== 'anyone_commenter') return false;
    if (linkPerm === 'anyone_reader' && colPub !== 'anyone_reader') return false;
    if (linkPerm === 'anyone_any' && !['anyone_writer', 'anyone_commenter', 'anyone_reader'].includes(colPub)) {
      return false;
    }
    if (linkPerm === 'anyone_off' && colPub !== 'anyone_off') return false;
  }

  const typeVal = $('batch-filter-type')?.value || 'all';
  const colType = String(row[2] || '');
  if (typeVal !== 'all') {
    if (typeVal === 'folder' && !colType.includes('文件夹')) return false;
    if (typeVal === 'sheet' && !colType.includes('表格') && !colType.includes('Excel')) return false;
    if (typeVal === 'doc' && !colType.includes('文档') && !colType.includes('Word') && !colType.includes('PDF')) {
      return false;
    }
    if (typeVal === 'slide' && !colType.includes('演示')) return false;
    if (
      typeVal === 'other' &&
      (colType.includes('文件夹') ||
        colType.includes('表格') ||
        colType.includes('Excel') ||
        colType.includes('文档') ||
        colType.includes('Word') ||
        colType.includes('PDF') ||
        colType.includes('演示'))
    ) {
      return false;
    }
  }

  const execVal = $('batch-filter-exec-status')?.value || 'all';
  const colG = String(row[6] || '');
  const colExec = String(row[7] || '');
  if (execVal !== 'all') {
    if (execVal === 'b_all_ok' && !colG.includes('B列全部可读') && !colExec.includes('均有读取权限')) return false;
    if (
      execVal === 'b_missing' &&
      !colG.includes('B列部分可读') &&
      !colG.includes('B列全部无权限') &&
      !colExec.includes('缺 ') &&
      !colExec.includes('均无读取权限')
    ) {
      return false;
    }
    if (execVal === 'b_partial' && !colG.includes('B列部分可读')) return false;
    if (execVal === 'b_none' && !colG.includes('B列全部无权限') && !colExec.includes('均无读取权限')) return false;
    if (execVal === 'ok' && !colExec.includes('✅')) return false;
    if (execVal === 'error' && !colExec.includes('❌') && !colMy.includes('❌')) return false;
  }

  return true;
}

function updateBatchFilterCountBadge() {
  const masterLinkRows = (state.batchMasterRows || []).filter(r => String(r?.[0] || '').trim());
  const matchedLinkRows = isBatchFilterActive()
    ? masterLinkRows.filter(r => matchesBatchRowFilter(r))
    : masterLinkRows;
  if ($('batch-filter-result-count')) {
    $('batch-filter-result-count').textContent = `显示 ${matchedLinkRows.length} / ${masterLinkRows.length} 条链接`;
  }
}

function renderBatchMasterToSheet() {
  if (!state.batchLinksSheet) return;
  const activeFilter = isBatchFilterActive();
  const visibleRows = [];
  const rowMap = [];

  if (!activeFilter) {
    const total = Math.max(25, state.batchMasterRows.length);
    for (let i = 0; i < total; i++) {
      const r = state.batchMasterRows[i] || ['', '', '', '', '', '', '', ''];
      state.batchMasterRows[i] = r;
      visibleRows.push([...r]);
      rowMap.push(i);
    }
  } else {
    for (let i = 0; i < state.batchMasterRows.length; i++) {
      const r = state.batchMasterRows[i];
      if (matchesBatchRowFilter(r)) {
        visibleRows.push([...r]);
        rowMap.push(i);
      }
    }
    if (visibleRows.length === 0) {
      visibleRows.push(['', '', '-', '当前筛选条件下无匹配链接', '', '', '', '']);
      rowMap.push(0);
    }
  }

  state.batchVisibleRowMap = rowMap;
  state.isUpdatingBatchSheet = true;
  try {
    state.batchLinksSheet.setData(visibleRows);
  } finally {
    state.isUpdatingBatchSheet = false;
  }
  updateBatchFilterCountBadge();
}

function getActiveBatchFileIds() {
  const rows = isBatchFilterActive()
    ? (state.batchMasterRows || []).filter(r => matchesBatchRowFilter(r))
    : state.batchMasterRows || [];
  const linksText = rows.map(r => String(r?.[0] || '').trim()).filter(Boolean).join('\n');
  return parseDriveLinksInput(linksText);
}

function syncBatchSheetToInputs() {
  if (!state.batchLinksSheet) return;
  const rows = state.batchMasterRows || [];
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
  updateBatchFilterCountBadge();
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

  const curRows = state.batchMasterRows || [];
  const totalRows = Math.max(25, linksLines.length, emailLines.length, curRows.length);
  state.batchMasterRows = Array.from({ length: totalRows }, (_, i) => {
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

  renderBatchMasterToSheet();
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
  renderTransferWorkspace();
}

/* ==================== 全盘所有权转移工作台（左：来源扫描 ➔ 右：接收与对比 · 断点续传 · 实时日志） ==================== */

let transferLogRenderTimer = null;

function renderTransferLogsConsole() {
  const box = $('transfer-log-console');
  if (!box) return;
  const logs = state.transferState?.logs || [];
  if (!logs.length) {
    box.innerHTML = `<div class="muted">暂无转移操作日志。选择左侧来源邮箱并点击「🔍 扫描来源全盘所有权文件」开始记录…</div>`;
    return;
  }
  box.innerHTML = logs
    .slice(-120)
    .map(line => `<div class="transfer-log-line">${escapeHtml(line)}</div>`)
    .join('');
  box.scrollTop = box.scrollHeight;
}

async function appendTransferLog(msg, persistNow = true) {
  const nowStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${nowStr}] ${msg}`;
  if (!Array.isArray(state.transferState.logs)) state.transferState.logs = [];
  state.transferState.logs.push(line);
  if (state.transferState.logs.length > 400) {
    state.transferState.logs = state.transferState.logs.slice(-400);
  }
  if (persistNow) {
    if (transferLogRenderTimer) {
      clearTimeout(transferLogRenderTimer);
      transferLogRenderTimer = null;
    }
    renderTransferLogsConsole();
    state.transferState = await saveOwnershipTransferState(state.transferState);
  } else if (!transferLogRenderTimer) {
    transferLogRenderTimer = setTimeout(() => {
      transferLogRenderTimer = null;
      renderTransferLogsConsole();
    }, 180);
  }
}

function renderTransferAccountSelectors() {
  const srcSelect = $('transfer-source-select');
  const tgtSelect = $('transfer-target-select');
  const tgtInput = $('transfer-target-email-input');
  if (!srcSelect || !tgtSelect) return;

  const accounts = state.accounts || [];
  if (!state.transferState.sourceEmail && accounts.length > 0) {
    state.transferState.sourceEmail = normalizeEntry(accounts[0].email);
  }
  if (!state.transferState.targetEmail && accounts.length > 1) {
    state.transferState.targetEmail = normalizeEntry(accounts[1].email);
  }

  const curSrc = normalizeEntry(state.transferState.sourceEmail || '');
  const curTgt = normalizeEntry(state.transferState.targetEmail || '');

  srcSelect.innerHTML =
    `<option value="">-- 请选择已授权的来源邮箱 (${accounts.length}个可用) --</option>` +
    accounts
      .map(
        a =>
          `<option value="${escapeHtml(normalizeEntry(a.email))}" ${
            normalizeEntry(a.email) === curSrc ? 'selected' : ''
          }>📤 来源: ${escapeHtml(a.email)}</option>`
      )
      .join('');

  tgtSelect.innerHTML =
    `<option value="">-- 选已授权接收号 --</option>` +
    accounts
      .map(
        a =>
          `<option value="${escapeHtml(normalizeEntry(a.email))}" ${
            normalizeEntry(a.email) === curTgt ? 'selected' : ''
          }>📥 接收: ${escapeHtml(a.email)}</option>`
      )
      .join('');

  if (tgtInput && document.activeElement !== tgtInput) {
    tgtInput.value = curTgt;
  }

  const autoChk = $('transfer-auto-accept-chk');
  if (autoChk) {
    autoChk.checked = state.transferState.autoAccept !== false;
  }
}

function renderTransferWorkspace(skipSheet = false) {
  const onlyStats = skipSheet === true;
  if (!onlyStats) {
    renderTransferAccountSelectors();
  }

  const items = state.transferState?.items || [];
  if (items.length > 0 && items[0].rootFolderId === undefined && typeof enrichTransferItemsWithTree === 'function') {
    enrichTransferItemsWithTree(items);
  }
  const total = items.length;
  let folderCount = 0;
  let sourceOwnedCount = 0;
  let pendingAcceptCount = 0;
  let targetOwnedCount = 0;
  let failedCount = 0;

  // 统计各顶层大文件夹的完成度
  const rootFolderStats = new Map();

  // 单次循环极速统计（即使 20,000 条也仅耗时 0.5ms）
  for (let i = 0; i < total; i++) {
    const it = items[i];
    if (it.mimeType === 'application/vnd.google-apps.folder') folderCount++;
    const st = it.stage;
    if (st === 'pending_init') sourceOwnedCount++;
    else if (st === 'pending_accept') pendingAcceptCount++;
    else if (st === 'completed') targetOwnedCount++;
    else if (st === 'failed') failedCount++;

    if (!onlyStats) {
      const rfId = it.rootFolderId || '__root_loose__';
      const rfName = it.rootFolderName || '📄 根目录直属单文件';
      let rStat = rootFolderStats.get(rfId);
      if (!rStat) {
        rStat = { id: rfId, name: rfName, total: 0, done: 0 };
        rootFolderStats.set(rfId, rStat);
      }
      rStat.total++;
      if (st === 'completed' || st === 'pending_accept') rStat.done++;
    }
  }
  const fileCount = total - folderCount;

  // 更新顶层大目录筛选下拉框（展示每个顶层文件夹的实时进度）
  const rootSelect = $('transfer-filter-root-folder');
  if (!onlyStats && rootSelect) {
    const prevVal = rootSelect.value || 'all';
    const sortedRoots = [...rootFolderStats.values()].sort((a, b) => {
      if (a.id === '__root_loose__') return 1;
      if (b.id === '__root_loose__') return -1;
      return b.total - a.total;
    });
    rootSelect.innerHTML =
      `<option value="all">📁 顶层大目录：全部 (${total}项)</option>` +
      sortedRoots
        .map(r => {
          const pctR = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
          const icon = r.id === '__root_loose__' ? '📄' : pctR === 100 ? '✅' : '📂';
          return `<option value="${escapeHtml(r.id)}">${icon} ${escapeHtml(r.name)} (${r.done}/${r.total} · ${pctR}%)</option>`;
        })
        .join('');
    if ([...rootSelect.options].some(o => o.value === prevVal)) {
      rootSelect.value = prevVal;
    }
  }

  if ($('transfer-tab-badge')) {
    $('transfer-tab-badge').textContent = `${targetOwnedCount}/${total}`;
  }
  if ($('tf-stat-total')) $('tf-stat-total').textContent = String(total);
  if ($('tf-stat-folders')) $('tf-stat-folders').textContent = String(folderCount);
  if ($('tf-stat-files')) $('tf-stat-files').textContent = String(fileCount);
  if ($('tf-stat-source-owned')) $('tf-stat-source-owned').textContent = String(sourceOwnedCount);
  if ($('tf-stat-pending-accept')) $('tf-stat-pending-accept').textContent = String(pendingAcceptCount);
  if ($('tf-stat-target-owned')) $('tf-stat-target-owned').textContent = String(targetOwnedCount);
  if ($('tf-stat-failed')) $('tf-stat-failed').textContent = String(failedCount);

  const processedCount = targetOwnedCount + pendingAcceptCount;
  const pct = total > 0 ? Math.round((processedCount / total) * 100) : 0;
  if ($('transfer-progress-bar-fill')?.style) {
    $('transfer-progress-bar-fill').style.width = `${pct}%`;
  }
  if ($('transfer-progress-text')) {
    $('transfer-progress-text').textContent = `📊 进度：已处理 ${processedCount}/${total} (${pct}%) · 已彻底转入接收方 ${targetOwnedCount} · 待接收确认 ${pendingAcceptCount} · 待发起 ${sourceOwnedCount}`;
  }
  if ($('transfer-saved-time')) {
    $('transfer-saved-time').textContent = state.transferState.lastScannedAt
      ? `💾 本地断点记录：扫描于 ${formatTime(state.transferState.lastScannedAt)} · 保存于 ${formatTime(state.transferState.lastUpdatedAt)}（可直接续传，无需重扫）`
      : '💾 本地断点记录：尚未扫描（扫描一次后自动持久保存，无需每次重扫）';
  }

  const srcTag = $('transfer-source-status-tag');
  if (srcTag) {
    srcTag.textContent = total > 0 ? `已缓存 ${total} 项 (待转 ${sourceOwnedCount})` : '待扫描来源网盘';
  }

  const tgtEmail = normalizeEntry($('transfer-target-email-input')?.value || state.transferState.targetEmail || '');
  const isTargetAuthorized = (state.accounts || []).some(a => normalizeEntry(a.email) === tgtEmail);
  const tgtTag = $('transfer-target-status-tag');
  if (tgtTag) {
    if (!tgtEmail) {
      tgtTag.textContent = '请填写或选择接收邮箱';
    } else if (isTargetAuthorized) {
      tgtTag.textContent = `✅ 已授权 (${tgtEmail}) · 支持API自动接受`;
    } else {
      tgtTag.textContent = `⚠️ 未导入Token (${tgtEmail}) · 仅发邀请`;
    }
  }

  const startBtn = $('transfer-start-resume-btn');
  const pauseBtn = $('transfer-pause-btn');
  if (startBtn && pauseBtn) {
    startBtn.disabled = state.transferRunning;
    pauseBtn.disabled = !state.transferRunning;
    if (state.transferRunning) {
      startBtn.textContent = '⏳ 正在全盘转移中…';
    } else if (sourceOwnedCount > 0 && (targetOwnedCount > 0 || pendingAcceptCount > 0)) {
      startBtn.textContent = `▶️ 断点续传剩余 (${sourceOwnedCount} 项)`;
    } else {
      startBtn.textContent = '▶️ 多线程开始 / 断点续传';
    }
  }

  // 渲染 Jspreadsheet 对比表格（高频转移循环中可通过 skipSheet=true 跳过重度 DOM 重建，且超过 500 条时仅渲染前 500 条预览以彻底杜绝万级数据主线程卡顿）
  if (!onlyStats && state.transferSheet) {
    const rootFolderFilter = $('transfer-filter-root-folder')?.value || 'all';
    const stageFilter = $('transfer-filter-stage')?.value || 'all';
    const typeFilter = $('transfer-filter-type')?.value || 'all';
    const kw = ($('transfer-filter-kw')?.value || '').trim().toLowerCase();

    const filtered = items.filter(it => {
      if (rootFolderFilter !== 'all' && (it.rootFolderId || '__root_loose__') !== rootFolderFilter) return false;
      if (stageFilter !== 'all' && it.stage !== stageFilter) return false;
      const isFolder = it.mimeType === 'application/vnd.google-apps.folder';
      if (typeFilter === 'folder' && !isFolder) return false;
      if (typeFilter === 'file' && isFolder) return false;
      if (kw) {
        const hay = `${it.name || ''} ${it.rootFolderName || ''} ${it.sourceOwner || ''} ${it.targetOwner || ''} ${it.currentOwner || ''} ${it.statusText || ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    const MAX_SHEET_PREVIEW = 500;
    const displayList = filtered.length > MAX_SHEET_PREVIEW ? filtered.slice(0, MAX_SHEET_PREVIEW) : filtered;

    state.isUpdatingTransferSheet = true;
    try {
      if (!displayList.length) {
        const emptyHint =
          items.length === 0
            ? '尚未扫描来源邮箱，请先在上方左侧选择来源邮箱并点击「🔍 极速多线程扫描全盘」'
            : '当前筛选条件下没有匹配的转移记录';
        state.transferSheet.setData([['-', emptyHint, '', '', '', '', '', '']]);
      } else {
        const rows = displayList.map(it => {
          const typeLabel = fileCategoryLabel(it.mimeType, it.name);
          const curOwnerCell =
            it.currentOwner && it.currentOwner === normalizeEntry(it.targetOwner || tgtEmail)
              ? `📥 已归接收方 (${it.currentOwner})`
              : `📤 仍归来源方 (${it.currentOwner || it.sourceOwner})`;
          const detailCell = it.error
            ? `❌ ${it.error} (${formatTime(it.updatedAt)})`
            : `${formatTime(it.updatedAt)}`;
          return [
            typeLabel,
            it.name || '(无名称)',
            it.sourceOwner || state.transferState.sourceEmail || '',
            it.targetOwner || tgtEmail || '',
            curOwnerCell,
            it.statusText || '',
            detailCell,
            it.webViewLink || it.id
          ];
        });
        if (filtered.length > MAX_SHEET_PREVIEW) {
          rows.push([
            'ℹ️ 提示',
            `为保证万级文件多线程极速运行不卡顿，表格仅预览前 ${MAX_SHEET_PREVIEW} 条（共匹配 ${filtered.length} 条，可用上方搜索/筛选精确查看或导出完整 CSV）`,
            '',
            '',
            '',
            '',
            '',
            ''
          ]);
        }
        state.transferSheet.setData(rows);
      }
    } finally {
      state.isUpdatingTransferSheet = false;
    }
  }

  if (!onlyStats) {
    renderTransferLogsConsole();
  }
}

async function handleTransferScanSource(mergeMode = false) {
  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry($('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || '');

  if (!sourceEmail) {
    toast('请先在左侧下拉框选择「来源邮箱（原所有者）」');
    return;
  }

  const scanBtn = $('transfer-scan-source-btn');
  const incBtn = $('transfer-incremental-scan-btn');
  const pauseBtn = $('transfer-pause-btn');
  const origScanBtnText = scanBtn ? scanBtn.textContent : '🔍 首次扫描我所有的文件与文件夹';

  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = '⏳ 正在校验令牌并连接云盘…';
  }
  if (incBtn) incBtn.disabled = true;
  if (pauseBtn) pauseBtn.disabled = false;
  state.transferPauseRequested = false;

  const existingSnapshotItems = Array.isArray(state.transferState.items) ? [...state.transferState.items] : [];

  await appendTransferLog(
    `${mergeMode ? '➕ 启动增量补扫' : '🔍 启动首次全盘扫描'}：正在扫描来源邮箱 ${sourceEmail} 名下所有「我是所有者 ('me' in owners)」的文件夹与文件（支持边扫描边实时展示）…`,
    false
  );

  try {
    const items = await scanSourceOwnedItemsForTransfer({
      sourceEmail,
      targetEmail,
      existingItems: existingSnapshotItems,
      mergeMode,
      shouldStop: () => Boolean(state.transferPauseRequested),
      async onProgress(p) {
        if (p?.message) {
          $('progress').textContent = p.message;
          if ($('transfer-progress-text')) {
            $('transfer-progress-text').textContent = `⏳ ${p.message}`;
          }
        }
        if (p?.phase === 'token_ready') {
          await appendTransferLog(`🔑 免登录令牌校验通过 (${sourceEmail})，开始分页拉取云盘数据（每页结果将实时渲染至下方表格）…`, false);
        } else if (p?.phase === 'auth_refresh') {
          await appendTransferLog(`🔄 正在使用免登录 refreshToken 自动换取新访问令牌 (${sourceEmail})…`, false);
        } else if (p?.phase === 'scanning' && scanBtn) {
          scanBtn.textContent = `⏳ 正在拉取第 ${p.page} 页 (已出 ${p.count} 项)…`;
        }
      },
      async onPartialItems(partialItems, info) {
        const pFolderCnt = partialItems.filter(i => i.mimeType === 'application/vnd.google-apps.folder').length;
        const pFileCnt = partialItems.length - pFolderCnt;

        state.transferState.sourceEmail = sourceEmail;
        if (targetEmail) state.transferState.targetEmail = targetEmail;
        state.transferState.lastScannedAt = new Date().toISOString();
        state.transferState.items = partialItems;

        if (scanBtn) {
          scanBtn.textContent = info.hasMore
            ? `⚡ 4线程极速扫：第 ${info.page} 批 (${info.total} 项)…`
            : `✅ 已拉取完 ${info.total} 项，正在保存…`;
        }

        const shardLabel = info.shardName ? `${info.shardName} ` : '';
        await appendTransferLog(
          `📄 [4线程并发 · 第 ${info.page} 批] ${shardLabel}本批 +${info.pageAdded} 项 ➔ 累计 ${info.total} 项（📁 文件夹 ${pFolderCnt} / 📄 文件 ${pFileCnt}）${
            info.hasMore ? '，继续并发拉取…' : '，全部分片拉取完毕！'
          }`,
          false
        );

        // 立即刷新看板统计卡片 + Jspreadsheet 表格，让用户每批都能实时看到文件出来
        renderTransferWorkspace();

        // 每 3 批自动在后台存一次断点，防止中途关闭丢失
        if (info.page % 3 === 0) {
          await saveOwnershipTransferState(state.transferState);
        }
      }
    });

    const folderCnt = items.filter(i => i.mimeType === 'application/vnd.google-apps.folder').length;
    const fileCnt = items.length - folderCnt;
    const completedCnt = items.filter(i => i.stage === 'completed').length;
    const pendingCnt = items.filter(i => i.stage === 'pending_accept').length;

    state.transferState.sourceEmail = sourceEmail;
    if (targetEmail) state.transferState.targetEmail = targetEmail;
    state.transferState.lastScannedAt = new Date().toISOString();
    state.transferState.items = items;
    state.transferState = await saveOwnershipTransferState(state.transferState);

    const stopNote = state.transferPauseRequested ? '（已按请求提前停止并保留已扫结果）' : '';
    await appendTransferLog(
      `✅ 扫描并保存完成${stopNote}：共 ${items.length} 项（文件夹 ${folderCnt} 个 / 文件 ${fileCnt} 个 · 已归接收方 ${completedCnt} 项 · 待确认 ${pendingCnt} 项）。记录已持久化保存，后续可直接断点续传！`,
      true
    );
    $('progress').textContent = `来源邮箱 (${sourceEmail}) 全盘扫描完成：共 ${items.length} 项已保存至本地记录`;
    renderTransferWorkspace();
    toast(`已扫描并保存 ${items.length} 项（文件夹 ${folderCnt} / 文件 ${fileCnt}），无需每次重扫`);
  } catch (error) {
    await appendTransferLog(`❌ 扫描来源邮箱失败：${error.message}`, true);
    toast(`扫描失败：${error.message}`);
  } finally {
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = origScanBtnText;
    }
    if (incBtn) incBtn.disabled = false;
    if (pauseBtn && !state.transferRunning) pauseBtn.disabled = true;
  }
}

async function handleTransferRunLoop(retryFailedOnly = false, onlyRootFolderId = '') {
  if (state.transferRunning) return;

  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry($('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || '');
  const autoAccept = Boolean($('transfer-auto-accept-chk')?.checked ?? true);

  if (!sourceEmail) {
    toast('请先在左侧选择「来源邮箱（原所有者）」');
    return;
  }
  if (!targetEmail) {
    toast('请先在右侧选择或输入「接收邮箱（新所有者）」');
    return;
  }
  if (sourceEmail === targetEmail) {
    toast('来源邮箱与接收邮箱不能相同');
    return;
  }

  if (!state.transferState.items || state.transferState.items.length === 0) {
    await handleTransferScanSource(false);
    if (!state.transferState.items || state.transferState.items.length === 0) return;
  }

  state.transferState.sourceEmail = sourceEmail;
  state.transferState.targetEmail = targetEmail;
  state.transferState.autoAccept = autoAccept;

  const items = state.transferState.items;
  if (items.length > 0 && items[0].rootFolderId === undefined && typeof enrichTransferItemsWithTree === 'function') {
    enrichTransferItemsWithTree(items);
  }
  for (const it of items) {
    it.targetOwner = targetEmail;
  }

  let sourceToken = '';
  let targetToken = '';
  try {
    sourceToken = await getValidTokenForAccount(sourceEmail, true);
  } catch (err) {
    toast(`获取来源邮箱 (${sourceEmail}) 令牌失败：${err.message}`);
    return;
  }

  const isTargetAuthorized = (state.accounts || []).some(a => normalizeEntry(a.email) === targetEmail);
  if (isTargetAuthorized) {
    try {
      targetToken = await getValidTokenForAccount(targetEmail, false);
    } catch (_e) {
      targetToken = '';
    }
  }

  const selectedRootFilter = onlyRootFolderId || ($('transfer-filter-root-folder')?.value || 'all');

  let todoIndices = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (onlyRootFolderId && onlyRootFolderId !== 'all' && (it.rootFolderId || '__root_loose__') !== onlyRootFolderId) {
      continue;
    }
    const st = it.stage;
    if (retryFailedOnly) {
      if (st === 'failed') todoIndices.push(i);
    } else {
      if (st === 'pending_init' || st === 'failed' || (st === 'pending_accept' && autoAccept && targetToken)) {
        todoIndices.push(i);
      }
    }
  }

  // 若用户在下拉框选中了某个顶层大文件夹（即使点击的是常规开始按钮），自动将该顶层大文件夹的所有条目排到最前面优先插队转移！
  if (!onlyRootFolderId && selectedRootFilter && selectedRootFilter !== 'all') {
    const prio = [];
    const rest = [];
    for (const idx of todoIndices) {
      if ((items[idx].rootFolderId || '__root_loose__') === selectedRootFilter) prio.push(idx);
      else rest.push(idx);
    }
    todoIndices = [...prio, ...rest];
  }

  if (!todoIndices.length) {
    toast('当前筛选范围内没有待处理的条目（已全部处理完毕，或可点击「🔄 刷新左右归属对比」核验）');
    return;
  }

  const concurrency = Math.max(1, Math.min(16, Number($('transfer-concurrency-select')?.value) || 8));

  state.transferRunning = true;
  state.transferPauseRequested = false;
  renderTransferWorkspace();

  await appendTransferLog(
    `🚀 启动 ${concurrency} 线程并发转移（含 AIMD 智能平滑控速）：来源 [${sourceEmail}] ➔ 接收 [${targetEmail}]，本次待处理 ${todoIndices.length} / 总计 ${items.length} 项`,
    true
  );

  let processedInRun = 0;
  let successInRun = 0;
  let pendingInRun = 0;
  let failInRun = 0;
  let cursor = 0;
  let lastRenderAt = 0;
  let lastSheetRenderAt = Date.now();
  let saveInFlight = false;
  let personalGmailAcceptProbeFailures = 0;
  let skipTargetApiAccept = false;
  let cachedTargetPermId = items.find(it => it.targetPermissionId)?.targetPermissionId || '';
  const isPersonalGmailTarget = /@(gmail|googlemail)\.com$/i.test(targetEmail);

  try {
    // 【阶段 0：顶层大文件夹剪枝预热 + 开局自动挂入接收方『我的云端硬盘』根目录】
    const topFoldersToPrep = todoIndices
      .map(idx => items[idx])
      .filter(it => it.isTopLevelFolder && (!it.targetPermissionId || (targetToken && !it._mountedToTargetRoot)));
    if (topFoldersToPrep.length > 0 && typeof prepareTopLevelFoldersForTransfer === 'function') {
      $('progress').textContent = `🌳 正在预热 ${topFoldersToPrep.length} 个顶层大文件夹（级联赋予 writer 权限并自动挂入接收方『我的云端硬盘』）…`;
      const prepRes = await prepareTopLevelFoldersForTransfer({
        sourceToken,
        targetToken,
        topFolders: topFoldersToPrep,
        targetEmail,
        onLog: msg => appendTransferLog(msg, false)
      });
      if (prepRes.permId && !cachedTargetPermId) {
        cachedTargetPermId = prepRes.permId;
      }
      if (prepRes.grantedCount > 0) {
        // 等待 1.2 秒让 Google Drive 后端完成对所有子目录和子文件的继承权限传播，使后续万级子文件 100% 走 1 步 PATCH
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    const workerCount = Math.min(concurrency, todoIndices.length);
    const workers = Array.from({ length: workerCount }, async (_, workerId) => {
      // 错峰启动各工作线程（间隔 65ms），形成平滑流水线，避免 12 线程同一毫秒并发冲撞 Google API 触发 403 限速等待
      if (workerId > 0) {
        await new Promise(r => setTimeout(r, workerId * 65));
      }

      while (cursor < todoIndices.length) {
        if (state.transferPauseRequested) {
          break;
        }
        const k = cursor++;
        if (k >= todoIndices.length) break;

        const idx = todoIndices[k];
        const item = items[idx];

        try {
          const res = await transferSingleItemOwnership({
            sourceToken,
            targetToken,
            item,
            targetEmail,
            autoAccept,
            skipTargetApiAccept,
            knownTargetPermId: cachedTargetPermId
          });
          if (res.targetPermissionId && !cachedTargetPermId) {
            cachedTargetPermId = res.targetPermissionId;
          }
          item.stage = res.stage;
          item.currentOwner = res.currentOwner || item.currentOwner;
          item.targetPermissionId = res.targetPermissionId || item.targetPermissionId;
          item.statusText = res.statusText;
          item.error = '';
          item.updatedAt = new Date().toISOString();

          if (res.stage === 'completed') {
            successInRun++;
          } else {
            pendingInRun++;
            if (isPersonalGmailTarget && autoAccept && targetToken && !skipTargetApiAccept && !res.acceptedByApi) {
              personalGmailAcceptProbeFailures++;
              if (personalGmailAcceptProbeFailures >= 2) {
                skipTargetApiAccept = true;
                await appendTransferLog(
                  `⚡ 智能加速已开启：检测到个人 @gmail.com 接收号需网页确认，后续条目自动跳过冗余 API 接收探测，以 ${workerCount} 线程全速设为待接收(Pending)状态！`,
                  false
                );
              }
            }
          }

          for (const l of res.logs || []) {
            await appendTransferLog(`[T${workerId + 1} · ${k + 1}/${todoIndices.length}] ${l}`, false);
          }
        } catch (err) {
          item.stage = 'failed';
          item.statusText = `❌ 失败: ${err.message}`;
          item.error = err.message;
          item.updatedAt = new Date().toISOString();
          failInRun++;
          await appendTransferLog(
            `❌ [T${workerId + 1} · ${k + 1}/${todoIndices.length}] 《${item.name}》转移失败: ${err.message}`,
            false
          );
        }

        processedInRun++;
        $('progress').textContent = `⚡ ${workerCount}线程并发转移中 (${processedInRun}/${todoIndices.length})：已完成 ${successInRun} · 待确认 ${pendingInRun} · 失败 ${failInRun}`;

        const now = Date.now();
        if (now - lastRenderAt >= 200 || processedInRun === todoIndices.length) {
          lastRenderAt = now;
          const shouldRefreshSheet = now - lastSheetRenderAt >= 4500 || processedInRun === todoIndices.length;
          if (shouldRefreshSheet) lastSheetRenderAt = now;
          renderTransferWorkspace(!shouldRefreshSheet);
        }
        // 后台异步保存断点，绝不阻塞工作线程网络并发
        if (processedInRun % 40 === 0 && !saveInFlight) {
          saveInFlight = true;
          saveOwnershipTransferState(state.transferState)
            .catch(() => {})
            .finally(() => {
              saveInFlight = false;
            });
        }
      }
    });

    await Promise.all(workers);

    if (state.transferPauseRequested) {
      await appendTransferLog(
        `⏸️ 用户已暂停多线程转移：本次已处理 ${processedInRun} 项。当前进度已自动保存，随时可点击「▶️ 多线程开始 / 断点续传」继续！`,
        true
      );
      toast('已暂停转移并保存当前断点进度');
    } else {
      await appendTransferLog(
        `🏁 ${workerCount} 线程并发转移执行完毕：处理 ${processedInRun} 项（直接完成接管 ${successInRun} 项 · 已发邀请待确认 ${pendingInRun} 项 · 失败 ${failInRun} 项）。${
          pendingInRun > 0
            ? '提示：对处于「待接收(Pending)」的个人号文件，可点击右侧「🌐 网页全选接受兜底 (Ctrl+A)」在网页汇总页全选后一键全部接受！'
            : ''
        }`,
        true
      );
      toast(`多线程处理完成：已接管 ${successInRun} 项，待确认 ${pendingInRun} 项，失败 ${failInRun} 项`);
    }
  } finally {
    state.transferRunning = false;
    state.transferPauseRequested = false;
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
  }
}

async function handleTransferAcceptAll() {
  const targetEmail = normalizeEntry($('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || '');
  if (!targetEmail) {
    toast('请先在右侧选择或输入「接收邮箱」');
    return;
  }

  let targetToken = '';
  try {
    targetToken = await getValidTokenForAccount(targetEmail, true);
  } catch (err) {
    toast(`接收邮箱 (${targetEmail}) 尚未在插件内授权，请先点击「+授权接收号」或使用「🌐 网页全选接受兜底」`);
    return;
  }

  const items = state.transferState.items || [];
  const candidates = items.filter(it => it.stage === 'pending_accept' || it.stage === 'pending_init');
  if (!candidates.length) {
    toast('当前列表中没有待接收 (Pending) 的文件');
    return;
  }

  const concurrency = Math.max(1, Math.min(16, Number($('transfer-concurrency-select')?.value) || 8));
  const workerCount = Math.min(concurrency, candidates.length);

  const btn = $('transfer-accept-all-btn');
  if (btn) btn.disabled = true;
  await appendTransferLog(
    `⚡ 接收邮箱 [${targetEmail}] 启动 ${workerCount} 线程并发批量接受 ${candidates.length} 个文件的所有权…`,
    false
  );

  let acceptedCount = 0;
  let stillPendingCount = 0;
  let doneCount = 0;
  let cursor = 0;
  let lastRenderAt = 0;

  try {
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < candidates.length) {
        const i = cursor++;
        if (i >= candidates.length) break;
        const it = candidates[i];
        const res = await acceptSingleItemOwnership({
          targetToken,
          item: it,
          targetEmail
        });
        it.stage = res.stage;
        it.currentOwner = res.currentOwner || it.currentOwner;
        it.targetPermissionId = res.targetPermissionId || it.targetPermissionId;
        it.statusText = res.statusText;
        it.updatedAt = new Date().toISOString();

        if (res.accepted) acceptedCount++;
        else stillPendingCount++;
        doneCount++;

        $('progress').textContent = `⚡ ${workerCount}线程并发接受所有权 (${doneCount}/${candidates.length}): 已接管 ${acceptedCount} 项`;

        const now = Date.now();
        if (now - lastRenderAt >= 350 || doneCount === candidates.length) {
          lastRenderAt = now;
          renderTransferWorkspace();
        }
        if (doneCount % 15 === 0) {
          await saveOwnershipTransferState(state.transferState);
        }
      }
    });

    await Promise.all(workers);

    await appendTransferLog(
      `📥 接收方 ${workerCount} 线程批量接受执行完毕：API 直接接管成功 ${acceptedCount} 项，仍待网页确认 ${stillPendingCount} 项。${
        stillPendingCount > 0
          ? '若 Google 个人号拦截了 API 自动接受，请点击右侧「🌐 网页全选接受兜底」，在打开的页面按 Ctrl+A 全选 -> 右键 -> 接受所有权，即可一次性全部完成！'
          : ''
      }`,
      true
    );
    toast(`多线程接收完成：已接管 ${acceptedCount} 项，待网页确认 ${stillPendingCount} 项`);
  } finally {
    if (btn) btn.disabled = false;
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
  }
}

async function handleTransferVerifyCompare() {
  const items = state.transferState.items || [];
  if (!items.length) {
    toast('请先扫描来源邮箱文件后再进行左右归属对比');
    return;
  }
  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry($('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || '');

  let sourceToken = '';
  let targetToken = '';
  if (sourceEmail) {
    try {
      sourceToken = await getValidTokenForAccount(sourceEmail, false);
    } catch (_e) {}
  }
  if (targetEmail) {
    try {
      targetToken = await getValidTokenForAccount(targetEmail, false);
    } catch (_e) {}
  }

  const btn = $('transfer-verify-compare-btn');
  if (btn) btn.disabled = true;
  await appendTransferLog(`🔄 开始实测对比左边来源邮箱 [${sourceEmail}] 与右边接收邮箱 [${targetEmail}] 的真实所有者归属（共 ${items.length} 项）…`, false);

  try {
    const res = await verifyOwnershipTransferItems({
      sourceToken,
      targetToken,
      items,
      targetEmail,
      onProgress(p) {
        if (p?.message) $('progress').textContent = p.message;
      }
    });
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
    await appendTransferLog(
      `✅ 左右归属对比核验完成：总计 ${res.total} 项 ➔ 📥 已归属接收邮箱 ${res.newlyCompleted} 项 | 📨 待接收确认(Pending) ${res.stillPending} 项 | 📤 仍归属来源邮箱 ${res.stillSource} 项`,
      true
    );
    toast(`对比完成：已归接收方 ${res.newlyCompleted} 项，待确认 ${res.stillPending} 项，仍归来源 ${res.stillSource} 项`);
  } catch (err) {
    await appendTransferLog(`❌ 归属对比失败：${err.message}`, true);
    toast(`对比失败：${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleTransferMountToRoot() {
  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry($('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || '');
  if (!targetEmail) {
    toast('请先在右侧选择或输入「接收邮箱」');
    return;
  }

  let targetToken = '';
  let sourceToken = '';
  try {
    targetToken = await getValidTokenForAccount(targetEmail, true);
  } catch (err) {
    toast(`接收邮箱 (${targetEmail}) 尚未在插件内授权，请先点击「+授权接收号」完成授权`);
    return;
  }
  if (sourceEmail) {
    try {
      sourceToken = await getValidTokenForAccount(sourceEmail, false);
    } catch (_e) {}
  }

  const concurrency = Math.max(1, Math.min(16, Number($('transfer-concurrency-select')?.value) || 8));
  const btn = $('transfer-mount-to-root-btn');
  if (btn) btn.disabled = true;

  await appendTransferLog(
    `📂 开始整理接收邮箱 [${targetEmail}] 的『我的云端硬盘』目录显示：自动将顶层与悬空目录挂入根目录、修复子目录脱钩归位，并强制刷新文件夹视图索引（彻底解决点开文件夹一闪而过变空）…`,
    false
  );

  try {
    const res = await mountTransferredItemsToMyDriveRoot({
      targetToken,
      sourceToken,
      transferItems: state.transferState?.items || [],
      concurrency,
      onProgress(p) {
        if (p?.message) $('progress').textContent = p.message;
      }
    });

    if (state.transferState?.items?.length) {
      state.transferState = await saveOwnershipTransferState(state.transferState);
    }

    await appendTransferLog(
      `✅ 归入『我的云端硬盘』与目录索引修复完成！接收号共拥有 ${res.totalOwned} 项 ➔ 本次成功挂入根目录 ${res.mountedCount} 个（📁 文件夹 ${res.mountedFolders} 个 / 📄 文件 ${res.mountedFiles} 个）· 自动归位子目录项 ${res.repairedChildCount || 0} 个 · 刷新激活文件夹索引 ${res.refreshedFolderCount || 0} 个。现在去网页刷新即可直接看到全部文件夹与内部文件，不再一闪而过！`,
      true
    );
    toast(
      `已完成：挂入根目录 ${res.mountedFolders} 个文件夹/${res.mountedFiles} 个文件，归位子项 ${res.repairedChildCount || 0} 个，刷新文件夹索引 ${res.refreshedFolderCount || 0} 个！`
    );
  } catch (err) {
    await appendTransferLog(`❌ 归入『我的云端硬盘』失败：${err.message}`, true);
    toast(`操作失败：${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleTransferScanSpecificFolder() {
  if (state.transferRunning) {
    toast('当前有正在运行的转移任务，请先暂停后再扫描指定文件夹');
    return;
  }

  const rawFolderText = $('transfer-source-folder-input')?.value || '';
  const folderIds = parseDriveLinksInput(rawFolderText);
  if (!folderIds.length) {
    $('transfer-source-folder-input')?.focus?.();
    toast('请先在左侧「📁 指定源文件夹」输入框粘贴 1 个或多个 Google Drive 文件夹链接或文件夹 ID');
    return;
  }

  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry(
    $('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || ''
  );
  if (!sourceEmail && !targetEmail) {
    toast('请先在上方选择已授权的「来源邮箱」或「接收邮箱」');
    return;
  }

  const recursive = Boolean($('transfer-source-folder-recursive')?.checked ?? true);
  const btn = $('transfer-scan-folder-btn');
  const pauseBtn = $('transfer-pause-btn');
  const origText = btn ? btn.textContent : '🔍 扫描指定文件夹';

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 正在扫描指定夹…';
  }
  if (pauseBtn) pauseBtn.disabled = false;
  state.transferPauseRequested = false;

  await appendTransferLog(
    `📁 启动指定源文件夹定向扫描：共指定 ${folderIds.length} 个源文件夹（${recursive ? '递归扫描所有子文件夹与深层文件' : '仅扫描直属子项'}，即使网页端点开一闪而过也能 100% 扫出内部全部文件）…`,
    false
  );

  try {
    const items = await scanSpecificFoldersForTransfer({
      sourceEmail,
      targetEmail,
      folderIds,
      recursive,
      existingItems: state.transferState.items || [],
      mergeMode: false,
      shouldStop: () => Boolean(state.transferPauseRequested),
      onProgress(p) {
        if (p?.message) {
          $('progress').textContent = p.message;
          if ($('transfer-progress-text')) $('transfer-progress-text').textContent = `⏳ ${p.message}`;
        }
      },
      async onPartialItems(partialItems, info) {
        state.transferState.sourceEmail = sourceEmail;
        if (targetEmail) state.transferState.targetEmail = targetEmail;
        state.transferState.sourceFolderIds = folderIds;
        state.transferState.lastScannedAt = new Date().toISOString();
        state.transferState.items = partialItems;

        if (btn) {
          btn.textContent = `⏳ 已扫出 ${info.total} 项…`;
        }
        renderTransferWorkspace();
      }
    });

    const folderCnt = items.filter(i => i.mimeType === 'application/vnd.google-apps.folder').length;
    const fileCnt = items.length - folderCnt;

    state.transferState.sourceEmail = sourceEmail;
    if (targetEmail) state.transferState.targetEmail = targetEmail;
    state.transferState.sourceFolderIds = folderIds;
    state.transferState.lastScannedAt = new Date().toISOString();
    state.transferState.items = items;
    state.transferState = await saveOwnershipTransferState(state.transferState);

    await appendTransferLog(
      `✅ 指定源文件夹扫描完成：共扫出 ${items.length} 项（📁 文件夹 ${folderCnt} 个 / 📄 文件 ${fileCnt} 个）。您现在可以在右侧粘贴「🎯 目标文件夹」链接并点击「📂 转移文件到目标文件夹」或「👑 转所有权+移入目标夹」！`,
      true
    );
    $('progress').textContent = `指定源文件夹扫描完成：共 ${items.length} 项（文件夹 ${folderCnt} / 文件 ${fileCnt}）`;
    renderTransferWorkspace();
    toast(`已扫出指定文件夹内共 ${items.length} 项（文件夹 ${folderCnt} / 文件 ${fileCnt}）`);
  } catch (err) {
    await appendTransferLog(`❌ 扫描指定源文件夹失败：${err.message}`, true);
    toast(`扫描指定文件夹失败：${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
    if (pauseBtn && !state.transferRunning) pauseBtn.disabled = true;
  }
}

async function handleTransferMoveToDestFolder(withOwnershipTransferFirst = false) {
  if (state.transferRunning) {
    toast('当前有正在运行的任务，请等待或暂停后再操作');
    return;
  }

  const rawDestText = ($('transfer-dest-folder-input')?.value || '').trim();
  const parsedDestIds = rawDestText.toLowerCase() === 'root' ? ['root'] : parseDriveLinksInput(rawDestText);
  const destFolderId = parsedDestIds[0] || '';
  if (!destFolderId) {
    $('transfer-dest-folder-input')?.focus?.();
    toast('请先在右侧「🎯 目标文件夹」输入框粘贴目标文件夹链接或文件夹 ID');
    return;
  }

  // 若尚未扫描任何文件，且左侧填了指定源文件夹，自动先扫描指定源文件夹
  if (!state.transferState?.items?.length) {
    const srcFolderIds = parseDriveLinksInput($('transfer-source-folder-input')?.value || '');
    if (srcFolderIds.length > 0) {
      await handleTransferScanSpecificFolder();
    }
    if (!state.transferState?.items?.length) {
      toast('请先点击左侧「🔍 扫描指定文件夹」（或「🔍 极速多线程扫描全盘」）扫描要转移的文件');
      return;
    }
  }

  // 如果用户点击的是「👑 转所有权+移入目标夹」，且左右账号不同，先执行一轮多线程所有权转移
  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry(
    $('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || ''
  );

  if (withOwnershipTransferFirst && sourceEmail && targetEmail && sourceEmail !== targetEmail) {
    await handleTransferRunLoop(false);
  }

  let sourceToken = '';
  let targetToken = '';
  if (sourceEmail) {
    try {
      sourceToken = await getValidTokenForAccount(sourceEmail, false);
    } catch (_e) {}
  }
  if (targetEmail) {
    try {
      targetToken = await getValidTokenForAccount(targetEmail, false);
    } catch (_e) {}
  }
  if (!sourceToken && !targetToken) {
    toast('请先授权来源邮箱或接收邮箱后再执行转移到目标文件夹');
    return;
  }

  const structureMode = $('transfer-move-structure-mode')?.value || 'keep_tree';
  const concurrency = Math.max(1, Math.min(16, Number($('transfer-concurrency-select')?.value) || 8));
  const selectedRootFilter = $('transfer-filter-root-folder')?.value || 'all';
  const allItems = state.transferState.items || [];
  const itemsToMove =
    selectedRootFilter && selectedRootFilter !== 'all'
      ? allItems.filter(it => (it.rootFolderId || '__root_loose__') === selectedRootFilter)
      : allItems;

  const sourceFolderIds =
    parseDriveLinksInput($('transfer-source-folder-input')?.value || '').length > 0
      ? parseDriveLinksInput($('transfer-source-folder-input')?.value || '')
      : state.transferState.sourceFolderIds || [];

  const moveBtn = $('transfer-move-to-dest-btn');
  const ownMoveBtn = $('transfer-own-and-move-btn');
  const pauseBtn = $('transfer-pause-btn');
  if (moveBtn) moveBtn.disabled = true;
  if (ownMoveBtn) ownMoveBtn.disabled = true;
  if (pauseBtn) pauseBtn.disabled = false;
  state.transferRunning = true;
  state.transferPauseRequested = false;

  const modeLabel =
    structureMode === 'rebuild_folders'
      ? '✨ 重建同名新子目录并移入文件(防闪退)'
      : structureMode === 'flatten_files'
      ? '📄 提取全部文件平铺移入'
      : '🌳 保持原内部子目录结构移入';

  await appendTransferLog(
    `📂 开始将 ${itemsToMove.length} 个扫描条目批量转移至目标文件夹 [${destFolderId}]（模式：${modeLabel} · ${concurrency} 线程并发）…`,
    false
  );

  try {
    const res = await moveTransferItemsToTargetFolder({
      sourceToken,
      targetToken,
      sourceEmail,
      targetEmail,
      items: itemsToMove,
      sourceFolderIds,
      destFolderId,
      structureMode,
      concurrency,
      shouldStop: () => Boolean(state.transferPauseRequested),
      onProgress(p) {
        if (p?.message) $('progress').textContent = p.message;
      },
      onLog: msg => appendTransferLog(msg, false)
    });

    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();

    await appendTransferLog(
      `✅ 转移文件到目标文件夹《${res.destFolderName}》完成！共移动文件 ${res.movedFiles} 个 · 移动原文件夹 ${res.movedFolders} 个 · 新建子文件夹 ${res.createdFolders} 个（失败 ${res.failedCount} 个）。现在去网页打开目标文件夹《${res.destFolderName}》即可直接查看全部内容！`,
      true
    );
    $('progress').textContent = `已转移至目标文件夹《${res.destFolderName}》：文件 ${res.movedFiles} 个 / 文件夹 ${
      res.movedFolders + res.createdFolders
    } 个`;
    toast(`已成功将 ${res.movedFiles} 个文件（及 ${res.movedFolders + res.createdFolders} 个子目录）转移至《${res.destFolderName}》！`);
  } catch (err) {
    await appendTransferLog(`❌ 转移文件到目标文件夹失败：${err.message}`, true);
    toast(`转移到目标文件夹失败：${err.message}`);
  } finally {
    state.transferRunning = false;
    state.transferPauseRequested = false;
    if (moveBtn) moveBtn.disabled = false;
    if (ownMoveBtn) ownMoveBtn.disabled = false;
    if (pauseBtn) pauseBtn.disabled = true;
  }
}

function exportTransferCsv() {
  const items = state.transferState?.items || [];
  if (!items.length) {
    toast('暂无转移对比记录可导出');
    return;
  }
  const rows = [
    ['File ID', 'Type', 'Name', 'Source Email (Left)', 'Target Email (Right)', 'Current Actual Owner', 'Stage', 'Status Text', 'Updated At', 'Link']
  ];
  for (const it of items) {
    rows.push([
      it.id,
      fileDetailedCategory(it.mimeType, it.name),
      it.name || '',
      it.sourceOwner || '',
      it.targetOwner || '',
      it.currentOwner || '',
      it.stage || '',
      it.statusText || '',
      it.updatedAt || '',
      it.webViewLink || ''
    ]);
  }
  const csvContent = rows
    .map(r => r.map(c => `"${String(c ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drive-ownership-transfer-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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
      const extra = Array.from({ length: 20 }, () => ['', '', '', '', '', '', '', '']);
      state.batchMasterRows = [...(state.batchMasterRows || []), ...extra];
      renderBatchMasterToSheet();
      toast('已在表格底部增加 20 行');
    }
  });

  const resetBatchFilterInputs = () => {
    if ($('batch-filter-keyword')) $('batch-filter-keyword').value = '';
    if ($('batch-filter-my-access')) $('batch-filter-my-access').value = 'all';
    if ($('batch-filter-link-perm')) $('batch-filter-link-perm').value = 'all';
    if ($('batch-filter-type')) $('batch-filter-type').value = 'all';
    if ($('batch-filter-exec-status')) $('batch-filter-exec-status').value = 'all';
  };

  $('batch-links-clear-btn').addEventListener('click', () => {
    $('batch-links-input').value = '';
    $('batch-emails-input').value = '';
    resetBatchFilterInputs();
    state.batchMasterRows = Array.from({ length: 25 }, () => ['', '', '', '', '', '', '', '']);
    renderBatchMasterToSheet();
    updateBatchLinksParsedInfo();
    toast('已清空表格中的链接与邮箱');
  });

  // 批量链接表格的多维筛选事件绑定
  let batchFilterDebounce = null;
  $('batch-filter-keyword')?.addEventListener('input', () => {
    clearTimeout(batchFilterDebounce);
    batchFilterDebounce = setTimeout(() => {
      renderBatchMasterToSheet();
    }, 100);
  });

  ['batch-filter-my-access', 'batch-filter-link-perm', 'batch-filter-type', 'batch-filter-exec-status'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      renderBatchMasterToSheet();
    });
  });

  $('batch-filter-reset-btn')?.addEventListener('click', () => {
    resetBatchFilterInputs();
    renderBatchMasterToSheet();
    toast('已重置批量链接表格筛选条件');
  });

  $('batch-filter-keep-only-btn')?.addEventListener('click', () => {
    if (!isBatchFilterActive()) {
      toast('请先选择至少一个筛选条件，再点击「仅保留当前筛选」');
      return;
    }
    const matched = (state.batchMasterRows || []).filter(r => matchesBatchRowFilter(r));
    const padCount = Math.max(0, 25 - matched.length);
    const padded = [...matched, ...Array.from({ length: padCount }, () => ['', '', '', '', '', '', '', ''])];
    state.batchMasterRows = padded;
    resetBatchFilterInputs();
    renderBatchMasterToSheet();
    syncBatchSheetToInputs();
    toast(`已剔除未命中项，表格仅保留筛选出的 ${matched.length} 条记录`);
  });

  const renderBatchLinksScanTable = (results = []) => {
    // 同步更新 state.batchMasterRows 并按当前筛选条件渲染 Jspreadsheet
    if (state.batchLinksSheet) {
      const byFileId = new Map(results.map(r => [r.fileId, r]));
      const rows = state.batchMasterRows || [];
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

        const chk = item.emailCheckSummary;
        let countSummary = '';
        let execStatus = '';

        if (item.loading) {
          countSummary = chk ? '⏳ 正在核查B列账号…' : '⏳ 统计中…';
          execStatus = '⏳ 正在检测…';
        } else if (item.error) {
          countSummary = chk ? `❌ 无法核查 (0/${chk.total})` : item.linkStatusLabel;
          execStatus = `❌ ${item.error}`;
        } else if (chk && chk.total > 0) {
          if (chk.readableCount === chk.total && chk.explicitCount === chk.total) {
            countSummary = `✅ B列全部可读 (${chk.explicitCount}/${chk.total}已授权 · 编${chk.writerCount}/读${chk.readerCount})`;
          } else if (chk.readableCount === chk.total && chk.viaPublicLink) {
            countSummary = `🌐 B列全部可读 (公开链接可读 · 单独授权${chk.explicitCount}/${chk.total})`;
          } else if (chk.readableCount > 0) {
            countSummary = `⚠️ B列部分可读 (${chk.readableCount}/${chk.total}可读 · 缺${chk.missingEmails.length}个)`;
          } else {
            countSummary = `❌ B列全部无权限 (0/${chk.total}可读)`;
          }

          if (chk.missingEmails.length === 0) {
            execStatus = `✅ B列 ${chk.total} 个账号均有读取权限 (${chk.readableEmails.map(e => e.split('@')[0]).join(', ')})`;
          } else if (chk.readableCount > 0) {
            execStatus = `⚠️ 缺 ${chk.missingEmails.length} 个无权限: ${chk.missingEmails.join(', ')} | ✅可读(${chk.readableCount}): ${chk.readableEmails.map(e => e.split('@')[0]).join(', ')}`;
          } else {
            execStatus = `❌ B列 ${chk.total} 个账号均无读取权限: ${chk.missingEmails.join(', ')}`;
          }
        } else {
          countSummary = item.permissions?.length
            ? `共 ${nonOwners.length} 项 (编辑 ${wCount} / 查看 ${rCount})`
            : item.linkStatusLabel;
          execStatus = `✅ 已检测 (${item.linkStatusLabel})`;
        }

        rows[rIdx][2] = typeLabel;
        rows[rIdx][3] = item.name || item.fileId;
        rows[rIdx][4] = item.myAccessLabel || '';
        rows[rIdx][5] = pubDropdownId;
        rows[rIdx][6] = countSummary;
        rows[rIdx][7] = execStatus;
      }
      renderBatchMasterToSheet();
    }
  };

  const handleScanBatchLinks = async () => {
    syncBatchSheetToInputs();
    const fileIds = getActiveBatchFileIds();
    const checkEmails = parseEmailsInput($('batch-emails-input')?.value || '');
    if (!fileIds.length) {
      toast('请先在表格 A 列粘贴至少 1 个 Google 文件或文件夹链接');
      return;
    }

    $('batch-links-scan-btn').disabled = true;
    $('progress').textContent = checkEmails.length
      ? `正在扫描 ${fileIds.length} 个链接，并核查 B 列 ${checkEmails.length} 个账号的可读权限…`
      : `正在扫描 ${fileIds.length} 个链接的权限…`;
    try {
      const results = await scanBatchLinksStatus({
        fileIds,
        checkEmails,
        targetAccount: state.activeAccount,
        onProgress(p) {
          if (p?.message) $('progress').textContent = p.message;
        },
        onPartialResults(liveResults) {
          renderBatchLinksScanTable(liveResults);
        }
      });
      renderBatchLinksScanTable(results);
      if (checkEmails.length > 0) {
        const allOkLinks = results.filter(r => r.emailCheckSummary && r.emailCheckSummary.readableCount === r.emailCheckSummary.total).length;
        const missingLinks = results.length - allOkLinks;
        $('progress').textContent = `核查完成：共 ${results.length} 个链接 · B列(${checkEmails.length}个账号)全部可读 ${allOkLinks} 个，存在缺权限 ${missingLinks} 个`;
        toast(`核查完成：全部可读 ${allOkLinks} 个链接，缺权限 ${missingLinks} 个链接`);
      } else {
        $('progress').textContent = `链接权限扫描完成：共检测 ${results.length} 个链接`;
        toast(`已扫描 ${results.length} 个链接的权限状态`);
      }
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
      toast('当前表格（或筛选结果）中没有可处理的链接');
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
      !confirm(`确认对当前列表中的 ${targetFileIds.length} 个链接直接设置为：\n「${modeMap[publicMode] || publicMode}」？\n（无需填写邮箱，直接修改链接公开权限）`)
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
        const rows = state.batchMasterRows || [];
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
        renderBatchMasterToSheet();
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
    const fileIds = getActiveBatchFileIds();
    const publicMode = $('batch-links-public-mode').value || 'anyone_writer';
    handleApplyPublicModeToLinks(fileIds, publicMode);
  });

  $('batch-links-fill-accounts-btn')?.addEventListener('click', () => {
    const accEmails = [
      ...(state.accounts || []).map(a => normalizeEntry(a.email)),
      ...(state.oauthClients || []).map(c => normalizeEntry(c.boundEmail || c.client_email || ''))
    ].filter(Boolean);
    const uniqueAccEmails = [...new Set(accEmails)];
    if (!uniqueAccEmails.length) {
      toast('当前尚未导入授权账号。您可以直接在表格 B 列 Ctrl+V 粘贴需要核查的账号邮箱（如 sa-140@...）');
      return;
    }
    syncBatchSheetToInputs();
    const existingEmails = parseEmailsInput($('batch-emails-input')?.value || '');
    const merged = [...new Set([...existingEmails, ...uniqueAccEmails])];
    if ($('batch-emails-input')) $('batch-emails-input').value = merged.join('\n');
    syncInputsToBatchSheet();
    updateBatchLinksParsedInfo();
    toast(`已将 ${uniqueAccEmails.length} 个已导入账号填入 B 列，点击「🔍 扫描链接权限」即可核查可读性`);
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
    const fileIds = getActiveBatchFileIds();
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
        `确认对当前筛选/列表中的 ${fileIds.length} 个链接、${emails.length} 个邮箱执行：\n「${actionDesc}」？\n（全程静默处理，不发送骚扰邮件通知）`
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
        const targetSet = new Set(fileIds);
        const rows = state.batchMasterRows || [];
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const parsed = parseDriveLinksInput(rows[rIdx]?.[0] || '');
          if (!parsed.length || !targetSet.has(parsed[0])) continue;
          rows[rIdx][7] =
            mode === 'grant'
              ? `✅ 已对 ${emails.length} 个邮箱开通${roleLabel(role)}`
              : `✅ 已移除 ${emails.length} 个邮箱权限`;
        }
        renderBatchMasterToSheet();
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
  $('add-account-btn').addEventListener('click', () => handleAddMoreAccount('', ''));
  $('export-auth-passport-btn')?.addEventListener('click', () => exportAuthorizedPassportJson('', true));

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
    } else if (action === 'export-single-account') {
      await exportAuthorizedPassportJson(btn.dataset.email || '', false);
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

  // 8.5 全盘所有权转移工作台（左：来源邮箱扫描 ➔ 右：接收邮箱接受 · 对比 · 进度 · 日志 · 断点续传）
  $('transfer-source-select')?.addEventListener('change', async e => {
    state.transferState.sourceEmail = normalizeEntry(e.target.value || '');
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
  });

  $('transfer-target-select')?.addEventListener('change', async e => {
    const val = normalizeEntry(e.target.value || '');
    if (val) {
      state.transferState.targetEmail = val;
      if ($('transfer-target-email-input')) $('transfer-target-email-input').value = val;
      state.transferState = await saveOwnershipTransferState(state.transferState);
      renderTransferWorkspace();
    }
  });

  $('transfer-target-email-input')?.addEventListener('input', async e => {
    const val = normalizeEntry(e.target.value || '');
    state.transferState.targetEmail = val;
    if ($('transfer-target-select')) {
      const matched = [...($('transfer-target-select').options || [])].some(o => o.value === val);
      $('transfer-target-select').value = matched ? val : '';
    }
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();
  });

  $('transfer-auto-accept-chk')?.addEventListener('change', async e => {
    state.transferState.autoAccept = Boolean(e.target.checked);
    state.transferState = await saveOwnershipTransferState(state.transferState);
  });

  $('transfer-add-source-btn')?.addEventListener('click', () => handleAddMoreAccount('', 'source'));
  $('transfer-add-target-btn')?.addEventListener('click', () =>
    handleAddMoreAccount($('transfer-target-email-input')?.value || '', 'target')
  );

  $('transfer-scan-source-btn')?.addEventListener('click', () => handleTransferScanSource(false));
  $('transfer-incremental-scan-btn')?.addEventListener('click', () => handleTransferScanSource(true));
  $('transfer-scan-folder-btn')?.addEventListener('click', handleTransferScanSpecificFolder);
  $('transfer-start-resume-btn')?.addEventListener('click', () => handleTransferRunLoop(false));
  $('transfer-retry-failed-btn')?.addEventListener('click', () => handleTransferRunLoop(true));
  $('transfer-move-to-dest-btn')?.addEventListener('click', () => handleTransferMoveToDestFolder(false));
  $('transfer-own-and-move-btn')?.addEventListener('click', () => handleTransferMoveToDestFolder(true));
  $('transfer-priority-folder-btn')?.addEventListener('click', () => {
    const rfVal = $('transfer-filter-root-folder')?.value || 'all';
    if (!rfVal || rfVal === 'all') {
      toast('请先在左侧「📁 顶层大目录」下拉框中选择一个要优先转移的文件夹');
      return;
    }
    handleTransferRunLoop(false, rfVal);
  });

  $('transfer-pause-btn')?.addEventListener('click', () => {
    if (state.transferRunning) {
      state.transferPauseRequested = true;
      toast('正在安全暂停，当前文件处理完毕后立即保存断点…');
    }
  });

  $('transfer-accept-all-btn')?.addEventListener('click', handleTransferAcceptAll);
  $('transfer-mount-to-root-btn')?.addEventListener('click', handleTransferMountToRoot);
  $('transfer-verify-compare-btn')?.addEventListener('click', handleTransferVerifyCompare);

  let pendingWebAcceptOpened = false;
  $('transfer-open-web-pending-btn')?.addEventListener('click', () => {
    pendingWebAcceptOpened = true;
    const url = 'https://drive.google.com/drive/search?q=pendingowner:me';
    try {
      chrome.tabs.create({ url });
    } catch (_e) {
      window.open?.(url, '_blank');
    }
    appendTransferLog('🌐 已打开 Google Drive 网页端「待我接受所有权 (pendingowner:me)」汇总页：在网页按 Ctrl+A 全选 -> 右键 -> 共享 -> 接受所有权，切回本插件页面时将自动极速同步完成状态！', true);
    toast('已打开待接受汇总页：在网页按 Ctrl+A 全选接受后，切回本页面将自动同步完成状态');
  });

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', () => {
      if (pendingWebAcceptOpened && !state.transferRunning && (state.transferState?.items || []).some(it => it.stage === 'pending_accept')) {
        pendingWebAcceptOpened = false;
        handleTransferVerifyCompare();
      }
    });
  }

  $('transfer-export-passport-btn')?.addEventListener('click', () => exportAuthorizedPassportJson('', true));
  $('transfer-import-passport-btn')?.addEventListener('click', () => $('oauth-json-file')?.click());
  $('transfer-export-csv-btn')?.addEventListener('click', exportTransferCsv);

  $('transfer-clear-records-btn')?.addEventListener('click', async () => {
    if (state.transferRunning) {
      toast('请先暂停当前转移任务再清空缓存');
      return;
    }
    if (!confirm('确认清空已保存的全盘转移扫描记录与断点进度？')) return;
    state.transferState = await clearOwnershipTransferState();
    renderTransferWorkspace();
    toast('已清空全盘转移缓存记录');
  });

  $('transfer-clear-log-btn')?.addEventListener('click', async () => {
    state.transferState.logs = [];
    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferLogsConsole();
    toast('已清空转移控制台日志');
  });

  $('transfer-compare-cards')?.addEventListener('click', e => {
    const card = e.target.closest('[data-tf-filter]');
    if (!card) return;
    const val = card.dataset.tfFilter || 'all';
    document.querySelectorAll('#transfer-compare-cards .summary-card').forEach(c => {
      c.classList.toggle('active', c.dataset.tfFilter === val);
    });
    if ($('transfer-filter-stage')) $('transfer-filter-stage').value = val;
    renderTransferWorkspace();
  });

  ['transfer-filter-root-folder', 'transfer-filter-stage', 'transfer-filter-type'].forEach(id => {
    $(id)?.addEventListener('change', renderTransferWorkspace);
  });

  let tfFilterDebounce = null;
  $('transfer-filter-kw')?.addEventListener('input', () => {
    clearTimeout(tfFilterDebounce);
    tfFilterDebounce = setTimeout(renderTransferWorkspace, 100);
  });

  // 9. 加载存储数据并首次渲染（含全盘所有权转移断点缓存自动恢复）
  try {
    const [policy, directory, presets, logs, oauthClients, accounts, snapshot, transferState] = await Promise.all([
      getPolicy(),
      getDirectory(),
      getFilterPresets(),
      getAuditLogs(),
      getOAuthClients(),
      getAuthorizedAccounts(),
      getSnapshot(),
      getOwnershipTransferState()
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
    state.transferState = transferState;

    if (state.lastScanAt) {
      $('progress').textContent = `上次扫描：${formatTime(state.lastScanAt)}（共 ${state.files.length} 个文件）`;
    }
  } catch (error) {
    console.error('加载缓存失败:', error);
  }

  renderAll();
}

init();
