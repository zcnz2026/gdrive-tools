const $ = id => document.getElementById(id);

const state = {
  accounts: [],          // 已授权账号列表
  oauthClients: [],      // 已保存的桌面/Web OAuth JSON 凭证
  activeAccount: 'all',  // 'all' 或具体 email
  files: [],
  newFileIds: new Set(),
  policy: { ...DEFAULT_POLICY },
  directory: JSON.parse(JSON.stringify(DEFAULT_DIRECTORY)), // { groups, contacts }
  filterPresets: [],
  logs: [],
  lastScanAt: '',
  activeTab: 'files',
  selectedFileIds: new Set(),
  selectedTypeCats: new Set(), // 多选的文件类型分类
  selectedBatchGroups: new Set(), // 批量操作勾选的邮箱分组
  coreNameFilter: ''     // 点击同系列标签时的特定核心词根过滤
};

function toast(message) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => node.classList.remove('show'), 4800);
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

/* ==================== 顶部多账号栏与全局看板 ==================== */

function renderAccountsBar() {
  const listNode = $('accounts-list');
  const clientsInfo = $('oauth-clients-info');
  clientsInfo.textContent = `已存 OAuth JSON 凭证：${state.oauthClients.length} 个`;

  if (!state.accounts.length) {
    listNode.innerHTML =
      '<span class="muted">尚未授权任何账号，请点击右上角「🔑 导入桌面 JSON 授权」选择下载的 OAuth JSON 文件</span>';
    setStatus('待授权', false);
    $('scan').disabled = state.oauthClients.length === 0;
    return;
  }

  setStatus(`已授权 ${state.accounts.length} 个账号`, true);
  $('scan').disabled = false;

  const allPill = `<button type="button" class="account-pill ${state.activeAccount === 'all' ? 'active' : ''}" data-action="switch-account" data-email="all">
    🌐 全部已授权账号 (${state.accounts.length})
  </button>`;

  const accountPills = state.accounts
    .map(acc => {
      const isAct = normalizeEntry(state.activeAccount) === normalizeEntry(acc.email);
      return `<span class="account-pill ${isAct ? 'active' : ''}" data-action="switch-account" data-email="${escapeHtml(acc.email)}">
        <span>👤 ${escapeHtml(acc.email)}</span>
        <button type="button" class="remove-acc" data-action="remove-account" data-email="${escapeHtml(acc.email)}" title="移除此账号授权">×</button>
      </span>`;
    })
    .join('');

  listNode.innerHTML = allPill + accountPills;
  $('account').textContent = `当前已连接 ${state.accounts.length} 个 Google 账号${state.lastScanAt ? ` · 上次扫描：${formatTime(state.lastScanAt)}` : ''}`;
}

function updateTopBadges() {
  renderAccountsBar();

  const scheduleNode = $('schedule-badge');
  if (state.policy.scheduleEnabled) {
    const modeLabel = state.policy.autoEnforce ? '⚡ 自动守护修正' : '🔔 仅提醒';
    scheduleNode.textContent = `⏱️ 定时巡检：每 ${state.policy.scheduleMinutes} 分钟 · ${modeLabel}`;
    scheduleNode.classList.add('active');
  } else {
    scheduleNode.textContent = '⏱️ 定时巡检：未开启';
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
  enforceBtn.textContent = `⚡ 一键修正异常 (${summary.anomalousFiles})`;
  enforceBtn.disabled = summary.anomalousFiles === 0;

  $('export').disabled = scopedFiles.length === 0;
  $('clear-new-flags').classList.toggle('hidden', summary.newFiles === 0);

  $('tab-count-files').textContent = scopedFiles.length;
  $('tab-count-collabs').textContent = buildMergedPersonList().length;
  $('tab-count-policy').textContent = state.policy.writers.length + state.policy.readers.length;
  $('tab-count-logs').textContent = state.logs.length;

  updateExtensionBadge(state.files, state.policy, '');
}

/* ==================== 导入 OAuth 桌面 JSON 凭证与多账号授权 ==================== */

async function handleAuthorizeWithClient(client) {
  setStatus('等待 Google 登录授权…');
  try {
    const account = await authorizeWithOAuthClient(client);
    state.accounts = await getAuthorizedAccounts();
    state.oauthClients = await getOAuthClients();
    renderAll();
    toast(`✅ 已成功授权账号：${account.email}！正在自动扫描该账号文件…`);
    await handleScan(account.email);
  } catch (error) {
    renderAccountsBar();
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
    renderAccountsBar();
    toast(`已成功导入 ${extractedClients.length} 个桌面/Web OAuth 授权凭证，即将打开 Google 授权页…`);
    for (const client of extractedClients) {
      await handleAuthorizeWithClient(client);
    }
  } else if (!allowlistImported) {
    toast('未在所选 JSON 中识别到有效的 Google OAuth 凭证（installed / web）');
  }
}

async function handleAddMoreAccount() {
  state.oauthClients = await getOAuthClients();
  if (!state.oauthClients.length) {
    $('oauth-json-file').click();
    return;
  }

  let chosenClient = state.oauthClients[state.oauthClients.length - 1];
  if (state.oauthClients.length > 1) {
    const listText = state.oauthClients
      .map((c, idx) => `${idx + 1}. ${c.project_id || '项目'} (${c.client_id.slice(0, 18)}…)`)
      .join('\n');
    const input = prompt(
      `已保存 ${state.oauthClients.length} 个 OAuth 凭证，请输入要使用的序号（1-${state.oauthClients.length}）：\n${listText}`,
      String(state.oauthClients.length)
    );
    if (input === null) return;
    const idx = Math.max(0, Math.min(state.oauthClients.length - 1, (Number(input) || 1) - 1));
    chosenClient = state.oauthClients[idx];
  }

  await handleAuthorizeWithClient(chosenClient);
}

/* ==================== 高级搜索、排除词、类型包含/排除 & 核心词根归并 (TAB 1) ==================== */

function parseKeywords(str = '') {
  return String(str)
    .toLowerCase()
    .split(/[\s,，;；]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function syncQuickExcludeButtons() {
  const exTerms = new Set(parseKeywords($('file-exclude-search')?.value || ''));
  document.querySelectorAll('.quick-kw-btn').forEach(btn => {
    const kw = (btn.dataset.exKw || '').toLowerCase();
    btn.classList.toggle('active', exTerms.has(kw));
  });
}

function renderTypeFilterPills() {
  const mode = $('type-filter-mode')?.value || 'include';
  document.querySelectorAll('.type-pill').forEach(pill => {
    const cat = pill.dataset.typeCat;
    const isSel = state.selectedTypeCats.has(cat);
    pill.classList.toggle('active-include', isSel && mode === 'include');
    pill.classList.toggle('active-exclude', isSel && mode === 'exclude');
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
  bar.innerHTML =
    '<span class="muted" style="margin:0;">常用筛选：</span>' +
    state.filterPresets
      .map(
        p => `<span class="preset-pill" data-action="apply-preset" data-preset-id="${escapeHtml(p.id)}">
          <span>🔖 ${escapeHtml(p.name)}</span>
          <button type="button" class="del-preset" data-action="delete-preset" data-preset-id="${escapeHtml(p.id)}" title="删除此筛选预设">×</button>
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

  const typeMode = $('type-filter-mode')?.value || 'include';
  const groupFilter = $('file-group-filter')?.value || 'all';
  const patternMode = $('file-name-pattern')?.value || 'default';
  const statusFilter = $('file-status-filter')?.value || 'all';
  const hidePrivate = $('hide-private')?.checked || false;

  let result = baseFiles.filter(file => {
    const evalStat = evaluateFile(file, state.policy, file.ownerAccount);
    const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
    const detCat = fileDetailedCategory(file.mimeType, file.name);
    const coreName = extractCoreFileName(file.name || '');

    // 特定系列词根过滤
    if (state.coreNameFilter && coreName !== state.coreNameFilter) return false;

    // 隐藏仅自己可见
    if (hidePrivate && !evalStat.hasNonOwner) return false;

    // 文件类型包含 / 排除多选过滤
    if (state.selectedTypeCats.size > 0) {
      const matchedType = state.selectedTypeCats.has(detCat);
      if (typeMode === 'include' && !matchedType) return false;
      if (typeMode === 'exclude' && matchedType) return false;
    }

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

    // 不规范文件名与重复系列过滤
    if (patternMode === 'duplicates_only' && (coreCounts.get(coreName) || 0) < 2) {
      return false;
    }
    if (patternMode === 'messy_only' && !analyzeMessyFileName(file.name || '').isMessy) {
      return false;
    }

    const fileNameLower = (file.name || '').toLowerCase();

    // 排除关键词过滤（只要文件名命中任一排除词即隐藏）
    if (excludeTerms.length > 0) {
      const hitExclude = excludeTerms.some(term => fileNameLower.includes(term));
      if (hitExclude) return false;
    }

    // 包含关键词过滤（匹配文件名、核心词根、ID、所属账号、协作者邮箱、A列姓名、分组名）
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

      const checkSingleTerm = term => {
        if (matchMode === 'fuzzy') {
          return fuzzyMatchTerm(fullSearchText, term);
        }
        return fullSearchText.includes(term);
      };

      if (matchMode === 'and') {
        if (!includeTerms.every(checkSingleTerm)) return false;
      } else {
        if (!includeTerms.some(checkSingleTerm)) return false;
      }
    }

    return true;
  });

  // 排序：如果开启了按核心名称聚合排序，则将同系列的表排在一起
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

function renderPermissionChip(file, p, contactLookup) {
  const fileOwner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
  const evalResult = evaluatePermission(p, state.policy, fileOwner);
  const inherited = permIsInherited(p);
  const label = permissionLabel(p, contactLookup);

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
        <button type="button" class="chip-btn" data-action="quick-allow-writer" data-email="${escapeHtml(p.emailAddress)}" title="加入「允许编辑」白名单">+可编辑</button>
        <button type="button" class="chip-btn" data-action="quick-allow-reader" data-email="${escapeHtml(p.emailAddress)}" title="加入「仅限查看」白名单">+只读</button>
      `;
    } else if (evalResult.status === 'violation_downgrade') {
      quickAllowBtn = `
        <button type="button" class="chip-btn" data-action="quick-allow-writer" data-email="${escapeHtml(p.emailAddress)}" title="提升至「允许编辑」白名单">升为可编辑</button>
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
  syncQuickExcludeButtons();
  renderTypeFilterPills();
  renderSavedPresetsBar();

  const scopedFiles = getScopedFilesByAccount();
  const coreCounts = buildCoreNameCounts(scopedFiles);
  const contactLookup = buildContactLookup(state.directory);
  const filtered = getFilteredFiles();
  const tbody = $('file-rows');

  $('filtered-count').textContent = filtered.length;

  if (!state.files.length) {
    tbody.innerHTML = state.accounts.length
      ? '<tr><td colspan="5" class="empty">点击顶部「立即扫描文件」读取当前已授权账号下的文件与表格</td></tr>'
      : '<tr><td colspan="5" class="empty">请先点击右上角「🔑 导入桌面 JSON 授权」导入你的 Google OAuth JSON 文件完成授权</td></tr>';
    $('select-all').disabled = true;
    updateBatchButtons();
    return;
  }

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">
      当前筛选条件下没有匹配的文件
      ${state.coreNameFilter ? `<button type="button" class="btn btn-xs" id="clear-core-filter-inline">清除系列筛选 (${escapeHtml(state.coreNameFilter)})</button>` : ''}
    </td></tr>`;
    $('select-all').disabled = true;
    updateBatchButtons();
    return;
  }

  $('select-all').disabled = false;

  tbody.innerHTML = filtered
    .map(file => {
      const fileOwner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
      const stat = evaluateFile(file, state.policy, fileOwner);
      const detCat = fileDetailedCategory(file.mimeType, file.name);
      const catLabel = fileCategoryLabel(file.mimeType, file.name);
      const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
      const checked = state.selectedFileIds.has(file.id) ? 'checked' : '';

      const coreName = extractCoreFileName(file.name || '');
      const sameCoreCount = coreCounts.get(coreName) || 1;
      const messyInfo = analyzeMessyFileName(file.name || '');

      let seriesTagHtml = '';
      if (sameCoreCount > 1 && coreName) {
        seriesTagHtml = `<span class="core-series-tag" data-action="filter-core-name" data-core="${escapeHtml(coreName)}" title="点击只看此同名/相似系列的 ${sameCoreCount} 个文件">
          🧩 同系列(${sameCoreCount}): ${escapeHtml(coreName.slice(0, 14))}
        </span>`;
      } else if (messyInfo.hasRepeatedToken) {
        seriesTagHtml = `<span class="core-series-tag" title="文件名包含重复关键词段">🔁 含重复词</span>`;
      }

      // 分组授权覆盖情况展示
      const groupCoverages = getFileGroupCoverage(file, state.directory);
      const groupCovHtml = groupCoverages.length
        ? `<div class="group-coverage-list">
            ${groupCoverages
              .map(cov => {
                const isPartial = cov.status === 'partial';
                const fillBtn = isPartial
                  ? `<button type="button" class="chip-btn" data-action="fill-group-on-file" data-file-id="${escapeHtml(file.id)}" data-group="${escapeHtml(cov.groupName)}" title="为【${escapeHtml(cov.groupName)}】剩余未授权成员补齐权限">+补齐</button>`
                  : '';
                return `<span class="group-cov-badge ${isPartial ? 'partial' : ''}">
                  <span>👥 ${escapeHtml(cov.groupName)}: ${cov.grantedCount}/${cov.totalCount}人</span>
                  ${fillBtn}
                </span>`;
              })
              .join('')}
          </div>`
        : '';

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
        statusHtml = pills.join('');
      }

      const perms = file.permissions || [];
      const chipsHtml = perms.length
        ? `<div class="perm-list">${perms.map(p => renderPermissionChip(file, p, contactLookup)).join('')}</div>`
        : '<span class="muted">仅所有者 / 无共享权限</span>';

      const errorHtml = file.permissionError
        ? `<div class="status-pill danger" style="margin-top:4px;">读取失败：${escapeHtml(file.permissionError)}</div>`
        : '';

      const titleLink = file.webViewLink
        ? `<a class="file-name" href="${escapeHtml(file.webViewLink)}" target="_blank" rel="noreferrer">${escapeHtml(file.name || '(无名称)')}</a>`
        : `<span class="file-name">${escapeHtml(file.name || '(无名称)')}</span>`;

      const enforceBtn = stat.hasActionableViolation
        ? `<button type="button" class="btn warning btn-xs" data-action="enforce-file" data-file-id="${escapeHtml(file.id)}">⚡ 一键修正此项</button>`
        : '';

      return `<tr>
        <td>
          <input type="checkbox" class="row-check" data-file-id="${escapeHtml(file.id)}" ${checked}>
        </td>
        <td>
          <div class="file-title-row">
            <span class="badge type-${detCat}">${catLabel}</span>
            ${isNew ? '<span class="badge new-tag">NEW 新增</span>' : ''}
            ${titleLink}
          </div>
          <div class="file-sub">
            ${seriesTagHtml}
            <span>${fileOwner ? `账号: ${escapeHtml(fileOwner)} · ` : ''}${escapeHtml(formatTime(file.modifiedTime))}</span>
          </div>
        </td>
        <td>
          ${groupCovHtml}
          <div>${statusHtml}</div>
        </td>
        <td>${chipsHtml}${errorHtml}</td>
        <td>
          <div class="row-actions">
            ${enforceBtn}
            <button type="button" class="btn primary btn-xs" data-action="grant-group-single-file" data-file-id="${escapeHtml(file.id)}">👥 按组授权此文件</button>
            <button type="button" class="btn btn-xs" data-action="add-collaborator" data-file-id="${escapeHtml(file.id)}">➕ 添加单人邮箱</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  updateBatchButtons();
}

function updateBatchButtons() {
  const filtered = getFilteredFiles();
  const validSelected = [...state.selectedFileIds].filter(id => state.files.some(f => f.id === id));
  state.selectedFileIds = new Set(validSelected);

  const count = state.selectedFileIds.size;
  const hasGroupChosen = state.selectedBatchGroups.size > 0;

  $('selected-count').textContent = count;
  $('batch-enforce').disabled = count === 0;
  $('batch-downgrade-all').disabled = count === 0;
  $('batch-remove-public').disabled = count === 0;
  $('batch-revoke-all').disabled = count === 0;

  $('batch-grant-groups').disabled = count === 0 || !hasGroupChosen;
  $('batch-keep-only-groups').disabled = count === 0 || !hasGroupChosen;
  $('batch-revoke-groups').disabled = count === 0 || !hasGroupChosen;

  if (filtered.length > 0) {
    $('select-all').checked = filtered.every(f => state.selectedFileIds.has(f.id));
  } else {
    $('select-all').checked = false;
  }
}

/* ==================== TAB 2: 邮箱分组与人员表格管理 ==================== */

function renderGroupSelectorsAndBatchBar() {
  const groups = state.directory.groups || [];

  // 1. 批量栏中的分组多选框
  const batchGroupNode = $('batch-group-checkboxes');
  if (!groups.length) {
    batchGroupNode.innerHTML = '<span class="muted">请先在「邮箱分组」页创建组</span>';
  } else {
    batchGroupNode.innerHTML = groups
      .map(g => {
        const memberCount = (state.directory.contacts || []).filter(c => (c.groups || []).includes(g.name)).length;
        const checked = state.selectedBatchGroups.has(g.name) ? 'checked' : '';
        return `<label class="group-check-pill">
          <input type="checkbox" class="batch-grp-check" data-group="${escapeHtml(g.name)}" ${checked}>
          <span>${escapeHtml(g.name)} (${memberCount}人)</span>
        </label>`;
      })
      .join('');
  }

  // 2. 文件列表页的按分组筛选下拉
  const fileGroupSelect = $('file-group-filter');
  const prevVal = fileGroupSelect.value || 'all';
  fileGroupSelect.innerHTML =
    '<option value="all">👥 全部邮箱分组状态</option>' +
    '<option value="__partial__">⚠️ 存在分组未全员覆盖的文件</option>' +
    groups.map(g => `<option value="grp:${escapeHtml(g.name)}">👥 已授权给【${escapeHtml(g.name)}】的文件</option>`).join('');
  if ([...fileGroupSelect.options].some(o => o.value === prevVal)) {
    fileGroupSelect.value = prevVal;
  }

  // 3. 人员页的按分组筛选下拉
  const collabGroupSelect = $('collab-group-filter');
  const prevCollabGrp = collabGroupSelect.value || 'all';
  collabGroupSelect.innerHTML =
    '<option value="all">全部所属分组</option>' +
    '<option value="__ungrouped__">未分组人员</option>' +
    groups.map(g => `<option value="${escapeHtml(g.name)}">👥 ${escapeHtml(g.name)}</option>`).join('');
  if ([...collabGroupSelect.options].some(o => o.value === prevCollabGrp)) {
    collabGroupSelect.value = prevCollabGrp;
  }

  // 4. 表格导入目标分组下拉
  const importTargetSelect = $('import-target-group-select');
  const prevImportGrp = importTargetSelect.value;
  importTargetSelect.innerHTML =
    groups.map(g => `<option value="${escapeHtml(g.name)}">导入到：${escapeHtml(g.name)}</option>`).join('') +
    '<option value="">不预设组（仅按表格C列分组）</option>';
  if (prevImportGrp && [...importTargetSelect.options].some(o => o.value === prevImportGrp)) {
    importTargetSelect.value = prevImportGrp;
  }

  // 5. 已扫描到的 Google 表格下拉选择器（用于直接读取人员名单表）
  const sheetPicker = $('drive-sheet-picker');
  const sheets = state.files.filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
  const prevSheet = sheetPicker.value;
  sheetPicker.innerHTML =
    '<option value="">-- 从已扫描到的 Google 表格中选择人员名单表 --</option>' +
    sheets
      .map(s => `<option value="${escapeHtml(s.id)}">📊 ${escapeHtml(s.name)} (${escapeHtml(s.ownerAccount || '')})</option>`)
      .join('');
  if (prevSheet && [...sheetPicker.options].some(o => o.value === prevSheet)) {
    sheetPicker.value = prevSheet;
  }
}

function buildMergedPersonList() {
  const map = new Map();
  const scopedFiles = getScopedFilesByAccount();

  // 先装入通讯录中的所有联系人（即使暂时还没任何文件权限也能显示和管理！）
  for (const c of state.directory.contacts || []) {
    const email = normalizeEntry(c.email);
    if (!email) continue;
    map.set(email, {
      email,
      name: c.name || '',
      groups: [...(c.groups || [])],
      inDirectory: true,
      type: 'user',
      totalFiles: 0,
      editableFiles: 0,
      readerFiles: 0,
      inheritedFiles: 0,
      directRefs: []
    });
  }

  // 再合并扫描到的所有文件协作者
  for (const file of scopedFiles) {
    const ownerNorm = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    for (const p of file.permissions || []) {
      if (p.role === 'owner') continue;
      if (p.type !== 'user' && p.type !== 'group') continue;
      const email = normalizeEntry(p.emailAddress || '');
      if (!email || email === ownerNorm) continue;

      if (!map.has(email)) {
        map.set(email, {
          email,
          name: p.displayName || '',
          groups: [],
          inDirectory: false,
          type: p.type,
          totalFiles: 0,
          editableFiles: 0,
          readerFiles: 0,
          inheritedFiles: 0,
          directRefs: []
        });
      }
      const item = map.get(email);
      if (!item.name && p.displayName) item.name = p.displayName;
      item.totalFiles++;
      if (permIsInherited(p)) {
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

  return [...map.values()].sort((a, b) => {
    if (b.groups.length !== a.groups.length) return b.groups.length - a.groups.length;
    return b.totalFiles - a.totalFiles;
  });
}

function renderCollaboratorsTab() {
  renderGroupSelectorsAndBatchBar();

  // 渲染分组卡片
  const groupsContainer = $('groups-cards-container');
  const groups = state.directory.groups || [];
  const scopedFiles = getScopedFilesByAccount();

  if (!groups.length) {
    groupsContainer.innerHTML = '<div class="muted">尚未创建分组，请在右上方输入组名（如：1组、2组）点击「新建分组」。</div>';
  } else {
    groupsContainer.innerHTML = groups
      .map(g => {
        const members = (state.directory.contacts || []).filter(c => (c.groups || []).includes(g.name));
        const coveredFiles = scopedFiles.filter(f =>
          getFileGroupCoverage(f, state.directory).some(cov => cov.groupName === g.name)
        );
        const isReaderGrp = g.defaultRole === 'reader';
        return `<div class="group-card ${isReaderGrp ? 'reader-group' : ''}">
          <div class="group-card-head">
            <span class="group-card-title">👥 ${escapeHtml(g.name)}</span>
            <select class="perm-select" data-action="change-group-role" data-group="${escapeHtml(g.name)}">
              <option value="writer" ${g.defaultRole === 'writer' ? 'selected' : ''}>默认: ✏️ 可编辑 (白名单)</option>
              <option value="reader" ${g.defaultRole === 'reader' ? 'selected' : ''}>默认: 👁️ 仅查看 (白名单)</option>
            </select>
          </div>
          <div class="group-card-meta">
            成员：<strong>${members.length}</strong> 人 · 已关联文件：<strong>${coveredFiles.length}</strong> 个
          </div>
          <div class="group-card-actions">
            <button type="button" class="btn btn-xs" data-action="view-group-members" data-group="${escapeHtml(g.name)}">👤 看组员</button>
            <button type="button" class="btn btn-xs" data-action="view-group-files" data-group="${escapeHtml(g.name)}">📋 看本组文件</button>
            <button type="button" class="btn warning btn-xs" data-action="downgrade-whole-group" data-group="${escapeHtml(g.name)}" ${coveredFiles.length === 0 ? 'disabled' : ''}>👁️ 全组降只读</button>
            <button type="button" class="btn danger btn-xs" data-action="revoke-whole-group" data-group="${escapeHtml(g.name)}" ${coveredFiles.length === 0 ? 'disabled' : ''}>🗑️ 清空本组权限</button>
            <button type="button" class="btn btn-xs" data-action="delete-group" data-group="${escapeHtml(g.name)}" title="删除此分组">×</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // 渲染人员与分组对应总表
  const allPersons = buildMergedPersonList();
  const query = ($('collab-search')?.value || '').trim().toLowerCase();
  const groupFilter = $('collab-group-filter')?.value || 'all';
  const statusFilter = $('collab-filter')?.value || 'all';
  const tbody = $('collab-rows');

  const filtered = allPersons.filter(c => {
    const inWriters = matchesAllowlist(c.email, state.policy.writers);
    const inReaders = matchesAllowlist(c.email, state.policy.readers);
    const isStranger = !inWriters && !inReaders;
    const isOverprivileged = inReaders && c.editableFiles > 0;

    if (groupFilter === '__ungrouped__' && c.groups.length > 0) return false;
    if (groupFilter !== 'all' && groupFilter !== '__ungrouped__' && !c.groups.includes(groupFilter)) return false;

    if (statusFilter === 'in_directory' && !c.inDirectory) return false;
    if (statusFilter === 'stranger' && !isStranger) return false;
    if (statusFilter === 'overprivileged' && !isOverprivileged) return false;
    if (statusFilter === 'writer_list' && !inWriters) return false;
    if (statusFilter === 'reader_list' && !inReaders) return false;

    if (query) {
      const matchEmail = c.email.includes(query);
      const matchName = (c.name || '').toLowerCase().includes(query);
      const matchGrp = c.groups.some(g => g.toLowerCase().includes(query));
      if (!matchEmail && !matchName && !matchGrp) return false;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">没有匹配的人员记录（可在上方从表格粘贴或导入 A列名称、B列邮箱）</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map(c => {
      const inWriters = matchesAllowlist(c.email, state.policy.writers);
      const inReaders = matchesAllowlist(c.email, state.policy.readers);

      let statusBadge = '';
      if (inWriters) {
        statusBadge = '<span class="status-pill ok">✏️ 允许编辑</span>';
      } else if (inReaders) {
        statusBadge =
          c.editableFiles > 0
            ? `<span class="status-pill warning">🟠 越权 (${c.editableFiles}可编辑)</span>`
            : '<span class="status-pill ok">👁️ 合规只读</span>';
      } else {
        statusBadge = '<span class="status-pill danger">🔴 未在白名单</span>';
      }

      const groupTogglesHtml = groups
        .map(g => {
          const inGrp = c.groups.includes(g.name);
          return `<button type="button" class="group-toggle-chip ${inGrp ? 'in-group' : ''}" data-action="toggle-person-group" data-email="${escapeHtml(c.email)}" data-name="${escapeHtml(c.name || '')}" data-group="${escapeHtml(g.name)}" title="点击将此人加入或移出【${escapeHtml(g.name)}】">
            ${inGrp ? '✓ ' : '+ '}${escapeHtml(g.name)}
          </button>`;
        })
        .join('');

      return `<tr>
        <td>
          <div class="file-title-row">
            <strong>${escapeHtml(c.name || '—')}</strong>
            <button type="button" class="chip-btn" data-action="edit-person-name" data-email="${escapeHtml(c.email)}" data-name="${escapeHtml(c.name || '')}" title="修改名称/备注">✎</button>
          </div>
        </td>
        <td>
          <div class="file-name">${escapeHtml(c.email)}</div>
        </td>
        <td>
          ${groupTogglesHtml || '<span class="muted">暂无分组</span>'}
        </td>
        <td>
          共 <strong>${c.totalFiles}</strong> 个文件<br>
          <span class="muted">可编辑: ${c.editableFiles} · 只读: ${c.readerFiles}${c.inheritedFiles ? ` · 继承: ${c.inheritedFiles}` : ''}</span>
        </td>
        <td>
          ${statusBadge}
          <div style="margin-top:4px;">
            <button type="button" class="chip-btn" data-action="set-collab-tier" data-email="${escapeHtml(c.email)}" data-tier="writer">设为可编辑</button>
            <button type="button" class="chip-btn" data-action="set-collab-tier" data-email="${escapeHtml(c.email)}" data-tier="reader">设为只读</button>
          </div>
        </td>
        <td>
          <div class="batch-actions">
            <button type="button" class="btn btn-xs" data-action="filter-by-collab" data-email="${escapeHtml(c.email)}">🔍 看文件</button>
            <button type="button" class="btn warning btn-xs" data-action="downgrade-collab-all" data-email="${escapeHtml(c.email)}" ${c.editableFiles === 0 ? 'disabled' : ''}>👁️ 降只读</button>
            <button type="button" class="btn danger btn-xs" data-action="revoke-collab-all" data-email="${escapeHtml(c.email)}" ${c.directRefs.length === 0 ? 'disabled' : ''}>🗑️ 撤权限</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

/* ==================== 白名单与自动化配置视图 (TAB 3) ==================== */

function renderPolicyTab() {
  const contactLookup = buildContactLookup(state.directory);

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
        .map(item => {
          const disp = formatCollaboratorDisplay(item, '', contactLookup);
          return `<div class="allow-item">
            <span>${escapeHtml(disp)}</span>
            <div class="allow-item-actions">
              <button type="button" class="chip-btn" data-action="move-to-reader" data-entry="${escapeHtml(item)}" title="转为仅限查看">👁️ 转只读</button>
              <button type="button" class="chip-btn remove" data-action="remove-writer" data-entry="${escapeHtml(item)}" title="移除">×</button>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="muted">暂无条目。添加后，这些邮箱可拥有编辑或只读权限。</div>';

  $('readers-list').innerHTML = state.policy.readers.length
    ? state.policy.readers
        .map(item => {
          const disp = formatCollaboratorDisplay(item, '', contactLookup);
          return `<div class="allow-item">
            <span>${escapeHtml(disp)}</span>
            <div class="allow-item-actions">
              <button type="button" class="chip-btn" data-action="move-to-writer" data-entry="${escapeHtml(item)}" title="转为允许编辑">✏️ 转可编辑</button>
              <button type="button" class="chip-btn remove" data-action="remove-reader" data-entry="${escapeHtml(item)}" title="移除">×</button>
            </div>
          </div>`;
        })
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
  renderGroupSelectorsAndBatchBar();
  renderFilesTab();
  renderCollaboratorsTab();
  renderPolicyTab();
  renderLogsTab();
}

/* ==================== 核心交互动作实现 ==================== */

async function handleScan(targetAccountOverride = null) {
  $('scan').disabled = true;
  setStatus('扫描中…', true);
  $('progress').textContent = '正在准备扫描…';
  try {
    const targetAcc = targetAccountOverride || state.activeAccount || 'all';
    const result = await runFullScan({
      interactive: true,
      source: 'manual',
      targetAccount: targetAcc,
      onProgress(info) {
        $('progress').textContent = info.message;
      }
    });
    state.accounts = result.accounts;
    state.files = result.snapshot.files;
    state.lastScanAt = result.snapshot.lastScanAt;
    state.newFileIds = new Set(result.snapshot.newFileIds || []);
    state.logs = await getAuditLogs();

    const errCount = state.files.filter(f => f.permissionError).length;
    $('progress').textContent = errCount
      ? `扫描完成：共 ${state.files.length} 个文件（新增 ${result.newlyDiscoveredCount} 个），${errCount} 个文件读取权限失败`
      : `扫描完成：共 ${state.files.length} 个文件，发现 ${result.summary.anomalousFiles} 个权限异常文件`;
    renderAll();
  } catch (error) {
    $('progress').textContent = `扫描失败：${error.message}`;
    toast(`扫描失败：${error.message}`);
    renderAccountsBar();
  } finally {
    $('scan').disabled = false;
  }
}

async function persistSnapshotAndLogs() {
  const prev = await getSnapshot();
  await saveSnapshot({
    ...prev,
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
    const st = evaluateFile(f, state.policy, f.ownerAccount);
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
    const res = await enforceFilesByPolicy(null, targetFiles, state.policy, '', 'manual', prog => {
      $('progress').textContent = `正在修正权限 ${prog.done}/${prog.total}（已移除 ${prog.removed}，已降级 ${prog.downgraded}）…`;
    });
    await persistSnapshotAndLogs();
    $('progress').textContent = `修正完成：移除 ${res.removed} 项，降级为只读 ${res.downgraded} 项，失败 ${res.failed} 项`;
    toast(`处理完成：移除 ${res.removed} 项，降为只读 ${res.downgraded} 项`);
  } catch (error) {
    toast(`执行失败：${error.message}`);
  }
}

/* ==================== 按邮箱分组批量授权 / 对齐 / 撤权 ==================== */

async function handleGroupOperationOnFiles(targetFiles, groupNames, mode, roleOption = 'group_default') {
  if (!targetFiles.length) return toast('请先选择文件');
  if (!groupNames.length) return toast('请先选择至少一个邮箱分组');

  const membersCount = (state.directory.contacts || []).filter(c =>
    (c.groups || []).some(g => groupNames.includes(g))
  ).length;
  if (membersCount === 0 && mode !== 'keep_only_groups') {
    return toast(`所选分组【${groupNames.join('、')}】中还没有成员，请先在「邮箱分组与人员表格」页导入成员`);
  }

  const groupTitle = groupNames.join('、');
  const modeConfirmText = {
    grant: `确定为 ${targetFiles.length} 个文件开通分组【${groupTitle}】（共 ${membersCount} 名成员）的访问权限吗？`,
    keep_only_groups: `确定对 ${targetFiles.length} 个文件执行「仅保留【${groupTitle}】分组权限」吗？\n• 自动为组内成员补齐/对齐权限\n• 自动移除不属于所选分组的其他协作者直接权限`,
    revoke_groups: `确定从 ${targetFiles.length} 个文件中移除分组【${groupTitle}】所有成员的权限吗？`
  }[mode];

  if (!confirm(modeConfirmText)) return;

  try {
    $('progress').textContent = `正在按分组【${groupTitle}】处理权限…`;
    const res = await executeGroupBatchOnFiles({
      files: targetFiles,
      groupNames,
      mode,
      roleOption,
      directory: state.directory,
      onProgress(p) {
        $('progress').textContent = `按组处理中 ${p.done}/${p.total}（新增 ${p.createdCount}，调整 ${p.updatedCount}，移除 ${p.removedCount}）…`;
      }
    });
    await persistSnapshotAndLogs();
    $('progress').textContent = `按组【${groupTitle}】处理完成：新增授权 ${res.createdCount} 项，角色调整 ${res.updatedCount} 项，移除 ${res.removedCount} 项`;
    toast(`按组处理完成：新增 ${res.createdCount} 项，调整 ${res.updatedCount} 项，移除 ${res.removedCount} 项`);
  } catch (error) {
    toast(`按组操作失败：${error.message}`);
  }
}

/* ==================== 导入人员表格（A列名称、B列邮箱、可选C列分组） ==================== */

async function importParsedContacts(rows) {
  if (!rows.length) {
    toast('未识别到有效的人员邮箱行，请确认包含有效邮箱地址');
    return;
  }
  const contacts = [...(state.directory.contacts || [])];
  for (const r of rows) {
    contacts.push({
      email: r.email,
      name: r.name,
      groups: r.group ? [r.group] : []
    });
  }
  state.directory = await saveDirectory({
    groups: state.directory.groups,
    contacts
  });
  state.policy = await getPolicy();
  renderAll();
  toast(`✅ 已成功导入 ${rows.length} 条人员记录（自动按组同步白名单）！`);
}

/* ==================== 单文件行内与其它操作 ==================== */

async function handleInlineRoleChange(fileId, permId, newRole) {
  const file = state.files.find(f => f.id === fileId);
  const perm = file?.permissions?.find(p => p.id === permId);
  if (!file || !perm) return;
  const prevRole = perm.role;
  if (prevRole === newRole) return;

  try {
    const token = await resolveTokenForFile(file, true);
    await updatePermissionRole(token, fileId, permId, newRole);
    perm.role = newRole;
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'downgrade',
      accountEmail: file.ownerAccount || '',
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: file.webViewLink || '',
      permissionId: perm.id,
      targetType: perm.type,
      targetEmail: perm.emailAddress || '',
      domain: perm.domain || '',
      targetLabel: permissionLabel(perm, buildContactLookup(state.directory)),
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
  const label = permissionLabel(perm, buildContactLookup(state.directory));
  if (!confirm(`确定从「${file.name}」移除 ${label}（${roleLabel(perm.role)}）的权限吗？`)) return;

  try {
    const token = await resolveTokenForFile(file, true);
    await deletePermission(token, fileId, permId);
    file.permissions = (file.permissions || []).filter(p => p.id !== permId);
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'revoke',
      accountEmail: file.ownerAccount || '',
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
    const token = await resolveTokenForFile(file, true);
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
      accountEmail: file.ownerAccount || '',
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

async function handleBatchCustomAction(mode) {
  const files = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!files.length) return toast('请先勾选文件');

  if (mode === 'enforce') {
    return handleEnforceFiles(files);
  }

  const tasks = [];
  for (const file of files) {
    const ownerNorm = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    for (const p of file.permissions || []) {
      if (p.role === 'owner' || permIsInherited(p)) continue;
      if (p.emailAddress && normalizeEntry(p.emailAddress) === ownerNorm) continue;

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
    let done = 0;
    const logs = [];
    for (const item of tasks) {
      const { file, permission, action } = item;
      const token = await resolveTokenForFile(file, true);
      const label = permissionLabel(permission, buildContactLookup(state.directory));
      if (action === 'remove') {
        await deletePermission(token, file.id, permission.id);
        file.permissions = (file.permissions || []).filter(x => x.id !== permission.id);
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'revoke',
          accountEmail: file.ownerAccount || '',
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
          accountEmail: file.ownerAccount || '',
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

async function setCollaboratorAllowTier(email, tier) {
  const norm = normalizeEntry(email);
  const writers = state.policy.writers.filter(x => x !== norm);
  const readers = state.policy.readers.filter(x => x !== norm);
  if (tier === 'writer') writers.push(norm);
  if (tier === 'reader') readers.push(norm);
  state.policy = await savePolicy({ writers, readers });
  renderAll();
  const tierName = tier === 'writer' ? '允许编辑白名单' : tier === 'reader' ? '仅限查看白名单' : '白名单外';
  toast(`已将 ${norm} 设为：${tierName}`);
}

async function handleCollabBatchOp(email, opType) {
  const norm = normalizeEntry(email);
  const scopedFiles = getScopedFilesByAccount();
  const targets = [];
  for (const file of scopedFiles) {
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
    return toast('该人员没有可操作的目标直接权限');
  }
  const promptText =
    opType === 'downgrade'
      ? `确定将 ${norm} 在 ${targets.length} 个文件中的权限全部降级为「仅查看」吗？`
      : `确定撤除 ${norm} 在全部 ${targets.length} 个文件中的直接访问权限吗？`;
  if (!confirm(promptText)) return;

  try {
    const logs = [];
    for (const { file, permission } of targets) {
      const token = await resolveTokenForFile(file, true);
      if (opType === 'downgrade') {
        const prevRole = permission.role;
        await updatePermissionRole(token, file.id, permission.id, 'reader');
        permission.role = 'reader';
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'downgrade',
          accountEmail: file.ownerAccount || '',
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
          accountEmail: file.ownerAccount || '',
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
    const file = state.files.find(f => f.id === log.fileId);
    const token = await getValidTokenForAccount(log.accountEmail || file?.ownerAccount || '', true);

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
      accountEmail: log.accountEmail || '',
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

/* ==================== 白名单/分组 JSON 导入导出与 CSV 导出 ==================== */

async function importAllowlistFromObject(parsed) {
  let writers = [...state.policy.writers];
  let readers = [...state.policy.readers];
  let publicLinkRule = state.policy.publicLinkRule;

  if (parsed?.directory) {
    state.directory = await saveDirectory(parsed.directory);
  }

  if (Array.isArray(parsed) || Array.isArray(parsed?.keepEmails)) {
    const list = normalizeEmailList(Array.isArray(parsed) ? parsed : parsed.keepEmails);
    const asWriter = confirm(
      `检测到单列表白名单 JSON（共 ${list.length} 个邮箱）。\n点击「确定」导入到【允许编辑白名单】，点击「取消」导入到【仅限查看白名单】。`
    );
    if (asWriter) writers.push(...list);
    else readers.push(...list);
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    (Array.isArray(parsed.writers) || Array.isArray(parsed.readers) || parsed.directory)
  ) {
    if (Array.isArray(parsed.writers)) writers.push(...parsed.writers);
    if (Array.isArray(parsed.readers)) readers.push(...parsed.readers);
    if (['forbid', 'reader_only', 'allow'].includes(parsed.publicLinkRule)) {
      publicLinkRule = parsed.publicLinkRule;
    }
  } else {
    throw new Error('未识别的 JSON 格式（既不是 Google OAuth 凭证，也不是白名单/分组配置）');
  }

  state.policy = await savePolicy({ writers, readers, publicLinkRule });
  renderAll();
  toast(`配置导入成功：可编辑 ${state.policy.writers.length} 项，仅查看 ${state.policy.readers.length} 项`);
}

function handleExportPolicyJson() {
  const data = {
    writers: state.policy.writers,
    readers: state.policy.readers,
    publicLinkRule: state.policy.publicLinkRule,
    directory: state.directory,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'drive-allowlist-and-groups.json';
  link.click();
  URL.revokeObjectURL(url);
}

function handleExportCsv() {
  const scopedFiles = getScopedFilesByAccount();
  const contactLookup = buildContactLookup(state.directory);
  const lines = [
    [
      '所属账号',
      '文件名',
      '核心词根',
      '文件ID',
      '分类',
      '已授权分组',
      '是否新增',
      '链接',
      '权限类型',
      '角色',
      'A列姓名',
      'B列邮箱/范围',
      '所属分组',
      '是否继承',
      '合规判定'
    ]
  ];
  for (const file of scopedFiles) {
    const fileOwner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
    const perms = file.permissions?.length ? file.permissions : [null];
    const isNew = Boolean(file.isNew || state.newFileIds.has(file.id));
    const coreName = extractCoreFileName(file.name || '');
    const fileGroups = getFileGroupCoverage(file, state.directory)
      .map(c => `${c.groupName}(${c.grantedCount}/${c.totalCount})`)
      .join('; ');

    for (const p of perms) {
      const evalRes = p ? evaluatePermission(p, state.policy, fileOwner) : { reason: '仅自己可见' };
      const em = normalizeEntry(p?.emailAddress || '');
      const contact = contactLookup.get(em);
      lines.push([
        fileOwner,
        file.name || '',
        coreName,
        file.id || '',
        fileCategoryLabel(file.mimeType, file.name),
        fileGroups,
        isNew ? '是' : '否',
        file.webViewLink || '',
        p?.type || '',
        p ? roleLabel(p.role) : '',
        contact?.name || p?.displayName || '',
        p ? p.emailAddress || permissionLabel(p) : '',
        contact?.groups?.join('/') || '',
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
  state.directory = await getDirectory();
  state.filterPresets = await getFilterPresets();
  state.accounts = await getAuthorizedAccounts();
  state.oauthClients = await getOAuthClients();
  const snapshot = await getSnapshot();
  state.logs = await getAuditLogs();

  if (snapshot.files?.length) {
    state.files = snapshot.files;
    state.lastScanAt = snapshot.lastScanAt || '';
    state.newFileIds = new Set(snapshot.newFileIds || []);
    $('progress').textContent = `已加载上次扫描结果（${formatTime(state.lastScanAt)}，共 ${state.files.length} 个文件）`;
  }

  renderAll();

  // 顶部导入桌面 OAuth JSON 授权与多账号事件
  $('oauth-json-file').addEventListener('change', e => {
    if (e.target.files?.length) {
      handleOAuthFilesUpload(e.target.files);
      e.target.value = '';
    }
  });

  $('add-account-btn').addEventListener('click', handleAddMoreAccount);
  $('scan').addEventListener('click', () => handleScan());
  $('export').addEventListener('click', handleExportCsv);

  $('quick-enforce-all').addEventListener('click', () => {
    const scopedFiles = getScopedFilesByAccount();
    const anomalous = scopedFiles.filter(f => evaluateFile(f, state.policy, f.ownerAccount).hasActionableViolation);
    handleEnforceFiles(anomalous);
  });

  // 多账号栏切换与移除账号
  $('accounts-list').addEventListener('click', async e => {
    const removeBtn = e.target.closest('[data-action="remove-account"]');
    if (removeBtn) {
      e.stopPropagation();
      const email = removeBtn.dataset.email;
      if (!confirm(`确定移除账号 ${email} 的授权记录及本地缓存文件吗？`)) return;
      state.accounts = await removeAuthorizedAccount(email);
      state.files = state.files.filter(f => normalizeEntry(f.ownerAccount) !== normalizeEntry(email));
      if (normalizeEntry(state.activeAccount) === normalizeEntry(email)) {
        state.activeAccount = 'all';
      }
      await persistSnapshotAndLogs();
      toast(`已移除账号 ${email}`);
      return;
    }

    const switchBtn = e.target.closest('[data-action="switch-account"]');
    if (switchBtn) {
      state.activeAccount = switchBtn.dataset.email || 'all';
      state.selectedFileIds.clear();
      renderAll();
    }
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

  /* ==================== TAB 1 高级搜索与筛选器事件 ==================== */
  [
    'file-search',
    'search-match-mode',
    'file-exclude-search',
    'type-filter-mode',
    'file-group-filter',
    'file-name-pattern',
    'file-status-filter',
    'hide-private'
  ].forEach(id => {
    $(id).addEventListener('input', renderFilesTab);
    $(id).addEventListener('change', renderFilesTab);
  });

  // 快捷排除关键词按钮
  document.querySelectorAll('.quick-kw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kw = (btn.dataset.exKw || '').toLowerCase();
      const current = parseKeywords($('file-exclude-search').value);
      const next = current.includes(kw) ? current.filter(x => x !== kw) : [...current, kw];
      $('file-exclude-search').value = next.join(' ');
      renderFilesTab();
    });
  });

  // 文件类型多选胶囊（包含/排除）
  $('type-pills-bar').addEventListener('click', e => {
    const pill = e.target.closest('.type-pill');
    if (pill) {
      const cat = pill.dataset.typeCat;
      if (state.selectedTypeCats.has(cat)) state.selectedTypeCats.delete(cat);
      else state.selectedTypeCats.add(cat);
      renderFilesTab();
    }
  });

  $('clear-type-pills').addEventListener('click', () => {
    state.selectedTypeCats.clear();
    renderFilesTab();
  });

  $('reset-all-filters-btn').addEventListener('click', () => {
    $('file-search').value = '';
    $('search-match-mode').value = 'or';
    $('file-exclude-search').value = '';
    $('type-filter-mode').value = 'include';
    state.selectedTypeCats.clear();
    $('file-group-filter').value = 'all';
    $('file-name-pattern').value = 'default';
    $('file-status-filter').value = 'all';
    $('hide-private').checked = false;
    state.coreNameFilter = '';
    renderFilesTab();
    toast('已重置所有筛选条件');
  });

  // 保存常用筛选预设
  $('save-filter-preset-btn').addEventListener('click', async () => {
    const name = prompt('为当前筛选条件输入一个预设名称（如：核心财务表、待清理副本）：');
    if (!name || !name.trim()) return;
    const preset = {
      id: `pre_${Date.now()}`,
      name: name.trim(),
      search: $('file-search').value,
      matchMode: $('search-match-mode').value,
      excludeSearch: $('file-exclude-search').value,
      typeMode: $('type-filter-mode').value,
      selectedTypes: [...state.selectedTypeCats],
      groupFilter: $('file-group-filter').value,
      namePattern: $('file-name-pattern').value,
      statusFilter: $('file-status-filter').value,
      hidePrivate: $('hide-private').checked
    };
    state.filterPresets = await saveFilterPresets([...state.filterPresets, preset]);
    renderSavedPresetsBar();
    toast(`已保存筛选预设「${preset.name}」`);
  });

  $('saved-presets-bar').addEventListener('click', async e => {
    const delBtn = e.target.closest('[data-action="delete-preset"]');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.presetId;
      state.filterPresets = await saveFilterPresets(state.filterPresets.filter(p => p.id !== id));
      renderSavedPresetsBar();
      return;
    }
    const applyBtn = e.target.closest('[data-action="apply-preset"]');
    if (applyBtn) {
      const p = state.filterPresets.find(x => x.id === applyBtn.dataset.presetId);
      if (!p) return;
      $('file-search').value = p.search || '';
      $('search-match-mode').value = p.matchMode || 'or';
      $('file-exclude-search').value = p.excludeSearch || '';
      $('type-filter-mode').value = p.typeMode || 'include';
      state.selectedTypeCats = new Set(p.selectedTypes || []);
      $('file-group-filter').value = p.groupFilter || 'all';
      $('file-name-pattern').value = p.namePattern || 'default';
      $('file-status-filter').value = p.statusFilter || 'all';
      $('hide-private').checked = Boolean(p.hidePrivate);
      state.coreNameFilter = '';
      renderFilesTab();
      toast(`已应用筛选预设「${p.name}」`);
    }
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

  // 批量分组选择与按组批量按钮
  $('batch-group-checkboxes').addEventListener('change', e => {
    const chk = e.target.closest('.batch-grp-check');
    if (!chk) return;
    const grp = chk.dataset.group;
    if (chk.checked) state.selectedBatchGroups.add(grp);
    else state.selectedBatchGroups.delete(grp);
    updateBatchButtons();
  });

  $('batch-grant-groups').addEventListener('click', () => {
    const files = state.files.filter(f => state.selectedFileIds.has(f.id));
    const roleOpt = $('batch-group-role').value || 'group_default';
    handleGroupOperationOnFiles(files, [...state.selectedBatchGroups], 'grant', roleOpt);
  });

  $('batch-keep-only-groups').addEventListener('click', () => {
    const files = state.files.filter(f => state.selectedFileIds.has(f.id));
    const roleOpt = $('batch-group-role').value || 'group_default';
    handleGroupOperationOnFiles(files, [...state.selectedBatchGroups], 'keep_only_groups', roleOpt);
  });

  $('batch-revoke-groups').addEventListener('click', () => {
    const files = state.files.filter(f => state.selectedFileIds.has(f.id));
    handleGroupOperationOnFiles(files, [...state.selectedBatchGroups], 'revoke_groups');
  });

  // 常规批量按钮
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
    if (e.target.id === 'clear-core-filter-inline') {
      state.coreNameFilter = '';
      renderFilesTab();
      return;
    }
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
    } else if (action === 'fill-group-on-file') {
      const file = state.files.find(f => f.id === btn.dataset.fileId);
      if (file) handleGroupOperationOnFiles([file], [btn.dataset.group], 'grant', 'group_default');
    } else if (action === 'grant-group-single-file') {
      const file = state.files.find(f => f.id === btn.dataset.fileId);
      if (!file) return;
      const groups = state.directory.groups || [];
      if (!groups.length) return toast('请先在「邮箱分组与人员表格」页创建分组');
      const groupListStr = groups.map((g, idx) => `${idx + 1}. ${g.name} (默认:${roleLabel(g.defaultRole)})`).join('\n');
      const choice = prompt(
        `为「${file.name}」按组开通权限，请输入组名或序号（多个用逗号分隔）：\n${groupListStr}`,
        groups[0].name
      );
      if (!choice) return;
      const inputs = choice.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      const chosenNames = [];
      for (const inp of inputs) {
        const idx = Number(inp);
        if (!Number.isNaN(idx) && idx >= 1 && idx <= groups.length) {
          chosenNames.push(groups[idx - 1].name);
        } else if (groups.some(g => g.name === inp)) {
          chosenNames.push(inp);
        }
      }
      if (!chosenNames.length) return toast('未匹配到有效分组名称');
      handleGroupOperationOnFiles([file], chosenNames, 'grant', 'group_default');
    } else if (action === 'filter-core-name') {
      const core = btn.dataset.core;
      state.coreNameFilter = state.coreNameFilter === core ? '' : core;
      renderFilesTab();
      toast(state.coreNameFilter ? `已筛选同系列词根：${core}（再次点击标签可取消）` : '已恢复显示全部系列');
    }
  });

  /* ==================== TAB 2: 邮箱分组与人员表格事件 ==================== */

  $('create-group-btn').addEventListener('click', async () => {
    const name = ($('new-group-name').value || '').trim();
    if (!name) return toast('请输入新分组名称（如：1组、2组）');
    const role = $('new-group-role').value === 'writer' ? 'writer' : 'reader';
    $('new-group-name').value = '';
    const groups = [...(state.directory.groups || []), { name, defaultRole: role, policyTier: role }];
    state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已创建分组「${name}」`);
  });

  $('groups-cards-container').addEventListener('change', async e => {
    const sel = e.target.closest('[data-action="change-group-role"]');
    if (!sel) return;
    const grpName = sel.dataset.group;
    const newRole = sel.value === 'writer' ? 'writer' : 'reader';
    const groups = (state.directory.groups || []).map(g =>
      g.name === grpName ? { ...g, defaultRole: newRole, policyTier: newRole } : g
    );
    state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已将分组「${grpName}」默认权限设为：${roleLabel(newRole)}`);
  });

  $('groups-cards-container').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, group } = btn.dataset;
    if (action === 'view-group-members') {
      $('collab-group-filter').value = group;
      renderCollaboratorsTab();
    } else if (action === 'view-group-files') {
      switchTab('files');
      $('file-group-filter').value = `grp:${group}`;
      renderFilesTab();
    } else if (action === 'downgrade-whole-group') {
      const scopedFiles = getScopedFilesByAccount();
      handleGroupOperationOnFiles(scopedFiles, [group], 'grant', 'reader');
    } else if (action === 'revoke-whole-group') {
      const scopedFiles = getScopedFilesByAccount();
      handleGroupOperationOnFiles(scopedFiles, [group], 'revoke_groups');
    } else if (action === 'delete-group') {
      if (!confirm(`确定删除分组「${group}」吗？（组内联系人的邮箱记录仍会保留）`)) return;
      const groups = (state.directory.groups || []).filter(g => g.name !== group);
      const contacts = (state.directory.contacts || []).map(c => ({
        ...c,
        groups: (c.groups || []).filter(g => g !== group)
      }));
      state.directory = await saveDirectory({ groups, contacts });
      renderAll();
      toast(`已删除分组「${group}」`);
    }
  });

  // 方式 1：粘贴表格文本导入（A列名称、B列邮箱、可选C列分组）
  $('parse-paste-contacts-btn').addEventListener('click', async () => {
    const raw = $('paste-contacts-textarea').value;
    if (!raw || !raw.trim()) return toast('请先粘贴表格中的「名称 + 邮箱」内容');
    const fallbackGroup = $('import-target-group-select').value || '';
    const rows = parseTabularContactsText(raw, fallbackGroup);
    await importParsedContacts(rows);
    if (rows.length) $('paste-contacts-textarea').value = '';
  });

  // 上传 CSV/TSV 表格文件导入
  $('import-contacts-csv').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const fallbackGroup = $('import-target-group-select').value || '';
      const rows = parseTabularContactsText(text, fallbackGroup);
      await importParsedContacts(rows);
    } catch (error) {
      toast(`读取表格文件失败：${error.message}`);
    } finally {
      e.target.value = '';
    }
  });

  // 方式 2：直接从 Google Drive 的 Google 表格读取 A列名称、B列邮箱
  $('drive-sheet-picker').addEventListener('change', e => {
    if (e.target.value) $('drive-sheet-url-input').value = e.target.value;
  });

  $('fetch-drive-sheet-contacts-btn').addEventListener('click', async () => {
    const sheetInput = ($('drive-sheet-url-input').value || $('drive-sheet-picker').value || '').trim();
    if (!sheetInput) return toast('请先选择一个 Google 表格或输入表格链接/ID');
    const fallbackGroup = $('import-target-group-select').value || '';
    try {
      const fileId = extractDriveFileId(sheetInput);
      const matchedFile = state.files.find(f => f.id === fileId);
      const token = await resolveTokenForFile(matchedFile, true);
      $('progress').textContent = '正在从 Google 表格读取人员名单（A列名称、B列邮箱）…';
      const rows = await fetchContactsFromGoogleSheet(token, sheetInput, fallbackGroup);
      await importParsedContacts(rows);
      $('progress').textContent = `已从 Google 表格同步 ${rows.length} 条人员名单`;
    } catch (error) {
      toast(`从 Google 表格读取失败：${error.message}`);
    }
  });

  // 人员列表筛选与行内交互
  ['collab-search', 'collab-group-filter', 'collab-filter'].forEach(id => {
    $(id).addEventListener('input', renderCollaboratorsTab);
    $(id).addEventListener('change', renderCollaboratorsTab);
  });

  $('trust-all-current-writers').addEventListener('click', async () => {
    const collabs = buildMergedPersonList();
    if (!collabs.length) return toast('当前没有人员可导入');
    if (!confirm(`确定将当前 ${collabs.length} 名人员按其现有权限录入白名单吗？`)) return;
    const writers = [...state.policy.writers];
    const readers = [...state.policy.readers];
    for (const c of collabs) {
      if (c.editableFiles > 0) writers.push(c.email);
      else readers.push(c.email);
    }
    state.policy = await savePolicy({ writers, readers });
    renderAll();
    toast(`已将 ${collabs.length} 名人员同步至白名单`);
  });

  $('collab-rows').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, email, name, group, tier } = btn.dataset;

    if (action === 'toggle-person-group') {
      const norm = normalizeEntry(email);
      const contacts = [...(state.directory.contacts || [])];
      const existing = contacts.find(c => normalizeEntry(c.email) === norm);
      if (existing) {
        const hasGrp = (existing.groups || []).includes(group);
        existing.groups = hasGrp
          ? existing.groups.filter(g => g !== group)
          : [...(existing.groups || []), group];
      } else {
        contacts.push({ email: norm, name: name || '', groups: [group] });
      }
      state.directory = await saveDirectory({ groups: state.directory.groups, contacts });
      state.policy = await getPolicy();
      renderAll();
    } else if (action === 'edit-person-name') {
      const newName = prompt(`修改 ${email} 的名称/备注（对应表格 A列）：`, name || '');
      if (newName === null) return;
      const norm = normalizeEntry(email);
      const contacts = [...(state.directory.contacts || [])];
      const existing = contacts.find(c => normalizeEntry(c.email) === norm);
      if (existing) {
        existing.name = newName.trim();
      } else {
        contacts.push({ email: norm, name: newName.trim(), groups: [] });
      }
      state.directory = await saveDirectory({ groups: state.directory.groups, contacts });
      renderAll();
      toast(`已更新 ${email} 的名称为「${newName.trim()}」`);
    } else if (action === 'set-collab-tier') {
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

  /* ==================== TAB 3: 白名单与定期扫描设置事件 ==================== */
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
    const filteredReaders = [...state.policy.readers, ...entries];
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
    if (e.target.files?.length) {
      handleOAuthFilesUpload(e.target.files);
      e.target.value = '';
    }
  });
  $('export-policy-json').addEventListener('click', handleExportPolicyJson);

  /* ==================== TAB 4: 日志页事件 ==================== */
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
      state.accounts = await getAuthorizedAccounts();
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
