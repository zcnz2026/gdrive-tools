const $ = id => document.getElementById(id);

const ALL_TYPE_CATS = ['sheet', 'excel', 'doc', 'word_pdf', 'slide', 'folder', 'media', 'other'];

const STAGE_VIEW_TITLES = {
  assets: '云盘资产巡检',
  excluded: '排除扫描目录',
  'folder-links': '目录授权与跨表关联',
  groups: '邮箱分组与模板',
  partners: '合作方与全盘移除',
  settings: '账号与白名单设置'
};

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
  activeNav: 'assets',
  assetsSubTab: 'list',
  activeTab: 'ops',
  assetsViewMode: 'tree',
  flSubTab: 'batch',
  groupsSubTab: 'dir',
  expandedTreeFolderIds: new Set(),
  collapsedTreeFolderIds: new Set(),
  expandedUniformGroupIds: new Set(),
  selectedFileIds: new Set(),
  selectedTypeCats: new Set(ALL_TYPE_CATS),
  selectedBatchGroups: new Set(),
  pickedBatchAssetIds: new Set(),
  pickedExcludedFolderIds: new Set(),
  autoScanCheckpoint: null,
  thirdPartyAppAlerts: [],
  expandedPermFileIds: new Set(),
  inspectedFileId: '',
  rightPaneCollapsed: false,
  coreNameFilter: '',
  scanSheet: null,
  scanSheetFileIds: [],
  isUpdatingScanSheet: false,
  scanDetailView: false,
  batchLinksSheet: null,
  isUpdatingBatchSheet: false,
  batchMasterRows: Array.from({ length: 25 }, () => ['', '', '', '', '', '', '', '']),
  batchVisibleRowMap: Array.from({ length: 25 }, (_, i) => i),
  irBatchSheet: null,
  isUpdatingIrSheet: false,
  irBatchRows: Array.from({ length: 30 }, () => ['', '', '']),
  irBatchRunning: false,
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
  },
  onboardingDismissed: false,
  batchTaskRunning: false,
  batchTaskStopRequested: false,
  batchTaskRetryFn: null,
  batchTaskFailedItems: [],
  collabViewMode: 'people',
  collabSubTab: 'groups',
  lastOffboardResult: null,
  currentWindowId: null,
  permDiffs: {},
  ttlQueue: [],
  localTtlMutatingCount: 0,
  localTtlMutationEpoch: 0,
  roleBundles: [],
  editingBundleId: '',
  partnerProfiles: [],
  editingPartnerId: '',
  importRangeReport: null,
  importRangeScanning: false,
  dormantEntries: [],
  dormantScannedOnce: false
};

function hideToastPopover() {
  const node = $('toast');
  if (!node) return;
  toast._pausedForFocus = false;
  if (typeof node.hidePopover === 'function') {
    try {
      node.hidePopover();
    } catch (_e) {
      // ignore if popover is already closed
    }
  }
  node.classList.remove('show');
}

function toast(message) {
  const node = $('toast');
  if (!node) return;
  const cleanMsg = String(message ?? '');

  // 当模态对话框处于打开状态时，暂存通知并在模态框关闭后再弹出，避免被惰性背景遮挡漏看
  let openModal = null;
  try {
    openModal = typeof document !== 'undefined' ? document.querySelector?.('dialog:modal') : null;
  } catch (_e) {
    openModal = null;
  }
  if (openModal) {
    toast._queuedMessage = cleanMsg;
    if (!toast._modalHookedSet) toast._modalHookedSet = new WeakSet();
    if (!toast._modalHookedSet.has(openModal)) {
      toast._modalHookedSet.add(openModal);
      openModal.addEventListener(
        'close',
        () => {
          toast._modalHookedSet?.delete(openModal);
          if (toast._queuedMessage) {
            const pending = toast._queuedMessage;
            toast._queuedMessage = '';
            toast(pending);
          }
        },
        { once: true }
      );
    }
    return;
  }

  if (typeof document !== 'undefined' && document.activeElement && !node.contains?.(document.activeElement)) {
    toast._priorFocus = document.activeElement;
  }

  const textNode = $('toast-text');
  if (textNode) {
    textNode.textContent = cleanMsg;
  } else {
    node.textContent = cleanMsg;
  }

  if (typeof node.showPopover === 'function') {
    try {
      node.showPopover();
    } catch (_e) {
      // ignore if already open in top layer
    }
  }
  node.classList.add('show');

  // 屏幕阅读器无障碍播报：优先使用原生 ariaNotify()，回退至预置的 aria-live 区域
  if (typeof document !== 'undefined' && typeof document.ariaNotify === 'function') {
    try {
      document.ariaNotify(cleanMsg);
    } catch (_e) {
      // fallback handled below if needed
    }
  } else {
    const liveNode = $('toast-live-announcer');
    if (liveNode) {
      liveNode.textContent = '';
      setTimeout(() => {
        liveNode.textContent = cleanMsg;
      }, 16);
    }
  }

  clearTimeout(toast._timer);
  toast._pausedForFocus = false;
  toast._timer = setTimeout(() => {
    if (node.matches?.(':focus-within')) {
      toast._pausedForFocus = true;
      return;
    }
    hideToastPopover();
  }, 4500);
}

function bindImeSafeEnter(inputEl, onSubmit) {
  if (!inputEl || typeof onSubmit !== 'function') return;
  let lastCompositionEndAt = null;
  inputEl.addEventListener('compositionend', event => {
    lastCompositionEndAt = event.timeStamp;
  });
  inputEl.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (
        lastCompositionEndAt !== null &&
        typeof event.timeStamp === 'number' &&
        Math.abs(event.timeStamp - lastCompositionEndAt) < 50
      ) {
        return;
      }
      onSubmit(event);
    }
  });
}

function getSystemColorScheme() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function getStoredColorScheme() {
  try {
    const val = localStorage.getItem('color-scheme');
    return val === 'light' || val === 'dark' ? val : null;
  } catch (_e) {
    return null;
  }
}

function applyColorSchemeMeta(storedScheme) {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector?.('meta[name="color-scheme"]');
  if (meta) {
    meta.content = storedScheme === 'light' || storedScheme === 'dark' ? storedScheme : 'light dark';
  }
}

function syncThemeControlsUI() {
  const sys = getSystemColorScheme();
  const stored = getStoredColorScheme();
  const rendered = stored || sys;

  const sel = $('theme-mode-select');
  if (sel) {
    const sysOpt = sel.querySelector?.('option[value="system"]') || sel.options?.[0];
    if (sysOpt && sysOpt.value === 'system') {
      sysOpt.textContent = `跟随系统 (当前${sys === 'dark' ? '深色' : '浅色'})`;
    }
    sel.value = stored || 'system';
  }

  const toggleBtn = $('theme-toggle-btn');
  if (toggleBtn) {
    const label = rendered === 'dark' ? '切换至浅色界面' : '切换至深色界面';
    toggleBtn.setAttribute?.('aria-label', label);
    toggleBtn.title = label;
  }
}

function toggleComfortColorScheme() {
  const sys = getSystemColorScheme();
  const stored = getStoredColorScheme();
  const currentlyRendered = stored || sys;
  const target = currentlyRendered === 'dark' ? 'light' : 'dark';

  try {
    if (target === sys) {
      localStorage.removeItem('color-scheme');
      applyColorSchemeMeta(null);
    } else {
      localStorage.setItem('color-scheme', target);
      applyColorSchemeMeta(target);
    }
  } catch (_e) {
    applyColorSchemeMeta(target === sys ? null : target);
  }
  syncThemeControlsUI();
}

function setExplicitColorScheme(mode) {
  try {
    if (mode === 'light' || mode === 'dark') {
      localStorage.setItem('color-scheme', mode);
      applyColorSchemeMeta(mode);
    } else {
      localStorage.removeItem('color-scheme');
      applyColorSchemeMeta(null);
    }
  } catch (_e) {
    applyColorSchemeMeta(mode === 'light' || mode === 'dark' ? mode : null);
  }
  syncThemeControlsUI();
}

function initDialogLightDismissFallback() {
  if (typeof HTMLDialogElement === 'undefined' || 'closedBy' in HTMLDialogElement.prototype) return;
  if (typeof document === 'undefined' || !document.querySelectorAll) return;

  const isOutsideDialog = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', e => {
      pressedOutside = e.target === dialog && isOutsideDialog(e, dialog);
    });
    dialog.addEventListener('pointerup', e => {
      if (pressedOutside && e.target === dialog && isOutsideDialog(e, dialog)) {
        dialog.close();
      }
      pressedOutside = false;
    });
  });
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

function sanitizeExternalUrl(url = '') {
  if (!url) return '#';
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch (_e) {
    // reject invalid or non-http(s) URLs such as javascript: or data:
  }
  return '#';
}

function escapeCsvCell(value = '') {
  let str = String(value ?? '');
  // 防御电子表格公式注入（CSV / DDE Injection，CWE-1236）
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replaceAll('"', '""')}"`;
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

function setRightPaneCollapsed(collapsed) {
  state.rightPaneCollapsed = Boolean(collapsed);
  const ws = $('main-split-workspace');
  if (ws) ws.classList.toggle('right-collapsed', state.rightPaneCollapsed);
  const btn = $('toggle-right-pane-btn');
  if (btn) {
    btn.textContent = state.rightPaneCollapsed ? '展开侧栏 ◂' : '收起侧栏 ▸';
  }
}

let activeDryRunResolve = null;

function resolveActiveDryRun(confirmed = false) {
  if (activeDryRunResolve) {
    const fn = activeDryRunResolve;
    activeDryRunResolve = null;
    fn(Boolean(confirmed));
  }
}

function closeDryRunModal(confirmed = false) {
  const modal = $('dry-run-modal');
  const retVal = confirmed ? 'confirm' : 'cancel';
  if (modal && typeof modal.close === 'function') {
    if (modal.open) {
      modal.close(retVal);
    } else {
      modal.returnValue = '';
    }
  } else if (modal) {
    modal.classList?.add('hidden');
  }
  resolveActiveDryRun(confirmed);
}

function confirmWithDryRunModal({ title = '批量权限变更预演确认', summaryHtml = '', previewItems = [], confirmText = '确认执行变更', isDanger = false, fallbackText = '' }) {
  const modal = $('dry-run-modal');
  if (!modal) {
    return Promise.resolve(confirm(fallbackText || title));
  }
  $('dry-run-title').textContent = title;
  $('dry-run-summary').innerHTML = summaryHtml;
  const body = $('dry-run-body');
  if (!previewItems.length) {
    body.innerHTML = `<div class="muted">即将按上述范围执行变更</div>`;
  } else {
    const shown = previewItems.slice(0, 80);
    body.innerHTML =
      shown
        .map(
          it => `<div class="dry-run-item">
            <strong>${escapeHtml(it.title || '')}</strong>
            <div>${escapeHtml(it.detail || '')}</div>
          </div>`
        )
        .join('') +
      (previewItems.length > shown.length
        ? `<div class="muted">… 及另外 ${previewItems.length - shown.length} 项</div>`
        : '');
  }
  const confirmBtn = $('dry-run-confirm-btn');
  if (confirmBtn) {
    confirmBtn.textContent = confirmText;
    confirmBtn.className = isDanger ? 'btn danger' : 'btn primary';
  }
  modal.returnValue = '';
  if (typeof modal.showModal === 'function') {
    if (!modal.open) modal.showModal();
  } else {
    modal.classList?.remove('hidden');
  }
  return new Promise(resolve => {
    activeDryRunResolve = resolve;
  });
}

async function resolveTokenForFile(file, interactive = true) {
  const owner =
    file?.ownerAccount ||
    file?.owners?.[0]?.emailAddress ||
    (state.activeAccount !== 'all' ? state.activeAccount : '');
  return getValidTokenForAccount(owner, interactive);
}

function getAccountFilesIncludingExcluded() {
  if (state.activeAccount === 'all') return state.files;
  const target = normalizeEntry(state.activeAccount);
  return state.files.filter(f => normalizeEntry(f.ownerAccount || f.owners?.[0]?.emailAddress || '') === target);
}

function getScopedFilesByAccount() {
  const accountFiles = getAccountFilesIncludingExcluded();
  const excludedIdSet = getCurrentExcludedIdSet();
  if (!excludedIdSet.size) return accountFiles;
  return accountFiles.filter(f => !isFileExcludedCompat(f, excludedIdSet));
}

function pruneExcludedSelectionAndInspector() {
  const excludedIdSet = getCurrentExcludedIdSet();
  if (!excludedIdSet.size) return;
  const fileMap = new Map(state.files.map(f => [f.id, f]));
  for (const id of [...state.selectedFileIds]) {
    const f = fileMap.get(id);
    if (excludedIdSet.has(id) || (f && isFileExcludedCompat(f, excludedIdSet))) {
      state.selectedFileIds.delete(id);
    }
  }
  if (state.inspectedFileId) {
    const inspected = fileMap.get(state.inspectedFileId);
    if (
      excludedIdSet.has(state.inspectedFileId) ||
      (inspected && isFileExcludedCompat(inspected, excludedIdSet))
    ) {
      state.inspectedFileId = '';
    }
  }
}

/* ==================== 顶部状态、账号下拉与设置内账号列表 ==================== */

function syncOnboardingStageUI() {
  const shouldShow =
    state.accounts.length === 0 &&
    state.oauthClients.length === 0 &&
    state.files.length === 0 &&
    !state.onboardingDismissed;
  $('onboarding-stage')?.classList.toggle('hidden', !shouldShow);
  $('scan-results-header')?.classList.toggle('hidden', shouldShow);
  $('summary')?.classList.toggle('hidden', shouldShow);
  document.querySelector('#view-assets .asset-filter-bar')?.classList.toggle('hidden', shouldShow);
  document.querySelector('#view-assets .asset-list-sticky-header')?.classList.toggle('hidden', shouldShow);
  document.querySelector('#view-assets .asset-stage-body')?.classList.toggle('hidden', shouldShow);
  if (shouldShow) {
    $('asset-tree-wrap')?.classList.add('hidden');
    $('scan-results-scroll')?.classList.add('hidden');
  } else if ($('asset-tree-wrap')) {
    const isTree = state.assetsViewMode !== 'grid';
    $('asset-tree-wrap')?.classList.toggle('hidden', !isTree);
    $('scan-results-scroll')?.classList.toggle('hidden', isTree);
  } else {
    $('scan-results-scroll')?.classList.remove('hidden');
  }
}

function renderAccountsUI() {
  syncOnboardingStageUI();

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
      const typeIcon = isSa ? '服务账号' : 'OAuth 客户端';
      const boundList = Array.isArray(c.boundEmails) && c.boundEmails.length
        ? c.boundEmails.join(', ')
        : c.boundEmail || '';
      const bound = boundList ? `已授权: ${boundList}` : '未授权';
      const statusCls = boundList ? 'ok' : 'warning';
      const btnText = isSa
        ? '刷新令牌'
        : boundList
        ? '再登录其他邮箱 / 重授'
        : '弹出浏览器登录';
      return `<div class="allow-item">
        <span class="inspector-perm-info" title="${escapeHtml(c.client_id)}">
          <strong>${escapeHtml(name)}</strong>
          <span class="badge">${typeIcon}</span>
          <span class="status-pill ${statusCls}">${escapeHtml(bound)}</span>
        </span>
        <span class="row-flex">
          <button type="button" class="btn btn-xs primary" data-action="auth-oauth-client" data-uid="${escapeHtml(uid)}" title="使用此 JSON 凭证弹出浏览器选择任意 Google 邮箱登录（同一个桌面 OAuth 凭证可连续登录多个浏览器邮箱）">${btnText}</button>
          <button type="button" class="btn-text btn-text-danger" data-action="remove-oauth-client" data-uid="${escapeHtml(uid)}" title="删除此 JSON 凭证">×</button>
        </span>
      </div>`;
    })
    .join('');

  const accountPillsHtml = state.accounts.length
    ? `<div class="accounts-pills">` +
      state.accounts
        .map(
          acc => `<span class="account-pill">
            <span>${escapeHtml(acc.email)}</span>
            <button type="button" class="remove-acc" data-action="remove-account" data-email="${escapeHtml(acc.email)}" title="移除此账号">×</button>
          </span>`
        )
        .join('') +
      `</div>`
    : '';

  listNode.innerHTML = clientRowsHtml + accountPillsHtml;
}

function applySnapshotToState(snapshot = {}) {
  state.files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  state.newFileIds = new Set(Array.isArray(snapshot?.newFileIds) ? snapshot.newFileIds : []);
  state.lastScanAt = snapshot?.lastScanAt || '';
  state.permDiffs = snapshot?.permDiffs && typeof snapshot.permDiffs === 'object' ? snapshot.permDiffs : {};
  if (typeof hydrateFilesPermissionDiffs === 'function') {
    hydrateFilesPermissionDiffs(state.files, state.permDiffs);
  }
}

function resolveFileDiffInfo(file) {
  if (!file) return null;
  if (typeof getFilePermissionDiff === 'function') {
    const diff = getFilePermissionDiff(file, state.permDiffs);
    if (diff && diff.changed !== false) return diff;
  }
  const fallback = file.permDiff || file._permDiff || state.permDiffs?.[file.id] || null;
  if (fallback && fallback.changed !== false) return fallback;
  if (file.hasPermDiff) return { changed: true, summaryText: '较上次扫描发生权限变动', changes: [] };
  return null;
}

function formatDiffDetailsText(diff) {
  if (!diff) return '';
  const items = Array.isArray(diff.changes) ? diff.changes : [];
  const formatted = items
    .map(ch => {
      if (!ch) return '';
      if (typeof ch === 'string') return ch;
      return ch.summary || ch.text || ch.description || ch.message || ch.detail || ch.label || '';
    })
    .filter(Boolean);
  if (formatted.length > 0) {
    return formatted.join('；');
  }
  return diff.summaryText || '较上次扫描发生权限变动';
}

function formatLocalDateTimeInputValue(date = new Date(Date.now() + 24 * 3600 * 1000)) {
  const d =
    date instanceof Date && !Number.isNaN(date.getTime())
      ? date
      : new Date(Date.now() + 24 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bindTtlSelectWithCustomInput(selectId, customInputId) {
  const sel = $(selectId);
  const inp = $(customInputId);
  if (!sel || !inp) return;
  const syncVisibility = () => {
    const isCustom = sel.value === 'custom';
    inp.classList.toggle('hidden', !isCustom);
    if (isCustom && !inp.value) {
      inp.value = formatLocalDateTimeInputValue();
    }
  };
  sel.addEventListener('change', syncVisibility);
  syncVisibility();
}

function resetTtlControls(selectId, customInputId) {
  const sel = $(selectId);
  const inp = $(customInputId);
  if (sel) sel.value = 'none';
  if (inp) {
    inp.value = '';
    inp.classList.add('hidden');
  }
}

function formatTtlBadgeText(expiresAt) {
  if (!expiresAt) return '';
  if (typeof formatTtlRemaining === 'function') {
    return formatTtlRemaining(expiresAt, Date.now());
  }
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return '';
  if (diffMs <= 0) return '已到期';
  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `剩余 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `剩余 ${hours} 小时`;
  return `剩余 ${Math.ceil(hours / 24)} 天`;
}

function getTtlUrgencyClass(expiresAt) {
  if (!expiresAt) return '';
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return '';
  if (diffMs <= 0) return 'expired';
  if (diffMs <= 2 * 3600 * 1000) return 'warning';
  return '';
}

function resolveTtlSelection(selectId, customInputId) {
  const preset = $(selectId)?.value || 'none';
  const customVal = ($(customInputId)?.value || '').trim();
  if (!preset || preset === 'none') {
    return { preset: 'none', expiresAt: '', label: '长期有效' };
  }
  let expiresAt = '';
  if (typeof resolveTtlExpiresAt === 'function') {
    expiresAt = resolveTtlExpiresAt(preset, customVal) || '';
  } else {
    const now = Date.now();
    if (preset === '24h') expiresAt = new Date(now + 24 * 3600 * 1000).toISOString();
    else if (preset === '7d') expiresAt = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
    else if (preset === '30d') expiresAt = new Date(now + 30 * 24 * 3600 * 1000).toISOString();
    else if (preset === 'custom') {
      if (!customVal) throw new Error('请选择自定义到期时间');
      const ts = new Date(customVal).getTime();
      if (Number.isNaN(ts) || ts <= now) throw new Error('自定义到期时间必须晚于当前时间');
      expiresAt = new Date(ts).toISOString();
    }
  }
  const remainText = expiresAt ? formatTtlBadgeText(expiresAt) : '';
  const label = expiresAt
    ? `限时至 ${formatTime(expiresAt)}${remainText ? ` (${remainText})` : ''}`
    : '长期有效';
  return { preset, expiresAt, label };
}

function getActivePendingTtlEntries() {
  return (Array.isArray(state.ttlQueue) ? state.ttlQueue : []).filter(
    entry => entry && (!entry.status || entry.status === 'pending' || entry.status === 'failed')
  );
}

function findMatchingTtlEntryForPerm(fileId, perm) {
  if (!fileId || !perm) return null;
  const permEmail = normalizeEntry(perm.emailAddress || '');
  const permDomain = normalizeEntry(perm.domain || '');
  for (const entry of getActivePendingTtlEntries()) {
    if (entry.fileId !== fileId) continue;
    if (perm.id && entry.permissionId && entry.permissionId === perm.id) return entry;
    const entryEmail = normalizeEntry(entry.targetEmail || entry.emailAddress || '');
    if (permEmail && entryEmail && permEmail === entryEmail) return entry;
    const entryType = entry.targetType || entry.type || '';
    const entryDomain = normalizeEntry(entry.domain || '');
    if (perm.type === 'domain' && entryType === 'domain' && permDomain && permDomain === entryDomain) {
      return entry;
    }
    if (perm.type === 'anyone' && entryType === 'anyone') {
      return entry;
    }
  }
  return null;
}

async function refreshTtlQueueState() {
  if (typeof getTtlQueue === 'function') {
    try {
      const list = await getTtlQueue();
      state.ttlQueue = Array.isArray(list) ? list : [];
    } catch (_e) {
      // ignore storage read error in tests
    }
  }
  return state.ttlQueue;
}

function updateTopBadges() {
  renderAccountsUI();

  const scheduleNode = $('schedule-badge');
  if (scheduleNode) {
    if (state.policy.scheduleEnabled) {
      const modeLabel = state.policy.autoEnforce ? '自动修正' : '仅提醒';
      scheduleNode.textContent = `巡检：每${state.policy.scheduleMinutes}分 (${modeLabel})`;
      scheduleNode.classList.add('active');
    } else {
      scheduleNode.textContent = '定时巡检：未开启';
      scheduleNode.classList.remove('active');
    }
  }

  const scopedFiles = getScopedFilesByAccount();
  const summary = computeSummary(scopedFiles, state.policy, '', state.newFileIds);
  const diffCount =
    typeof summary.changedFiles === 'number'
      ? summary.changedFiles
      : scopedFiles.filter(f => Boolean(resolveFileDiffInfo(f))).length;
  if ($('stat-total')) $('stat-total').textContent = summary.total;
  if ($('stat-shared')) $('stat-shared').textContent = summary.shared;
  if ($('stat-unauthorized')) $('stat-unauthorized').textContent = summary.unauthorizedFiles;
  if ($('stat-overprivileged')) $('stat-overprivileged').textContent = summary.overprivilegedFiles;
  if ($('stat-inheritance-broken')) {
    $('stat-inheritance-broken').textContent = summary.inheritanceBrokenFiles || 0;
  }
  if ($('stat-public')) $('stat-public').textContent = summary.publicFiles;
  if ($('stat-diff')) {
    $('stat-diff').textContent = diffCount;
  }
  if ($('stat-new')) $('stat-new').textContent = summary.newFiles;

  const enforceBtn = $('quick-enforce-all');
  if (enforceBtn) {
    enforceBtn.textContent = `一键修正异常 (${summary.anomalousFiles})`;
    enforceBtn.disabled = summary.anomalousFiles === 0;
  }

  if ($('export')) $('export').disabled = scopedFiles.length === 0;
  $('clear-diff-flags')?.classList.toggle('hidden', diffCount === 0);
  $('clear-new-flags')?.classList.toggle('hidden', summary.newFiles === 0);

  if ($('nav-count-assets')) $('nav-count-assets').textContent = summary.total;
  if ($('nav-count-excluded')) {
    $('nav-count-excluded').textContent = (state.policy?.excludedFolders || []).length;
  }
  if ($('nav-count-groups')) {
    const grpTotal = (state.directory.groups?.length || 0) + (state.roleBundles?.length || 0);
    $('nav-count-groups').textContent = grpTotal;
  }
  if ($('tab-count-collabs')) $('tab-count-collabs').textContent = buildMergedPersonList().length;
  if ($('tab-count-logs')) $('tab-count-logs').textContent = state.logs.length;

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

function extractEmailsFromText(rawText = '') {
  if (typeof parseEmailListInput === 'function') {
    return parseEmailListInput(rawText);
  }
  if (typeof parseEmailsInput === 'function') {
    return parseEmailsInput(rawText);
  }
  const matches = String(rawText || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(matches.map(e => normalizeEntry(e)).filter(Boolean))];
}

function groupRoleDisplayLabel(role = 'reader') {
  if (role === 'writer') return '可编辑';
  if (role === 'commenter') return '可评论';
  return '仅查看';
}

function isDisallowedPassportPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (
    parsed.type === 'gdrive_auth_passport' ||
    parsed.format === 'gdrive_auth_passport_encrypted' ||
    Boolean(parsed.encryptedPassport) ||
    (Boolean(parsed.ciphertext) && Boolean(parsed.kdf)) ||
    Array.isArray(parsed.authorizedAccounts)
  ) {
    return true;
  }
  const hasRawToken = Boolean(parsed.refresh_token || parsed.refreshToken || parsed.access_token || parsed.accessToken);
  const isStandardClient = Boolean(parsed.installed || parsed.web || parsed.type === 'service_account' || parsed.private_key);
  return hasRawToken && !isStandardClient;
}

async function handleOAuthFilesUpload(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  const extractedClients = [];
  let allowlistImported = false;
  let rejectedCount = 0;

  for (const file of files) {
    try {
      const parsed = JSON.parse(await file.text());

      if (isDisallowedPassportPayload(parsed)) {
        rejectedCount++;
        throw new Error('已移除免授权通行证导入功能，请导入标准 Google OAuth 客户端 JSON 在浏览器中完成授权');
      }

      const clients = extractOAuthClientsFromJson(parsed, file.name);
      if (clients.length > 0) {
        extractedClients.push(...clients);
      } else if (
        Array.isArray(parsed) ||
        (parsed &&
          typeof parsed === 'object' &&
          (parsed.policy ||
            parsed.directory ||
            Array.isArray(parsed.writers) ||
            Array.isArray(parsed.readers) ||
            Array.isArray(parsed.allowList) ||
            Array.isArray(parsed.groups) ||
            Array.isArray(parsed.contacts)))
      ) {
        await importAllowlistFromObject(parsed);
        allowlistImported = true;
      } else {
        rejectedCount++;
        toast(`文件 ${file.name} 未包含有效的 Google OAuth 客户端凭证或白名单配置`);
      }
    } catch (error) {
      rejectedCount++;
      toast(`读取 ${file.name} 失败：${error.message}`);
    }
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
  } else if (!allowlistImported && rejectedCount === 0) {
    toast('未识别到有效的 Google OAuth 客户端 JSON、服务账号凭证或白名单配置');
  }
}

async function handleAddMoreAccount(loginHint = '', roleTarget = '') {
  state.oauthClients = await getOAuthClients();
  // 只筛选支持弹出浏览器登录的桌面/Web OAuth 客户端凭证（排除 Service Account JSON）
  const interactiveClients = state.oauthClients.filter(
    c => c.client_type !== 'service_account' && c.client_id && c.client_secret
  );

  if (!interactiveClients.length) {
    if (state.oauthClients.length > 0) {
      toast('当前仅导入了 Service Account 服务账号密钥 JSON。如需授权个人或团队邮箱，请导入桌面端 OAuth Client JSON 文件！');
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
  const breakageMap = statusFilter === 'inheritance_broken' ? analyzeInheritanceBreakage(baseFiles) : null;

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
    if (statusFilter === 'inheritance_broken' && !getFileInheritanceBreakage(file, breakageMap)) return false;
    if (statusFilter === 'public' && !evalStat.hasPublic) return false;
    if (statusFilter === 'writers_can_share' && file.writersCanShare === false) return false;
    if (
      statusFilter === 'copy_unlocked' &&
      (file.mimeType === 'application/vnd.google-apps.folder' || file.copyRequiresWriterPermission === true)
    ) {
      return false;
    }
    if (statusFilter === 'shared' && !evalStat.hasNonOwner) return false;
    if (statusFilter === 'diff' && !resolveFileDiffInfo(file)) return false;
    if (statusFilter === 'new' && !isNew) return false;

    // 邮箱分组覆盖与绑定资产过滤
    if (groupFilter !== 'all') {
      const cov = getFileGroupCoverage(file, state.directory);
      if (groupFilter === '__partial__') {
        if (!cov.some(c => c.status === 'partial')) return false;
      } else if (groupFilter.startsWith('grp:')) {
        const gName = groupFilter.slice(4);
        const grpObj = (state.directory.groups || []).find(g => g.name === gName);
        const isBoundAsset = Boolean(grpObj?.assets?.some(a => a && a.fileId === file.id));
        if (!cov.some(c => c.groupName === gName) && !isBoundAsset) return false;
      }
    }

    if (patternMode === 'duplicates_only' && (coreCounts.get(coreName) || 0) < 2) return false;
    if (patternMode === 'messy_only' && !analyzeMessyFileName(file.name || '').isMessy) return false;

    const fileNameLower = (file.name || '').toLowerCase();
    if (excludeTerms.length > 0 && excludeTerms.some(term => fileNameLower.includes(term))) {
      return false;
    }

    if (includeTerms.length > 0) {
      const ownerNorm = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
      const nonOwnerPerms = (file.permissions || []).filter(p => {
        if (!p || p.role === 'owner') return false;
        const em = normalizeEntry(p.emailAddress || '');
        if (em && em === ownerNorm) return false;
        return true;
      });

      const cov = getFileGroupCoverage(file, state.directory);
      const searchableChunks = [
        fileNameLower,
        coreName,
        (file.id || '').toLowerCase(),
        (file.ownerAccount || '').toLowerCase(),
        ...cov.map(c => c.groupName.toLowerCase()),
        ...(file.permissions || []).map(p => {
          const em = normalizeEntry(p.emailAddress || '');
          const dom = (p.domain || '').toLowerCase();
          const contact = contactLookup.get(em);
          return [
            em,
            (p.displayName || '').toLowerCase(),
            dom,
            dom ? `@${dom}` : '',
            (contact?.name || '').toLowerCase(),
            ...(contact?.groups || []).map(g => g.toLowerCase())
          ].join(' ');
        })
      ];
      const fullSearchText = searchableChunks.join(' ');

      const checkSingleTerm = term => {
        if (term.startsWith('domain:')) {
          const targetDom = term.slice(7).replace(/^@/, '').trim().toLowerCase();
          if (!targetDom) return true;
          return nonOwnerPerms.some(p => {
            if (p.type !== 'user' && p.type !== 'group') return false;
            const em = normalizeEntry(p.emailAddress || '');
            return em && extractEmailDomain(em) === targetDom;
          });
        }
        if (term.startsWith('@') && term.length > 1) {
          const domQuery = term.slice(1).toLowerCase();
          return nonOwnerPerms.some(p => {
            const em = normalizeEntry(p.emailAddress || '');
            if (em && (extractEmailDomain(em) === domQuery || em.includes(term))) return true;
            const pDom = (p.domain || '').toLowerCase();
            return Boolean(pDom && (pDom === domQuery || `@${pDom}`.includes(term)));
          });
        }
        return matchMode === 'fuzzy' ? fuzzyMatchTerm(fullSearchText, term) : fullSearchText.includes(term);
      };

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

function enableSingleClickDropdown(hostEl, getSheetInstance, dropdownColsSet) {
  if (!hostEl || typeof hostEl.addEventListener !== 'function') return;
  hostEl.addEventListener('click', e => {
    const td = e.target?.closest?.('td[data-x][data-y]');
    if (!td) return;
    const col = Number(td.dataset.x);
    if (!dropdownColsSet.has(col)) return;
    if (td.classList?.contains('editor') || e.target?.closest?.('.jdropdown-container, input, select')) {
      return;
    }
    const sheet = getSheetInstance?.();
    if (!sheet || typeof sheet.openEditor !== 'function') return;
    setTimeout(() => {
      if (!td.classList?.contains('editor')) {
        try {
          sheet.openEditor(td, false);
        } catch (_err) {
          // ignore if cell already editing or detached
        }
      }
    }, 0);
  });
}

function ensureBatchLinksAutoCapacity(minSpareRows = 3, appendCount = 20) {
  if (!Array.isArray(state.batchMasterRows)) {
    state.batchMasterRows = Array.from({ length: 25 }, () => ['', '', '', '', '', '', '', '']);
  }
  let lastNonEmpty = -1;
  for (let i = state.batchMasterRows.length - 1; i >= 0; i--) {
    const r = state.batchMasterRows[i];
    if (String(r?.[0] || '').trim() || String(r?.[1] || '').trim()) {
      lastNonEmpty = i;
      break;
    }
  }
  let expanded = false;
  while (state.batchMasterRows.length - 1 - lastNonEmpty < minSpareRows) {
    for (let k = 0; k < appendCount; k++) {
      state.batchMasterRows.push(['', '', '', '', '', '', '', '']);
    }
    expanded = true;
  }
  return expanded;
}

function ensureIrBatchAutoCapacity(minSpareRows = 3, appendCount = 20) {
  if (!Array.isArray(state.irBatchRows)) {
    state.irBatchRows = Array.from({ length: 30 }, () => ['', '', '']);
  }
  let lastNonEmpty = -1;
  for (let i = state.irBatchRows.length - 1; i >= 0; i--) {
    const r = state.irBatchRows[i];
    if (String(r?.[0] || '').trim() || String(r?.[1] || '').trim()) {
      lastNonEmpty = i;
      break;
    }
  }
  let expanded = false;
  while (state.irBatchRows.length - 1 - lastNonEmpty < minSpareRows) {
    for (let k = 0; k < appendCount; k++) {
      state.irBatchRows.push(['', '', '']);
    }
    expanded = true;
  }
  return expanded;
}

function renderIrBatchSheet() {
  ensureIrBatchAutoCapacity();
  if (!state.irBatchSheet) return;
  state.isUpdatingIrSheet = true;
  try {
    state.irBatchSheet.setData(state.irBatchRows.map(r => [r[0] || '', r[1] || '', r[2] || '']));
  } finally {
    state.isUpdatingIrSheet = false;
  }
}

function initSpreadsheets() {
  if (typeof jspreadsheet !== 'function') return;

  const scanHost = $('scan-spreadsheet-grid');
  if (scanHost && !state.scanSheet) {
    state.scanSheet = jspreadsheet(scanHost, {
      data: [[false, '-', '请先在「账号与白名单设置」导入 OAuth JSON 授权后点击「立即扫描」', '', '', 'anyone_off', '', '']],
      columns: [
        { type: 'checkbox', title: '勾选', width: 44 },
        { type: 'text', title: '类型', width: 105, readOnly: true, align: 'left' },
        { type: 'text', title: '文件/文件夹名称', width: 240, readOnly: true, align: 'left' },
        { type: 'text', title: '我的权限 / 所属账号', width: 165, readOnly: true, align: 'left' },
        { type: 'text', title: '分组 / 合规状态', width: 155, readOnly: true, align: 'left' },
        { type: 'dropdown', title: '当前链接权限 (单击即改)', width: 170, source: PUBLIC_LINK_DROPDOWN_SOURCE, align: 'left' },
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
      parseFormulas: false,
      autoCasting: false,
      stripHTML: true,
      stripHTMLOnCopy: true,
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
      },
      onselection(instance, x1, y1) {
        if (state.isUpdatingScanSheet) return;
        if (Number(x1) === 0 || Number(x1) === 5) return;
        const row = Number(y1);
        const fileId = state.scanSheetFileIds[row];
        if (!fileId) return;
        state.inspectedFileId = fileId;
        renderFileInspector();
      }
    });
    enableSingleClickDropdown(scanHost, () => state.scanSheet, new Set([5]));
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
        { type: 'dropdown', title: 'F. 当前链接权限 (单击即改)', width: 165, source: PUBLIC_LINK_DROPDOWN_SOURCE, align: 'left' },
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
      parseFormulas: false,
      autoCasting: false,
      stripHTML: true,
      stripHTMLOnCopy: true,
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
          const expanded = ensureBatchLinksAutoCapacity();
          syncBatchSheetToInputs();
          if (expanded) renderBatchMasterToSheet();
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
            const expanded = ensureBatchLinksAutoCapacity();
            syncBatchSheetToInputs();
            if (expanded) renderBatchMasterToSheet();
          }, 20);
        }
      }
    });
    enableSingleClickDropdown(batchHost, () => state.batchLinksSheet, new Set([5]));
  }

  const irHost = $('ir-batch-spreadsheet-grid');
  if (irHost && !state.irBatchSheet) {
    state.irBatchRows = Array.from({ length: 30 }, () => ['', '', '']);
    state.irBatchSheet = jspreadsheet(irHost, {
      data: state.irBatchRows.map(r => [...r]),
      columns: [
        { type: 'text', title: 'A. 来源表链接或 ID (Donor · 支持整列粘贴)', width: 320, align: 'left' },
        { type: 'text', title: 'B. 目标汇总表链接或 ID (Target · 留空自动继承首行)', width: 320, align: 'left' },
        { type: 'text', title: 'C. 跨表授权状态', width: 260, readOnly: true, align: 'left' }
      ],
      minDimensions: [3, 30],
      tableOverflow: true,
      tableWidth: '100%',
      tableHeight: '100%',
      allowInsertColumn: false,
      allowDeleteColumn: false,
      parseFormulas: false,
      autoCasting: false,
      stripHTML: true,
      stripHTMLOnCopy: true,
      onchange(instance, cell, x, y, value) {
        if (state.isUpdatingIrSheet) return;
        const col = Number(x);
        const row = Number(y);
        while (state.irBatchRows.length <= row) {
          state.irBatchRows.push(['', '', '']);
        }
        state.irBatchRows[row][col] = value ?? '';
        if ((col === 0 || col === 1) && ensureIrBatchAutoCapacity()) {
          renderIrBatchSheet();
        }
      },
      onpaste() {
        if (!state.isUpdatingIrSheet) {
          setTimeout(() => {
            const sheetRows = state.irBatchSheet.getData() || [];
            state.irBatchRows = sheetRows.map(r => [
              String(r?.[0] ?? ''),
              String(r?.[1] ?? ''),
              String(r?.[2] ?? '')
            ]);
            if (ensureIrBatchAutoCapacity()) {
              renderIrBatchSheet();
            }
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
      allowDeleteColumn: false,
      parseFormulas: false,
      autoCasting: false,
      stripHTML: true,
      stripHTMLOnCopy: true
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
        const breakage = getFileInheritanceBreakage(file);
        const diffInfo = resolveFileDiffInfo(file);
        const coverages = getFileGroupCoverage(file, state.directory)
          .map(c => `${c.groupName}(${c.grantedCount}/${c.totalCount})`)
          .join(' ');
        const parts = [];
        if (diffInfo) {
          parts.push(diffInfo.riskIncreased ? '权限变动(扩权)' : '权限变动');
        }
        if (coverages) parts.push(coverages);
        if (!stat.hasNonOwner && file.shared !== true && !breakage?.broken) {
          parts.push('仅自己');
        } else {
          if (stat.removeCount > 0) parts.push(`违规:${stat.removeCount}`);
          if (stat.downgradeCount > 0) parts.push(`越权:${stat.downgradeCount}`);
          if (breakage?.broken) parts.push(`逃逸:${breakage.escapedCount}`);
          if (!stat.hasActionableViolation && !breakage?.broken) parts.push('✓合规');
        }
        statusText = parts.join(' · ') || '✓合规';
      }

      const pubMode = getFilePublicModeId(file);
      const collabSummary = summarizeFileCollaborators(file, ownerEmail);
      const linkText = formatDriveCanonicalLink(file);

      return [isSelected, typeLabel, nameCell, ownerCell, statusText, pubMode, collabSummary, linkText];
    });

    state.scanSheet.setData(rows);
  } finally {
    state.isUpdatingScanSheet = false;
  }
}

function hasAnyScannedBatchRow() {
  return (state.batchMasterRows || []).some(r => Boolean(String(r?.[4] || '').trim()));
}

function isBatchFilterActive() {
  const kw = ($('batch-filter-keyword')?.value || '').trim();
  const myAccess = $('batch-filter-my-access')?.value || 'all';
  const linkPerm = $('batch-filter-link-perm')?.value || 'all';
  const typeVal = $('batch-filter-type')?.value || 'all';
  const execVal = $('batch-filter-exec-status')?.value || 'all';
  const hasOtherFilter = Boolean(kw || linkPerm !== 'all' || typeVal !== 'all' || execVal !== 'all');
  if (hasOtherFilter) return true;
  if (myAccess === 'all') return false;
  // 默认「我是所有者」在尚未执行链接扫描前不遮挡空白粘贴行，扫描出权限后再自动过滤非自有项
  if (myAccess === 'owner' && !hasAnyScannedBatchRow()) return false;
  return true;
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
      if (colMy && !colMy.includes('所有者') && !(colMy.includes('可编辑') && !colMy.includes('不可改权限'))) {
        return false;
      }
    } else if (myAccess === 'owner') {
      // 未扫描前刚粘贴/添加进来的行 colMy 为空，保持可见以免添加后立刻消失
      if (colMy && !colMy.includes('所有者')) return false;
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
  const emails = extractEmailsFromText(emailLines.join('\n'));
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

  ensureBatchLinksAutoCapacity();
  renderBatchMasterToSheet();
  syncBatchSheetToInputs();
}

function appendAssetsToBatchLinksColumnA(files = []) {
  const list = (Array.isArray(files) ? files : []).filter(f => f && f.id);
  if (!list.length) return 0;

  syncBatchSheetToInputs();
  const rows = (state.batchMasterRows || []).map(r => [...r]);
  const existingIds = new Set(
    rows
      .map(r => parseDriveLinksInput(String(r?.[0] || ''))[0] || '')
      .filter(Boolean)
  );

  let addedCount = 0;
  let emptyScanIdx = 0;
  for (const file of list) {
    if (existingIds.has(file.id)) continue;
    existingIds.add(file.id);
    const link = formatDriveCanonicalLink(file) || `https://drive.google.com/open?id=${file.id}`;
    const typeLabel = fileCategoryLabel(file.mimeType, file.name);
    while (emptyScanIdx < rows.length && String(rows[emptyScanIdx]?.[0] || '').trim()) {
      emptyScanIdx++;
    }
    if (emptyScanIdx < rows.length) {
      rows[emptyScanIdx][0] = link;
      rows[emptyScanIdx][2] = typeLabel;
      rows[emptyScanIdx][3] = file.name || file.id;
      emptyScanIdx++;
    } else {
      rows.push([link, '', typeLabel, file.name || file.id, '', '', '', '']);
      emptyScanIdx = rows.length;
    }
    addedCount++;
  }

  state.batchMasterRows = rows;
  ensureBatchLinksAutoCapacity();
  renderBatchMasterToSheet();
  syncBatchSheetToInputs();
  return addedCount;
}

function appendEmailsToBatchLinksColumnB(emails = []) {
  const cleanEmails = [
    ...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeEntry).filter(e => e && e.includes('@')))
  ];
  if (!cleanEmails.length) return 0;

  syncBatchSheetToInputs();
  const rows = (state.batchMasterRows || []).map(r => [...r]);
  const existingEmails = new Set(
    rows.map(r => normalizeEntry(String(r?.[1] || ''))).filter(Boolean)
  );

  let addedCount = 0;
  let emptyScanIdx = 0;
  for (const em of cleanEmails) {
    if (existingEmails.has(em)) continue;
    existingEmails.add(em);
    while (emptyScanIdx < rows.length && String(rows[emptyScanIdx]?.[1] || '').trim()) {
      emptyScanIdx++;
    }
    if (emptyScanIdx < rows.length) {
      rows[emptyScanIdx][1] = em;
      emptyScanIdx++;
    } else {
      rows.push(['', em, '', '', '', '', '', '']);
      emptyScanIdx = rows.length;
    }
    addedCount++;
  }

  state.batchMasterRows = rows;
  ensureBatchLinksAutoCapacity();
  renderBatchMasterToSheet();
  syncBatchSheetToInputs();
  return addedCount;
}

function renderBatchLinksAssetPicker() {
  const listEl = $('batch-links-asset-picker-list');
  if (!listEl) return;

  const q = ($('batch-links-asset-search')?.value || '').trim().toLowerCase();
  const typeFilter = $('batch-links-asset-type-filter')?.value || 'all';
  const scoped = getScopedFilesByAccount();
  const source = scoped.length ? scoped : state.files;

  const matched = source.filter(f => {
    if (!f || !f.id) return false;
    if (typeFilter === 'folder' && f.mimeType !== 'application/vnd.google-apps.folder') return false;
    if (typeFilter === 'sheet' && f.mimeType !== 'application/vnd.google-apps.spreadsheet') return false;
    if (!q) return true;
    return (f.name || '').toLowerCase().includes(q) || (f.id || '').toLowerCase().includes(q);
  });

  if (!matched.length) {
    listEl.innerHTML = `<div class="muted">${source.length ? '未找到匹配的已扫描文件或文件夹' : '尚未扫描云盘文件，请先点击右上角「立即扫描」'}</div>`;
    return;
  }

  listEl.innerHTML = matched
    .slice(0, 80)
    .map(f => {
      const checked = state.pickedBatchAssetIds.has(f.id) ? 'checked' : '';
      const typeLabel = fileCategoryLabel(f.mimeType, f.name);
      return `<label class="picker-item">
        <input type="checkbox" data-action="batch-pick-asset" data-file-id="${escapeHtml(f.id)}" ${checked}>
        <span class="badge">${escapeHtml(typeLabel)}</span>
        <span class="picker-item-name">${escapeHtml(f.name || f.id)}</span>
      </label>`;
    })
    .join('');
}

function renderBatchLinksEmailPicker() {
  const listEl = $('batch-links-email-picker-list');
  if (!listEl) return;

  const q = ($('batch-links-email-search')?.value || '').trim().toLowerCase();
  const groups = state.directory.groups || [];
  const contacts = state.directory.contacts || [];
  const chunks = [];

  const matchedGroups = groups.filter(g => {
    if (!q) return true;
    return (g.name || '').toLowerCase().includes(q);
  });
  for (const g of matchedGroups) {
    const members = contacts
      .filter(c => (c.groups || []).includes(g.name))
      .map(c => normalizeEntry(c.email))
      .filter(Boolean);
    chunks.push(`<button type="button" class="picker-item picker-item-btn" data-action="batch-pick-group-emails" data-group="${escapeHtml(g.name)}">
      <span class="badge">分组</span>
      <strong class="picker-item-name">${escapeHtml(g.name)}</strong>
      <span class="muted">${members.length} 人 · 单击填入 B 列</span>
    </button>`);
  }

  const people = buildMergedPersonList().filter(p => {
    if (!q) return true;
    return (
      p.email.includes(q) ||
      (p.name || '').toLowerCase().includes(q) ||
      (p.groups || []).some(g => g.toLowerCase().includes(q))
    );
  });
  for (const p of people.slice(0, 60)) {
    const grpText = p.groups?.length ? ` (${p.groups.join('、')})` : '';
    chunks.push(`<button type="button" class="picker-item picker-item-btn" data-action="batch-pick-single-email" data-email="${escapeHtml(p.email)}">
      <span class="badge">邮箱</span>
      <span class="picker-item-name">${escapeHtml(p.name ? `${p.name} · ${p.email}` : p.email)}${escapeHtml(grpText)}</span>
    </button>`);
  }

  listEl.innerHTML = chunks.length
    ? chunks.join('')
    : '<div class="muted">暂无匹配的分组或邮箱，可直接在表格 B 列粘贴邮箱</div>';
}

function renderFileInspector() {
  const card = $('file-inspector-card');
  if (!card) return;
  const file = state.files.find(f => f.id === state.inspectedFileId);
  if (!file) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  const ownerEmail = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
  const typeLabel = fileCategoryLabel(file.mimeType, file.name);
  const canonicalLink = formatDriveCanonicalLink(file);
  const evalStat = evaluateFile(file, state.policy, ownerEmail);

  $('inspector-file-type').textContent = typeLabel;
  $('inspector-file-name').textContent = file.name || '(未命名文件)';
  $('inspector-file-name').title = file.name || '';
  const openLinkEl = $('inspector-open-link');
  if (openLinkEl) {
    openLinkEl.href = sanitizeExternalUrl(canonicalLink);
  }

  // 合规状态与快捷修正按钮
  const statusPillHtml = evalStat.hasActionableViolation
    ? `<span class="status-pill danger">存在违规 (${evalStat.removeCount} 移除 / ${evalStat.downgradeCount} 降级)</span>
       <button type="button" class="btn warning btn-xs" data-action="inspector-enforce-file" data-file-id="${escapeHtml(file.id)}">一键修正此文件</button>`
    : `<span class="status-pill ok">符合白名单策略</span>`;

  $('inspector-meta-bar').innerHTML = `
    <span>所属账号：<strong>${escapeHtml(ownerEmail || '未知')}</strong></span>
    <span class="row-flex">${statusPillHtml}</span>
  `;

  // 子文件权限逃逸（宽于父文件夹）提示条
  const breakage = getFileInheritanceBreakage(file);
  const breakageBar = $('inspector-breakage-bar');
  if (breakageBar) {
    if (breakage?.broken) {
      breakageBar.classList.remove('hidden');
      const descEl = $('inspector-breakage-desc');
      if (descEl) {
        const reasons = (breakage.escapedPermissions || []).map(x => x.reason).slice(0, 2).join('；');
        descEl.textContent = reasons ? `${breakage.summaryText} · ${reasons}` : breakage.summaryText;
      }
    } else {
      breakageBar.classList.add('hidden');
    }
  }

  // 较上次扫描权限变更 Diff 提示条
  const diffInfo = resolveFileDiffInfo(file);
  const diffBar = $('inspector-diff-bar');
  if (diffBar) {
    if (diffInfo) {
      diffBar.classList.remove('hidden');
      const diffDescEl = $('inspector-diff-desc');
      if (diffDescEl) {
        diffDescEl.textContent = formatDiffDetailsText(diffInfo);
      }
    } else {
      diffBar.classList.add('hidden');
    }
  }

  // 防扩散与文件锁定加固状态条 (#inspector-security-bar)
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  const writersRestricted = file.writersCanShare === false;
  const copyRestricted = file.copyRequiresWriterPermission === true;
  const contentLocked = Boolean(
    file.contentLocked || file.contentRestrictions?.some?.(r => Boolean(r?.readOnly))
  );

  const secBar = $('inspector-security-bar');
  if (secBar) {
    secBar.classList.remove('hidden');
  }
  const btnWritersShare = $('inspector-toggle-writers-share');
  if (btnWritersShare) {
    btnWritersShare.disabled = false;
    btnWritersShare.classList.toggle('active', writersRestricted);
    btnWritersShare.setAttribute('aria-pressed', writersRestricted ? 'true' : 'false');
    btnWritersShare.textContent = writersRestricted ? '已禁编辑拉人' : '禁编辑拉人';
    btnWritersShare.title = writersRestricted
      ? '当前已禁止编辑者拉人或修改权限，点击可恢复允许'
      : '点击禁止可编辑协作者二次拉人或修改权限';
  }
  const btnCopyLock = $('inspector-toggle-copy-lock');
  if (btnCopyLock) {
    btnCopyLock.disabled = isFolder;
    btnCopyLock.classList.toggle('active', copyRestricted);
    btnCopyLock.setAttribute('aria-pressed', copyRestricted ? 'true' : 'false');
    btnCopyLock.textContent = copyRestricted ? '已禁只读下载复制' : '禁只读下载复制';
    btnCopyLock.title = isFolder
      ? 'Google Drive 文件夹不支持禁复制下载标记'
      : copyRestricted
      ? '当前已禁止只读和评论者下载、打印、复制，点击可恢复允许'
      : '点击禁止仅查看与可评论者下载、打印、复制文件内容';
  }
  const btnContentLock = $('inspector-toggle-content-lock');
  if (btnContentLock) {
    btnContentLock.disabled = isFolder;
    btnContentLock.classList.toggle('active', contentLocked);
    btnContentLock.setAttribute('aria-pressed', contentLocked ? 'true' : 'false');
    btnContentLock.textContent = contentLocked ? '已锁定防误改' : '锁定防误改';
    btnContentLock.title = isFolder
      ? 'Google Drive 文件夹不支持内容只读锁'
      : contentLocked
      ? `当前已开启防误改内容锁${file.contentLockReason ? `（${file.contentLockReason}）` : ''}，点击可解锁`
      : '点击开启官方内容只读锁定，防止协作者误修改定稿文件';
  }

  // 分组覆盖率与一键补齐按钮
  const coverages = getFileGroupCoverage(file, state.directory);
  const covBox = $('inspector-group-coverage');
  if (!coverages.length) {
    covBox.innerHTML = '';
  } else {
    covBox.innerHTML = coverages
      .map(c => {
        const isPartial = c.status === 'partial';
        const completeBtn = isPartial
          ? `<button type="button" class="btn-text" data-action="inspector-complete-group" data-file-id="${escapeHtml(file.id)}" data-group="${escapeHtml(c.groupName)}" title="为该文件补齐此组缺失成员的权限">+补齐</button>`
          : '';
        return `<span class="group-cov-badge ${isPartial ? 'partial' : ''}">
          <span>${escapeHtml(c.groupName)}: ${c.grantedCount}/${c.totalCount}人</span>
          ${completeBtn}
        </span>`;
      })
      .join('');
  }

  // 协作者列表渲染
  const contactLookup = buildContactLookup(state.directory);
  const perms = file.permissions || [];
  const listNode = $('inspector-perm-list');
  if (!perms.length) {
    listNode.innerHTML = `<div class="muted">仅所有者自己可见，暂无其他协作者或公开链接</div>`;
    return;
  }

  listNode.innerHTML = perms
    .map(p => {
      const ev = evaluatePermission(p, state.policy, ownerEmail);
      const isOwner = p.role === 'owner' || normalizeEntry(p.emailAddress || '') === normalizeEntry(ownerEmail);
      const inherited = permIsInherited(p);
      let labelText = permissionLabel(p, contactLookup);
      if (p.type === 'anyone') labelText = '公开链接 (知道链接的任何人)';
      else if (p.type === 'domain') labelText = `域内共享 (@${p.domain || ''})`;

      if (isOwner) {
        return `<div class="inspector-perm-row">
          <div class="inspector-perm-info" title="${escapeHtml(labelText)}">
            <strong>${escapeHtml(labelText)}</strong>
          </div>
          <span class="badge">所有者</span>
        </div>`;
      }

      const ttlEntry = findMatchingTtlEntryForPerm(file.id, p);
      const ttlExpiresAt = ttlEntry?.expiresAt || p.expirationTime || '';
      const ttlText = ttlExpiresAt ? formatTtlBadgeText(ttlExpiresAt) : '';
      const ttlUrgency = ttlExpiresAt ? getTtlUrgencyClass(ttlExpiresAt) : '';
      const ttlBadgeHtml = ttlText
        ? `<span class="ttl-remaining ${ttlUrgency}" title="到期时间：${escapeHtml(formatTime(ttlExpiresAt))}"> · 限时 ${escapeHtml(ttlText)}</span>`
        : '';

      if (inherited) {
        return `<div class="inspector-perm-row">
          <div class="inspector-perm-info" title="${escapeHtml(labelText)}">
            <span>${escapeHtml(labelText)}</span>
            <span class="muted"> (${escapeHtml(roleLabel(p.role))} · 继承自上级目录)</span>${ttlBadgeHtml}
          </div>
          <span class="badge">继承</span>
        </div>`;
      }

      const roleSelectHtml = `
        <select class="perm-select" data-action="inspector-role-change" data-file-id="${escapeHtml(file.id)}" data-perm-id="${escapeHtml(p.id)}">
          <option value="writer" ${p.role === 'writer' || p.role === 'organizer' || p.role === 'fileOrganizer' ? 'selected' : ''}>可编辑</option>
          <option value="commenter" ${p.role === 'commenter' ? 'selected' : ''}>可评论</option>
          <option value="reader" ${p.role === 'reader' ? 'selected' : ''}>仅查看</option>
        </select>
      `;

      return `<div class="inspector-perm-row ${escapeHtml(ev.status)}">
        <div class="inspector-perm-info" title="${escapeHtml(labelText)} (${escapeHtml(ev.reason)})">
          <strong>${escapeHtml(labelText)}</strong>
          ${ev.status !== 'compliant' ? `<span class="muted"> · ${escapeHtml(ev.reason)}</span>` : ''}${ttlBadgeHtml}
        </div>
        <div class="row-flex">
          ${roleSelectHtml}
          <button type="button" class="btn danger btn-xs" data-action="inspector-remove-perm" data-file-id="${escapeHtml(file.id)}" data-perm-id="${escapeHtml(p.id)}">移除</button>
        </div>
      </div>`;
    })
    .join('');
}

function buildFallbackPermissionTree(files = []) {
  const byId = new Map();
  for (const f of files) {
    byId.set(f.id, {
      id: f.id,
      file: f,
      name: f.name || f.id,
      mimeType: f.mimeType || '',
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
      children: [],
      diverged: Boolean(getFileInheritanceBreakage(f)?.broken),
      uniformChildCount: 0
    });
  }
  const roots = [];
  for (const node of byId.values()) {
    const pid = Array.isArray(node.file.parents) && node.file.parents[0] ? String(node.file.parents[0]) : '';
    const parentNode = pid ? byId.get(pid) : null;
    if (parentNode && parentNode.id !== node.id) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function isFileShared(file) {
  if (!file) return false;
  return (
    Boolean(file.shared) ||
    (file.permissions || []).some(p => p && p.role !== 'owner' && p.type !== 'owner')
  );
}

function getNormalizedTreeNodeChildren(node) {
  const merged = [];
  const seen = new Set();
  for (const arr of [node?.children, node?.divergedChildren, node?.uniformChildren, node?.subItems]) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const cid = item?.id || item?.file?.id;
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      merged.push(item);
    }
  }
  return merged;
}

function isTreeNodeNotable(node) {
  const file = node?.file || node;
  if (!file) return false;
  const ownerEmail = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
  const evalStat = node?.evaluation || evaluateFile(file, state.policy, ownerEmail);
  const breakage = getFileInheritanceBreakage(file);
  const diffInfo = resolveFileDiffInfo(file);
  return Boolean(
    node?.diverged ||
      breakage?.broken ||
      evalStat?.hasActionableViolation ||
      diffInfo
  );
}

function treeNodeHasNotableDescendant(node) {
  const children = getNormalizedTreeNodeChildren(node);
  for (const ch of children) {
    if (isTreeNodeNotable(ch) || treeNodeHasNotableDescendant(ch)) return true;
  }
  return false;
}

function renderAssetTreeView(filteredFiles = []) {
  const container = $('asset-tree-list');
  if (!container) return;

  if (!filteredFiles.length) {
    container.innerHTML = `<div class="muted empty">当前筛选条件下暂无云盘资产记录，请点击右上角「立即扫描」或调整筛选条件。</div>`;
    return;
  }

  const divergedOnly = Boolean($('tree-diverged-only-chk')?.checked);
  let roots = [];
  if (typeof buildFolderPermissionTree === 'function') {
    try {
      const built = buildFolderPermissionTree(
        filteredFiles,
        state.policy,
        state.activeAccount !== 'all' ? state.activeAccount : ''
      );
      if (Array.isArray(built)) roots = built;
      else if (Array.isArray(built?.roots)) roots = built.roots;
      else if (Array.isArray(built?.nodes)) roots = built.nodes;
      else roots = buildFallbackPermissionTree(filteredFiles);
    } catch (_e) {
      roots = buildFallbackPermissionTree(filteredFiles);
    }
  } else {
    roots = buildFallbackPermissionTree(filteredFiles);
  }

  const renderNodeHtml = (node, depth = 0, hasParentFolder = false) => {
    const file = node?.file || node;
    if (!file || !file.id) return '';
    const fileId = file.id;
    const isFolder = Boolean(node?.isFolder ?? (file.mimeType === 'application/vnd.google-apps.folder'));
    const allChildren = getNormalizedTreeNodeChildren(node);
    const selfNotable = isTreeNodeNotable(node);
    const descNotable = treeNodeHasNotableDescendant(node);

    if (divergedOnly && !selfNotable && !descNotable) {
      return '';
    }

    const ownerEmail = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
    const evalStat = node?.evaluation || evaluateFile(file, state.policy, ownerEmail);
    const breakage = getFileInheritanceBreakage(file);
    const diffInfo = resolveFileDiffInfo(file);
    const isSelected = state.selectedFileIds.has(fileId);
    const isInspected = state.inspectedFileId === fileId;
    const isShared =
      Boolean(file.shared) ||
      (file.permissions || []).some(p => p && p.role !== 'owner' && p.type !== 'owner');

    const defaultExpanded = depth === 0 || descNotable || state.expandedTreeFolderIds.has(fileId);
    const isExpanded = isFolder
      ? state.expandedTreeFolderIds.has(fileId) || (defaultExpanded && !state.collapsedTreeFolderIds.has(fileId))
      : false;

    const badges = [];
    const unauthCount = evalStat.removeCount ?? evalStat.unauthorizedCount ?? 0;
    const overprivCount = evalStat.downgradeCount ?? evalStat.overprivilegedCount ?? 0;
    if (unauthCount > 0) {
      badges.push(`<span class="status-pill danger">非白名单 ${unauthCount}</span>`);
    }
    if (overprivCount > 0) {
      badges.push(`<span class="status-pill warning">越权 ${overprivCount}</span>`);
    }
    if (hasParentFolder && (node?.diverged || breakage?.broken)) {
      badges.push(`<span class="status-pill warning">权限分叉</span>`);
    }
    if (diffInfo) {
      badges.push(`<span class="status-pill info">权限变动</span>`);
    }
    if (!isFolder && Boolean(file.contentLocked || file.contentRestrictions?.some?.(r => Boolean(r?.readOnly)))) {
      badges.push(`<span class="status-pill info">已锁定</span>`);
    }
    if (file.writersCanShare === false) {
      badges.push(`<span class="badge">禁拉人</span>`);
    } else if (!isFolder && isShared && file.writersCanShare !== false) {
      badges.push(`<span class="badge">未禁拉人</span>`);
    }
    if (!isFolder && file.copyRequiresWriterPermission === true) {
      badges.push(`<span class="badge">禁复制</span>`);
    }

    const coverages = getFileGroupCoverage(file, state.directory);
    for (const cov of coverages.slice(0, 3)) {
      badges.push(
        `<span class="badge">${escapeHtml(cov.groupName)} ${cov.grantedCount}/${cov.totalCount}</span>`
      );
    }

    const nonOwnerCount = (file.permissions || []).filter(
      p => p.role !== 'owner' && normalizeEntry(p.emailAddress || '') !== normalizeEntry(ownerEmail)
    ).length;
    const shareMetaText = isShared ? `共享 ${nonOwnerCount} 项` : '私密';
    const typeLabel = fileCategoryLabel(file.mimeType, file.name);
    const rowClasses = [
      'tree-node-row',
      isFolder ? 'folder-row' : 'file-row',
      hasParentFolder && (node?.diverged || breakage?.broken) ? 'diverged is-diverged' : '',
      evalStat.hasActionableViolation ? 'violation has-violation' : '',
      isSelected ? 'selected' : '',
      isInspected ? 'inspected active' : ''
    ]
      .filter(Boolean)
      .join(' ');

    const expanderHtml =
      isFolder && allChildren.length > 0
        ? `<button type="button" class="btn-text tree-toggle-btn" data-action="tree-toggle-folder" data-folder-id="${escapeHtml(fileId)}" aria-expanded="${isExpanded ? 'true' : 'false'}" title="${isExpanded ? '收起子目录' : '展开子目录'}">${isExpanded ? '▾' : '▸'}</button>`
        : `<span class="tree-expander-spacer"></span>`;

    let childrenBlockHtml = '';
    if (isFolder && allChildren.length > 0 && isExpanded) {
      const prominentChildren = [];
      const uniformLeafChildren = [];
      for (const ch of allChildren) {
        const chFile = ch?.file || ch;
        const chIsFolder = Boolean(ch?.isFolder ?? (chFile?.mimeType === 'application/vnd.google-apps.folder'));
        if (chIsFolder || isTreeNodeNotable(ch) || treeNodeHasNotableDescendant(ch)) {
          prominentChildren.push(ch);
        } else {
          uniformLeafChildren.push(ch);
        }
      }

      const prominentHtml = prominentChildren.map(ch => renderNodeHtml(ch, depth + 1, true)).join('');
      let uniformHtml = '';
      if (!divergedOnly && uniformLeafChildren.length > 0) {
        const isUniOpen = state.expandedUniformGroupIds.has(fileId);
        const foldBtnHtml = `<button type="button" class="tree-uniform-fold" data-action="tree-toggle-uniform" data-folder-id="${escapeHtml(fileId)}" aria-expanded="${isUniOpen ? 'true' : 'false'}">${
          isUniOpen
            ? `▾ 收起 ${uniformLeafChildren.length} 个与父目录权限完全一致的子文件`
            : `▸ 已折叠 ${uniformLeafChildren.length} 个与父目录权限一致的子文件（点击展开）`
        }</button>`;
        const uniItemsHtml = isUniOpen
          ? uniformLeafChildren.map(ch => renderNodeHtml(ch, depth + 1, true)).join('')
          : '';
        uniformHtml = foldBtnHtml + uniItemsHtml;
      }

      if (prominentHtml || uniformHtml) {
        childrenBlockHtml = `<div class="tree-children">${prominentHtml}${uniformHtml}</div>`;
      }
    }

    return `<div class="tree-node">
      <div class="${rowClasses}" data-file-id="${escapeHtml(fileId)}">
        <div class="row-flex grow">
          ${expanderHtml}
          <input type="checkbox" data-action="tree-select-file" data-file-id="${escapeHtml(fileId)}" ${isSelected ? 'checked' : ''} aria-label="勾选 ${escapeHtml(file.name || fileId)}">
          <button type="button" class="btn-text tree-node-main" data-action="tree-inspect-file" data-file-id="${escapeHtml(fileId)}">
            <span class="tree-badge badge">${escapeHtml(typeLabel)}</span>
            <strong class="tree-node-title">${escapeHtml(file.name || '(未命名)')}</strong>
            <span class="tree-node-path muted">${escapeHtml(shareMetaText)}</span>
          </button>
        </div>
        <div class="row-flex wrap-flex tree-node-badges">
          ${badges.join('')}
        </div>
      </div>
      ${childrenBlockHtml}
    </div>`;
  };

  const htmlOut = roots.map(r => renderNodeHtml(r, 0, false)).join('');
  container.innerHTML =
    htmlOut || `<div class="muted empty">当前未检测到权限分叉或违规资产，取消勾选「仅看分叉」可浏览完整目录树。</div>`;
}

function setAssetsViewMode(mode = 'tree') {
  state.assetsViewMode = mode === 'grid' ? 'grid' : 'tree';
  const isTree = state.assetsViewMode === 'tree';
  $('assets-view-tree-btn')?.classList.toggle('active', isTree);
  $('assets-view-grid-btn')?.classList.toggle('active', !isTree);
  syncOnboardingStageUI();
  renderFilesTab();
}

function syncFloatingBatchDock() {
  const selCount = state.selectedFileIds.size;
  const dock = $('floating-batch-dock');
  if (dock) {
    dock.classList.toggle('hidden', selCount === 0);
  }
  if ($('dock-selected-count')) {
    $('dock-selected-count').textContent = String(selCount);
  }
}

function closeBatchActionModal() {
  const modal = $('batch-action-modal');
  if (!modal) return;
  if (typeof modal.close === 'function' && modal.open) {
    modal.close();
  }
  modal.classList?.add('hidden');
}

function openBatchActionModal(mode = 'direct') {
  const selCount = state.selectedFileIds.size;
  if (selCount === 0) {
    toast('请先勾选至少 1 个文件或文件夹');
    return;
  }
  const modal = $('batch-action-modal');
  if (!modal) return;

  const metaMap = {
    direct: {
      title: '指定邮箱授权',
      subtitle: `已选 ${selCount} 项资产 · 直接批量授予或移除一个或多个邮箱权限`
    },
    group: {
      title: '按分组授权',
      subtitle: `已选 ${selCount} 项资产 · 支持按 Google 表格个人权限或分组默认权限赋权`
    },
    harden: {
      title: '修改编辑与下载权限',
      subtitle: `已选 ${selCount} 项资产 · 批量限制编辑者拉人、禁止只读下载复制或锁定防误改`
    },
    cleanup: {
      title: '关闭权限范围',
      subtitle: `已选 ${selCount} 项资产 · 按白名单修正违规、对齐父目录或关闭外链`
    },
    'save-group': {
      title: '保存到分组',
      subtitle: `已选 ${selCount} 项资产 · 将勾选文件绑定保存到指定邮箱/范围分组，支持一键筛选或同时生成岗位权限包`
    }
  };
  const chosen = metaMap[mode] ? mode : 'direct';
  if ($('batch-modal-title')) $('batch-modal-title').textContent = metaMap[chosen].title;
  if ($('batch-modal-subtitle')) $('batch-modal-subtitle').textContent = metaMap[chosen].subtitle;

  for (const key of ['direct', 'group', 'harden', 'cleanup', 'save-group']) {
    $(`dock-panel-${key}`)?.classList.toggle('hidden', key !== chosen);
  }

  if (chosen === 'save-group') {
    const sel = $('batch-save-group-select');
    if (sel && sel.value === '__new__') {
      $('batch-save-group-new-name')?.focus?.();
    }
  }

  modal.classList?.remove('hidden');
  if (typeof modal.showModal === 'function') {
    if (!modal.open) modal.showModal();
  }
}

function renderFilesTab() {
  syncOnboardingStageUI();
  analyzeInheritanceBreakage(getScopedFilesByAccount());
  const filtered = getFilteredFiles();

  // 清理已不存在的选中项
  const validIds = new Set(state.files.map(f => f.id));
  for (const id of [...state.selectedFileIds]) {
    if (!validIds.has(id)) state.selectedFileIds.delete(id);
  }
  if (state.inspectedFileId && !validIds.has(state.inspectedFileId)) {
    state.inspectedFileId = '';
  }

  const curStatusFilter = $('file-status-filter')?.value || 'all';
  document.querySelectorAll('#summary .summary-card').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cardFilter === curStatusFilter);
  });

  if ($('filtered-count')) $('filtered-count').textContent = filtered.length;
  if ($('selected-count')) $('selected-count').textContent = state.selectedFileIds.size;

  const selectAllEl = $('select-all');
  if (selectAllEl) {
    selectAllEl.disabled = filtered.length === 0;
    selectAllEl.checked = filtered.length > 0 && filtered.every(f => state.selectedFileIds.has(f.id));
  }

  updateBatchButtons();
  renderAssetTreeView(filtered);
  renderScanSpreadsheet(filtered);
  renderFileInspector();
}

function syncBatchOpButtonStyles() {
  const grpRunBtn = $('batch-group-op-run-btn');
  if (grpRunBtn) {
    const grpMode = $('batch-group-op-mode')?.value || 'grant';
    grpRunBtn.className = grpMode === 'revoke_groups' ? 'btn danger' : 'btn primary';
  }

  const quickRunBtn = $('batch-quick-action-run-btn');
  if (quickRunBtn) {
    const quickMode = $('batch-quick-action-select')?.value || 'remove_public';
    if (quickMode === 'remove_public' || quickMode === 'revoke_all') {
      quickRunBtn.className = 'btn danger';
    } else if (quickMode === 'enforce' || quickMode === 'align_parent') {
      quickRunBtn.className = 'btn warning';
    } else {
      quickRunBtn.className = 'btn';
    }
  }
}

function updateBatchButtons() {
  const selCount = state.selectedFileIds.size;
  const hasSelected = selCount > 0;
  const hasGroups = state.selectedBatchGroups.size > 0;
  const filteredCount = getFilteredFiles().length;

  const selTabBadge = $('tab-count-selected');
  if (selTabBadge) {
    selTabBadge.textContent = String(selCount);
    selTabBadge.classList.toggle('active', hasSelected);
  }

  const summaryBar = $('batch-target-summary-bar');
  if (summaryBar) {
    summaryBar.classList.toggle('active', hasSelected);
    summaryBar.classList.toggle('has-selection', hasSelected);
  }

  const summaryTextEl = $('batch-target-summary-text');
  if (summaryTextEl) {
    summaryTextEl.textContent = hasSelected
      ? `已勾选 ${selCount} 个文件 / 文件夹（当前列表共 ${filteredCount} 项）`
      : `尚未勾选文件（请在左侧列表勾选，或点击全选当前 ${filteredCount} 项）`;
  }

  if ($('batch-select-filtered-btn')) $('batch-select-filtered-btn').disabled = filteredCount === 0;
  if ($('batch-clear-selection-btn')) $('batch-clear-selection-btn').disabled = !hasSelected;
  if ($('batch-direct-grant-btn')) $('batch-direct-grant-btn').disabled = !hasSelected;
  if ($('batch-direct-revoke-btn')) $('batch-direct-revoke-btn').disabled = !hasSelected;

  if ($('batch-grant-groups')) $('batch-grant-groups').disabled = !hasSelected || !hasGroups;
  if ($('batch-keep-only-groups')) $('batch-keep-only-groups').disabled = !hasSelected || !hasGroups;
  if ($('batch-revoke-groups')) $('batch-revoke-groups').disabled = !hasSelected || !hasGroups;
  if ($('batch-group-op-run-btn')) $('batch-group-op-run-btn').disabled = !hasSelected || !hasGroups;

  if ($('batch-enforce')) $('batch-enforce').disabled = !hasSelected;
  if ($('batch-downgrade-all')) $('batch-downgrade-all').disabled = !hasSelected;
  if ($('batch-remove-public')) $('batch-remove-public').disabled = !hasSelected;
  if ($('batch-revoke-all')) $('batch-revoke-all').disabled = !hasSelected;
  if ($('batch-quick-action-run-btn')) $('batch-quick-action-run-btn').disabled = !hasSelected;
  if ($('batch-harden-run-btn')) $('batch-harden-run-btn').disabled = !hasSelected;

  syncBatchOpButtonStyles();
  syncFloatingBatchDock();
  renderSecurityRadar();
}

function renderBatchLinksFolderPicker() {
  const folderPicker = $('batch-links-pick-folder');
  if (!folderPicker) return;

  const scoped = getScopedFilesByAccount();
  const sourceFiles = scoped.length ? scoped : state.files;
  const folders = sourceFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  const folderIdSet = new Set(folders.map(f => f.id));
  const hierarchyMap = buildDriveHierarchyInfo(sourceFiles);
  const orderedFolders = sortItemsByHierarchyTree(folders, hierarchyMap);
  const rootFolders = orderedFolders.filter(f => {
    const pid = Array.isArray(f.parents) && f.parents[0] ? String(f.parents[0]) : '';
    return !pid || !folderIdSet.has(pid);
  });

  const optionsHtml = [
    `<option value="">+带入已扫描文件夹 (${orderedFolders.length})…</option>`
  ];
  if (rootFolders.length > 0) {
    optionsHtml.push(
      `<option value="__all_root_folders__">带入全部已扫描顶层文件夹 (${rootFolders.length}个)</option>`
    );
  }
  if (orderedFolders.length > rootFolders.length) {
    optionsHtml.push(
      `<option value="__all_folders__">带入全部已扫描文件夹 (${orderedFolders.length}个)</option>`
    );
  }
  for (const f of orderedFolders) {
    const h = hierarchyMap.get(f.id) || {};
    const displayLabel = h.treeDisplayName || f.name || f.id;
    optionsHtml.push(`<option value="${escapeHtml(f.id)}">📁 ${escapeHtml(displayLabel)}</option>`);
  }
  folderPicker.innerHTML = optionsHtml.join('');
}

function setCollabSubTab(subtab = 'groups') {
  state.collabSubTab = subtab === 'people' ? 'people' : 'groups';
  const isPeople = state.collabSubTab === 'people';
  $('collab-subtab-groups-btn')?.classList.toggle('active', !isPeople);
  $('collab-subtab-people-btn')?.classList.toggle('active', isPeople);
  $('collab-subview-groups')?.classList.toggle('hidden', isPeople);
  $('collab-subview-people')?.classList.toggle('hidden', !isPeople);
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
  if (fileGrpSel) {
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
  }

  // 2. #batch-group-checkboxes
  const validGroupNames = new Set(groups.map(g => g.name));
  for (const gName of [...state.selectedBatchGroups]) {
    if (!validGroupNames.has(gName)) state.selectedBatchGroups.delete(gName);
  }
  const batchBox = $('batch-group-checkboxes');
  if (batchBox) {
    if (!groups.length) {
      batchBox.innerHTML = `<span class="muted">暂无分组，</span><button type="button" class="btn-link" data-action="goto-manage-groups">前往人员与分组新建</button>`;
      if ($('batch-group-dropdown-label')) $('batch-group-dropdown-label').textContent = '暂无分组 (0)';
    } else {
      batchBox.innerHTML = groups
        .map(
          g => `<label class="drop-item">
            <input type="checkbox" class="batch-grp-chk" value="${escapeHtml(g.name)}" ${state.selectedBatchGroups.has(g.name) ? 'checked' : ''}>
            <span>${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人 · 默认${groupRoleDisplayLabel(g.defaultRole)})</span>
          </label>`
        )
        .join('');
      if ($('batch-group-dropdown-label')) {
        $('batch-group-dropdown-label').textContent =
          state.selectedBatchGroups.size > 0
            ? `已选分组: ${[...state.selectedBatchGroups].join(', ')}`
            : `请选择分组 (共${groups.length}组)`;
      }
    }
  }

  // 3. #collab-group-filter
  const collabGrpSel = $('collab-group-filter');
  if (collabGrpSel) {
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
  }

  // 4. #import-target-group-select
  const impSel = $('import-target-group-select');
  if (impSel) {
    const prevImp = impSel.value;
    impSel.innerHTML = [
      `<option value="">按表格 C 列组名或暂不归组</option>`,
      ...groups.map(g => `<option value="${escapeHtml(g.name)}">归入：${escapeHtml(g.name)}</option>`)
    ].join('');
    if ([...impSel.options].some(o => o.value === prevImp)) {
      impSel.value = prevImp;
    }
  }

  // 5. #settings-groups-list（结构化 .group-card-row 分组管理列表，含绑定文件数）
  const settingsGrpList = $('settings-groups-list');
  if (settingsGrpList) {
    settingsGrpList.innerHTML = groups.length
      ? groups
          .map(g => {
            const count = groupCountMap.get(g.name) || 0;
            const boundCount = Array.isArray(g.assets) ? g.assets.length : 0;
            const curRole =
              g.defaultRole === 'writer'
                ? 'writer'
                : g.defaultRole === 'commenter'
                ? 'commenter'
                : 'reader';
            const boundBadge =
              boundCount > 0
                ? `<span class="group-card-count badge">已绑 ${boundCount} 文件</span>`
                : '';
            return `<div class="group-card-row">
              <div class="group-card-info">
                <strong class="group-card-name">${escapeHtml(g.name)}</strong>
                <span class="group-card-count badge">${count} 人</span>
                ${boundBadge}
              </div>
              <div class="group-card-actions row-flex">
                <select class="select select-sm" data-action="change-group-role" data-group="${escapeHtml(g.name)}" aria-label="${escapeHtml(g.name)} 默认角色">
                  <option value="writer" ${curRole === 'writer' ? 'selected' : ''}>默认可编辑</option>
                  <option value="commenter" ${curRole === 'commenter' ? 'selected' : ''}>默认可评论</option>
                  <option value="reader" ${curRole === 'reader' ? 'selected' : ''}>默认仅查看</option>
                </select>
                <button type="button" class="btn btn-xs" data-action="filter-files-by-group" data-group="${escapeHtml(g.name)}" title="在资产视图筛选该分组关联与绑定的文件">${boundCount > 0 ? '筛此组绑定文件' : '筛此组文件'}</button>
                <button type="button" class="btn-text btn-text-danger" data-action="delete-group" data-group="${escapeHtml(g.name)}" title="删除该分组">删除</button>
              </div>
            </div>`;
          })
          .join('')
      : '<span class="muted">暂无分组，可在上方新建或从 Google 表格导入自动建组</span>';
  }

  // 5.5 #group-quick-add-select & #batch-save-group-select
  const quickAddGrpSel = $('group-quick-add-select');
  if (quickAddGrpSel) {
    const prevQa = quickAddGrpSel.value;
    quickAddGrpSel.innerHTML = [
      `<option value="">请选择目标分组…</option>`,
      ...groups.map(
        g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人)</option>`
      )
    ].join('');
    if ([...quickAddGrpSel.options].some(o => o.value === prevQa)) {
      quickAddGrpSel.value = prevQa;
    } else if (groups.length > 0 && !prevQa) {
      quickAddGrpSel.value = groups[0].name;
    }
  }

  const saveGrpSel = $('batch-save-group-select');
  if (saveGrpSel) {
    const prevSaveGrp = saveGrpSel.value;
    saveGrpSel.innerHTML = [
      ...groups.map(
        g =>
          `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${groupCountMap.get(g.name) || 0}人 · 已绑 ${(g.assets || []).length}文件)</option>`
      ),
      `<option value="__new__">+ 新建分组并保存…</option>`
    ].join('');
    if (prevSaveGrp && [...saveGrpSel.options].some(o => o.value === prevSaveGrp)) {
      saveGrpSel.value = prevSaveGrp;
    } else if (groups.length > 0) {
      saveGrpSel.value = groups[0].name;
    } else {
      saveGrpSel.value = '__new__';
    }
  }

  // 6. #drive-sheet-picker, #ir-target-sheet-picker, #ir-pick-donor-sheet, #ir-pick-target-sheet
  const sheets = state.files.filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
  const fillSheetPicker = (id, placeholder) => {
    const picker = $(id);
    if (!picker) return;
    const prev = picker.value;
    picker.innerHTML = [
      `<option value="">${placeholder} (${sheets.length})</option>`,
      ...sheets.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
    ].join('');
    if ([...picker.options].some(o => o.value === prev)) {
      picker.value = prev;
    }
  };
  fillSheetPicker('drive-sheet-picker', '从已扫描的云端 Google 表格选择');
  fillSheetPicker('ir-target-sheet-picker', '从已扫描的 Google 表格选择目标表');
  fillSheetPicker('ir-pick-donor-sheet', '+带入已扫描表格到 A 列(来源)…');
  fillSheetPicker('ir-pick-target-sheet', '+设 B 列目标汇总表…');

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

  // 8. 批量授权选择器（旧下拉 + 新可搜索单点浮层）
  renderBatchLinksFolderPicker();
  renderBatchLinksAssetPicker();
  renderBatchLinksEmailPicker();

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
      contactRole: c.role || '',
      groupRoles: c.groupRoles && typeof c.groupRoles === 'object' ? { ...c.groupRoles } : {},
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
          contactRole: contact?.role || '',
          groupRoles: contact?.groupRoles && typeof contact.groupRoles === 'object' ? { ...contact.groupRoles } : {},
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

function setCollabViewMode(mode = 'people') {
  state.collabViewMode = mode === 'domains' ? 'domains' : 'people';
  const isDomains = state.collabViewMode === 'domains';
  $('collab-view-people-btn')?.classList.toggle('active', !isDomains);
  $('collab-view-domains-btn')?.classList.toggle('active', isDomains);
  $('collab-people-table-wrap')?.classList.toggle('hidden', isDomains);
  $('collab-domains-wrap')?.classList.toggle('hidden', !isDomains);
  $('collab-domain-category-filter')?.classList.toggle('hidden', !isDomains);
  renderCollaboratorsTab();
}

function renderCollaboratorsDomainView(query = '') {
  const tbody = $('collab-domain-rows');
  if (!tbody) return;
  const catFilter = $('collab-domain-category-filter')?.value || 'all';
  const domains = buildDomainAuditSummary(
    getScopedFilesByAccount(),
    state.directory,
    state.policy,
    state.accounts
  ).filter(d => {
    if (catFilter !== 'all' && d.category !== catFilter) return false;
    if (!query) return true;
    const cleanQ = query.replace(/^@/, '');
    return (
      d.domain.includes(cleanQ) ||
      (d.users || []).some(u => u.email.includes(query) || (u.name || '').toLowerCase().includes(query))
    );
  });

  if (!domains.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无匹配的域名统计数据</td></tr>';
    return;
  }

  tbody.innerHTML = domains
    .map(d => {
      let catBadge = `<span class="status-pill info">内部企业域</span>`;
      if (d.category === 'external') {
        catBadge = `<span class="status-pill ${d.strangerCount > 0 ? 'danger' : 'warning'}">外部合作域</span>`;
      } else if (d.category === 'personal') {
        catBadge = `<span class="status-pill warning">公共个人域</span>`;
      }

      const anomalyParts = [];
      anomalyParts.push(d.strangerCount > 0 ? `非白名单 ${d.strangerCount}` : '全员白名单');
      if (d.overprivilegedCount > 0) anomalyParts.push(`越权 ${d.overprivilegedCount}`);

      return `<tr>
        <td>
          <div><strong>@${escapeHtml(d.domain)}</strong></div>
          <div>${catBadge}</div>
        </td>
        <td>
          <div><strong>${d.userCount}</strong> 名协作者</div>
          <div class="muted">${escapeHtml(anomalyParts.join(' · '))}</div>
        </td>
        <td>
          <div><strong>${d.fileCount}</strong> 个文件</div>
          <div class="muted">编辑 ${d.writerFileCount} / 只读 ${d.readerFileCount}</div>
        </td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-xs" data-action="domain-filter-files" data-domain="${escapeHtml(d.domain)}">在左侧筛选该域文件</button>
            <button type="button" class="btn btn-xs" data-action="domain-filter-people" data-domain="${escapeHtml(d.domain)}">按域过滤人员</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

function renderCollaboratorsTab() {
  renderGroupSelectorsAndBatchBar();
  setCollabSubTab(state.collabSubTab);

  const isDomains = state.collabViewMode === 'domains';
  $('collab-view-people-btn')?.classList.toggle('active', !isDomains);
  $('collab-view-domains-btn')?.classList.toggle('active', isDomains);
  $('collab-people-table-wrap')?.classList.toggle('hidden', isDomains);
  $('collab-domains-wrap')?.classList.toggle('hidden', !isDomains);
  $('collab-domain-category-filter')?.classList.toggle('hidden', !isDomains);

  const selectedGroup = $('collab-group-filter')?.value || 'all';
  const summaryBar = $('selected-group-summary');
  if (summaryBar) {
    if (selectedGroup === 'all') {
      summaryBar.classList.add('hidden');
      summaryBar.innerHTML = '';
    } else {
      const grpObj = (state.directory.groups || []).find(g => g.name === selectedGroup);
      const members = (state.directory.contacts || []).filter(c => (c.groups || []).includes(selectedGroup));
      summaryBar.classList.remove('hidden');
      summaryBar.innerHTML = `
        <span><strong>${escapeHtml(selectedGroup)}</strong>：共 ${members.length} 人（默认${groupRoleDisplayLabel(grpObj?.defaultRole)}）</span>
        <div class="row-flex">
          <button type="button" class="btn btn-xs" data-action="group-sync-writers" data-group="${escapeHtml(selectedGroup)}">全组入编辑白名单</button>
          <button type="button" class="btn btn-xs" data-action="group-sync-readers" data-group="${escapeHtml(selectedGroup)}">全组入只读白名单</button>
        </div>
      `;
    }
  }

  const query = ($('collab-search')?.value || '').trim().toLowerCase();
  renderCollaboratorsDomainView(query);

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
  if (!tbody) return;
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
        .map(g => {
          const memberGrpRole = p.groupRoles?.[g] || p.contactRole || '';
          const roleHint = memberGrpRole ? `·${groupRoleDisplayLabel(memberGrpRole)}` : '';
          return `<span class="badge">
            ${escapeHtml(g)}${escapeHtml(roleHint)}
            <button type="button" class="btn-text btn-text-danger" data-action="remove-person-group" data-email="${escapeHtml(p.email)}" data-group="${escapeHtml(g)}" title="从该组移除">×</button>
          </span>`;
        })
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
          <div><strong>${escapeHtml(p.name || '未填姓名')}</strong></div>
          <div class="muted">${escapeHtml(p.email)}</div>
        </td>
        <td>
          <div>${tierBadge}</div>
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
            <button type="button" class="btn danger btn-xs" data-action="person-offboard-drive" data-email="${escapeHtml(p.email)}" title="跨全部已授权网盘检索并彻底清退此邮箱">全盘清退</button>
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
            <button type="button" class="btn-text btn-text-danger" data-action="del-writer" data-val="${escapeHtml(item)}">移除</button>
          </div>`
        )
        .join('')
    : '<span class="muted">暂无允许编辑名单</span>';

  $('readers-list').innerHTML = readers.length
    ? readers
        .map(
          item => `<div class="allow-item">
            <span>${escapeHtml(item)}</span>
            <button type="button" class="btn-text btn-text-danger" data-action="del-reader" data-val="${escapeHtml(item)}">移除</button>
          </div>`
        )
        .join('')
    : '<span class="muted">暂无仅限查看名单</span>';

  if ($('policy-schedule-enabled')) $('policy-schedule-enabled').checked = Boolean(state.policy.scheduleEnabled);
  if ($('policy-schedule-minutes')) $('policy-schedule-minutes').value = String(state.policy.scheduleMinutes || 720);
  if ($('policy-startup-scan-chk')) {
    $('policy-startup-scan-chk').checked = state.policy.scanOnBrowserStartup !== false;
  }
  if ($('auto-enforce-select')) $('auto-enforce-select').value = state.policy.autoEnforce ? 'enforce' : 'alert';
  if ($('policy-public-rule')) $('policy-public-rule').value = state.policy.publicLinkRule || 'forbid';

  if ($('oauth-guard-enabled-chk')) {
    $('oauth-guard-enabled-chk').checked = state.policy.thirdPartyOAuthGuardEnabled !== false;
  }
  if ($('oauth-guard-mode-select')) {
    $('oauth-guard-mode-select').value = state.policy.oauthGuardMode === 'alert' ? 'alert' : 'block';
  }
  if ($('oauth-block-drive-chk')) {
    $('oauth-block-drive-chk').checked = state.policy.blockThirdPartyDriveScope !== false;
  }
  if ($('oauth-block-sheets-chk')) {
    $('oauth-block-sheets-chk').checked = state.policy.blockThirdPartySheetsScope !== false;
  }
  const blockedKeywords = Array.isArray(state.policy.blockedAppKeywords)
    ? state.policy.blockedAppKeywords
    : ['chatgpt', 'openai', 'grok', 'xai', 'muse', 'claude', 'cursor', 'notion', 'zapier', 'make'];
  renderOAuthGuardKeywordTags(blockedKeywords);
  const kwInput = $('oauth-guard-keywords-input');
  if (kwInput && document.activeElement !== kwInput) {
    kwInput.value = blockedKeywords.join(', ');
  }
  const trustedInput = $('oauth-guard-trusted-input');
  if (trustedInput && document.activeElement !== trustedInput) {
    const trustedList = Array.isArray(state.policy.trustedOAuthKeywords)
      ? state.policy.trustedOAuthKeywords
      : [];
    trustedInput.value = trustedList.join(', ');
  }
  renderAutoPatrolCheckpointInfo();
  renderThirdPartyAppAlerts();
}

function isLogRestorable(log) {
  return Boolean(
    log &&
      !log.restored &&
      (log.actionType === 'revoke' || log.actionType === 'downgrade') &&
      log.fileId &&
      (log.targetEmail || log.domain || log.targetType === 'anyone')
  );
}

function isTtlLogItem(item) {
  if (!item) return false;
  if (item.isTtl === true) return true;
  if (item.source === 'ttl') return true;
  if (item.ttlId) return true;
  const act = String(item.actionType || '');
  if (act.startsWith('ttl')) return true;
  return /限时|到期自动|到期回收/.test(String(item.message || ''));
}

function renderTtlQueue() {
  const pending = getActivePendingTtlEntries()
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.expiresAt || 0).getTime() || Number.MAX_SAFE_INTEGER;
      const tb = new Date(b.expiresAt || 0).getTime() || Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  const countEl = $('ttl-queue-count');
  if (countEl) countEl.textContent = pending.length;

  const reapBtn = $('ttl-reap-expired-btn');
  if (reapBtn) reapBtn.disabled = pending.length === 0;

  const tbody = $('ttl-queue-rows');
  if (!tbody) return;

  if (!pending.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无待回收的限时权限</td></tr>';
    return;
  }

  tbody.innerHTML = pending
    .map(entry => {
      const ttlId = entry.id || entry.ttlId || '';
      const fileLabel = entry.fileName || entry.name || entry.fileId || '-';
      const targetLabel =
        entry.targetLabel ||
        entry.targetEmail ||
        entry.emailAddress ||
        (entry.domain ? `@${entry.domain}` : '') ||
        (entry.targetType === 'anyone' ? '公开链接 (任何人)' : '-');
      const roleText = roleLabel(entry.grantedRole || entry.role || 'reader');
      const remainText = formatTtlBadgeText(entry.expiresAt) || '-';
      const urgencyClass = entry.status === 'failed' ? 'expired' : getTtlUrgencyClass(entry.expiresAt);
      const expireTimeStr = entry.expiresAt ? formatTime(entry.expiresAt) : '-';
      const subMetaText =
        entry.status === 'failed' && entry.lastError
          ? `回收重试失败：${entry.lastError}`
          : `到期：${expireTimeStr}`;

      return `<tr>
        <td>
          <div><strong>${escapeHtml(fileLabel)}</strong></div>
          <div class="muted">${escapeHtml(targetLabel)}</div>
        </td>
        <td>
          <div>${escapeHtml(roleText)} · <span class="ttl-remaining ${urgencyClass}">${escapeHtml(remainText)}</span></div>
          <div class="muted">${escapeHtml(subMetaText)}</div>
        </td>
        <td>
          <div class="row-flex wrap-flex">
            <button type="button" class="btn danger btn-xs" data-action="ttl-revoke-now" data-ttl-id="${escapeHtml(ttlId)}">立即收回</button>
            <button type="button" class="btn btn-xs" data-action="ttl-keep-permanent" data-ttl-id="${escapeHtml(ttlId)}">转为长期</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

function renderLogsTab() {
  renderTtlQueue();

  const filterVal = $('log-filter')?.value || 'all';
  const filtered = state.logs.filter(item => {
    if (filterVal === 'all') return true;
    if (filterVal === 'ttl') return isTtlLogItem(item);
    return item.source === filterVal;
  });

  const restorableLogs = filtered.filter(isLogRestorable);
  const batchRestoreBtn = $('batch-restore-logs-btn');
  if (batchRestoreBtn) {
    batchRestoreBtn.textContent = `批量回滚 (${restorableLogs.length})`;
    batchRestoreBtn.disabled = restorableLogs.length === 0;
  }

  const tbody = $('log-rows');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无匹配的日志记录</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .slice(0, 150)
    .map(log => {
      const canRestore = isLogRestorable(log);

      const actionHtml = log.restored
        ? '<span class="muted">已回滚</span>'
        : canRestore
        ? `<button type="button" class="btn btn-xs" data-action="restore-log" data-log-id="${escapeHtml(log.id)}">一键回滚</button>`
        : '<span class="muted">-</span>';

      return `<tr>
        <td>
          <div><strong>${escapeHtml(log.fileName || '-')}</strong></div>
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

function setAssetsSubTab(sub = 'list') {
  const nextSub = sub === 'auto' ? 'auto' : 'list';
  state.assetsSubTab = nextSub;

  const listBtn = $('assets-subtab-list-btn');
  const autoBtn = $('assets-subtab-auto-btn');
  if (listBtn) {
    listBtn.classList.toggle('active', nextSub === 'list');
    listBtn.setAttribute('aria-selected', nextSub === 'list' ? 'true' : 'false');
  }
  if (autoBtn) {
    autoBtn.classList.toggle('active', nextSub === 'auto');
    autoBtn.setAttribute('aria-selected', nextSub === 'auto' ? 'true' : 'false');
  }

  $('assets-subpanel-list')?.classList.toggle('active', nextSub === 'list');
  $('assets-subpanel-list')?.classList.toggle('hidden', nextSub !== 'list');
  $('assets-subpanel-auto')?.classList.toggle('active', nextSub === 'auto');
  $('assets-subpanel-auto')?.classList.toggle('hidden', nextSub !== 'auto');

  if (nextSub === 'auto') {
    renderDormantRadar();
    renderLogsTab();
    renderPolicyTab();
  }
}

function switchMainNav(navKey = 'assets') {
  const isLegacySecurity = navKey === 'security';
  const validKeys = ['assets', 'excluded', 'folder-links', 'groups', 'partners', 'settings'];
  const nextNav = isLegacySecurity ? 'assets' : validKeys.includes(navKey) ? navKey : 'assets';
  state.activeNav = nextNav;

  if ($('stage-view-title')) {
    $('stage-view-title').textContent = STAGE_VIEW_TITLES[nextNav] || '云盘资产巡检';
  }

  document.querySelectorAll('.rail-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === nextNav);
  });

  document.querySelectorAll('.stage-view').forEach(sec => {
    const isActive = sec.id === `view-${nextNav}`;
    sec.classList.toggle('active', isActive);
    if (isActive) sec.classList.remove('hidden');
  });

  if (isLegacySecurity) {
    setAssetsSubTab('auto');
  } else if (nextNav === 'excluded') {
    renderExcludedFoldersView();
  }
}

function setFolderLinksSubTab(sub = 'batch') {
  const nextSub = sub === 'importrange' || sub === 'transfer' ? sub : 'batch';
  state.flSubTab = nextSub;
  $('fl-subtab-batch-btn')?.classList.toggle('active', nextSub === 'batch');
  $('fl-subtab-importrange-btn')?.classList.toggle('active', nextSub === 'importrange');
  $('fl-subtab-transfer-btn')?.classList.toggle('active', nextSub === 'transfer');

  $('left-panel-batch-links')?.classList.toggle('active', nextSub === 'batch');
  $('left-panel-batch-links')?.classList.toggle('hidden', nextSub !== 'batch');

  $('fl-subpanel-importrange')?.classList.toggle('active', nextSub === 'importrange');
  $('fl-subpanel-importrange')?.classList.toggle('hidden', nextSub !== 'importrange');

  $('left-panel-ownership-transfer')?.classList.toggle('active', nextSub === 'transfer');
  $('left-panel-ownership-transfer')?.classList.toggle('hidden', nextSub !== 'transfer');
}

function setGroupsSubTab(sub = 'dir') {
  const nextSub = sub === 'bundles' ? 'bundles' : 'dir';
  state.groupsSubTab = nextSub;
  $('groups-subtab-dir-btn')?.classList.toggle('active', nextSub === 'dir');
  $('groups-subtab-bundles-btn')?.classList.toggle('active', nextSub === 'bundles');

  $('groups-subpanel-dir')?.classList.toggle('active', nextSub === 'dir');
  $('groups-subpanel-dir')?.classList.toggle('hidden', nextSub !== 'dir');

  $('groups-subpanel-bundles')?.classList.toggle('active', nextSub === 'bundles');
  $('groups-subpanel-bundles')?.classList.toggle('hidden', nextSub !== 'bundles');
}

function switchTab(tabName) {
  state.activeTab = tabName;
  if (state.rightPaneCollapsed) {
    setRightPaneCollapsed(false);
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });

  if (document.querySelectorAll('.stage-view').length > 0) {
    const navMap = {
      ops: 'assets',
      batch: 'assets',
      assets: 'assets',
      'folder-links': 'folder-links',
      groups: 'groups',
      collaborators: 'partners',
      partners: 'partners',
      logs: 'security',
      security: 'security',
      settings: 'settings'
    };
    if (navMap[tabName]) {
      switchMainNav(navMap[tabName]);
    }
  }
}

/* ==================== v1.0.0 安全加固、沉睡雷达、跨表放行、岗位包与合作方档案 ==================== */

async function refreshBundlesAndPartnersState() {
  if (typeof getRoleBundles === 'function') {
    try {
      const list = await getRoleBundles();
      state.roleBundles = Array.isArray(list) ? list : [];
    } catch (_e) {}
  }
  if (typeof getPartnerProfiles === 'function') {
    try {
      const list = await getPartnerProfiles();
      state.partnerProfiles = Array.isArray(list) ? list : [];
    } catch (_e) {}
  }
}

async function execSecurityHardeningCompat(options = {}) {
  if (typeof applyFileSecurityHardening === 'function') {
    return applyFileSecurityHardening(options);
  }
  const files = options.files || [];
  let changedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const failedItems = [];
  for (let i = 0; i < files.length; i++) {
    if (options.shouldStop?.()) return { changedCount, failedCount, skippedCount, failedItems, stopped: true };
    const f = files[i];
    if (!f) {
      skippedCount++;
      continue;
    }
    const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
    const body = {};
    if (typeof options.writersCanShare === 'boolean') body.writersCanShare = options.writersCanShare;
    if (!isFolder && typeof options.copyRequiresWriterPermission === 'boolean') {
      body.copyRequiresWriterPermission = options.copyRequiresWriterPermission;
    }
    if (!isFolder && typeof options.contentLock === 'boolean') {
      body.contentRestrictions = [
        { readOnly: options.contentLock, reason: options.lockReason || '由 Drive 权限管理中心锁定保护' }
      ];
    }
    if (Object.keys(body).length === 0) {
      skippedCount++;
      continue;
    }
    try {
      const token = await resolveTokenForFile(f, i === 0);
      await driveApi(
        token,
        `/files/${encodeURIComponent(f.id)}?supportsAllDrives=true&fields=id,writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason)`,
        { method: 'PATCH', body: JSON.stringify(body) }
      );
      if (typeof options.writersCanShare === 'boolean') f.writersCanShare = options.writersCanShare;
      if (!isFolder && typeof options.copyRequiresWriterPermission === 'boolean') {
        f.copyRequiresWriterPermission = options.copyRequiresWriterPermission;
      }
      if (!isFolder && typeof options.contentLock === 'boolean') {
        f.contentLocked = options.contentLock;
        f.contentLockReason = options.contentLock ? options.lockReason || '' : '';
        f.contentRestrictions = options.contentLock ? [{ readOnly: true, reason: options.lockReason || '' }] : [];
      }
      changedCount++;
    } catch (err) {
      failedCount++;
      failedItems.push({ fileId: f.id, errorMessage: err?.message || String(err) });
    }
    options.onProgress?.({ done: i + 1, total: files.length });
  }
  await saveCurrentFilesSnapshot();
  return { changedCount, failedCount, skippedCount, failedItems, stopped: false };
}

async function handleInspectorToggleSecurity(field) {
  const file = state.files.find(f => f.id === state.inspectedFileId);
  if (!file) return;
  if (
    file.mimeType === 'application/vnd.google-apps.folder' &&
    (field === 'copyRequiresWriterPermission' || field === 'contentLock')
  ) {
    toast('文件夹不支持直接设置单文件防复制或内容锁');
    return;
  }

  const payload = { files: [file] };
  let actionText = '';
  if (field === 'writersCanShare') {
    const nextVal = file.writersCanShare === false ? true : false;
    payload.writersCanShare = nextVal;
    actionText = nextVal === false ? '已禁止可编辑协作者二次拉人或改权限' : '已恢复允许编辑者分享';
  } else if (field === 'copyRequiresWriterPermission') {
    const nextVal = file.copyRequiresWriterPermission === true ? false : true;
    payload.copyRequiresWriterPermission = nextVal;
    actionText = nextVal ? '已禁止只读与评论者下载、打印、复制' : '已恢复允许只读下载复制';
  } else if (field === 'contentLock') {
    const curLocked = Boolean(
      file.contentLocked || file.contentRestrictions?.some?.(r => Boolean(r?.readOnly))
    );
    const nextLock = !curLocked;
    payload.contentLock = nextLock;
    payload.lockReason = '由 Drive 权限管理中心锁定防误改';
    actionText = nextLock ? '已开启文件只读锁定保护' : '已解除文件只读锁定';
  } else {
    return;
  }

  try {
    state.localTtlMutatingCount += 1;
    state.localTtlMutationEpoch += 1;
    let res;
    try {
      res = await execSecurityHardeningCompat(payload);
      await saveCurrentFilesSnapshot();
    } finally {
      state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
      state.localTtlMutationEpoch += 1;
    }
    if ((res?.failedCount || 0) > 0) {
      throw new Error(res.failedItems?.[0]?.errorMessage || '安全属性更新失败');
    }
    state.logs = await getAuditLogs();
    renderAll();
    toast(`《${file.name}》${actionText}`);
  } catch (error) {
    toast(`安全加固失败：${error?.message || error}`);
  }
}

async function handleBatchHardenSelected() {
  const selectedFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!selectedFiles.length) {
    toast('请先勾选至少 1 个文件');
    return;
  }
  const setNoWritersShare = Boolean($('batch-harden-writers-chk')?.checked);
  const setNoCopy = Boolean($('batch-harden-copy-chk')?.checked);
  const lockMode = $('batch-harden-lock-select')?.value || 'no_change';

  const writersCanShare = setNoWritersShare ? false : undefined;
  const copyRequiresWriterPermission = setNoCopy ? true : undefined;
  const contentLock = lockMode === 'lock' ? true : lockMode === 'unlock' ? false : undefined;

  if (
    writersCanShare === undefined &&
    copyRequiresWriterPermission === undefined &&
    contentLock === undefined
  ) {
    toast('请至少勾选一项防扩散加固规则或选择锁定状态');
    return;
  }

  closeBatchActionModal();

  const descParts = [];
  if (writersCanShare === false) descParts.push('禁编辑者二次拉人');
  if (copyRequiresWriterPermission === true) descParts.push('禁只读下载复制打印');
  if (contentLock === true) descParts.push('开启内容防误改锁');
  else if (contentLock === false) descParts.push('解除内容防误改锁');
  const ruleSummary = descParts.join(' · ');

  const hasFileOnlyRule = copyRequiresWriterPermission !== undefined || contentLock !== undefined;
  const previewItems = selectedFiles.map(f => ({
    title: f.name || f.id,
    detail:
      f.mimeType === 'application/vnd.google-apps.folder'
        ? writersCanShare === false
          ? hasFileOnlyRule
            ? '应用规则：禁编辑者二次拉人（自动跳过单文件锁属性）'
            : '应用规则：禁编辑者二次拉人'
          : '文件夹将自动跳过单文件锁属性'
        : `应用规则：${ruleSummary}`
  }));

  const confirmed = await confirmWithDryRunModal({
    title: '批量防扩散与锁定加固预演',
    summaryHtml: `即将对已勾选的 <strong>${selectedFiles.length}</strong> 项资产执行安全加固：<strong>${escapeHtml(ruleSummary)}</strong>。`,
    previewItems,
    confirmText: `确认加固 (${selectedFiles.length} 项)`,
    isDanger: false,
    fallbackText: `确认对 ${selectedFiles.length} 项资产执行「${ruleSummary}」？`
  });
  if (!confirmed) return;

  try {
    await runControllableBatchTask({
      title: `批量安全加固：${ruleSummary}`,
      retryFn: null,
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          res = await execSecurityHardeningCompat({
            files: selectedFiles,
            writersCanShare,
            copyRequiresWriterPermission,
            contentLock,
            lockReason: '由 Drive 权限管理中心批量锁定保护',
            shouldStop,
            onProgress(p) {
              updateProgress({ done: p?.done ?? 0, total: p?.total ?? selectedFiles.length, message: p?.message || '' });
            }
          });
          await saveCurrentFilesSnapshot();
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }
        state.logs = await getAuditLogs();
        renderAll();
        const summaryDetail = `已加固 ${res.changedCount || 0} 项 · 跳过 ${res.skippedCount || 0} 项 · 失败 ${res.failedCount || 0} 项`;
        $('progress').textContent = `批量安全加固完成：${summaryDetail}`;
        toast(`安全加固完成：${summaryDetail}`);
        return { ...res, failCount: res.failedCount || 0, summaryDetail };
      }
    });
  } catch (error) {
    toast(`批量安全加固失败：${error?.message || error}`);
  }
}

function getCurrentExcludedIdSet() {
  const excludedFolders = state.policy?.excludedFolders || [];
  if (!excludedFolders.length) return new Set();
  if (typeof buildExcludedFileIdSet === 'function') {
    return buildExcludedFileIdSet(state.files, excludedFolders);
  }
  return new Set(excludedFolders.map(x => String(x?.id || '').trim()).filter(Boolean));
}

function isFileExcludedCompat(file, excludedIdSet = null) {
  const excludedFolders = state.policy?.excludedFolders || [];
  if (!file || !excludedFolders.length) return false;
  if (typeof isFileInExcludedFolders === 'function') {
    return Boolean(isFileInExcludedFolders(file, excludedFolders, excludedIdSet));
  }
  const set = excludedIdSet || getCurrentExcludedIdSet();
  if (set.has(file.id)) return true;
  if (Array.isArray(file.parents) && file.parents.some(pid => set.has(pid))) return true;
  return false;
}

function getStickyPublicLinkTargets() {
  const excludedIdSet = getCurrentExcludedIdSet();
  const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
  const pool =
    selected.length > 0
      ? selected
      : getScopedFilesByAccount().filter(f => f.ownedByMe !== false);
  return pool.filter(f => {
    if (isFileExcludedCompat(f, excludedIdSet)) return false;
    return (f.permissions || []).some(p => {
      if (!p || (p.type !== 'anyone' && p.type !== 'domain')) return false;
      const isPureInherited =
        permIsInherited(p) && !(typeof permHasDirectGrant === 'function' && permHasDirectGrant(p));
      return !isPureInherited;
    });
  });
}

function getStickyHardenTargets(kind) {
  const excludedIdSet = getCurrentExcludedIdSet();
  const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
  const pool =
    selected.length > 0
      ? selected
      : getScopedFilesByAccount().filter(f => f.ownedByMe !== false);
  const eligible = pool.filter(f => !isFileExcludedCompat(f, excludedIdSet));
  if (kind === 'writers') {
    return eligible.filter(f => f.writersCanShare !== false);
  }
  return eligible.filter(
    f => f.mimeType !== 'application/vnd.google-apps.folder' && f.copyRequiresWriterPermission !== true
  );
}

function renderSecurityRadar() {
  const summaryEl = $('security-radar-summary');
  const tbody = $('security-radar-rows');
  const closePublicBtn = $('security-close-public-btn');
  const hardenWritersBtn = $('security-harden-writers-btn');
  const hardenCopyBtn = $('security-harden-copy-btn');
  if (!summaryEl && !tbody && !closePublicBtn && !hardenWritersBtn && !hardenCopyBtn) return;

  const publicTargets = getStickyPublicLinkTargets();
  const writersTargets = getStickyHardenTargets('writers');
  const copyTargets = getStickyHardenTargets('copy');
  const hasSelected = state.selectedFileIds.size > 0;

  if (closePublicBtn) {
    closePublicBtn.disabled = publicTargets.length === 0;
    closePublicBtn.title = hasSelected
      ? `一键关闭已勾选的 ${publicTargets.length} 项未排除公开/域内共享链接`
      : `一键关闭全部 ${publicTargets.length} 项未排除自有文件的公开/域内共享链接`;
  }
  if (hardenWritersBtn) {
    hardenWritersBtn.disabled = writersTargets.length === 0;
    hardenWritersBtn.title = hasSelected
      ? `对已勾选的 ${writersTargets.length} 项未加固资产禁止编辑者拉人`
      : `对全部 ${writersTargets.length} 项未加固自有资产禁止编辑者拉人`;
  }
  if (hardenCopyBtn) {
    hardenCopyBtn.disabled = copyTargets.length === 0;
    hardenCopyBtn.title = hasSelected
      ? `对已勾选的 ${copyTargets.length} 个未加固文档禁止只读下载复制`
      : `对全部 ${copyTargets.length} 个未加固自有文档禁止只读下载复制`;
  }

  if (!summaryEl && !tbody) return;

  const scoped = getScopedFilesByAccount();
  const sharedDocs = scoped.filter(
    f => f.mimeType !== 'application/vnd.google-apps.folder' && isFileShared(f)
  );
  const writersOpenList = sharedDocs.filter(f => f.writersCanShare !== false);
  const copyOpenList = sharedDocs.filter(f => f.copyRequiresWriterPermission !== true);
  const lockedList = scoped.filter(f =>
    Boolean(f.contentLocked || f.contentRestrictions?.some?.(r => Boolean(r?.readOnly)))
  );

  if (summaryEl) {
    summaryEl.innerHTML = `已共享文档 <strong>${sharedDocs.length}</strong> 个 · 未禁编辑拉人 <strong>${writersOpenList.length}</strong> 个 · 未禁只读复制下载 <strong>${copyOpenList.length}</strong> 个 · 已开启内容锁 <strong>${lockedList.length}</strong> 个`;
  }

  if (!tbody) return;
  const riskyDocs = sharedDocs.filter(
    f => f.writersCanShare !== false || f.copyRequiresWriterPermission !== true
  );
  if (!riskyDocs.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">当前已共享文档均已完成防扩散加固，或暂无对外共享文档</td></tr>';
    return;
  }

  tbody.innerHTML = riskyDocs
    .slice(0, 80)
    .map(f => {
      const wOpen = f.writersCanShare !== false;
      const cOpen = f.copyRequiresWriterPermission !== true;
      const isLocked = Boolean(
        f.contentLocked || f.contentRestrictions?.some?.(r => Boolean(r?.readOnly))
      );
      const tags = [];
      if (wOpen) tags.push('<span class="status-pill warning">编辑可拉人</span>');
      else tags.push('<span class="badge">已禁拉人</span>');
      if (cOpen) tags.push('<span class="status-pill warning">只读可复制下载</span>');
      else tags.push('<span class="badge">已禁复制</span>');
      if (isLocked) tags.push('<span class="status-pill info">已锁定</span>');

      return `<tr>
        <td>
          <div><strong>${escapeHtml(f.name || f.id)}</strong></div>
          <div class="muted">${escapeHtml(fileCategoryLabel(f.mimeType, f.name))}</div>
        </td>
        <td><div class="row-flex wrap-flex">${tags.join('')}</div></td>
        <td>
          <div class="row-flex wrap-flex">
            ${wOpen ? `<button type="button" class="btn btn-xs" data-action="radar-harden-writers" data-file-id="${escapeHtml(f.id)}">禁拉人</button>` : ''}
            ${cOpen ? `<button type="button" class="btn btn-xs" data-action="radar-harden-copy" data-file-id="${escapeHtml(f.id)}">禁复制</button>` : ''}
            <button type="button" class="btn btn-xs" data-action="radar-toggle-lock" data-file-id="${escapeHtml(f.id)}">${isLocked ? '解锁' : '锁定'}</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

async function handleRadarBulkHarden(kind) {
  const targets = getStickyHardenTargets(kind);
  const scopeDesc = state.selectedFileIds.size > 0 ? '已勾选的' : '全部未加固自有';

  if (!targets.length) {
    toast(state.selectedFileIds.size > 0 ? '所选资产均已完成该项防扩散设置' : '当前没有需要加固的自有资产');
    return;
  }

  const label = kind === 'writers' ? '一键禁止编辑者二次拉人' : '一键禁止只读与评论者下载复制';
  const confirmed = await confirmWithDryRunModal({
    title: `修改编辑与下载权限预演：${label}`,
    summaryHtml: `即将对${scopeDesc} <strong>${targets.length}</strong> 项资产执行「<strong>${escapeHtml(label)}</strong>」。`,
    previewItems: targets.map(f => ({ title: f.name || f.id, detail: label })),
    confirmText: `确认执行 (${targets.length} 项)`,
    isDanger: false,
    fallbackText: `确认对${scopeDesc} ${targets.length} 项资产执行「${label}」？`
  });
  if (!confirmed) return;

  try {
    await runControllableBatchTask({
      title: label,
      retryFn: null,
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          res = await execSecurityHardeningCompat({
            files: targets,
            writersCanShare: kind === 'writers' ? false : undefined,
            copyRequiresWriterPermission: kind === 'copy' ? true : undefined,
            shouldStop,
            onProgress(p) {
              updateProgress({ done: p?.done ?? 0, total: p?.total ?? targets.length, message: p?.message || '' });
            }
          });
          await saveCurrentFilesSnapshot();
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }
        state.logs = await getAuditLogs();
        renderAll();
        const summaryDetail = `成功加固 ${res.changedCount || 0} 个 · 失败 ${res.failedCount || 0} 个`;
        toast(`${label}完成：${summaryDetail}`);
        return { ...res, failCount: res.failedCount || 0, summaryDetail };
      }
    });
  } catch (error) {
    toast(`安全雷达加固失败：${error?.message || error}`);
  }
}

function computeDormantEntriesNow() {
  const days = Number($('dormant-days-select')?.value) || 90;
  const scoped = getScopedFilesByAccount();
  if (typeof findDormantEditorEntries === 'function') {
    return findDormantEditorEntries(scoped, { inactiveDays: days, nowMs: Date.now() }) || [];
  }
  const cutoffMs = Date.now() - days * 86400 * 1000;
  const entries = [];
  for (const f of scoped) {
    const lastTs = new Date(f.viewedByMeTime || f.modifiedTime || 0).getTime();
    if (!lastTs || lastTs > cutoffMs) continue;
    const owner = normalizeEntry(f.ownerAccount || f.owners?.[0]?.emailAddress || '');
    const inactiveDays = Math.floor((Date.now() - lastTs) / (86400 * 1000));
    for (const p of f.permissions || []) {
      if (p.role === 'owner' || permIsInherited(p)) continue;
      if (p.role !== 'writer' && p.role !== 'organizer' && p.role !== 'fileOrganizer') continue;
      const em = normalizeEntry(p.emailAddress || '');
      if (em && em === owner) continue;
      entries.push({
        fileId: f.id,
        fileName: f.name || f.id,
        accountEmail: f.ownerAccount || owner,
        permissionId: p.id,
        targetType: p.type,
        targetEmail: em,
        domain: p.domain || '',
        targetLabel: em || p.domain || '公开可编辑链接',
        role: p.role,
        inactiveDays
      });
    }
  }
  return entries;
}

function renderDormantRadar() {
  const tbody = $('dormant-rows');
  const downgradeAllBtn = $('dormant-downgrade-all-btn');
  if (!tbody) return;

  const entries = computeDormantEntriesNow();
  state.dormantEntries = entries;
  if (downgradeAllBtn) {
    downgradeAllBtn.disabled = entries.length === 0;
  }

  if (!entries.length) {
    const days = Number($('dormant-days-select')?.value) || 90;
    tbody.innerHTML = `<tr><td colspan="3" class="empty">未发现超过 ${days} 天未活跃的可编辑外部权限</td></tr>`;
    return;
  }

  tbody.innerHTML = entries
    .slice(0, 100)
    .map((e, idx) => {
      const targetText =
        e.targetLabel || e.targetEmail || e.emailAddress || (e.domain ? `@${e.domain}` : '公开链接');
      const dDays = e.dormantDays ?? e.inactiveDays ?? 0;
      const curRole = e.currentRole || e.role || 'writer';
      const daysText = dDays ? `沉睡 ${dDays} 天` : '长期未活跃';
      return `<tr>
        <td>
          <div><strong>${escapeHtml(e.fileName || e.fileId)}</strong></div>
          <div class="muted">${escapeHtml(daysText)}</div>
        </td>
        <td>
          <div><strong>${escapeHtml(targetText)}</strong></div>
          <div class="muted">当前：${escapeHtml(roleLabel(curRole))}</div>
        </td>
        <td>
          <div class="row-flex wrap-flex">
            <button type="button" class="btn warning btn-xs" data-action="dormant-downgrade-one" data-idx="${idx}">降为只读</button>
            <button type="button" class="btn danger btn-xs" data-action="dormant-revoke-one" data-idx="${idx}">收回</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

async function handleExecuteDormantEntries(entries = [], mode = 'downgrade_reader') {
  if (!entries.length) {
    toast('当前没有待处理的沉睡编辑权限');
    return;
  }
  const label = mode === 'revoke' ? '收回沉睡编辑权限' : '将沉睡编辑权降为仅查看';
  const confirmed = await confirmWithDryRunModal({
    title: `沉睡编辑权瘦身预演：${label}`,
    summaryHtml: `即将对 <strong>${entries.length}</strong> 处长期未活跃的可编辑权限执行「<strong>${escapeHtml(label)}</strong>」。`,
    previewItems: entries.map(e => ({
      title: `${e.fileName || e.fileId} · ${e.targetLabel || e.targetEmail || '公开链接'}`,
      detail: `${roleLabel(e.currentRole || e.role || 'writer')} → ${mode === 'revoke' ? '移除权限' : '仅查看'}`
    })),
    confirmText: `确认执行 (${entries.length} 处)`,
    isDanger: mode === 'revoke',
    fallbackText: `确认对 ${entries.length} 处沉睡编辑权限执行「${label}」？`
  });
  if (!confirmed) return;

  try {
    await runControllableBatchTask({
      title: label,
      retryFn: null,
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          if (typeof downgradeOrRevokeDormantEntries === 'function') {
            res = await downgradeOrRevokeDormantEntries({
              entries,
              files: state.files,
              mode,
              shouldStop,
              onProgress(p) {
                updateProgress({ done: p?.done ?? 0, total: p?.total ?? entries.length, message: p?.message || '' });
              }
            });
          } else {
            let changedCount = 0;
            let failedCount = 0;
            for (let i = 0; i < entries.length; i++) {
              if (shouldStop()) break;
              const e = entries[i];
              const f = state.files.find(x => x.id === e.fileId);
              if (!f) continue;
              try {
                const tk = await resolveTokenForFile(f, i === 0);
                if (mode === 'revoke') {
                  await deletePermission(tk, f.id, e.permissionId);
                  f.permissions = (f.permissions || []).filter(p => p.id !== e.permissionId);
                } else {
                  await updatePermissionRole(tk, f.id, e.permissionId, 'reader');
                  const p = (f.permissions || []).find(x => x.id === e.permissionId);
                  if (p) p.role = 'reader';
                }
                changedCount++;
              } catch (_err) {
                failedCount++;
              }
              updateProgress({ done: i + 1, total: entries.length });
            }
            res = { changedCount, failedCount };
          }
          const [snap, logs] = await Promise.all([getSnapshot(), getAuditLogs()]);
          if (Array.isArray(snap?.files) && snap.files.length) {
            applySnapshotToState(snap);
          } else {
            await saveCurrentFilesSnapshot();
          }
          state.logs = logs;
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }
        renderAll();
        const changed = res?.changedCount ?? res?.downgradedCount ?? res?.revokedCount ?? 0;
        const failed = res?.failedCount ?? 0;
        const summaryDetail = `成功 ${changed} 处 · 失败 ${failed} 处`;
        toast(`${label}完成：${summaryDetail}`);
        return { ...res, failCount: failed, summaryDetail };
      }
    });
  } catch (error) {
    toast(`沉睡权限处理失败：${error?.message || error}`);
  }
}

/* ==================== 锁定表格 IMPORTRANGE 跨表引用检测与放行 ==================== */

function renderImportRangeReport() {
  const summaryEl = $('ir-summary-bar');
  const tbody = $('ir-deps-rows');
  const fixAllBtn = $('ir-fix-all-source-perms-btn');
  if (!tbody) return;

  const report = state.importRangeReport;
  if (!report) {
    if (summaryEl) {
      summaryEl.classList.add('hidden');
      summaryEl.innerHTML = '';
    }
    if (fixAllBtn) fixAllBtn.disabled = true;
    tbody.innerHTML = '<tr><td colspan="4" class="empty">粘贴或选择目标 Google 表格后点击「检测跨表引用」</td></tr>';
    return;
  }

  const target = report.target || {};
  const deps = Array.isArray(report.dependencies) ? report.dependencies : [];
  const fixableDeps = deps.filter(
    d => d.status === 'missing_source_perm' || (!d.targetOwnerHasAccess && d.canFixSourcePerm !== false)
  );
  const needsClickCount = deps.filter(d => d.status === 'needs_allow_click').length;

  if (fixAllBtn) {
    fixAllBtn.disabled = fixableDeps.length === 0;
    fixAllBtn.textContent =
      fixableDeps.length > 0
        ? `一键补齐全部源表只读权限 (${fixableDeps.length})`
        : '一键补齐全部源表只读权限';
  }

  if (summaryEl) {
    summaryEl.classList.remove('hidden', 'ok', 'warning', 'danger');
    if (fixableDeps.length > 0) summaryEl.classList.add('danger');
    else if (needsClickCount > 0 || (report.refErrorCount || 0) > 0) summaryEl.classList.add('warning');
    else summaryEl.classList.add('ok');

    const ownerText = target.ownerEmail || target.owners?.[0]?.emailAddress || '未知所有者';
    summaryEl.innerHTML = `<span>目标表：<strong>${escapeHtml(target.name || target.id || '-')}</strong>（所有者：${escapeHtml(ownerText)}） · 检出 <strong>${report.totalFormulas || 0}</strong> 处 IMPORTRANGE 公式 · 涉及 <strong>${deps.length}</strong> 张上游源表 · #REF! 报错 <strong>${report.refErrorCount || 0}</strong> 处 · 缺源表权限 <strong>${fixableDeps.length}</strong> 张</span>`;
  }

  if (!deps.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">未在该目标表格中检测到 =IMPORTRANGE 跨表引用公式</td></tr>';
    return;
  }

  tbody.innerHTML = deps
    .map(dep => {
      const srcId = dep.sourceSpreadsheetId || dep.sourceId || '';
      const srcName = dep.sourceName || dep.name || srcId || '未知源表';
      const srcLink = dep.sourceWebViewLink || (srcId ? `https://docs.google.com/spreadsheets/d/${srcId}/edit` : '');

      const lockTag = dep.sourceLocked
        ? '<span class="status-pill warning">源表受限/已锁定</span>'
        : '<span class="badge">常规共享</span>';

      let statusPill = '<span class="status-pill ok">跨表权限正常</span>';
      if (dep.status === 'missing_source_perm') {
        statusPill = '<span class="status-pill danger">缺源表只读权限</span>';
      } else if (dep.status === 'needs_allow_click') {
        statusPill = '<span class="status-pill warning">源表已授权 · 需点「允许访问」</span>';
      } else if (dep.status === 'source_inaccessible') {
        statusPill = '<span class="status-pill warning">当前账号无权查看源表</span>';
      }

      const cells = Array.isArray(dep.cells) ? dep.cells : [];
      const cellsHtml = cells.length
        ? cells
            .slice(0, 8)
            .map(c => {
              const locLabel = `${c.sheetName || '工作表'}!${c.cellRef || ''}`;
              const refTag = c.isRefError ? ' <span class="status-pill danger">#REF!</span>' : '';
              const linkHtml = c.jumpUrl
                ? `<a href="${escapeHtml(sanitizeExternalUrl(c.jumpUrl))}" target="_blank" rel="noopener noreferrer" class="btn-link">定位 ↗</a>`
                : '';
              return `<div class="row-flex wrap-flex"><span>${escapeHtml(locLabel)}</span>${refTag} ${linkHtml}</div>`;
            })
            .join('') +
          (cells.length > 8 ? `<div class="muted">另有 ${cells.length - 8} 处引用…</div>` : '')
        : '<span class="muted">-</span>';

      const canFix = dep.status === 'missing_source_perm' || (!dep.targetOwnerHasAccess && dep.canFixSourcePerm !== false);
      const firstRefCell = cells.find(c => c.isRefError && c.jumpUrl) || cells.find(c => c.jumpUrl);
      let actionHtml = '<span class="muted">无需操作</span>';
      if (canFix && srcId) {
        actionHtml = `<button type="button" class="btn primary btn-xs" data-action="ir-grant-single-source" data-source-id="${escapeHtml(srcId)}">补齐源表只读</button>`;
      } else if (dep.status === 'needs_allow_click' && firstRefCell?.jumpUrl) {
        actionHtml = `<a href="${escapeHtml(sanitizeExternalUrl(firstRefCell.jumpUrl))}" target="_blank" rel="noopener noreferrer" class="btn warning btn-xs">打开点允许访问 ↗</a>`;
      }

      return `<tr>
        <td>
          <div>${srcLink ? `<a href="${escapeHtml(sanitizeExternalUrl(srcLink))}" target="_blank" rel="noopener noreferrer" class="btn-link"><strong>${escapeHtml(srcName)}</strong> ↗</a>` : `<strong>${escapeHtml(srcName)}</strong>`}</div>
          <div class="muted">${escapeHtml(srcId)}</div>
        </td>
        <td>
          <div class="row-flex wrap-flex">${lockTag} ${statusPill}</div>
        </td>
        <td>${cellsHtml}</td>
        <td>${actionHtml}</td>
      </tr>`;
    })
    .join('');
}

async function handleScanImportRangeDeps() {
  const inputVal = ($('ir-target-sheet-input')?.value || '').trim();
  const pickerVal = ($('ir-target-sheet-picker')?.value || $('ir-pick-target-sheet')?.value || '').trim();
  const targetIdOrUrl = inputVal || pickerVal;
  if (!targetIdOrUrl) {
    toast('请先粘贴或选择包含 =IMPORTRANGE 的目标 Google 表格');
    $('ir-target-sheet-input')?.focus?.();
    return;
  }
  if (typeof inspectImportRangeDependencies !== 'function') {
    toast('IMPORTRANGE 跨表检测引擎尚未就绪');
    return;
  }

  const scanBtn = $('ir-scan-btn');
  const origText = scanBtn?.textContent || '从汇总表公式自动提取来源填入 A/B 列';
  state.importRangeScanning = true;
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = '正在导出并解析公式…';
  }
  $('progress').textContent = '正在导出目标表格并分析 =IMPORTRANGE 跨表引用…';

  try {
    const report = await inspectImportRangeDependencies(targetIdOrUrl, {
      accountEmail: state.activeAccount !== 'all' ? state.activeAccount : ''
    });
    state.importRangeReport = report;
    renderImportRangeReport();
    const deps = Array.isArray(report?.dependencies) ? report.dependencies : [];
    const targetUrl =
      report?.target?.webViewLink ||
      (report?.target?.id ? `https://docs.google.com/spreadsheets/d/${report.target.id}/edit` : targetIdOrUrl);
    const extractedPairs = deps
      .filter(d => Boolean(d.sourceSpreadsheetId || d.sourceId))
      .map(d => ({
        donorInput:
          d.sourceWebViewLink ||
          `https://docs.google.com/spreadsheets/d/${d.sourceSpreadsheetId || d.sourceId}/edit`,
        targetInput: targetUrl,
        status:
          d.status === 'missing_source_perm'
            ? '待补齐源表权限并授权'
            : d.status === 'needs_allow_click'
            ? '待执行跨表授权 (A->B)'
            : '已检测到引用'
      }));
    const addedToSheet = appendIrBatchPairsToTable(extractedPairs);
    const depsCount = deps.length;
    const missingCount = deps.filter(d => d.status === 'missing_source_perm').length;
    $('progress').textContent = `跨表检测完成：共 ${report?.totalFormulas || 0} 处公式，${depsCount} 张源表，已自动回填 ${addedToSheet} 行到 A/B 表格`;
    toast(
      depsCount > 0
        ? `检测完成：发现 ${depsCount} 张上游源表（缺权限 ${missingCount} 张），已回填 ${addedToSheet} 行到下方 A/B 表`
        : '检测完成：该目标表格暂未包含 =IMPORTRANGE 跨表引用公式'
    );
  } catch (error) {
    toast(`检测跨表引用失败：${error?.message || error}`);
  } finally {
    state.importRangeScanning = false;
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = origText;
    }
  }
}

function syncIrSheetToRows() {
  if (!state.irBatchSheet) return state.irBatchRows || [];
  const data = state.irBatchSheet.getData() || [];
  state.irBatchRows = data.map(r => [
    String(r?.[0] ?? ''),
    String(r?.[1] ?? ''),
    String(r?.[2] ?? '')
  ]);
  return state.irBatchRows;
}

function extractIrSheetIdFromText(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (typeof parseDriveUrlOrId === 'function') {
    const parsed = parseDriveUrlOrId(trimmed);
    if (parsed?.fileId) return parsed.fileId;
  }
  const ids = parseDriveLinksInput(trimmed);
  if (ids.length > 0) return ids[0];
  if (/^[a-zA-Z0-9_-]{15,}$/.test(trimmed)) return trimmed;
  return '';
}

function collectIrBatchPairs() {
  const rows = syncIrSheetToRows();
  let defaultTargetId = '';
  let defaultTargetInput = '';
  for (const r of rows) {
    const tRaw = String(r?.[1] || '').trim();
    const tid = extractIrSheetIdFromText(tRaw);
    if (tid) {
      defaultTargetId = tid;
      defaultTargetInput = tRaw;
      break;
    }
  }

  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    const donorRaw = String(rows[i]?.[0] || '').trim();
    const targetRaw = String(rows[i]?.[1] || '').trim();
    const donorId = extractIrSheetIdFromText(donorRaw);
    if (!donorId) continue;
    const explicitTargetId = extractIrSheetIdFromText(targetRaw);
    const targetId = explicitTargetId || defaultTargetId;
    const targetInput = explicitTargetId ? targetRaw : defaultTargetInput;
    if (!targetId) continue;
    pairs.push({
      rowIndex: i,
      donorInput: donorRaw,
      targetInput,
      donorId,
      targetId,
      status: String(rows[i]?.[2] || '').trim()
    });
  }
  return pairs;
}

function appendIrBatchPairsToTable(pairs = []) {
  if (!Array.isArray(pairs) || !pairs.length) return 0;
  syncIrSheetToRows();
  const rows = (state.irBatchRows || []).map(r => [r[0] || '', r[1] || '', r[2] || '']);
  const existingKeySet = new Set();
  let firstTargetId = '';
  for (const r of rows) {
    const dId = extractIrSheetIdFromText(r[0]);
    const tId = extractIrSheetIdFromText(r[1]);
    if (!firstTargetId && tId) firstTargetId = tId;
    if (dId && (tId || firstTargetId)) {
      existingKeySet.add(`${dId}::${tId || firstTargetId}`);
    }
  }

  let addedCount = 0;
  let emptyIdx = 0;
  for (const p of pairs) {
    const donorInput = String(p?.donorInput || p?.donorId || '').trim();
    const targetInput = String(p?.targetInput || p?.targetId || '').trim();
    const dId = p?.donorId || extractIrSheetIdFromText(donorInput);
    const tId = p?.targetId || extractIrSheetIdFromText(targetInput) || firstTargetId;
    if (!dId) continue;
    const pairKey = `${dId}::${tId}`;
    if (existingKeySet.has(pairKey)) continue;
    existingKeySet.add(pairKey);
    if (!firstTargetId && tId) firstTargetId = tId;

    while (emptyIdx < rows.length && (String(rows[emptyIdx][0] || '').trim() || String(rows[emptyIdx][1] || '').trim())) {
      emptyIdx++;
    }
    const statusText = String(p?.status || '');
    if (emptyIdx < rows.length) {
      rows[emptyIdx] = [donorInput, targetInput, statusText];
      emptyIdx++;
    } else {
      rows.push([donorInput, targetInput, statusText]);
      emptyIdx = rows.length;
    }
    addedCount++;
  }

  state.irBatchRows = rows;
  renderIrBatchSheet();
  return addedCount;
}

async function handleIrImportFile(file) {
  if (!file) return;
  try {
    let parsedPairs = [];
    const isXlsx = /\.xlsx$/i.test(file.name || '');
    if (typeof parseImportRangePairsFromFile === 'function') {
      const payload = isXlsx ? await file.arrayBuffer() : await file.text();
      parsedPairs = (await parseImportRangePairsFromFile(payload, file.name || '')) || [];
    } else if (!isXlsx) {
      const text = await file.text();
      let inheritedTarget = '';
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split(/[\t,，;；]+/).map(s => s.trim());
        const dId = extractIrSheetIdFromText(parts[0] || '');
        const tId = extractIrSheetIdFromText(parts[1] || '');
        if (!inheritedTarget && tId) inheritedTarget = parts[1];
        if (!dId) continue;
        parsedPairs.push({
          donorInput: parts[0],
          targetInput: tId ? parts[1] : inheritedTarget,
          donorId: dId,
          targetId: tId || extractIrSheetIdFromText(inheritedTarget),
          status: parts[2] || ''
        });
      }
    } else {
      throw new Error('当前内核版本不支持直接解析 .xlsx，请另存为 CSV 后导入');
    }

    if (!parsedPairs.length) {
      toast('未在导入文件中识别到有效的 Google 表格链接或 ID（A列来源表，B列目标表）');
      return;
    }
    const added = appendIrBatchPairsToTable(parsedPairs);
    toast(`已从「${file.name}」导入 ${added} 条 A->B 跨表授权记录`);
  } catch (error) {
    toast(`导入文件失败：${error?.message || error}`);
  }
}

async function handleIrBatchAuthRun(retryPairs = null) {
  if (typeof executeBatchImportRangeAuth !== 'function') {
    toast('IMPORTRANGE 极速批量授权引擎尚未就绪');
    return;
  }

  const pairs = Array.isArray(retryPairs) ? retryPairs : collectIrBatchPairs();
  if (!pairs.length) {
    toast('请先在表格 A 列填入来源表链接/ID，并在 B 列（至少首行）填入目标汇总表链接/ID');
    return;
  }

  const autoPauseFormulas = Boolean($('ir-auto-pause-chk')?.checked);
  const uniqueTargetCount = new Set(pairs.map(p => p.targetId).filter(Boolean)).size;
  const runBtn = $('ir-batch-run-btn');
  if (runBtn) runBtn.disabled = true;
  state.irBatchRunning = true;

  const updateRowStatusCell = (rowIndex, statusText) => {
    if (typeof rowIndex !== 'number' || rowIndex < 0) return;
    while (state.irBatchRows.length <= rowIndex) {
      state.irBatchRows.push(['', '', '']);
    }
    state.irBatchRows[rowIndex][2] = statusText;
    if (state.irBatchSheet) {
      state.isUpdatingIrSheet = true;
      try {
        state.irBatchSheet.setValueFromCoords(2, rowIndex, statusText, true);
      } catch (_e) {
        // ignore if row index out of current sheet bounds
      } finally {
        state.isUpdatingIrSheet = false;
      }
    }
  };

  try {
    await runControllableBatchTask({
      title: Array.isArray(retryPairs)
        ? `重试 IMPORTRANGE 跨表授权 (${pairs.length} 行)`
        : `IMPORTRANGE 极速批量授权 (${pairs.length} 行 · ${uniqueTargetCount} 目标表)`,
      retryFn: failedItems => handleIrBatchAuthRun(failedItems),
      async runFn({ shouldStop, updateProgress }) {
        const res = await executeBatchImportRangeAuth({
          pairs,
          autoPauseFormulas,
          concurrency: 6,
          ensureDonorReader: true,
          shouldStop,
          onRowUpdate(rowIndex, info) {
            const txt = info?.statusText || (info?.ok ? '✅ 已授权(A->B)' : '❌ 授权失败');
            updateRowStatusCell(rowIndex, txt);
          },
          onProgress(p) {
            const msg = p?.message || `正在极速授权 ${p?.done ?? 0}/${p?.total ?? pairs.length}…`;
            if ($('progress')) $('progress').textContent = msg;
            updateProgress({
              done: p?.done ?? 0,
              total: p?.total ?? pairs.length,
              message: msg
            });
          }
        });

        state.logs = await getAuditLogs();
        renderLogsTab();

        const summaryEl = $('ir-summary-bar');
        const summaryDetail = `成功 ${res?.successCount || 0} 行 · 失败 ${res?.failedCount || 0} 行${
          res?.pausedTargetsCount ? ` · 已自动暂停并恢复 ${res.pausedTargetsCount} 张目标表公式` : ''
        }`;
        if (summaryEl) {
          summaryEl.classList.remove('hidden', 'ok', 'warning', 'danger');
          summaryEl.classList.add(res?.failedCount > 0 ? 'warning' : 'ok');
          summaryEl.innerHTML = `<span>IMPORTRANGE 批量授权${res?.stopped ? '已暂停' : '完成'}：${escapeHtml(summaryDetail)}</span>`;
        }
        if ($('progress')) $('progress').textContent = `IMPORTRANGE 批量授权：${summaryDetail}`;
        toast(`${res?.stopped ? '已暂停' : '完成'}：${summaryDetail}`);

        return {
          ...res,
          failCount: res?.failedCount || 0,
          failedItems: res?.failedPairs || [],
          summaryDetail
        };
      }
    });
  } catch (error) {
    toast(`IMPORTRANGE 批量授权失败：${error?.message || error}`);
  } finally {
    state.irBatchRunning = false;
    if (runBtn) runBtn.disabled = false;
  }
}

async function handleIrToggleFormulas(pause = true) {
  if (typeof toggleTargetSheetImportRangeFormulas !== 'function') {
    toast('公式暂停/恢复引擎尚未就绪');
    return;
  }
  const pairs = collectIrBatchPairs();
  const targetIdSet = new Set(pairs.map(p => p.targetId).filter(Boolean));
  const inputTargetId = extractIrSheetIdFromText($('ir-target-sheet-input')?.value || '');
  if (inputTargetId) targetIdSet.add(inputTargetId);

  const targetIds = [...targetIdSet];
  if (!targetIds.length) {
    toast('请先在表格 B 列或上方输入框中指定至少 1 个目标汇总表');
    return;
  }

  const btn = pause ? $('ir-pause-formulas-btn') : $('ir-resume-formulas-btn');
  if (btn) btn.disabled = true;
  const actionLabel = pause ? '暂停目标表 IMPORTRANGE 公式' : '恢复目标表 IMPORTRANGE 公式';
  if ($('progress')) $('progress').textContent = `正在对 ${targetIds.length} 张目标表执行「${actionLabel}」…`;

  try {
    let okCount = 0;
    let totalChanged = 0;
    let lastError = '';
    for (const tid of targetIds) {
      const r = await toggleTargetSheetImportRangeFormulas(tid, {
        pause,
        accountEmail: state.activeAccount !== 'all' ? state.activeAccount : ''
      });
      if (r?.ok) {
        okCount++;
        totalChanged += Number(r.formulasChanged || 0);
      } else {
        lastError = r?.error || r?.status || '调用失败';
      }
    }
    if (okCount === 0 && lastError) {
      toast(`${actionLabel}失败：${lastError}（若为老账号缺少 spreadsheets 权限，请重新授权一次即可）`);
    } else {
      toast(`${actionLabel}完成：成功处理 ${okCount}/${targetIds.length} 张目标表，共替换 ${totalChanged} 处公式`);
    }
  } catch (error) {
    toast(`${actionLabel}失败：${error?.message || error}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleIrExportCsv() {
  const rows = syncIrSheetToRows().filter(
    r => String(r[0] || '').trim() || String(r[1] || '').trim() || String(r[2] || '').trim()
  );
  if (!rows.length) {
    toast('当前跨表授权表格为空，无可导出记录');
    return;
  }
  const lines = [
    ['来源表(A列)', '目标汇总表(B列)', '授权状态(C列)'].map(escapeCsvCell).join(','),
    ...rows.map(r => [r[0] || '', r[1] || '', r[2] || ''].map(escapeCsvCell).join(','))
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `importrange-auth-results-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${rows.length} 条 IMPORTRANGE 授权结果 CSV`);
}

function handleIrClearTable() {
  state.irBatchRows = Array.from({ length: 30 }, () => ['', '', '']);
  state.importRangeReport = null;
  renderIrBatchSheet();
  renderImportRangeReport();
  toast('已清空 IMPORTRANGE 跨表授权表格');
}

/* ==================== 邮箱分组批量增删与底部悬浮坞「保存到分组」 ==================== */

async function handleGroupQuickAddEmails() {
  const grpName = ($('group-quick-add-select')?.value || '').trim();
  const role = ($('group-quick-add-role')?.value || '').trim();
  const rawEmails = ($('group-quick-add-emails')?.value || '').trim();
  if (!grpName) {
    toast('请先选择要加入的目标邮箱分组');
    $('group-quick-add-select')?.focus?.();
    return;
  }
  if (!rawEmails) {
    toast('请输入要批量加入的邮箱（每行或逗号分隔）');
    $('group-quick-add-emails')?.focus?.();
    return;
  }
  try {
    let addedCount = 0;
    let updatedCount = 0;
    if (typeof batchAddEmailsToGroup === 'function') {
      const res = await batchAddEmailsToGroup(grpName, rawEmails, role);
      state.directory = res?.directory || (await getDirectory());
      addedCount = res?.addedCount || 0;
      updatedCount = res?.updatedCount || 0;
    } else {
      const emails = extractEmailsFromText(rawEmails);
      if (!emails.length) {
        toast('未识别到有效邮箱地址');
        return;
      }
      const contacts = [...(state.directory.contacts || [])];
      for (const em of emails) {
        const exist = contacts.find(c => normalizeEntry(c.email) === em);
        if (exist) {
          exist.groups = [...new Set([...(exist.groups || []), grpName])];
          if (role) {
            exist.groupRoles = exist.groupRoles && typeof exist.groupRoles === 'object' ? { ...exist.groupRoles } : {};
            exist.groupRoles[grpName] = role;
          }
          updatedCount++;
        } else {
          contacts.push({
            email: em,
            name: '',
            groups: [grpName],
            groupRoles: role ? { [grpName]: role } : {}
          });
          addedCount++;
        }
      }
      state.directory = await saveDirectory({ groups: state.directory.groups, contacts });
    }
    state.policy = await getPolicy();
    if ($('group-quick-add-emails')) $('group-quick-add-emails').value = '';
    renderAll();
    toast(`已向分组「${grpName}」批量加入：新增 ${addedCount} 人 · 更新 ${updatedCount} 人`);
  } catch (error) {
    toast(`批量加入分组失败：${error?.message || error}`);
  }
}

async function handleGroupBatchRemoveEmails() {
  const rawEmails = ($('group-batch-remove-emails')?.value || '').trim();
  if (!rawEmails) {
    toast('请输入要从全部分组中批量删除的邮箱');
    $('group-batch-remove-emails')?.focus?.();
    return;
  }
  const emails = extractEmailsFromText(rawEmails);
  if (!emails.length) {
    toast('未识别到有效邮箱地址');
    return;
  }
  if (
    !confirm(
      `确认将这 ${emails.length} 个邮箱从全部邮箱分组及对应白名单中彻底移除？\n（仅清理本地分组与白名单配置，不影响 Drive 现有文件权限）`
    )
  ) {
    return;
  }
  try {
    let removedCount = 0;
    let affectedGroups = [];
    if (typeof batchRemoveEmailsFromAllGroups === 'function') {
      const res = await batchRemoveEmailsFromAllGroups(rawEmails);
      state.directory = res?.directory || (await getDirectory());
      removedCount = res?.removedCount || 0;
      affectedGroups = res?.affectedGroups || [];
    } else {
      const targetSet = new Set(emails);
      const grpHitSet = new Set();
      const keptContacts = [];
      for (const c of state.directory.contacts || []) {
        const em = normalizeEntry(c.email);
        if (targetSet.has(em)) {
          removedCount++;
          for (const g of c.groups || []) grpHitSet.add(g);
        } else {
          keptContacts.push(c);
        }
      }
      affectedGroups = [...grpHitSet];
      state.directory = await saveDirectory({ groups: state.directory.groups, contacts: keptContacts });
      await syncPolicyAndSchedule({
        writers: (state.policy.writers || []).filter(w => !targetSet.has(normalizeEntry(w))),
        readers: (state.policy.readers || []).filter(r => !targetSet.has(normalizeEntry(r)))
      });
    }
    state.policy = await getPolicy();
    if ($('group-batch-remove-emails')) $('group-batch-remove-emails').value = '';
    renderAll();
    toast(
      `已跨全部分组批量删除 ${removedCount} 个邮箱${affectedGroups.length ? `（涉及：${affectedGroups.join('、')}）` : ''}`
    );
  } catch (error) {
    toast(`批量删除邮箱失败：${error?.message || error}`);
  }
}

async function handleBatchSaveSelectedToGroup() {
  const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!selected.length) {
    toast('请先勾选要保存到分组的文件或文件夹');
    return;
  }

  const selVal = ($('batch-save-group-select')?.value || '').trim();
  const newName = ($('batch-save-group-new-name')?.value || '').trim();
  const defaultRole = $('batch-save-group-new-role')?.value || 'reader';
  const alsoAsBundle = Boolean($('batch-save-group-as-bundle-chk')?.checked);
  const groupName = selVal && selVal !== '__new__' ? selVal : newName;

  if (!groupName) {
    toast('请选择一个现有分组，或输入新分组名称');
    $('batch-save-group-new-name')?.focus?.();
    return;
  }

  try {
    let addedCount = 0;
    let totalAssets = 0;
    if (typeof bindAssetsToGroup === 'function') {
      const res = await bindAssetsToGroup(groupName, selected, {
        createIfMissing: true,
        defaultRole
      });
      state.directory = res?.directory || (await getDirectory());
      addedCount = res?.addedCount ?? selected.length;
      totalAssets = res?.totalAssets ?? selected.length;
    } else {
      const groups = [...(state.directory.groups || [])];
      let grp = groups.find(g => g.name === groupName);
      if (!grp) {
        grp = {
          name: groupName,
          defaultRole,
          policyTier: defaultRole === 'writer' ? 'writer' : 'reader',
          assets: []
        };
        groups.push(grp);
      }
      const map = new Map((grp.assets || []).map(a => [a.fileId, a]));
      const beforeSize = map.size;
      for (const f of selected) {
        map.set(f.id, {
          fileId: f.id,
          fileName: f.name || f.id,
          mimeType: f.mimeType || '',
          webViewLink: formatDriveCanonicalLink(f)
        });
      }
      grp.assets = [...map.values()];
      addedCount = grp.assets.length - beforeSize;
      totalAssets = grp.assets.length;
      state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    }

    if (alsoAsBundle) {
      const nextBundles = [...(state.roleBundles || [])];
      const bIdx = nextBundles.findIndex(b => b.name === groupName);
      const bundleItems = selected.map(f => ({
        fileId: f.id,
        fileName: f.name || f.id,
        mimeType: f.mimeType || '',
        webViewLink: formatDriveCanonicalLink(f),
        role: defaultRole
      }));
      const bundleObj = {
        id: bIdx >= 0 ? nextBundles[bIdx].id : `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: groupName,
        description: `由分组「${groupName}」同步生成的岗位权限包`,
        items: bundleItems,
        updatedAt: new Date().toISOString()
      };
      if (bIdx >= 0) nextBundles[bIdx] = bundleObj;
      else nextBundles.unshift(bundleObj);
      if (typeof saveRoleBundles === 'function') {
        state.roleBundles = await saveRoleBundles(nextBundles);
      } else {
        state.roleBundles = nextBundles;
      }
    }

    state.policy = await getPolicy();
    if ($('batch-save-group-new-name')) $('batch-save-group-new-name').value = '';
    closeBatchActionModal();
    renderAll();
    toast(
      `已将 ${selected.length} 项资产绑定至分组「${groupName}」（新增 ${addedCount} · 共绑定 ${totalAssets} 项）${
        alsoAsBundle ? '，并同步生成岗位权限包' : ''
      }`
    );
  } catch (error) {
    toast(`保存到分组失败：${error?.message || error}`);
  }
}

async function handleGrantImportRangeSources(sourceIds = []) {
  const report = state.importRangeReport;
  if (!report || !sourceIds.length) return;
  const targetOwnerEmail =
    report.target?.ownerEmail || report.target?.owners?.[0]?.emailAddress || '';
  if (!targetOwnerEmail) {
    toast('未能识别目标汇总表所有者邮箱，无法自动补齐源表只读权限');
    return;
  }
  if (typeof grantImportRangeSourceAccess !== 'function') {
    toast('源表只读权限放行引擎尚未就绪');
    return;
  }

  const fixAllBtn = $('ir-fix-all-source-perms-btn');
  if (fixAllBtn) fixAllBtn.disabled = true;
  $('progress').textContent = `正在为 ${targetOwnerEmail} 补齐 ${sourceIds.length} 张上游源表的只读权限…`;

  try {
    const res = await grantImportRangeSourceAccess({
      targetOwnerEmail,
      sourceIds,
      onProgress(p) {
        if (p?.message) $('progress').textContent = p.message;
      }
    });
    const grantedSet = new Set(
      (res.grantedIds || sourceIds).filter(
        id =>
          !(res.failedItems || []).some(
            fi => fi.sourceSpreadsheetId === id || fi.sourceId === id || fi.fileId === id
          )
      )
    );
    for (const dep of report.dependencies || []) {
      const sid = dep.sourceSpreadsheetId || dep.sourceId;
      if (grantedSet.has(sid)) {
        dep.targetOwnerHasAccess = true;
        const hasRefErr = (dep.cells || []).some(c => c.isRefError);
        dep.status = hasRefErr ? 'needs_allow_click' : 'accessible_or_public';
      }
    }
    state.logs = await getAuditLogs();
    renderImportRangeReport();
    renderLogsTab();
    toast(
      `源表放行完成：成功补齐 ${res.grantedCount || 0} 张（跳过 ${res.skippedCount || 0} · 失败 ${res.failedCount || 0}）。若目标表首次跨表引用，请点击右侧「定位 ↗」在表格内点一次「允许访问」。`
    );
  } catch (error) {
    toast(`补齐源表权限失败：${error?.message || error}`);
    renderImportRangeReport();
  }
}

/* ==================== 岗位权限包（Role Bundles）管理、入职与转岗 ==================== */

function parseBundleAssetsFallback(rawText = '', existingFiles = []) {
  const byId = new Map((existingFiles || []).map(f => [f.id, f]));
  const out = [];
  const seen = new Set();
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [mainPart, commentPart] = line.split('#');
    const parts = mainPart.split(/[\t,，|]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const ids = parseDriveLinksInput(parts[0]);
    const fid = ids[0] || (parts[0].length >= 10 && !parts[0].includes(' ') ? parts[0] : '');
    if (!fid || seen.has(fid)) continue;
    seen.add(fid);
    const roleRaw = parts[1] || 'reader';
    const role =
      typeof normalizePermissionRole === 'function'
        ? normalizePermissionRole(roleRaw, 'reader')
        : roleRaw === 'writer' || roleRaw === 'commenter'
        ? roleRaw
        : 'reader';
    const matched = byId.get(fid);
    out.push({
      fileId: fid,
      fileName: matched?.name || (commentPart || '').trim() || fid,
      mimeType: matched?.mimeType || '',
      webViewLink: matched ? formatDriveCanonicalLink(matched) : `https://drive.google.com/open?id=${fid}`,
      role
    });
  }
  return out;
}

function renderRoleBundlesSection() {
  const bundles = state.roleBundles || [];
  const listNode = $('bundles-list');
  if (listNode) {
    if (!bundles.length) {
      listNode.innerHTML =
        '<div class="muted">暂无岗位权限包，可在上方新建或在「云盘资产巡检」勾选资产后点击底部「存为岗位包」。</div>';
    } else {
      listNode.innerHTML = bundles
        .map(b => {
          const items = Array.isArray(b.items) ? b.items : [];
          const wCnt = items.filter(i => i.role === 'writer').length;
          const cCnt = items.filter(i => i.role === 'commenter').length;
          const rCnt = items.length - wCnt - cCnt;
          return `<div class="bundle-card group-card-row">
            <div class="group-card-info">
              <strong class="group-card-name">${escapeHtml(b.name || '未命名岗位包')}</strong>
              <span class="group-card-count badge">${items.length} 项资产</span>
              <span class="muted">${escapeHtml(b.description || `编辑 ${wCnt} · 评论 ${cCnt} · 查看 ${rCnt}`)}</span>
            </div>
            <div class="group-card-actions row-flex">
              <button type="button" class="btn btn-xs" data-action="bundle-pick-onboard" data-bundle-id="${escapeHtml(b.id)}">入职选用</button>
              <button type="button" class="btn btn-xs" data-action="bundle-edit" data-bundle-id="${escapeHtml(b.id)}">编辑</button>
              <button type="button" class="btn-text btn-text-danger" data-action="bundle-delete" data-bundle-id="${escapeHtml(b.id)}">删除</button>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  const fillSelect = (selId, placeholder) => {
    const sel = $(selId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = [
      `<option value="">${placeholder}</option>`,
      ...bundles.map(
        b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)} (${(b.items || []).length} 项)</option>`
      )
    ].join('');
    if ([...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
    }
  };

  fillSelect('bundle-onboard-select', '请选择岗位权限包…');
  fillSelect('bundle-transfer-from', '选择原岗位包…');
  fillSelect('bundle-transfer-to', '选择新岗位包…');
}

async function handleSaveRoleBundle() {
  const name = ($('bundle-name-input')?.value || '').trim();
  const description = ($('bundle-desc-input')?.value || '').trim();
  const rawAssets = ($('bundle-assets-textarea')?.value || '').trim();
  if (!name) {
    toast('请输入岗位权限包名称');
    $('bundle-name-input')?.focus?.();
    return;
  }
  const items =
    typeof parseRoleBundleAssetsInput === 'function'
      ? parseRoleBundleAssetsInput(rawAssets, state.files, 'reader')
      : parseBundleAssetsFallback(rawAssets, state.files);
  if (!items.length) {
    toast('请至少填入 1 个有效的 Google Drive 文件或文件夹链接 / ID');
    $('bundle-assets-textarea')?.focus?.();
    return;
  }

  const nextBundles = [...(state.roleBundles || [])];
  const existingIdx = state.editingBundleId
    ? nextBundles.findIndex(b => b.id === state.editingBundleId)
    : nextBundles.findIndex(b => b.name === name);
  const bundleObj = {
    id: existingIdx >= 0 ? nextBundles[existingIdx].id : `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    description,
    items,
    updatedAt: new Date().toISOString()
  };
  if (existingIdx >= 0) nextBundles[existingIdx] = bundleObj;
  else nextBundles.unshift(bundleObj);

  if (typeof saveRoleBundles === 'function') {
    state.roleBundles = await saveRoleBundles(nextBundles);
  } else {
    state.roleBundles = nextBundles;
  }
  state.editingBundleId = '';
  if ($('bundle-name-input')) $('bundle-name-input').value = '';
  if ($('bundle-desc-input')) $('bundle-desc-input').value = '';
  if ($('bundle-assets-textarea')) $('bundle-assets-textarea').value = '';
  renderAll();
  toast(`已保存岗位权限包「${name}」（包含 ${items.length} 项资产）`);
}

function handleSaveSelectedToBundle() {
  const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
  if (!selected.length) {
    toast('请先勾选要纳入岗位包的文件或文件夹');
    return;
  }
  const lines = selected.map(f => `${formatDriveCanonicalLink(f) || f.id}, reader, ${f.name || f.id}`);
  state.editingBundleId = '';
  if ($('bundle-assets-textarea')) {
    $('bundle-assets-textarea').value = lines.join('\n');
  }
  switchMainNav('groups');
  setGroupsSubTab('bundles');
  $('bundle-name-input')?.focus?.();
  toast(`已带入所选 ${selected.length} 项资产到岗位包表单，请填写岗位包名称并保存`);
}

async function handleBundleOnboardRun() {
  const bundleId = $('bundle-onboard-select')?.value || '';
  const bundle = (state.roleBundles || []).find(b => b.id === bundleId);
  if (!bundle) {
    toast('请先选择目标岗位权限包');
    return;
  }
  const emails = extractEmailsFromText($('bundle-onboard-emails')?.value || '');
  if (!emails.length) {
    toast('请输入至少 1 个入职人员邮箱');
    $('bundle-onboard-emails')?.focus?.();
    return;
  }

  let ttlSel = { preset: 'none', expiresAt: '', label: '长期有效' };
  try {
    ttlSel = resolveTtlSelection('bundle-onboard-ttl', 'bundle-onboard-ttl-custom');
  } catch (ttlError) {
    toast(ttlError.message);
    return;
  }

  const items = bundle.items || [];
  const confirmed = await confirmWithDryRunModal({
    title: `一键入职赋权预演：${bundle.name}`,
    summaryHtml: `即将为 <strong>${emails.length}</strong> 名入职人员按岗位包「<strong>${escapeHtml(bundle.name)}</strong>」一次性开通 <strong>${items.length}</strong> 项资产权限${ttlSel.expiresAt ? `（${escapeHtml(ttlSel.label)}，到期自动回收）` : ''}。`,
    previewItems: items.map(it => ({
      title: it.fileName || it.fileId,
      detail: `向 ${emails.join('、')} 授予 ${roleLabel(it.role || 'reader')}`
    })),
    confirmText: `确认入职赋权 (${items.length * emails.length} 项)`,
    isDanger: false,
    fallbackText: `确认按岗位包「${bundle.name}」为 ${emails.length} 人开通 ${items.length} 项权限？`
  });
  if (!confirmed) return;

  try {
    await runControllableBatchTask({
      title: `岗位入职赋权：${bundle.name}`,
      retryFn: null,
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          res = await executeRoleBundleOnboarding({
            bundle,
            emails,
            expiresAt: ttlSel.expiresAt,
            expireAction: 'revoke',
            shouldStop,
            onProgress(p) {
              updateProgress({ done: p?.done ?? 0, total: p?.total ?? items.length * emails.length, message: p?.message || '' });
            }
          });
          const snap = await getSnapshot();
          if (Array.isArray(snap?.files) && snap.files.length) applySnapshotToState(snap);
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }
        state.logs = await getAuditLogs();
        await refreshTtlQueueState();
        if (ttlSel.expiresAt && !(res?.failedCount > 0)) {
          resetTtlControls('bundle-onboard-ttl', 'bundle-onboard-ttl-custom');
        }
        if ($('bundle-onboard-emails') && !(res?.failedCount > 0)) $('bundle-onboard-emails').value = '';
        renderAll();
        const okCnt = res?.grantedCount ?? res?.changedCount ?? 0;
        const failCnt = res?.failedCount ?? 0;
        const summaryDetail = `成功开通 ${okCnt} 项 · 失败 ${failCnt} 项`;
        toast(`岗位入职赋权完成：${summaryDetail}`);
        return { ...res, failCount: failCnt, summaryDetail };
      }
    });
  } catch (error) {
    toast(`岗位入职赋权失败：${error?.message || error}`);
  }
}

async function handleBundleTransferRun() {
  const fromId = $('bundle-transfer-from')?.value || '';
  const toId = $('bundle-transfer-to')?.value || '';
  const fromBundle = (state.roleBundles || []).find(b => b.id === fromId);
  const toBundle = (state.roleBundles || []).find(b => b.id === toId);
  if (!fromBundle || !toBundle) {
    toast('请同时选择原岗位权限包与新岗位权限包');
    return;
  }
  if (fromBundle.id === toBundle.id) {
    toast('原岗位包与新岗位包相同，无需转岗切换');
    return;
  }
  const emails = extractEmailsFromText($('bundle-transfer-emails')?.value || '');
  if (!emails.length) {
    toast('请输入至少 1 个转岗人员邮箱');
    $('bundle-transfer-emails')?.focus?.();
    return;
  }

  const fromMap = new Map((fromBundle.items || []).map(i => [i.fileId, i]));
  const toMap = new Map((toBundle.items || []).map(i => [i.fileId, i]));
  const previewItems = [];
  for (const [fid, item] of fromMap) {
    if (!toMap.has(fid)) {
      previewItems.push({ title: item.fileName || fid, detail: `收回原岗位独有资产权限 (${roleLabel(item.role)})` });
    } else if (toMap.get(fid).role !== item.role) {
      previewItems.push({
        title: item.fileName || fid,
        detail: `调整重叠资产角色：${roleLabel(item.role)} → ${roleLabel(toMap.get(fid).role)}`
      });
    }
  }
  for (const [fid, item] of toMap) {
    if (!fromMap.has(fid)) {
      previewItems.push({ title: item.fileName || fid, detail: `开通新岗位新增资产权限 (${roleLabel(item.role)})` });
    }
  }

  const confirmed = await confirmWithDryRunModal({
    title: `一键转岗权限差集预演：${fromBundle.name} → ${toBundle.name}`,
    summaryHtml: `即将为 <strong>${emails.length}</strong> 名人员从「<strong>${escapeHtml(fromBundle.name)}</strong>」切换至「<strong>${escapeHtml(toBundle.name)}</strong>」（共涉及 <strong>${previewItems.length}</strong> 项差集变更）。`,
    previewItems,
    confirmText: `确认转岗切换`,
    isDanger: true,
    fallbackText: `确认将 ${emails.join(', ')} 从「${fromBundle.name}」切换至「${toBundle.name}」？`
  });
  if (!confirmed) return;

  try {
    await runControllableBatchTask({
      title: `转岗切换：${fromBundle.name} → ${toBundle.name}`,
      retryFn: null,
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          res = await executeRoleBundleTransfer({
            fromBundle,
            toBundle,
            emails,
            shouldStop,
            onProgress(p) {
              updateProgress({ done: p?.done ?? 0, total: p?.total ?? Math.max(1, previewItems.length * emails.length), message: p?.message || '' });
            }
          });
          const snap = await getSnapshot();
          if (Array.isArray(snap?.files) && snap.files.length) applySnapshotToState(snap);
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }
        state.logs = await getAuditLogs();
        if ($('bundle-transfer-emails') && !(res?.failedCount > 0)) $('bundle-transfer-emails').value = '';
        renderAll();
        const summaryDetail = `收回 ${res?.revokedCount || 0} · 调整 ${res?.updatedCount || 0} · 开通 ${res?.grantedCount || 0} · 失败 ${res?.failedCount || 0}`;
        toast(`转岗权限切换完成：${summaryDetail}`);
        return { ...res, failCount: res?.failedCount || 0, summaryDetail };
      }
    });
  } catch (error) {
    toast(`转岗权限切换失败：${error?.message || error}`);
  }
}

/* ==================== 外部合作方生命周期档案（Partner Profiles） ==================== */

function parsePartnerTargetsInput(rawText = '') {
  const domains = new Set();
  const emails = new Set();
  for (const token of String(rawText || '').split(/[\s,，;；\r\n]+/)) {
    const clean = token.trim().toLowerCase();
    if (!clean) continue;
    if (clean.includes('@') && !clean.startsWith('@')) {
      emails.add(clean);
    } else {
      const dom = clean.replace(/^@+/, '');
      if (dom.includes('.')) domains.add(dom);
    }
  }
  return { domains: [...domains], emails: [...emails] };
}

function renderPartnerProfilesSection() {
  const listNode = $('partners-list');
  if (!listNode) return;
  const profiles = state.partnerProfiles || [];
  if (!profiles.length) {
    listNode.innerHTML = '<div class="muted">暂无外部合作方档案，可在上方登记外包商或客户域名与合作到期日。</div>';
    return;
  }

  const scoped = getScopedFilesByAccount();
  listNode.innerHTML = profiles
    .map(partner => {
      let matchInfo = { files: [], matchedEmails: [], daysRemaining: null, isExpired: false, isExpiringSoon: false };
      if (typeof matchFilesForPartner === 'function') {
        matchInfo = matchFilesForPartner(scoped, partner, Date.now()) || matchInfo;
      }
      let expiryPill = '<span class="badge">长期合作</span>';
      if (partner.expiresAt) {
        if (matchInfo.isExpired) {
          expiryPill = `<span class="status-pill danger">已到期 (${escapeHtml(partner.expiresAt.slice(0, 10))})</span>`;
        } else if (matchInfo.isExpiringSoon) {
          expiryPill = `<span class="status-pill warning">剩余 ${matchInfo.daysRemaining ?? 0} 天到期</span>`;
        } else {
          expiryPill = `<span class="status-pill info">到期：${escapeHtml(partner.expiresAt.slice(0, 10))}</span>`;
        }
      }
      const targetDesc = [
        ...(partner.domains || []).map(d => `@${d}`),
        ...(partner.emails || [])
      ].join(', ');
      const fileCount = matchInfo.files?.length || 0;
      const emailCount = matchInfo.matchedEmails?.length || 0;

      return `<div class="partner-card group-card-row">
        <div class="group-card-info">
          <div class="row-flex wrap-flex">
            <strong class="group-card-name">${escapeHtml(partner.name || '未命名合作方')}</strong>
            ${expiryPill}
            <span class="group-card-count badge">涉及 ${fileCount} 文件 · ${emailCount} 邮箱</span>
          </div>
          <div class="muted">${escapeHtml(targetDesc || '未配置域名或邮箱')}</div>
        </div>
        <div class="group-card-actions row-flex">
          <button type="button" class="btn btn-xs" data-action="partner-filter-files" data-partner-id="${escapeHtml(partner.id)}">筛关联文件</button>
          <button type="button" class="btn danger btn-xs" data-action="partner-offboard-all" data-partner-id="${escapeHtml(partner.id)}">一键整包清退</button>
          <button type="button" class="btn-text btn-text-danger" data-action="partner-delete" data-partner-id="${escapeHtml(partner.id)}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

async function handleSavePartnerProfile() {
  const name = ($('partner-name-input')?.value || '').trim();
  const rawTargets = ($('partner-domains-input')?.value || '').trim();
  const expiryDate = ($('partner-expiry-input')?.value || '').trim();
  if (!name) {
    toast('请输入外部合作方名称');
    $('partner-name-input')?.focus?.();
    return;
  }
  const { domains, emails } = parsePartnerTargetsInput(rawTargets);
  if (!domains.length && !emails.length) {
    toast('请至少输入 1 个关联域名（如 @agency.com）或外部邮箱');
    $('partner-domains-input')?.focus?.();
    return;
  }

  const nextProfiles = [...(state.partnerProfiles || [])];
  const existingIdx = nextProfiles.findIndex(p => p.name === name);
  const profileObj = {
    id: existingIdx >= 0 ? nextProfiles[existingIdx].id : `partner_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    domains,
    emails,
    expiresAt: expiryDate ? `${expiryDate}T23:59:59.000Z` : '',
    note: '',
    updatedAt: new Date().toISOString()
  };
  if (existingIdx >= 0) nextProfiles[existingIdx] = profileObj;
  else nextProfiles.unshift(profileObj);

  if (typeof savePartnerProfiles === 'function') {
    state.partnerProfiles = await savePartnerProfiles(nextProfiles);
  } else {
    state.partnerProfiles = nextProfiles;
  }
  if ($('partner-name-input')) $('partner-name-input').value = '';
  if ($('partner-domains-input')) $('partner-domains-input').value = '';
  if ($('partner-expiry-input')) $('partner-expiry-input').value = '';
  renderAll();
  toast(`已保存合作方档案「${name}」`);
}

/* ==================== v1.2.0 排除扫描目录、断点续检状态与第三方关联应用守卫 ==================== */

function openExternalPageSafe(url) {
  const safe = sanitizeExternalUrl(url);
  if (!safe || safe === '#') return;
  try {
    if (typeof chrome !== 'undefined' && typeof chrome.tabs?.create === 'function') {
      chrome.tabs.create({ url: safe });
      return;
    }
  } catch (_e) {}
  window.open?.(safe, '_blank', 'noopener,noreferrer');
}

async function handleClosePublicLinksQuick() {
  const targets = getStickyPublicLinkTargets();
  if (!targets.length) {
    toast(
      state.selectedFileIds.size > 0
        ? '所选未排除资产中没有可关闭的直接公开/域内链接'
        : '当前未排除自有文件中没有公开或域内共享链接'
    );
    return;
  }
  await handleBatchQuickAction('remove_public', null, targets);
}

function renderExcludedFoldersView() {
  const excludedList = Array.isArray(state.policy?.excludedFolders) ? state.policy.excludedFolders : [];
  const excludedSet = new Set(excludedList.map(x => String(x?.id || '').trim()).filter(Boolean));

  if ($('excluded-folders-count')) {
    $('excluded-folders-count').textContent = String(excludedList.length);
  }
  if ($('nav-count-excluded')) {
    $('nav-count-excluded').textContent = String(excludedList.length);
  }

  const pickerList = $('excluded-folder-picker-list');
  if (pickerList) {
    const q = ($('excluded-folder-search')?.value || '').trim().toLowerCase();
    const scopedAll = getAccountFilesIncludingExcluded();
    const source = scopedAll.length ? scopedAll : state.files;
    const folders = source.filter(f => {
      if (!f || f.mimeType !== 'application/vnd.google-apps.folder') return false;
      if (!q) return true;
      return (f.name || '').toLowerCase().includes(q) || (f.id || '').toLowerCase().includes(q);
    });

    if (!folders.length) {
      pickerList.innerHTML = `<div class="muted">${
        source.length ? '未找到匹配的已扫描文件夹' : '尚未扫描云盘文件夹，也可在下方直接粘贴文件夹链接/ID 添加'
      }</div>`;
    } else {
      pickerList.innerHTML = folders
        .slice(0, 80)
        .map(f => {
          const already = excludedSet.has(f.id);
          const checked = !already && state.pickedExcludedFolderIds.has(f.id) ? 'checked' : '';
          return `<label class="picker-item">
            <input type="checkbox" data-action="excluded-pick-folder" data-folder-id="${escapeHtml(f.id)}" ${checked} ${already ? 'disabled' : ''}>
            <span class="badge">文件夹</span>
            <span class="picker-item-name">${escapeHtml(f.name || f.id)}</span>
            ${already ? '<span class="status-pill ok">已排除</span>' : ''}
          </label>`;
        })
        .join('');
    }
  }

  const listNode = $('excluded-folders-list');
  if (!listNode) return;
  if (!excludedList.length) {
    listNode.innerHTML =
      '<div class="muted">暂无排除目录。若存在面向官网或客户的公开资料文件夹，可从左侧勾选或粘贴链接加入排除清单，扫描与一键关链将自动跳过。</div>';
    return;
  }

  listNode.innerHTML = excludedList
    .map(item => {
      const fid = String(item?.id || '').trim();
      const name = item?.name || `文件夹 (${fid.slice(0, 8)}…)`;
      const link = item?.webViewLink || `https://drive.google.com/drive/folders/${encodeURIComponent(fid)}`;
      const recursiveBadge =
        item?.includeSubitems !== false
          ? '<span class="badge">含全部子文件/子目录</span>'
          : '<span class="badge">仅此目录</span>';
      const noteText = item?.note ? `备注：${item.note}` : `ID：${fid}`;
      return `<div class="excluded-folder-card group-card-row">
        <div class="group-card-info">
          <div class="row-flex wrap-flex">
            <strong class="group-card-name">${escapeHtml(name)}</strong>
            ${recursiveBadge}
          </div>
          <div class="excluded-folder-meta muted">${escapeHtml(noteText)}${
            item?.addedAt ? ` · 添加于 ${escapeHtml(formatTime(item.addedAt))}` : ''
          }</div>
        </div>
        <div class="group-card-actions row-flex">
          <a href="${escapeHtml(sanitizeExternalUrl(link))}" target="_blank" rel="noopener noreferrer" class="btn btn-xs">打开 ↗</a>
          <button type="button" class="btn-text btn-text-danger" data-action="remove-excluded-folder" data-folder-id="${escapeHtml(fid)}">移出</button>
        </div>
      </div>`;
    })
    .join('');
}

async function addExcludedFolderEntriesCompat(entries = []) {
  if (!entries.length) return;
  if (typeof addExcludedFolders === 'function') {
    state.policy = await addExcludedFolders(entries);
    try {
      await chrome.runtime.sendMessage({ type: 'SYNC_SCHEDULE' });
    } catch (_e) {}
  } else {
    const existing = Array.isArray(state.policy?.excludedFolders) ? [...state.policy.excludedFolders] : [];
    const byId = new Map(existing.map(x => [x.id, x]));
    const now = new Date().toISOString();
    for (const item of entries) {
      if (!item?.id) continue;
      byId.set(item.id, {
        id: item.id,
        name: item.name || item.id,
        webViewLink: item.webViewLink || `https://drive.google.com/drive/folders/${encodeURIComponent(item.id)}`,
        includeSubitems: item.includeSubitems !== false,
        note: item.note || '',
        addedAt: byId.get(item.id)?.addedAt || now
      });
    }
    await syncPolicyAndSchedule({ excludedFolders: [...byId.values()] });
  }
  pruneExcludedSelectionAndInspector();
}

async function handleExcludedAddPicked() {
  const chosen = state.files.filter(f => state.pickedExcludedFolderIds.has(f.id));
  if (!chosen.length) {
    toast('请先在左侧已扫描文件夹列表中勾选至少 1 个文件夹');
    return;
  }
  const entries = chosen.map(f => ({
    id: f.id,
    name: f.name || f.id,
    webViewLink: formatDriveCanonicalLink(f) || `https://drive.google.com/drive/folders/${encodeURIComponent(f.id)}`,
    includeSubitems: true,
    note: ''
  }));
  try {
    await addExcludedFolderEntriesCompat(entries);
    state.pickedExcludedFolderIds.clear();
    renderAll();
    toast(`已将 ${entries.length} 个文件夹加入排除目录，扫描与自动关链将自动跳过`);
  } catch (error) {
    toast(`添加排除目录失败：${error?.message || error}`);
  }
}

async function handleExcludedAddUrl() {
  const rawUrl = ($('excluded-folder-url-input')?.value || '').trim();
  const note = ($('excluded-folder-note-input')?.value || '').trim();
  const includeSubitems = Boolean($('excluded-folder-recursive-chk')?.checked ?? true);
  if (!rawUrl) {
    toast('请粘贴至少 1 个要排除的 Google Drive 文件夹链接或 ID');
    $('excluded-folder-url-input')?.focus?.();
    return;
  }
  const ids = parseDriveLinksInput(rawUrl);
  if (!ids.length) {
    const singleId = extractIrSheetIdFromText(rawUrl);
    if (singleId) ids.push(singleId);
  }
  if (!ids.length) {
    toast('未识别到有效的 Google Drive 文件夹链接或 ID');
    return;
  }
  const fileMap = new Map(state.files.map(f => [f.id, f]));
  const entries = ids.map(fid => {
    const local = fileMap.get(fid);
    return {
      id: fid,
      name: local?.name || note || `排除文件夹 (${fid.slice(0, 8)}…)`,
      webViewLink: local ? formatDriveCanonicalLink(local) : `https://drive.google.com/drive/folders/${encodeURIComponent(fid)}`,
      includeSubitems,
      note
    };
  });
  try {
    await addExcludedFolderEntriesCompat(entries);
    if ($('excluded-folder-url-input')) $('excluded-folder-url-input').value = '';
    if ($('excluded-folder-note-input')) $('excluded-folder-note-input').value = '';
    renderAll();
    toast(`已添加 ${entries.length} 个排除目录`);
  } catch (error) {
    toast(`添加排除目录失败：${error?.message || error}`);
  }
}

async function handleRemoveExcludedFolder(folderId) {
  if (!folderId) return;
  try {
    if (typeof removeExcludedFolder === 'function') {
      state.policy = await removeExcludedFolder(folderId);
    } else {
      const next = (state.policy?.excludedFolders || []).filter(x => x.id !== folderId);
      await syncPolicyAndSchedule({ excludedFolders: next });
    }
    renderAll();
    toast('已将该文件夹移出排除目录');
  } catch (error) {
    toast(`移出排除目录失败：${error?.message || error}`);
  }
}

async function refreshAutoPatrolCheckpointState() {
  if (typeof getAutoScanCheckpoint === 'function') {
    try {
      state.autoScanCheckpoint = await getAutoScanCheckpoint();
    } catch (_e) {}
  }
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_AUTO_PATROL_STATUS' });
      if (resp?.checkpoint) {
        state.autoScanCheckpoint = resp.checkpoint;
      }
      if (resp?.nextRunAt && state.autoScanCheckpoint) {
        state.autoScanCheckpoint = { ...state.autoScanCheckpoint, nextRunAt: resp.nextRunAt };
      }
    } catch (_e) {}
  }
  return state.autoScanCheckpoint;
}

function renderAutoPatrolCheckpointInfo() {
  const el = $('auto-patrol-checkpoint-info');
  if (!el) return;
  const cp = state.autoScanCheckpoint;
  const mins = Number(state.policy?.scheduleMinutes || 720) || 720;
  const cycleText = mins >= 60 && mins % 60 === 0 ? `${mins / 60} 小时` : `${mins} 分钟`;

  if (!state.policy?.scheduleEnabled) {
    el.textContent = '定期巡检已暂停，开启后默认每 12 小时自动守护并支持浏览器启动断点续检。';
    return;
  }
  if (cp && (cp.status === 'running' || cp.status === 'interrupted')) {
    const doneCnt = Array.isArray(cp.completedAccountEmails) ? cp.completedAccountEmails.length : 0;
    const totalCnt = Number(cp.totalAccounts || state.accounts.length || 0);
    el.textContent = `断点状态：上次自动巡检未完成（已完成 ${doneCnt}/${totalCnt} 个账号），下次启动或到点将自动断点续检。`;
    return;
  }
  if (cp?.lastSuccessAt) {
    const lastTs = Date.parse(cp.lastSuccessAt);
    let nextText = '待调度';
    if (cp.nextRunAt && Number.isFinite(Date.parse(cp.nextRunAt))) {
      nextText = formatTime(cp.nextRunAt);
    } else if (Number.isFinite(lastTs)) {
      nextText = formatTime(new Date(lastTs + mins * 60000).toISOString());
    }
    el.textContent = `上次巡检完成：${formatTime(cp.lastSuccessAt)} · 预计下次巡检：${nextText}（周期：每 ${cycleText}）`;
    return;
  }
  el.textContent = `定期守护已启用（每 ${cycleText}），尚未完成首次自动巡检；重启浏览器若未满周期将智能跳过，不重复扫描。`;
}

async function refreshThirdPartyAppAlertsState() {
  if (typeof getThirdPartyAppAlerts === 'function') {
    try {
      const list = await getThirdPartyAppAlerts();
      state.thirdPartyAppAlerts = Array.isArray(list) ? list : [];
    } catch (_e) {}
  }
  return state.thirdPartyAppAlerts;
}

function parseKeywordListText(raw = '') {
  return [
    ...new Set(
      String(raw || '')
        .split(/[\s,，;；\r\n]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

function renderOAuthGuardKeywordTags(keywords = []) {
  const host = $('oauth-guard-keywords-tags');
  if (!host) return;
  const list = Array.isArray(keywords) ? keywords : [];
  if (!list.length) {
    host.innerHTML = '<span class="muted">暂未配置指定应用黑名单（当前仍受网盘/表格权限封禁开关保护）</span>';
    return;
  }
  host.innerHTML = list
    .map(
      kw => `<span class="badge">
        ${escapeHtml(kw)}
        <button type="button" class="btn-text btn-text-danger" data-action="remove-oauth-keyword" data-keyword="${escapeHtml(kw)}" title="移出禁止名单">×</button>
      </span>`
    )
    .join('');
}

function renderThirdPartyAppAlerts() {
  const tbody = $('oauth-guard-alerts-rows');
  if (!tbody) return;
  const alerts = Array.isArray(state.thirdPartyAppAlerts) ? state.thirdPartyAppAlerts : [];
  if (!alerts.length) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="empty">暂无第三方 OAuth 授权拦截记录（访问高危应用或索取网盘/表格权限的 Google 授权页时将自动拦截并记录）</td></tr>';
    return;
  }
  tbody.innerHTML = alerts
    .slice(0, 50)
    .map(a => {
      const isBlocked = a.action === 'blocked';
      const actionBadge = isBlocked
        ? '<span class="oauth-alert-badge blocked status-pill danger">🛑 已拦截</span>'
        : '<span class="oauth-alert-badge warning status-pill warning">🔔 已预警</span>';
      const appTag = a.matchedKeyword || a.appName || '';
      const appPill = appTag ? `<span class="badge">${escapeHtml(appTag)}</span>` : '';
      const scopePills = [
        a.hasDriveScope ? '<span class="status-pill danger">Google 网盘</span>' : '',
        a.hasSheetsScope ? '<span class="status-pill warning">Google 表格</span>' : ''
      ]
        .filter(Boolean)
        .join(' ');
      const detailText =
        a.reason || a.title || a.tabTitle || a.message || '检测到第三方 Google OAuth 授权请求';
      const sourceHost = a.host || a.redirectDomain || 'accounts.google.com';
      const clientHint = a.clientId ? `Client ID：${String(a.clientId).slice(0, 32)}` : '';
      return `<tr>
        <td>
          <div>${actionBadge}</div>
          <div class="muted">${escapeHtml(formatTime(a.timestamp || a.detectedAt || ''))}</div>
        </td>
        <td>
          <div class="row-flex wrap-flex">${appPill} ${scopePills}</div>
          <div class="muted">${escapeHtml(String(detailText).slice(0, 150))}</div>
        </td>
        <td>
          <div class="row-flex wrap-flex">
            <span>${escapeHtml(sourceHost)}</span>
            <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer" class="btn btn-xs">去撤销 ↗</a>
          </div>
          ${clientHint ? `<div class="muted">${escapeHtml(clientHint)}</div>` : ''}
        </td>
      </tr>`;
    })
    .join('');
}

async function handleSaveOAuthGuardKeywords() {
  const blockedAppKeywords = parseKeywordListText($('oauth-guard-keywords-input')?.value || '');
  const trustedOAuthKeywords = parseKeywordListText($('oauth-guard-trusted-input')?.value || '');
  await syncPolicyAndSchedule({ blockedAppKeywords, trustedOAuthKeywords });
  toast(
    `已保存拦截规则：禁止应用 ${blockedAppKeywords.length} 项 · 信任放行 ${trustedOAuthKeywords.length} 项`
  );
}

async function handleRemoveOAuthKeyword(keyword) {
  const target = String(keyword || '').trim().toLowerCase();
  if (!target) return;
  const current = Array.isArray(state.policy.blockedAppKeywords)
    ? state.policy.blockedAppKeywords
    : [];
  const next = current.filter(k => String(k || '').trim().toLowerCase() !== target);
  await syncPolicyAndSchedule({ blockedAppKeywords: next });
  if ($('oauth-guard-keywords-input')) {
    $('oauth-guard-keywords-input').value = next.join(', ');
  }
  toast(`已将「${target}」移出禁止关联名单`);
}

async function handleClearOAuthGuardAlerts() {
  try {
    if (typeof clearThirdPartyAppAlerts === 'function') {
      await clearThirdPartyAppAlerts();
    } else if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
      await chrome.storage.local.set({ thirdPartyAppAlerts: [] });
    }
    state.thirdPartyAppAlerts = [];
    renderThirdPartyAppAlerts();
    toast('已清空第三方关联应用告警记录');
  } catch (error) {
    toast(`清空告警记录失败：${error?.message || error}`);
  }
}

function renderAll() {
  updateTopBadges();
  syncTypeDropdownUI();
  syncQuickExcludeButtons();
  renderSavedPresetsBar();
  renderGroupSelectorsAndBatchBar();
  renderFilesTab();
  renderExcludedFoldersView();
  renderCollaboratorsTab();
  renderRoleBundlesSection();
  renderPartnerProfilesSection();
  renderSecurityRadar();
  renderDormantRadar();
  renderImportRangeReport();
  renderPolicyTab();
  renderLogsTab();
  renderTransferWorkspace();
}

/* ==================== 全盘所有权转移工作台（左：来源扫描 ➔ 右：接收与对比 · 断点续传 · 实时日志） ==================== */

let transferLogRenderTimer = null;

function renderTransferLogsConsole() {
  const box = $('transfer-log-console');
  const latestNode = $('transfer-log-latest');
  const logs = state.transferState?.logs || [];
  if (latestNode) {
    latestNode.textContent = logs.length
      ? logs[logs.length - 1]
      : '等待操作：选择来源账号并点击「扫描来源全盘」，进度将自动持久化保存。';
  }
  if (!box) return;
  if (!logs.length) {
    box.innerHTML = `<div class="muted">暂无转移操作日志。选择左侧来源邮箱并点击「扫描来源全盘」开始记录…</div>`;
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
    `<option value="">请选择已授权的来源邮箱 (${accounts.length} 个可用)</option>` +
    accounts
      .map(
        a =>
          `<option value="${escapeHtml(normalizeEntry(a.email))}" ${
            normalizeEntry(a.email) === curSrc ? 'selected' : ''
          }>来源: ${escapeHtml(a.email)}</option>`
      )
      .join('');

  tgtSelect.innerHTML =
    `<option value="">选已授权接收号</option>` +
    accounts
      .map(
        a =>
          `<option value="${escapeHtml(normalizeEntry(a.email))}" ${
            normalizeEntry(a.email) === curTgt ? 'selected' : ''
          }>接收: ${escapeHtml(a.email)}</option>`
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
            formatDriveCanonicalLink(it)
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
          await appendTransferLog(`🔑 账号授权令牌校验通过 (${sourceEmail})，开始分页拉取云盘数据（每页结果将实时渲染至下方表格）…`, false);
        } else if (p?.phase === 'auth_refresh') {
          await appendTransferLog(`🔄 正在使用 refreshToken 自动刷新访问令牌 (${sourceEmail})…`, false);
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
    // 【阶段 0：顶层大文件夹剪枝预热 + 开局自动挂入接收方『我的云端硬盘』根目录（全量检查 items 以防子文件单独发送 POST 触发 Google 垃圾内容误判）】
    const topFoldersToPrep = items.filter(
      it => it.isTopLevelFolder && (!it.targetPermissionId || (targetToken && !it._mountedToTargetRoot))
    );
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

async function handleTransferRestoreSpamAndTrash() {
  if (state.transferRunning) {
    toast('当前有正在运行的任务，请先暂停后再执行垃圾内容/回收站恢复');
    return;
  }

  const sourceEmail = normalizeEntry($('transfer-source-select')?.value || state.transferState.sourceEmail || '');
  const targetEmail = normalizeEntry(
    $('transfer-target-email-input')?.value || $('transfer-target-select')?.value || state.transferState.targetEmail || ''
  );
  if (!targetEmail && !sourceEmail) {
    toast('请先在上方选择或输入「接收邮箱」或「来源邮箱」');
    return;
  }

  let targetToken = '';
  let sourceToken = '';
  if (targetEmail) {
    try {
      targetToken = await getValidTokenForAccount(targetEmail, false);
    } catch (_e) {}
  }
  if (sourceEmail) {
    try {
      sourceToken = await getValidTokenForAccount(sourceEmail, false);
    } catch (_e) {}
  }
  if (!targetToken && targetEmail) {
    try {
      targetToken = await getValidTokenForAccount(targetEmail, true);
    } catch (_e) {}
  }
  if (!targetToken && !sourceToken) {
    toast('请先在插件内授权接收邮箱或来源邮箱后再执行恢复');
    return;
  }

  const rawDestText = ($('transfer-dest-folder-input')?.value || '').trim();
  const parsedDestIds = rawDestText.toLowerCase() === 'root' ? ['root'] : parseDriveLinksInput(rawDestText);
  const fallbackDestFolderId = parsedDestIds[0] || '';
  const searchKeyword = ($('transfer-filter-kw')?.value || '').trim();
  const onlyRootFolderId = $('transfer-filter-root-folder')?.value || 'all';
  const concurrency = Math.max(1, Math.min(16, Number($('transfer-concurrency-select')?.value) || 8));

  const btn = $('transfer-restore-spam-trash-btn');
  const pauseBtn = $('transfer-pause-btn');
  if (btn) btn.disabled = true;
  if (pauseBtn) pauseBtn.disabled = false;
  state.transferRunning = true;
  state.transferPauseRequested = false;

  await appendTransferLog(
    `🛡️ 开始双账号扫描『回收站』、『垃圾内容隐身文档』与『文件夹内一闪而过文档』${searchKeyword ? `（精准搜索关键词："${searchKeyword}"）` : ''}，执行两步式「移出再移回」强制重建文件夹视图索引…`,
    false
  );

  try {
    const res = await scanAndRestoreSpamAndTrashItems({
      targetToken,
      sourceToken,
      targetEmail,
      sourceEmail,
      transferItems: state.transferState?.items || [],
      fallbackDestFolderId,
      searchKeyword,
      onlyRootFolderId,
      concurrency,
      shouldStop: () => Boolean(state.transferPauseRequested),
      onProgress(p) {
        if (p?.message) $('progress').textContent = p.message;
      },
      onLog: msg => appendTransferLog(msg, false)
    });

    state.transferState = await saveOwnershipTransferState(state.transferState);
    renderTransferWorkspace();

    const spamWebNote =
      res.failedCount > 0 || res.totalFound === 0
        ? ' 💡 提示：若部分文件被 Google 强锁在网页端『垃圾内容 (Spam)』视图中，请点击右侧「🧹 网页『垃圾内容』全选解除」按钮，在打开的网页按 Ctrl+A 全选 -> 右键点击「不是垃圾内容」，切回本页面将自动把它们归位！'
        : '';

    await appendTransferLog(
      `✅ 扫描与「一闪而过」深层修复完成！共处理 ${res.totalFound} 项文件（🗑️ 回收站恢复 ${res.restoredFromTrash} 项 / 🛡️ 脱钩隐身归位 ${res.rescuedFromSpamOrOrphan} 项 / ⚡ 文件夹内「移出再移回」重建索引修复一闪而过 ${res.fixedFlashInFolder || 0} 项 / 失败 ${res.failedCount} 项）。${spamWebNote}`,
      true
    );
    $('progress').textContent = `修复完成：文件夹内一闪而过修复 ${res.fixedFlashInFolder || 0} 项 · 脱钩归位 ${res.rescuedFromSpamOrOrphan} 项 · 回收站恢复 ${res.restoredFromTrash} 项`;
    toast(
      `修复完成：修复一闪而过 ${res.fixedFlashInFolder || 0} 项，找回隐身文件 ${res.rescuedFromSpamOrOrphan} 项，回收站恢复 ${res.restoredFromTrash} 项！`
    );
  } catch (err) {
    await appendTransferLog(`❌ 垃圾内容/回收站扫描恢复失败：${err.message}`, true);
    toast(`恢复失败：${err.message}`);
  } finally {
    state.transferRunning = false;
    state.transferPauseRequested = false;
    if (btn) btn.disabled = false;
    if (pauseBtn) pauseBtn.disabled = true;
  }
}

function exportTransferCsv() {
  const items = state.transferState?.items || [];
  if (!items.length) {
    toast('暂无转移对比记录可导出');
    return;
  }
  const hierarchyMap = buildDriveHierarchyInfo(items);
  const orderedItems = sortItemsByHierarchyTree(items, hierarchyMap);
  const rows = [
    [
      '层级 (Level)',
      '完整层级路径 (Full Path)',
      '所在目录路径 (Folder Path)',
      '层级缩进名称 (Tree Name)',
      '名称 (Name)',
      '类型 (Type)',
      '文件/文件夹专属链接 (Link)',
      '所属父文件夹 (Parent Folder)',
      '父文件夹链接 (Parent Folder Link)',
      '顶层根文件夹 (Root Folder)',
      '顶层根文件夹链接 (Root Folder Link)',
      'File ID',
      'Source Email (Left)',
      'Target Email (Right)',
      'Current Actual Owner',
      'Stage',
      'Status Text',
      'Updated At'
    ]
  ];
  for (const it of orderedItems) {
    const h = hierarchyMap.get(it.id) || {};
    const typeLabel = fileCategoryLabel(it.mimeType, it.name);
    const canonicalLink = h.canonicalLink || formatDriveCanonicalLink(it);
    rows.push([
      h.levelLabel || it.levelLabel || '第 1 层',
      h.fullPath || it.fullPath || it.name || '',
      h.folderPath || it.folderPath || '根目录',
      h.treeDisplayName || it.treeDisplayName || it.name || '',
      it.name || '',
      typeLabel,
      canonicalLink,
      h.parentFolderName || it.parentFolderName || '',
      h.parentFolderLink || it.parentFolderLink || '',
      h.rootFolderName || it.rootFolderName || '',
      h.rootFolderLink || it.rootFolderLink || '',
      it.id,
      it.sourceOwner || '',
      it.targetOwner || '',
      it.currentOwner || '',
      it.stage || '',
      it.statusText || '',
      it.updatedAt || ''
    ]);
  }
  const csvContent = rows
    .map(r => r.map(c => escapeCsvCell(c)).join(','))
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
    const policySrc = parsed.policy && typeof parsed.policy === 'object' ? parsed.policy : parsed;
    const dirSrc = parsed.directory && typeof parsed.directory === 'object' ? parsed.directory : parsed;

    const nextWriters = [...state.policy.writers];
    const nextReaders = [...state.policy.readers];
    if (Array.isArray(policySrc.writers)) nextWriters.push(...policySrc.writers.map(normalizeEntry));
    if (Array.isArray(policySrc.allowList)) nextWriters.push(...policySrc.allowList.map(normalizeEntry));
    if (Array.isArray(policySrc.readers)) nextReaders.push(...policySrc.readers.map(normalizeEntry));

    state.policy = await savePolicy({
      writers: nextWriters,
      readers: nextReaders,
      publicLinkRule: policySrc.publicLinkRule || state.policy.publicLinkRule
    });

    if (Array.isArray(dirSrc.groups) || Array.isArray(dirSrc.contacts)) {
      state.directory = await saveDirectory({
        groups: dirSrc.groups || state.directory.groups,
        contacts: dirSrc.contacts || state.directory.contacts
      });
    }
  }
  renderAll();
  toast('已成功导入白名单/分组配置');
}

async function importParsedContacts(rows, targetGroupOverride = '') {
  if (!rows || !rows.length) {
    toast('未识别到有效邮箱（支持 A列邮箱 · B列权限 · 可选C列分组 · D列姓名）');
    return;
  }

  const nextGroups = [...(state.directory.groups || [])];
  const groupNameSet = new Set(nextGroups.map(g => g.name));
  const nextContacts = [...(state.directory.contacts || [])];
  const byEmail = new Map();
  for (const c of nextContacts) {
    const em = normalizeEntry(c.email);
    if (em) byEmail.set(em, c);
  }

  let writerCount = 0;
  let readerCount = 0;
  let commenterCount = 0;
  let newGroupCount = 0;

  for (const r of rows) {
    const email = normalizeEntry(r.email || '');
    if (!email || !email.includes('@')) continue;

    const resolvedRole =
      typeof normalizePermissionRole === 'function'
        ? normalizePermissionRole(r.role || '', 'reader')
        : r.role === 'writer' || r.role === 'commenter' || r.role === 'reader'
        ? r.role
        : 'reader';

    if (resolvedRole === 'writer') writerCount++;
    else if (resolvedRole === 'commenter') commenterCount++;
    else readerCount++;

    const grpName = String(r.group || targetGroupOverride || '').trim();
    if (grpName && !groupNameSet.has(grpName)) {
      groupNameSet.add(grpName);
      nextGroups.push({
        name: grpName,
        defaultRole: resolvedRole,
        policyTier: resolvedRole === 'writer' ? 'writer' : 'reader'
      });
      newGroupCount++;
    }

    const existing = byEmail.get(email);
    if (existing) {
      if (r.name && !existing.name) existing.name = r.name;
      existing.role = resolvedRole;
      existing.groups = existing.groups || [];
      if (grpName && !existing.groups.includes(grpName)) {
        existing.groups.push(grpName);
      }
      existing.groupRoles =
        existing.groupRoles && typeof existing.groupRoles === 'object' ? { ...existing.groupRoles } : {};
      if (grpName) {
        existing.groupRoles[grpName] = resolvedRole;
      }
    } else {
      const created = {
        email,
        name: r.name || '',
        role: resolvedRole,
        groups: grpName ? [grpName] : [],
        groupRoles: grpName ? { [grpName]: resolvedRole } : {}
      };
      nextContacts.push(created);
      byEmail.set(email, created);
    }
  }

  state.directory = await saveDirectory({
    groups: nextGroups,
    contacts: nextContacts
  });
  state.policy = await getPolicy();
  renderAll();

  const newGrpSuffix = newGroupCount > 0 ? ` · 新建分组 ${newGroupCount} 个` : '';
  toast(
    `已导入 ${rows.length} 人（可编辑 ${writerCount} 人 · 仅查看 ${readerCount} 人 · 可评论 ${commenterCount} 人${newGrpSuffix}）`
  );
}

/* ==================== 扫描、批量执行与单项权限操作 ==================== */

async function handleScan(targetAccount = state.activeAccount, overrideScope = '') {
  const scanBtn = $('scan');
  const customScanBtn = $('scan-custom-folders-btn');
  const scanScope = overrideScope || $('scan-scope-select')?.value || 'owned';
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
      : scanScope === 'owned'
      ? '正在扫描我拥有的文件…'
      : '正在启动网盘极速扫描…';

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
        if (typeof hydrateFilesPermissionDiffs === 'function') {
          hydrateFilesPermissionDiffs(state.files, state.permDiffs);
        }
        updateTopBadges();
        renderFilesTab();
      }
    });
    state.accounts = res.accounts;
    state.oauthClients = await getOAuthClients();
    state.policy = res.policy;
    applySnapshotToState(res.snapshot);
    state.selectedFileIds.clear();
    const folderCount = state.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder').length;
    const diffCount = state.files.filter(f => Boolean(resolveFileDiffInfo(f))).length;
    const diffSuffix = diffCount > 0 ? ` / 权限变动 ${diffCount} 项` : '';
    $('progress').textContent = `扫描完成：共 ${state.files.length} 项（文件夹 ${folderCount} 个 / 新增 ${res.newlyDiscoveredCount} 项${diffSuffix}）`;
    renderAll();
    toast(`扫描完成：共 ${state.files.length} 项（含 ${folderCount} 个文件夹${diffCount > 0 ? `，变动 ${diffCount} 项` : ''}）`);
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

async function runControllableBatchTask({ title = '正在执行批量任务', runFn, retryFn = null }) {
  if (state.batchTaskRunning) {
    toast('当前已有批量任务正在运行，请等待完成或先点击暂停');
    return null;
  }

  clearTimeout(runControllableBatchTask._hideTimer);
  state.batchTaskRunning = true;
  state.batchTaskStopRequested = false;
  state.batchTaskRetryFn = typeof retryFn === 'function' ? retryFn : null;
  state.batchTaskFailedItems = [];

  const bar = $('batch-task-bar');
  const titleEl = $('batch-task-title');
  const detailEl = $('batch-task-detail');
  const fillEl = $('batch-task-progress-fill');
  const stopBtn = $('batch-task-stop-btn');
  const retryBtn = $('batch-task-retry-btn');
  const dismissBtn = $('batch-task-dismiss-btn');

  bar?.classList.remove('hidden', 'has-failures', 'stopped', 'completed');
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = '准备中…';
  if (fillEl) fillEl.style.width = '0%';
  if (stopBtn) {
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    stopBtn.textContent = '暂停 / 中止';
  }
  retryBtn?.classList.add('hidden');
  dismissBtn?.classList.add('hidden');

  const shouldStop = () => Boolean(state.batchTaskStopRequested);
  const updateProgress = ({ done = 0, total = 0, message = '' } = {}) => {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (detailEl) {
      detailEl.textContent = message || (total > 0 ? `${done} / ${total} (${pct}%)` : `${done}`);
    }
  };

  try {
    const res = await runFn({ shouldStop, updateProgress });
    state.batchTaskRunning = false;
    stopBtn?.classList.add('hidden');

    const failedItems = Array.isArray(res?.failedItems) ? res.failedItems : [];
    const failCount =
      Number(res?.failedCount ?? res?.failCount ?? res?.failed ?? failedItems.length) || 0;
    const stopped = Boolean(res?.stopped || state.batchTaskStopRequested);
    const hasFail = failCount > 0 || failedItems.length > 0;

    bar?.classList.toggle('has-failures', hasFail);
    bar?.classList.toggle('stopped', stopped && !hasFail);
    bar?.classList.toggle('completed', !stopped && !hasFail);

    if (!stopped && failCount === 0 && fillEl) {
      fillEl.style.width = '100%';
    }

    if (titleEl) {
      if (stopped) {
        titleEl.textContent = `${title} · 已暂停中止`;
      } else if (failCount > 0) {
        titleEl.textContent = `${title} · 部分失败 (${failCount} 项)`;
      } else {
        titleEl.textContent = `${title} · 已完成`;
      }
    }
    if (res?.summaryDetail && detailEl) {
      detailEl.textContent = res.summaryDetail;
    }

    dismissBtn?.classList.remove('hidden');
    if (failedItems.length > 0 && state.batchTaskRetryFn) {
      state.batchTaskFailedItems = failedItems;
      if (retryBtn) {
        retryBtn.textContent = `仅重试失败项 (${failedItems.length})`;
        retryBtn.classList.remove('hidden');
      }
    } else {
      retryBtn?.classList.add('hidden');
    }

    if (!stopped && failCount === 0 && failedItems.length === 0) {
      runControllableBatchTask._hideTimer = setTimeout(() => {
        if (!state.batchTaskRunning) {
          bar?.classList.add('hidden');
        }
      }, 2600);
    }

    return res;
  } catch (error) {
    state.batchTaskRunning = false;
    stopBtn?.classList.add('hidden');
    dismissBtn?.classList.remove('hidden');
    retryBtn?.classList.add('hidden');
    if (titleEl) titleEl.textContent = `${title} · 执行出错`;
    if (detailEl) detailEl.textContent = error?.message || String(error);
    throw error;
  }
}

async function handleEnforceFiles(targetFiles, retryQueue = null) {
  const excludedIdSet = getCurrentExcludedIdSet();
  const nonExcluded = Array.isArray(retryQueue)
    ? targetFiles || state.files
    : (targetFiles || []).filter(f => !isFileExcludedCompat(f, excludedIdSet));
  const actionable = Array.isArray(retryQueue)
    ? nonExcluded
    : nonExcluded.filter(f => evaluateFile(f, state.policy, f.ownerAccount).hasActionableViolation);

  if (!Array.isArray(retryQueue)) {
    if (!actionable.length) {
      const skippedExcluded = (targetFiles || []).length - nonExcluded.length;
      toast(
        skippedExcluded > 0
          ? `所选文件均符合策略或位于排除目录（已自动跳过 ${skippedExcluded} 项排除目录资产）`
          : '所选文件均符合当前白名单策略，无需处理'
      );
      return;
    }

    let rmTotal = 0;
    let downTotal = 0;
    const previewItems = [];
    const contactLookup = buildContactLookup(state.directory);

    for (const f of actionable) {
      const owner = f.ownerAccount || f.owners?.[0]?.emailAddress || '';
      const st = evaluateFile(f, state.policy, owner);
      rmTotal += st.removeCount;
      downTotal += st.downgradeCount;
      const actions = [];
      for (const p of f.permissions || []) {
        const ev = evaluatePermission(p, state.policy, owner);
        if (ev.status === 'violation_remove') {
          actions.push(`移除 ${permissionLabel(p, contactLookup)}`);
        } else if (ev.status === 'violation_downgrade') {
          actions.push(`降级 ${permissionLabel(p, contactLookup)} 为只读`);
        }
      }
      previewItems.push({
        title: `${f.name || f.id} (${owner || '默认账号'})`,
        detail: actions.join('；') || `移除 ${st.removeCount} 项，降级 ${st.downgradeCount} 项`
      });
    }

    const confirmed = await confirmWithDryRunModal({
      title: '白名单合规修正预演确认',
      summaryHtml: `即将对 <strong>${actionable.length}</strong> 个文件执行白名单修正：预计移除非白名单权限 <strong>${rmTotal}</strong> 项，将越权编辑降为只读 <strong>${downTotal}</strong> 项。`,
      previewItems,
      confirmText: `确认修正 (${actionable.length} 个文件)`,
      isDanger: rmTotal > 0,
      fallbackText: `确认对 ${actionable.length} 个文件按白名单修正？\n• 移除非白名单权限：${rmTotal} 项\n• 越权编辑降为只读：${downTotal} 项`
    });
    if (!confirmed) return;
  }

  $('progress').textContent = '正在执行白名单合规修正…';
  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? '重试白名单合规修正失败项' : '白名单合规修正',
      retryFn: failedItems => handleEnforceFiles(actionable, failedItems),
      async runFn({ shouldStop, updateProgress }) {
        const res = await enforceFilesByPolicy(
          null,
          actionable,
          state.policy,
          '',
          'manual',
          p => {
            const msg = `正在修正 ${p.done}/${p.total}…`;
            $('progress').textContent = msg;
            updateProgress({ done: p.done, total: p.total, message: `${p.done} / ${p.total}` });
          },
          { shouldStop, retryQueue }
        );
        await saveCurrentFilesSnapshot();
        state.logs = await getAuditLogs();
        const summaryDetail = `移除 ${res.removed} 项 · 降为只读 ${res.downgraded} 项 · 失败 ${res.failed} 项`;
        $('progress').textContent = `${res.stopped ? '已暂停修正' : '修正完成'}：${summaryDetail}`;
        renderAll();
        toast(`${res.stopped ? '已暂停修正' : '修正完成'}：移除 ${res.removed} 项，降为只读 ${res.downgraded} 项`);
        return { ...res, summaryDetail };
      }
    });
  } catch (error) {
    toast(`执行失败：${error.message}`);
  }
}

async function handleGroupBatchOperation(mode, retryQueue = null, inheritedExpiresAt = '') {
  const targetFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  const groupNames = [...state.selectedBatchGroups];
  const roleOption = $('batch-group-role')?.value || 'group_default';
  const modeTitle =
    mode === 'grant'
      ? '开通所选分组权限'
      : mode === 'keep_only_groups'
      ? '仅保留所选分组（移除组外人员）'
      : '移除所选分组权限';

  const canUseTtl = mode === 'grant' || mode === 'keep_only_groups';
  let ttlSel = { preset: 'none', expiresAt: '', label: '长期有效' };

  if (Array.isArray(retryQueue)) {
    const retryExpires = inheritedExpiresAt || retryQueue[0]?.expiresAt || '';
    if (retryExpires) {
      ttlSel = {
        preset: 'custom',
        expiresAt: retryExpires,
        label: `限时至 ${formatTime(retryExpires)}`
      };
    }
  } else {
    if (!targetFiles.length || !groupNames.length) {
      toast('请先勾选左侧文件并选择至少一个目标分组');
      return;
    }

    if (canUseTtl) {
      try {
        ttlSel = resolveTtlSelection('batch-group-ttl', 'batch-group-ttl-custom');
      } catch (ttlError) {
        toast(ttlError.message);
        return;
      }
    }

    const groupMembers = (state.directory.contacts || []).filter(c =>
      (c.groups || []).some(g => groupNames.includes(g))
    );
    const ttlDetailSuffix = ttlSel.expiresAt ? ` · ${ttlSel.label}` : '';
    const previewItems = targetFiles.map(f => ({
      title: f.name || f.id,
      detail: `操作：${modeTitle} · 目标分组：${groupNames.join('、')}（涉及组内成员 ${groupMembers.length} 人）${ttlDetailSuffix}`
    }));

    const ttlSummaryHtml = ttlSel.expiresAt
      ? ` 授权时效：<strong>${escapeHtml(ttlSel.label)}</strong>（到期自动收回）。`
      : '';
    const ttlFallbackSuffix = ttlSel.expiresAt ? `\n授权时效：${ttlSel.label}（到期自动收回）` : '';

    const confirmed = await confirmWithDryRunModal({
      title: `按分组批量操作预演：${modeTitle}`,
      summaryHtml: `已选择 <strong>${targetFiles.length}</strong> 个文件，目标分组：<strong>${escapeHtml(groupNames.join('、'))}</strong>（共 ${groupMembers.length} 名成员）。${ttlSummaryHtml}`,
      previewItems,
      confirmText: `确认执行 (${targetFiles.length} 个文件)`,
      isDanger: mode !== 'grant',
      fallbackText: `确认对已勾选的 ${targetFiles.length} 个文件执行「${modeTitle}」？\n目标分组：${groupNames.join('、')}${ttlFallbackSuffix}`
    });
    if (!confirmed) return;
  }

  $('progress').textContent = `正在执行分组批量操作…`;
  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? `重试分组操作 (${modeTitle})` : `分组批量操作：${modeTitle}`,
      retryFn: failedItems => handleGroupBatchOperation(mode, failedItems, ttlSel.expiresAt),
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          res = await executeGroupBatchOnFiles({
            files: targetFiles.length ? targetFiles : state.files,
            groupNames,
            mode,
            roleOption,
            directory: state.directory,
            expiresAt: ttlSel.expiresAt,
            expireAction: 'revoke',
            shouldStop,
            retryQueue,
            onProgress(p) {
              $('progress').textContent = `正在处理分组权限 ${p.done}/${p.total}…`;
              updateProgress({ done: p.done, total: p.total, message: `${p.done} / ${p.total}` });
            }
          });
          await saveCurrentFilesSnapshot();
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }
        state.logs = await getAuditLogs();
        await refreshTtlQueueState();
        if (!res.stopped && !(res.failedCount > 0) && ttlSel.expiresAt && !Array.isArray(retryQueue)) {
          resetTtlControls('batch-group-ttl', 'batch-group-ttl-custom');
        }
        const summaryDetail = `新增 ${res.createdCount} · 调整 ${res.updatedCount} · 移除 ${res.removedCount} · 失败 ${res.failedCount || 0}`;
        $('progress').textContent = `${res.stopped ? '分组操作已暂停' : '分组操作完成'}：${summaryDetail}`;
        renderAll();
        toast(`${res.stopped ? '分组操作已暂停' : '分组操作完成'}：新增 ${res.createdCount}，调整 ${res.updatedCount}，移除 ${res.removedCount}`);
        return { ...res, summaryDetail };
      }
    });
  } catch (error) {
    toast(`分组操作失败：${error.message}`);
  }
}

async function handleAlignFilesToParent(targetFiles, retryQueue = null) {
  const allScoped = getScopedFilesByAccount();
  const fullBreakageMap = analyzeInheritanceBreakage(allScoped.length ? allScoped : state.files);
  const candidateFiles = Array.isArray(targetFiles) ? targetFiles : [];

  if (!Array.isArray(retryQueue)) {
    const brokenFiles = candidateFiles.filter(f => fullBreakageMap.has(f.id));
    if (!brokenFiles.length) {
      toast('所选文件未检测到宽于父文件夹的逃逸权限');
      return;
    }

    const previewItems = [];
    let totalEscaped = 0;
    for (const f of brokenFiles) {
      const info = fullBreakageMap.get(f.id);
      if (!info) continue;
      totalEscaped += info.escapedCount || 0;
      const details = (info.escapedPermissions || [])
        .map(esc => {
          const actLabel =
            esc.suggestedAction === 'downgrade'
              ? `降回${roleLabel(esc.targetRole || 'reader')}`
              : '移除多余授权';
          return `[${actLabel}] ${esc.reason}`;
        })
        .join('；');
      previewItems.push({
        title: `${f.name || f.id}（父目录：${info.parentName || '上级文件夹'}）`,
        detail: details || info.summaryText
      });
    }

    const confirmed = await confirmWithDryRunModal({
      title: '对齐父目录权限预演（回收逃逸权限）',
      summaryHtml: `在所选范围内共检测到 <strong>${brokenFiles.length}</strong> 个子文件/子目录权限宽于父文件夹，即将回收或降级 <strong>${totalEscaped}</strong> 处逃逸权限，使其与上级文件夹保持一致。`,
      previewItems,
      confirmText: `确认对齐父目录 (${totalEscaped} 项)`,
      isDanger: true,
      fallbackText: `确认对 ${brokenFiles.length} 个文件的 ${totalEscaped} 处逃逸权限执行对齐父目录回收？`
    });
    if (!confirmed) return;
    targetFiles = brokenFiles;
  }

  $('progress').textContent = '正在对齐父目录权限…';
  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? '重试对齐父目录失败项' : '对齐父目录权限',
      retryFn: failedItems => handleAlignFilesToParent(targetFiles, failedItems),
      async runFn({ shouldStop, updateProgress }) {
        const res = await alignFilesToParentPermissions({
          files: targetFiles?.length ? targetFiles : state.files,
          breakageMap: fullBreakageMap,
          shouldStop,
          retryQueue,
          onProgress(p) {
            $('progress').textContent = `正在对齐父目录权限 ${p.done}/${p.total}…`;
            updateProgress({ done: p.done, total: p.total, message: `${p.done} / ${p.total}` });
          }
        });
        analyzeInheritanceBreakage(state.files);
        await saveCurrentFilesSnapshot();
        state.logs = await getAuditLogs();
        const summaryDetail = `移除 ${res.removedCount} 项 · 降回父级角色 ${res.downgradedCount} 项 · 失败 ${res.failedCount} 项`;
        $('progress').textContent = `${res.stopped ? '已暂停对齐' : '对齐父目录完成'}：${summaryDetail}`;
        renderAll();
        toast(`${res.stopped ? '已暂停对齐' : '对齐父目录完成'}：移除 ${res.removedCount} 项，降级 ${res.downgradedCount} 项`);
        return { ...res, summaryDetail };
      }
    });
  } catch (error) {
    toast(`对齐父目录失败：${error.message}`);
  }
}

async function handleBatchQuickAction(actionType, retryQueue = null, explicitTargetFiles = null) {
  const excludedIdSet = getCurrentExcludedIdSet();
  const rawTargets = Array.isArray(explicitTargetFiles)
    ? explicitTargetFiles
    : state.files.filter(f => state.selectedFileIds.has(f.id));
  const selectedFiles = Array.isArray(retryQueue)
    ? rawTargets
    : rawTargets.filter(f => !isFileExcludedCompat(f, excludedIdSet));
  if (actionType === 'align_parent') {
    return handleAlignFilesToParent(selectedFiles, retryQueue);
  }

  const titleMap = {
    downgrade_all: '将所选文件的全部协作者降为只读',
    remove_public: '关闭公开与域内共享链接',
    revoke_all: '清空所选文件的所有非所有者权限'
  };
  const actionLabel = titleMap[actionType] || '快捷权限清理';

  let permQueue = [];
  if (Array.isArray(retryQueue)) {
    permQueue = retryQueue;
  } else {
    if (!selectedFiles.length) {
      if (rawTargets.length > 0) {
        toast('所选文件均位于排除目录中，已自动跳过不执行清理');
      }
      return;
    }
    const contactLookup = buildContactLookup(state.directory);
    const previewItems = [];

    for (const file of selectedFiles) {
      const changes = [];
      for (const p of file.permissions || []) {
        const isPureInherited =
          permIsInherited(p) && !(typeof permHasDirectGrant === 'function' && permHasDirectGrant(p));
        if (p.role === 'owner' || isPureInherited) continue;
        if (actionType === 'downgrade_all' && p.role !== 'reader') {
          changes.push(`${permissionLabel(p, contactLookup)}: ${roleLabel(p.role)} → 仅查看`);
          permQueue.push({ fileId: file.id, permId: p.id, actionType });
        } else if (actionType === 'remove_public' && (p.type === 'anyone' || p.type === 'domain')) {
          changes.push(`关闭 ${permissionLabel(p, contactLookup)}`);
          permQueue.push({ fileId: file.id, permId: p.id, actionType });
        } else if (actionType === 'revoke_all') {
          changes.push(`移除 ${permissionLabel(p, contactLookup)} (${roleLabel(p.role)})`);
          permQueue.push({ fileId: file.id, permId: p.id, actionType });
        }
      }
      if (changes.length > 0) {
        previewItems.push({
          title: file.name || file.id,
          detail: changes.join('；')
        });
      }
    }

    if (permQueue.length === 0) {
      toast('目标未排除文件中没有需要变更的权限项');
      return;
    }

    const skippedExcluded = rawTargets.length - selectedFiles.length;
    const confirmed = await confirmWithDryRunModal({
      title: `快捷权限清理预演：${actionLabel}`,
      summaryHtml: `待检查 <strong>${selectedFiles.length}</strong> 个未排除文件${
        skippedExcluded > 0 ? `（已自动跳过 ${skippedExcluded} 项排除目录资产）` : ''
      }，其中 <strong>${previewItems.length}</strong> 个文件存在可变更项，共涉及 <strong>${permQueue.length}</strong> 项权限变更。`,
      previewItems,
      confirmText: `确认执行 (${permQueue.length} 项变更)`,
      isDanger: actionType === 'revoke_all' || actionType === 'remove_public',
      fallbackText: `确认对 ${selectedFiles.length} 个文件执行：\n「${actionLabel}」？`
    });
    if (!confirmed) return;
  }

  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? `重试快捷清理 (${actionLabel})` : actionLabel,
      retryFn: failedItems => handleBatchQuickAction(actionType, failedItems),
      async runFn({ shouldStop, updateProgress }) {
        let okCount = 0;
        let failCount = 0;
        let stopped = false;
        const failedItems = [];
        const newLogs = [];
        const fileMap = new Map(state.files.map(f => [f.id, f]));

        for (let i = 0; i < permQueue.length; i++) {
          if (shouldStop()) {
            stopped = true;
            break;
          }
          const item = permQueue[i];
          const file = fileMap.get(item.fileId);
          const p = file?.permissions?.find(x => x.id === item.permId);
          if (!file || !p) {
            updateProgress({ done: i + 1, total: permQueue.length });
            continue;
          }
          const owner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
          $('progress').textContent = `正在处理 (${i + 1}/${permQueue.length}): ${file.name || file.id}`;

          try {
            const token = await resolveTokenForFile(file, i === 0);
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
          } catch (err) {
            failCount++;
            failedItems.push({ ...item, errorMessage: err?.message || String(err) });
          }

          updateProgress({
            done: i + 1,
            total: permQueue.length,
            message: `${i + 1} / ${permQueue.length}`
          });
        }

        await saveCurrentFilesSnapshot();
        if (newLogs.length) await appendAuditLogs(newLogs);
        state.logs = await getAuditLogs();
        const summaryDetail = `成功 ${okCount} 项 · 失败 ${failCount} 项`;
        $('progress').textContent = `${stopped ? '批量处理已暂停' : '批量处理完成'}：${summaryDetail}`;
        renderAll();
        toast(`${stopped ? '处理已暂停' : '处理完成'}：成功 ${okCount} 项${failCount > 0 ? `，失败 ${failCount} 项` : ''}`);
        return { okCount, failCount, stopped, failedItems, summaryDetail };
      }
    });
  } catch (error) {
    toast(`批量处理失败：${error.message}`);
  }
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


async function handleInspectorAddPerm() {
  const file = state.files.find(f => f.id === state.inspectedFileId);
  if (!file) return;
  const emailInput = $('inspector-add-email');
  const roleSelect = $('inspector-add-role');
  const email = normalizeEntry(emailInput?.value || '');
  const role = roleSelect?.value || 'reader';

  if (!email || !email.includes('@')) {
    toast('请输入有效的协作者邮箱地址');
    emailInput?.focus?.();
    return;
  }

  let ttlSel = { preset: 'none', expiresAt: '', label: '长期有效' };
  try {
    ttlSel = resolveTtlSelection('inspector-add-ttl', 'inspector-add-ttl-custom');
  } catch (ttlError) {
    toast(ttlError.message);
    return;
  }

  try {
    const prevLogCount = state.logs.length;
    const token = await resolveTokenForFile(file, true);
    let created = null;
    let grantRes = null;
    let activeFile = file;

    state.localTtlMutatingCount += 1;
    state.localTtlMutationEpoch += 1;
    try {
      if (typeof grantPermissionWithTtl === 'function') {
        grantRes = await grantPermissionWithTtl({
          token,
          accountEmail: file.ownerAccount || '',
          file,
          fileId: file.id,
          type: 'user',
          role,
          emailAddress: email,
          expiresAt: ttlSel.expiresAt,
          expireAction: 'revoke'
        });
        created = grantRes?.createdPermission || grantRes;
      } else {
        created = await createPermission(token, file.id, { type: 'user', role, emailAddress: email });
      }

      activeFile = state.files.find(f => f.id === file.id) || file;
      activeFile.permissions = activeFile.permissions || [];
      const createdPermId = created?.id || grantRes?.ttlEntry?.permissionId || `perm-${Date.now()}`;
      const existingPerm = activeFile.permissions.find(
        p => (created?.id && p.id === created.id) || normalizeEntry(p.emailAddress || '') === email
      );
      if (existingPerm) {
        existingPerm.id = created?.id || existingPerm.id;
        existingPerm.role = role;
        if (ttlSel.expiresAt) {
          existingPerm.expirationTime = created?.expirationTime || ttlSel.expiresAt;
        }
      } else {
        activeFile.permissions.push({
          id: createdPermId,
          type: 'user',
          role,
          emailAddress: email,
          ...(ttlSel.expiresAt ? { expirationTime: created?.expirationTime || ttlSel.expiresAt } : {})
        });
      }

      if (emailInput) emailInput.value = '';
      resetTtlControls('inspector-add-ttl', 'inspector-add-ttl-custom');
      await saveCurrentFilesSnapshot();
    } finally {
      state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
      state.localTtlMutationEpoch += 1;
    }

    const afterGrantLogs = await getAuditLogs();
    if (!Array.isArray(afterGrantLogs) || afterGrantLogs.length <= prevLogCount) {
      const ttlMsgSuffix = ttlSel.expiresAt ? `（${ttlSel.label}）` : '';
      await appendAuditLogs({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        source: 'manual',
        actionType: 'grant',
        accountEmail: activeFile.ownerAccount || '',
        fileId: activeFile.id,
        fileName: activeFile.name,
        permissionId: created?.id || '',
        targetType: 'user',
        targetEmail: email,
        targetLabel: email,
        newRole: role,
        restored: false,
        message: `手动授予 ${roleLabel(role)} 权限${ttlMsgSuffix}`
      });
      state.logs = await getAuditLogs();
    } else {
      state.logs = afterGrantLogs;
    }

    await refreshTtlQueueState();
    renderAll();
    const ttlToastSuffix = ttlSel.expiresAt ? ` · ${ttlSel.label}` : '';
    toast(`已为《${activeFile.name}》添加 ${email} (${roleLabel(role)}${ttlToastSuffix})`);
  } catch (error) {
    toast(`添加失败：${error.message}`);
  }
}

async function handleTtlQueueAction(action, ttlId) {
  if (!ttlId) return;
  try {
    if (action === 'ttl-revoke-now') {
      if (typeof revokeTtlEntryNow !== 'function') {
        throw new Error('限时权限回收模块尚未就绪');
      }
      await revokeTtlEntryNow(ttlId, { interactive: true });
      const [snapshot, logs] = await Promise.all([getSnapshot(), getAuditLogs()]);
      applySnapshotToState(snapshot);
      state.logs = logs;
      await refreshTtlQueueState();
      renderAll();
      toast('已立即收回该限时权限');
    } else if (action === 'ttl-keep-permanent') {
      if (typeof cancelTtlEntry !== 'function') {
        throw new Error('限时权限管理模块尚未就绪');
      }
      await cancelTtlEntry(ttlId);
      state.logs = await getAuditLogs();
      await refreshTtlQueueState();
      renderAll();
      toast('已转为长期权限，不再自动回收');
    }
  } catch (error) {
    toast(`操作失败：${error?.message || error}`);
  }
}

async function handleReapExpiredTtl() {
  const reapBtn = $('ttl-reap-expired-btn');
  if (reapBtn) reapBtn.disabled = true;
  try {
    if (typeof processExpiredTtlPermissions !== 'function') {
      throw new Error('限时权限回收引擎尚未就绪');
    }
    const res = await processExpiredTtlPermissions({ now: Date.now() });
    const [snapshot, logs] = await Promise.all([getSnapshot(), getAuditLogs()]);
    applySnapshotToState(snapshot);
    state.logs = logs;
    await refreshTtlQueueState();
    renderAll();
    const revokedCount = res?.revokedCount ?? 0;
    const downgradedCount = res?.downgradedCount ?? 0;
    const actionedCount = revokedCount + downgradedCount || (res?.processedCount ?? 0);
    const failedCount = res?.failedCount ?? 0;
    if (actionedCount > 0 || failedCount > 0) {
      toast(`到期检查完成：已自动回收 ${actionedCount} 项${failedCount > 0 ? `，失败 ${failedCount} 项` : ''}`);
    } else {
      toast('检查完成：当前暂无已到期的限时权限');
    }
  } catch (error) {
    toast(`检查到期权限失败：${error?.message || error}`);
  } finally {
    renderTtlQueue();
  }
}

async function focusFileInDashboard(rawPayload) {
  let rawId = '';
  let preferredAccount = '';
  if (typeof rawPayload === 'string') {
    rawId = rawPayload.trim();
  } else if (rawPayload && typeof rawPayload === 'object') {
    rawId = String(rawPayload.fileId || rawPayload.id || '').trim();
    preferredAccount = String(rawPayload.accountEmail || rawPayload.preferredAccount || '').trim();
  }
  if (rawId && typeof parseDriveUrlOrId === 'function') {
    const parsed = parseDriveUrlOrId(rawId);
    if (parsed?.fileId) rawId = parsed.fileId;
    else if (typeof parsed === 'string' && parsed) rawId = parsed;
  }
  if (!rawId) return;

  if (typeof chrome !== 'undefined' && chrome.storage?.session?.remove) {
    try {
      await chrome.storage.session.remove('pendingFocusFileId');
    } catch (_e) {
      // ignore session storage error
    }
  }

  state.onboardingDismissed = true;
  switchMainNav('assets');
  setAssetsSubTab('list');

  let targetFile = state.files.find(f => f.id === rawId);
  if (!targetFile && typeof inspectSingleDriveItem === 'function') {
    try {
      if ($('progress')) $('progress').textContent = '正在读取目标文件权限详情…';
      const inspected = await inspectSingleDriveItem(rawId, {
        preferredAccount: preferredAccount || (state.activeAccount !== 'all' ? state.activeAccount : '')
      });
      const fetchedFile = inspected?.file || (inspected?.id ? inspected : null);
      if (fetchedFile && fetchedFile.id) {
        const existIdx = state.files.findIndex(f => f.id === fetchedFile.id);
        if (existIdx >= 0) {
          state.files[existIdx] = fetchedFile;
          targetFile = state.files[existIdx];
        } else {
          state.files.unshift(fetchedFile);
          targetFile = fetchedFile;
        }
        if (typeof hydrateFilesPermissionDiffs === 'function') {
          hydrateFilesPermissionDiffs(state.files, state.permDiffs);
        }
      }
    } catch (error) {
      toast(`读取文件详情失败：${error?.message || error}`);
      return;
    }
  }

  if (!targetFile) {
    renderAll();
    toast('未在当前扫描列表中找到该文件，请先扫描或确认当前账号拥有访问权限');
    return;
  }

  if (state.activeAccount !== 'all') {
    const fileAcc = normalizeEntry(targetFile.ownerAccount || targetFile.scannedByAccount || '');
    if (fileAcc && fileAcc !== normalizeEntry(state.activeAccount)) {
      state.activeAccount = 'all';
    }
  }

  if (!getFilteredFiles().some(f => f.id === targetFile.id)) {
    if ($('file-search')) $('file-search').value = '';
    if ($('search-match-mode')) $('search-match-mode').value = 'or';
    if ($('file-exclude-search')) $('file-exclude-search').value = '';
    if ($('file-group-filter')) $('file-group-filter').value = 'all';
    if ($('file-status-filter')) $('file-status-filter').value = 'all';
    if ($('file-name-pattern')) $('file-name-pattern').value = 'default';
    if ($('hide-private')) $('hide-private').checked = false;
    state.coreNameFilter = '';
    state.selectedTypeCats = new Set(ALL_TYPE_CATS);
  }

  state.inspectedFileId = targetFile.id;
  if (state.activeTab !== 'ops') {
    switchTab('ops');
  }
  renderAll();
  $('file-inspector-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  toast(`已定位文件《${targetFile.name || targetFile.id}》`);
}

async function handleDirectEmailsBatch(mode = 'grant', retryQueue = null, inheritedExpiresAt = '') {
  const targetFiles = state.files.filter(f => state.selectedFileIds.has(f.id));
  const emailsInputEl = $('batch-direct-emails-input');
  const emails = extractEmailsFromText(emailsInputEl?.value || '');
  const role = $('batch-direct-role')?.value || 'reader';
  const isGrant = mode !== 'revoke';
  const modeTitle = isGrant ? `批量授予「${roleLabel(role)}」权限` : '批量移除指定邮箱权限';

  let ttlSel = { preset: 'none', expiresAt: '', label: '长期有效' };
  if (Array.isArray(retryQueue)) {
    const retryExpires = inheritedExpiresAt || retryQueue[0]?.expiresAt || '';
    if (isGrant && retryExpires) {
      ttlSel = {
        preset: 'custom',
        expiresAt: retryExpires,
        label: `限时至 ${formatTime(retryExpires)}`
      };
    }
  } else {
    if (!targetFiles.length) {
      toast('请先在左侧列表勾选至少 1 个文件或文件夹');
      return;
    }
    if (!emails.length) {
      toast('请输入至少 1 个有效的目标邮箱地址');
      emailsInputEl?.focus?.();
      return;
    }
    if (isGrant) {
      try {
        ttlSel = resolveTtlSelection('batch-direct-ttl', 'batch-direct-ttl-custom');
      } catch (ttlError) {
        toast(ttlError.message);
        return;
      }
    }

    const emailSummaryText =
      emails.length <= 3 ? emails.join('、') : `${emails.slice(0, 3).join('、')} 等 ${emails.length} 个邮箱`;
    const ttlDetailSuffix = isGrant && ttlSel.expiresAt ? ` · ${ttlSel.label}` : '';
    const previewItems = targetFiles.map(f => ({
      title: f.name || f.id,
      detail: `${modeTitle} · 目标邮箱：${emailSummaryText}${ttlDetailSuffix}`
    }));

    const ttlSummaryHtml =
      isGrant && ttlSel.expiresAt
        ? ` 授权有效期：<strong>${escapeHtml(ttlSel.label)}</strong>（到期自动回收）。`
        : '';
    const confirmed = await confirmWithDryRunModal({
      title: `指定邮箱批量操作预演：${modeTitle}`,
      summaryHtml: `即将对已勾选的 <strong>${targetFiles.length}</strong> 个文件 / 文件夹，批量对 <strong>${emails.length}</strong> 个邮箱（${escapeHtml(emailSummaryText)}）执行「${escapeHtml(modeTitle)}」。${ttlSummaryHtml}`,
      previewItems,
      confirmText: `确认执行 (${targetFiles.length} 个文件)`,
      isDanger: !isGrant,
      fallbackText: `确认对已勾选的 ${targetFiles.length} 个文件，向 ${emails.length} 个邮箱执行「${modeTitle}」？`
    });
    if (!confirmed) return;
  }

  $('progress').textContent = `正在执行指定邮箱批量操作…`;
  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? `重试指定邮箱批量操作` : modeTitle,
      retryFn: failedItems => handleDirectEmailsBatch(mode, failedItems, ttlSel.expiresAt),
      async runFn({ shouldStop, updateProgress }) {
        state.localTtlMutatingCount += 1;
        state.localTtlMutationEpoch += 1;
        let res;
        try {
          const filesScope = targetFiles.length ? targetFiles : state.files;
          if (typeof executeDirectEmailsBatchOnFiles === 'function') {
            res = await executeDirectEmailsBatchOnFiles({
              files: filesScope,
              emails,
              mode: isGrant ? 'grant' : 'revoke',
              role,
              expiresAt: isGrant ? ttlSel.expiresAt : '',
              expireAction: 'revoke',
              shouldStop,
              retryQueue,
              onProgress(p) {
                if (p?.message) $('progress').textContent = p.message;
                updateProgress({
                  done: p?.done ?? 0,
                  total: p?.total ?? filesScope.length * Math.max(1, emails.length),
                  message: p?.message || `${p?.done ?? 0} / ${p?.total ?? 0}`
                });
              }
            });
          } else {
            let changedCount = 0;
            let failedCount = 0;
            const failedItems = [];
            let stopped = false;
            const tasks = Array.isArray(retryQueue)
              ? retryQueue
              : filesScope.flatMap(f => emails.map(em => ({ fileId: f.id, email: em })));
            const fileMap = new Map(state.files.map(f => [f.id, f]));
            for (let i = 0; i < tasks.length; i++) {
              if (shouldStop()) {
                stopped = true;
                break;
              }
              const t = tasks[i];
              const f = fileMap.get(t.fileId);
              if (!f) continue;
              try {
                const token = await resolveTokenForFile(f, i === 0);
                if (isGrant) {
                  if (typeof grantPermissionWithTtl === 'function') {
                    const gRes = await grantPermissionWithTtl({
                      token,
                      accountEmail: f.ownerAccount || '',
                      file: f,
                      fileId: f.id,
                      type: 'user',
                      role,
                      emailAddress: t.email,
                      expiresAt: ttlSel.expiresAt,
                      expireAction: 'revoke'
                    });
                    const created = gRes?.createdPermission || gRes;
                    f.permissions = f.permissions || [];
                    const ex = f.permissions.find(p => normalizeEntry(p.emailAddress || '') === t.email);
                    if (ex) ex.role = role;
                    else f.permissions.push({ id: created?.id || `perm-${Date.now()}`, type: 'user', role, emailAddress: t.email });
                  } else {
                    const created = await createPermission(token, f.id, { type: 'user', role, emailAddress: t.email });
                    f.permissions = f.permissions || [];
                    f.permissions.push({ id: created?.id || `perm-${Date.now()}`, type: 'user', role, emailAddress: t.email });
                  }
                } else {
                  const targetPerm = (f.permissions || []).find(
                    p => p.role !== 'owner' && normalizeEntry(p.emailAddress || '') === t.email
                  );
                  if (targetPerm) {
                    await deletePermission(token, f.id, targetPerm.id);
                    f.permissions = (f.permissions || []).filter(p => p.id !== targetPerm.id);
                  }
                }
                changedCount++;
              } catch (err) {
                failedCount++;
                failedItems.push({ ...t, expiresAt: ttlSel.expiresAt, errorMessage: err?.message || String(err) });
              }
              updateProgress({ done: i + 1, total: tasks.length, message: `${i + 1} / ${tasks.length}` });
            }
            res = { changedCount, failedCount, failedItems, stopped };
          }
          await saveCurrentFilesSnapshot();
        } finally {
          state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
          state.localTtlMutationEpoch += 1;
        }

        state.logs = await getAuditLogs();
        await refreshTtlQueueState();
        const changed = res?.changedCount ?? ((res?.createdCount || 0) + (res?.updatedCount || 0) + (res?.removedCount || 0));
        const failed = res?.failedCount ?? 0;
        if (isGrant && ttlSel.expiresAt && !res?.stopped && failed === 0 && !Array.isArray(retryQueue)) {
          resetTtlControls('batch-direct-ttl', 'batch-direct-ttl-custom');
        }
        renderAll();
        const summaryDetail = `成功变更 ${changed} 项 · 失败 ${failed} 项`;
        $('progress').textContent = `${res?.stopped ? '指定邮箱操作已暂停' : '指定邮箱操作完成'}：${summaryDetail}`;
        toast(`${res?.stopped ? '已暂停' : '操作完成'}：成功变更 ${changed} 项${failed > 0 ? `，失败 ${failed} 项` : ''}`);
        return { ...res, failCount: failed, summaryDetail };
      }
    });
  } catch (error) {
    toast(`指定邮箱批量操作失败：${error.message}`);
  }
}

async function handleInspectorCompleteGroup(fileId, groupName) {
  const file = state.files.find(f => f.id === fileId);
  if (!file || !groupName) return;
  try {
    $('progress').textContent = `正在为《${file.name}》补齐「${groupName}」成员权限…`;
    const res = await executeGroupBatchOnFiles({
      files: [file],
      groupNames: [groupName],
      mode: 'grant',
      roleOption: 'group_default',
      directory: state.directory
    });
    await saveCurrentFilesSnapshot();
    state.logs = await getAuditLogs();
    $('progress').textContent = `补齐完成：新增 ${res.createdCount} 人`;
    renderAll();
    toast(`已为《${file.name}》补齐「${groupName}」权限（新增 ${res.createdCount} 项）`);
  } catch (error) {
    toast(`补齐分组权限失败：${error.message}`);
  }
}

async function handleBatchRestoreLogs() {
  const filterVal = $('log-filter')?.value || 'all';
  const restorable = state.logs.filter(item => {
    if (filterVal === 'ttl' && !isTtlLogItem(item)) return false;
    if (filterVal !== 'all' && filterVal !== 'ttl' && item.source !== filterVal) return false;
    return isLogRestorable(item);
  });

  if (!restorable.length) {
    toast('当前没有可回滚的日志记录');
    return;
  }

  const previewItems = restorable.map(log => ({
    title: `${log.fileName || log.fileId} · ${log.targetLabel || log.targetEmail || '公开链接'}`,
    detail: `恢复为：${roleLabel(log.previousRole || 'reader')}（原变更：${log.message || log.actionType}）`
  }));

  const confirmed = await confirmWithDryRunModal({
    title: '批量回滚权限变更预演',
    summaryHtml: `即将按逆序恢复当前筛选列表中的 <strong>${restorable.length}</strong> 条权限变更记录。`,
    previewItems,
    confirmText: `确认回滚 (${restorable.length} 项)`,
    isDanger: false,
    fallbackText: `确认批量回滚这 ${restorable.length} 条权限变更记录？`
  });
  if (!confirmed) return;

  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < restorable.length; i++) {
    const log = restorable[i];
    $('progress').textContent = `正在批量回滚 (${i + 1}/${restorable.length}): ${log.fileName || log.fileId}`;
    try {
      const file = state.files.find(f => f.id === log.fileId) || {
        id: log.fileId,
        name: log.fileName,
        ownerAccount: log.accountEmail
      };
      const token = await resolveTokenForFile(file, i === 0);
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
      state.logs = await markAuditLogRestored(log.id);
      okCount++;
    } catch (_err) {
      failCount++;
    }
  }

  await saveCurrentFilesSnapshot();
  $('progress').textContent = `批量回滚完成：成功恢复 ${okCount} 项，失败 ${failCount} 项`;
  renderAll();
  toast(`批量回滚完成：成功恢复 ${okCount} 项`);
}

async function handlePersonBatchOp(email, mode, retryQueue = null) {
  const targetEmail = normalizeEntry(email);
  const label = mode === 'revoke' ? '全部撤权' : '全部降为只读';
  let tasks = [];

  if (Array.isArray(retryQueue)) {
    tasks = retryQueue;
  } else {
    for (const file of getScopedFilesByAccount()) {
      for (const p of file.permissions || []) {
        const isPureInherited =
          permIsInherited(p) && !(typeof permHasDirectGrant === 'function' && permHasDirectGrant(p));
        if (p.role === 'owner' || isPureInherited) continue;
        if (normalizeEntry(p.emailAddress) === targetEmail) {
          if (mode === 'revoke' || (mode === 'downgrade' && p.role !== 'reader')) {
            tasks.push({ fileId: file.id, permId: p.id });
          }
        }
      }
    }

    if (!tasks.length) {
      toast('该人员在当前文件范围内无可处理的直接权限');
      return;
    }

    const fileMap = new Map(state.files.map(f => [f.id, f]));
    const previewItems = tasks.map(({ fileId, permId }) => {
      const file = fileMap.get(fileId);
      const perm = file?.permissions?.find(p => p.id === permId);
      return {
        title: file?.name || fileId,
        detail:
          mode === 'revoke'
            ? `移除 ${targetEmail} (原角色: ${roleLabel(perm?.role || 'reader')})`
            : `${targetEmail}: ${roleLabel(perm?.role || 'writer')} → 仅查看`
      };
    });

    const confirmed = await confirmWithDryRunModal({
      title: `按人员批量操作预演：${label}`,
      summaryHtml: `即将对协作者 <strong>${escapeHtml(targetEmail)}</strong> 涉及的 <strong>${tasks.length}</strong> 个文件执行「${label}」。`,
      previewItems,
      confirmText: `确认${label} (${tasks.length} 项)`,
      isDanger: mode === 'revoke',
      fallbackText: `确认对 ${targetEmail} 涉及的 ${tasks.length} 处权限执行「${label}」？`
    });
    if (!confirmed) return;
  }

  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? `重试人员操作 (${targetEmail})` : `人员${label}：${targetEmail}`,
      retryFn: failedItems => handlePersonBatchOp(targetEmail, mode, failedItems),
      async runFn({ shouldStop, updateProgress }) {
        let ok = 0;
        let failCount = 0;
        let stopped = false;
        const failedItems = [];
        const newLogs = [];
        const fileMap = new Map(state.files.map(f => [f.id, f]));

        for (let i = 0; i < tasks.length; i++) {
          if (shouldStop()) {
            stopped = true;
            break;
          }
          const item = tasks[i];
          const file = fileMap.get(item.fileId);
          const perm = file?.permissions?.find(p => p.id === item.permId);
          if (!file || !perm) {
            updateProgress({ done: i + 1, total: tasks.length });
            continue;
          }
          $('progress').textContent = `正在处理 (${i + 1}/${tasks.length}): ${file.name || file.id}`;
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
          } catch (err) {
            failCount++;
            failedItems.push({ ...item, errorMessage: err?.message || String(err) });
          }
          updateProgress({ done: i + 1, total: tasks.length, message: `${i + 1} / ${tasks.length}` });
        }

        await saveCurrentFilesSnapshot();
        if (newLogs.length) await appendAuditLogs(newLogs);
        state.logs = await getAuditLogs();
        const summaryDetail = `成功 ${ok} 项 · 失败 ${failCount} 项`;
        $('progress').textContent = `${stopped ? '人员权限操作已暂停' : '已完成'} ${targetEmail}：${summaryDetail}`;
        renderAll();
        toast(`${stopped ? '已暂停' : '已处理'} ${ok} 项权限${failCount > 0 ? `，失败 ${failCount} 项` : ''}`);
        return { ok, failCount, stopped, failedItems, summaryDetail };
      }
    });
  } catch (error) {
    toast(`人员权限处理失败：${error.message}`);
  }
}

function resolveOffboardTargetLabel(result) {
  if (!result) return '';
  const list = Array.isArray(result.targetEmails) && result.targetEmails.length
    ? result.targetEmails
    : extractEmailsFromText(result.targetEmail || '');
  if (!list.length) return String(result.targetEmail || '').trim();
  if (list.length === 1) return list[0];
  return `${list[0]} 等 ${list.length} 个邮箱`;
}

function renderOffboardResultBar(result) {
  const bar = $('offboard-result-bar');
  const exportBtn = $('offboard-export-receipt-btn');
  if (!bar) return;
  const targetLabel = resolveOffboardTargetLabel(result);
  if (!result || !targetLabel) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    exportBtn?.classList.add('hidden');
    return;
  }

  const hasReceipt =
    (Array.isArray(result.receiptRows) && result.receiptRows.length > 0) ||
    (Array.isArray(result.ownedFilesSkipped) && result.ownedFilesSkipped.length > 0);
  exportBtn?.classList.toggle('hidden', !hasReceipt);

  const parts = [
    `已撤除 <strong>${result.revokedCount || 0}</strong> 处共享权限`,
    `失败 <strong>${result.failedCount || 0}</strong> 处`
  ];
  if (result.ownedSkippedCount > 0) {
    parts.push(
      `跳过其作为所有者的文件 <strong>${result.ownedSkippedCount}</strong> 个（请使用全盘所有权转移交接）`
    );
  }
  if (result.stopped) {
    parts.push('任务已中途暂停');
  }

  bar.classList.remove('hidden', 'ok', 'warning', 'danger');
  if ((result.failedCount || 0) > 0) {
    bar.classList.add('danger');
  } else if ((result.ownedSkippedCount || 0) > 0 || result.stopped) {
    bar.classList.add('warning');
  } else {
    bar.classList.add('ok');
  }
  bar.innerHTML = `<span><strong>${escapeHtml(targetLabel)}</strong> 移除结果：${parts.join(' · ')}</span>`;
}

function exportLastOffboardReceiptCsv() {
  const last = state.lastOffboardResult;
  const targetLabel = resolveOffboardTargetLabel(last);
  if (!last || !targetLabel) {
    toast('暂无可导出的清退回执记录');
    return;
  }
  const primaryEmailStr =
    Array.isArray(last.targetEmails) && last.targetEmails.length
      ? last.targetEmails.join(', ')
      : String(last.targetEmail || targetLabel);
  const mergedRows = [...(last.receiptRows || [])];
  for (const skipped of last.ownedFilesSkipped || []) {
    const alreadyRecorded = mergedRows.some(
      r => r.fileId === skipped.fileId && (r.status === 'skipped_owner' || r.previousRole === 'owner')
    );
    if (alreadyRecorded) continue;
    mergedRows.push({
      timestamp: new Date().toISOString(),
      accountEmail: skipped.accountEmail || '',
      targetEmail: skipped.targetEmail || primaryEmailStr,
      fileName: skipped.fileName || '',
      fileId: skipped.fileId || '',
      webViewLink: skipped.webViewLink || '',
      previousRole: 'owner',
      previousRoleLabel: '所有者',
      status: 'skipped_owner',
      resultText: '跳过（目标人员为文件所有者，需转移所有权）'
    });
  }

  const csvText = formatOffboardReceiptCsv({
    targetEmail: primaryEmailStr,
    targetEmails: last.targetEmails,
    receiptRows: mergedRows
  });
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const firstEmail = (Array.isArray(last.targetEmails) && last.targetEmails[0]) || primaryEmailStr.split(',')[0] || 'emails';
  const safeUser = firstEmail.trim().replace(/[^a-z0-9._-]+/gi, '_');
  const multiSuffix = Array.isArray(last.targetEmails) && last.targetEmails.length > 1 ? `-${last.targetEmails.length}emails` : '';
  a.href = url;
  a.download = `drive-offboard-receipt-${safeUser}${multiSuffix}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已下载清退审计回执 CSV');
}

async function handleOffboardPerson(explicitEmail = '', retryQueue = null) {
  const inputEl = $('offboard-email-input');
  const rawInput =
    explicitEmail ||
    inputEl?.value ||
    (Array.isArray(retryQueue) ? retryQueue.map(it => it?.targetEmail || '').join('\n') : '');
  const targetEmails = extractEmailsFromText(rawInput);

  if (!targetEmails.length) {
    toast('请输入至少 1 个有效的待移除邮箱地址（多个邮箱可用换行、逗号或空格分隔）');
    inputEl?.focus?.();
    return;
  }
  if (inputEl && explicitEmail) {
    inputEl.value = targetEmails.join('\n');
  }

  const targetEmailSet = new Set(targetEmails);
  const targetEmailJoined = targetEmails.join(', ');
  const displayTarget =
    targetEmails.length === 1
      ? targetEmails[0]
      : `${targetEmails[0]} 等 ${targetEmails.length} 个邮箱`;
  const liveSearch = Boolean($('offboard-live-search-chk')?.checked ?? true);

  if (!Array.isArray(retryQueue)) {
    const scoped = getScopedFilesByAccount();
    const previewItems = [];
    let localSharedCount = 0;
    let localOwnedCount = 0;

    for (const f of scoped) {
      const owner = normalizeEntry(f.ownerAccount || f.owners?.[0]?.emailAddress || '');
      const isOwnedByTarget =
        targetEmailSet.has(owner) ||
        (f.owners || []).some(o => targetEmailSet.has(normalizeEntry(o.emailAddress || '')));
      if (isOwnedByTarget) {
        localOwnedCount++;
        continue;
      }
      for (const p of f.permissions || []) {
        const permEmail = normalizeEntry(p.emailAddress || '');
        if (targetEmailSet.has(permEmail)) {
          if (p.role === 'owner') {
            localOwnedCount++;
          } else {
            localSharedCount++;
            previewItems.push({
              title: f.name || f.id,
              detail: `撤除 ${permEmail} 的${roleLabel(p.role)}权限`
            });
          }
        }
      }
    }

    if (liveSearch) {
      previewItems.unshift({
        title: '云端实时补漏检索已启用',
        detail: `执行时将同步调用 Google Drive API 检索 ${displayTarget} 参与但尚未在本地快照中的遗漏文件并一并撤权`
      });
    }

    if (!liveSearch && localSharedCount === 0 && localOwnedCount === 0) {
      toast('当前本地扫描快照中未发现目标邮箱的关联权限，建议勾选「含云端实时补漏」后重试');
      return;
    }

    const scopeNote =
      state.activeAccount === 'all' ? '全部已授权网盘账号' : `账号 ${state.activeAccount}`;
    const confirmed = await confirmWithDryRunModal({
      title: `移除指定邮箱全部文件权限确认：${displayTarget}`,
      summaryHtml: `即将跨 <strong>${escapeHtml(scopeNote)}</strong> 移除 <strong>${escapeHtml(displayTarget)}</strong> 的所有非所有者共享权限（本地快照已命中 <strong>${localSharedCount}</strong> 处共享权限${localOwnedCount > 0 ? `，另有 <strong>${localOwnedCount}</strong> 个其作为所有者的文件将自动跳过` : ''}${liveSearch ? '，并启用云端实时补漏检索' : ''}）。`,
      previewItems,
      confirmText: `确认一键移除 (${targetEmails.length} 个邮箱)`,
      isDanger: true,
      fallbackText: `确认在 ${scopeNote} 中移除 ${displayTarget} 的全部共享权限？`
    });
    if (!confirmed) return;
  }

  $('progress').textContent = `正在启动 ${displayTarget} 全盘权限移除…`;
  try {
    await runControllableBatchTask({
      title: Array.isArray(retryQueue) ? `重试权限移除失败项 (${displayTarget})` : `移除全部权限：${displayTarget}`,
      retryFn: failedItems => handleOffboardPerson(targetEmailJoined, failedItems),
      async runFn({ shouldStop, updateProgress }) {
        const isRetryRound = Array.isArray(retryQueue);
        const retriedKeys = isRetryRound
          ? new Set(retryQueue.map(it => `${it?.fileId || ''}::${normalizeEntry(it?.targetEmail || '')}`).filter(Boolean))
          : new Set();
        const prevReceiptRows = isRetryRound
          ? (state.lastOffboardResult?.receiptRows || []).filter(
              r =>
                !(
                  r.status === 'failed' &&
                  (retriedKeys.has(`${r.fileId || ''}::${normalizeEntry(r.targetEmail || '')}`) ||
                    retriedKeys.has(`${r.fileId || ''}::`))
                )
            )
          : [];
        const prevOwnedSkipped = isRetryRound
          ? state.lastOffboardResult?.ownedFilesSkipped || []
          : [];

        const offboardFn =
          typeof offboardEmailsAcrossDrive === 'function' ? offboardEmailsAcrossDrive : offboardPersonAcrossDrive;
        const res = await offboardFn({
          targetEmail: targetEmailJoined,
          targetEmails,
          files: state.files,
          targetAccount: state.activeAccount,
          liveSearch,
          shouldStop,
          retryQueue,
          onProgress(p) {
            if (p?.message) $('progress').textContent = p.message;
            updateProgress({
              done: p?.done ?? 0,
              total: p?.total ?? 0,
              message: p?.message || ''
            });
          }
        });

        const freshRows = (res.receiptRows || []).filter(r => {
          if (r.status === 'skipped_owner' || r.previousRole === 'owner') {
            return !prevReceiptRows.some(
              pr => pr.fileId === r.fileId && (pr.status === 'skipped_owner' || pr.previousRole === 'owner')
            );
          }
          return true;
        });
        const mergedReceiptRows = [...prevReceiptRows, ...freshRows];
        const cumulativeRevoked = isRetryRound
          ? mergedReceiptRows.filter(r => r.status === 'revoked' || r.status === 'revoked_cascade').length
          : res.revokedCount || 0;

        const mergedResult = {
          ...res,
          targetEmail: res.targetEmail || targetEmailJoined,
          targetEmails,
          revokedCount: cumulativeRevoked,
          receiptRows: mergedReceiptRows,
          ownedFilesSkipped: prevOwnedSkipped.length ? prevOwnedSkipped : res.ownedFilesSkipped || [],
          ownedSkippedCount: prevOwnedSkipped.length
            ? prevOwnedSkipped.length
            : res.ownedSkippedCount || 0
        };
        state.lastOffboardResult = mergedResult;

        await saveCurrentFilesSnapshot();
        state.logs = await getAuditLogs();
        renderAll();
        renderOffboardResultBar(mergedResult);

        const summaryDetail = `已撤除 ${res.revokedCount} 处 · 失败 ${res.failedCount} 处${mergedResult.ownedSkippedCount > 0 ? ` · 跳过自有文件 ${mergedResult.ownedSkippedCount} 个` : ''}`;
        $('progress').textContent = `${res.stopped ? '权限移除已暂停' : '权限移除完成'} (${displayTarget})：${summaryDetail}`;
        toast(
          `${res.stopped ? '移除已暂停' : '移除完成'}：已撤除 ${displayTarget} 共 ${res.revokedCount} 处权限${res.failedCount > 0 ? `，失败 ${res.failedCount} 处` : ''}`
        );
        return { ...res, summaryDetail };
      }
    });
  } catch (error) {
    toast(`移除全部权限失败：${error.message}`);
  }
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
  const hierarchyMap = buildDriveHierarchyInfo(state.files?.length ? state.files : scoped);
  const orderedScoped = sortItemsByHierarchyTree(scoped, hierarchyMap);
  const rows = [
    [
      '层级 (Level)',
      '完整层级路径 (Full Path)',
      '所在目录路径 (Folder Path)',
      '层级缩进名称 (Tree Name)',
      '文件/文件夹名称 (File Name)',
      '类型 (Type)',
      '文件/文件夹专属链接 (File Link)',
      '所属父文件夹 (Parent Folder)',
      '父文件夹链接 (Parent Folder Link)',
      '顶层根文件夹 (Root Folder)',
      '顶层根文件夹链接 (Root Folder Link)',
      'File ID',
      'Core Series',
      'Category',
      'Owner Account',
      'Group Coverage',
      'Permission ID',
      'Role',
      'Permission Type',
      'Email/Domain',
      'Contact Name',
      'Status',
      'Reason'
    ]
  ];

  for (const file of orderedScoped) {
    const h = hierarchyMap.get(file.id) || {};
    const core = extractCoreFileName(file.name || '');
    const cat = fileDetailedCategory(file.mimeType, file.name);
    const typeLabel = fileCategoryLabel(file.mimeType, file.name);
    const canonicalLink = h.canonicalLink || formatDriveCanonicalLink(file);
    const owner = file.ownerAccount || file.owners?.[0]?.emailAddress || '';
    const covStr = getFileGroupCoverage(file, state.directory)
      .map(c => `${c.groupName}(${c.grantedCount}/${c.totalCount})`)
      .join('; ');

    const baseCols = [
      h.levelLabel || '第 1 层',
      h.fullPath || file.name || '',
      h.folderPath || '根目录',
      h.treeDisplayName || file.name || '',
      file.name || '',
      typeLabel,
      canonicalLink,
      h.parentFolderName || '',
      h.parentFolderLink || '',
      h.rootFolderName || '',
      h.rootFolderLink || '',
      file.id,
      core,
      cat,
      owner,
      covStr
    ];

    const perms = Array.isArray(file.permissions) ? file.permissions : [];
    if (!perms.length) {
      rows.push([...baseCols, '', '', '', '', '', '', '']);
    } else {
      for (const p of perms) {
        const ev = evaluatePermission(p, state.policy, owner);
        const contact = contactLookup.get(normalizeEntry(p.emailAddress || ''));
        rows.push([
          ...baseCols,
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
  }

  const csvContent = rows
    .map(r => r.map(c => escapeCsvCell(c)).join(','))
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
  initDialogLightDismissFallback();
  syncThemeControlsUI();

  // 预先异步缓存当前窗口 ID，确保点击伴随侧边栏按钮时可在首个 await 前同步调用 chrome.sidePanel.open
  const windowIdReadyPromise = (async () => {
    if (typeof chrome !== 'undefined' && typeof chrome.windows?.getCurrent === 'function') {
      try {
        const win = await chrome.windows.getCurrent();
        if (win && typeof win.id === 'number') {
          state.currentWindowId = win.id;
        }
      } catch (_e) {
        // ignore in headless/test environment
      }
    }
  })();

  $('open-sidepanel-btn')?.addEventListener('click', async () => {
    if (
      typeof chrome === 'undefined' ||
      typeof chrome.sidePanel?.open !== 'function' ||
      typeof state.currentWindowId !== 'number'
    ) {
      toast('当前浏览器环境暂不支持直接唤起伴随侧边栏，请从浏览器右上角侧边栏图标中打开');
      return;
    }
    try {
      const openTask = chrome.sidePanel.open({ windowId: state.currentWindowId });
      await openTask;
      toast('已打开网页伴随侧边栏');
    } catch (error) {
      toast(`打开伴随侧边栏失败：${error?.message || error}`);
    }
  });

  bindTtlSelectWithCustomInput('inspector-add-ttl', 'inspector-add-ttl-custom');
  bindTtlSelectWithCustomInput('batch-direct-ttl', 'batch-direct-ttl-custom');
  bindTtlSelectWithCustomInput('batch-group-ttl', 'batch-group-ttl-custom');
  bindTtlSelectWithCustomInput('batch-links-ttl', 'batch-links-ttl-custom');
  bindTtlSelectWithCustomInput('bundle-onboard-ttl', 'bundle-onboard-ttl-custom');

  if ($('scan-scope-select')) {
    const scopeEl = $('scan-scope-select');
    if ([...scopeEl.options].some(o => o.value === 'owned')) {
      scopeEl.value = 'owned';
    }
  }

  // 0. 主题切换、Toast 焦点暂留与冷启动引导事件绑定
  $('theme-toggle-btn')?.addEventListener('click', toggleComfortColorScheme);
  $('theme-mode-select')?.addEventListener('change', e => {
    setExplicitColorScheme(e.target.value);
  });
  if (typeof window !== 'undefined') {
    const schemeMql = window.matchMedia?.('(prefers-color-scheme: dark)');
    schemeMql?.addEventListener?.('change', () => {
      syncThemeControlsUI();
    });
    window.addEventListener?.('storage', e => {
      if (!e || e.key === 'color-scheme' || e.key === null) {
        applyColorSchemeMeta(getStoredColorScheme());
        syncThemeControlsUI();
      }
    });
  }

  const toastNode = $('toast');
  toastNode?.addEventListener('focusout', e => {
    if (toast._pausedForFocus && !toastNode.contains?.(e.relatedTarget)) {
      toast._pausedForFocus = false;
      clearTimeout(toast._timer);
      toast._timer = setTimeout(() => {
        if (!toastNode.matches?.(':focus-within')) {
          hideToastPopover();
        }
      }, 1800);
    }
  });
  $('toast-close-btn')?.addEventListener('click', () => {
    const hadFocusInside = Boolean(
      typeof document !== 'undefined' && toastNode?.contains?.(document.activeElement)
    );
    const prior = toast._priorFocus;
    hideToastPopover();
    if (hadFocusInside && prior && typeof prior.focus === 'function' && prior.isConnected) {
      prior.focus();
    }
  });

  $('onboarding-oauth-file')?.addEventListener('change', async e => {
    await handleOAuthFilesUpload(e.target.files || []);
    e.target.value = '';
  });
  $('onboarding-open-settings-btn')?.addEventListener('click', () => {
    state.onboardingDismissed = true;
    syncOnboardingStageUI();
    switchMainNav('settings');
  });

  // 1. 左侧单列导航栏 + 二级子标签 + 资产树/表格视图切换
  document.querySelectorAll('.rail-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetNav = btn.dataset.nav;
      if (targetNav) switchMainNav(targetNav);
    });
  });

  $('assets-subtab-list-btn')?.addEventListener('click', () => setAssetsSubTab('list'));
  $('assets-subtab-auto-btn')?.addEventListener('click', () => setAssetsSubTab('auto'));

  $('fl-subtab-batch-btn')?.addEventListener('click', () => setFolderLinksSubTab('batch'));
  $('fl-subtab-importrange-btn')?.addEventListener('click', () => setFolderLinksSubTab('importrange'));
  $('fl-subtab-transfer-btn')?.addEventListener('click', () => setFolderLinksSubTab('transfer'));

  $('groups-subtab-dir-btn')?.addEventListener('click', () => setGroupsSubTab('dir'));
  $('groups-subtab-bundles-btn')?.addEventListener('click', () => setGroupsSubTab('bundles'));

  $('assets-view-tree-btn')?.addEventListener('click', () => setAssetsViewMode('tree'));
  $('assets-view-grid-btn')?.addEventListener('click', () => setAssetsViewMode('grid'));
  $('tree-diverged-only-chk')?.addEventListener('change', () => renderFilesTab());

  $('asset-tree-list')?.addEventListener('change', e => {
    const chk = e.target.closest('input[data-action="tree-select-file"]');
    if (!chk) return;
    const fileId = chk.dataset.fileId;
    if (!fileId) return;
    if (chk.checked) state.selectedFileIds.add(fileId);
    else state.selectedFileIds.delete(fileId);
    const row = chk.closest('.tree-node-row');
    if (row) row.classList.toggle('selected', chk.checked);
    const filtered = getFilteredFiles();
    if ($('selected-count')) $('selected-count').textContent = state.selectedFileIds.size;
    if ($('select-all')) {
      $('select-all').checked = filtered.length > 0 && filtered.every(f => state.selectedFileIds.has(f.id));
    }
    updateBatchButtons();
  });

  $('asset-tree-list')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'tree-toggle-folder') {
      const folderId = btn.dataset.folderId;
      if (!folderId) return;
      const isCurrentlyExpanded = btn.getAttribute('aria-expanded') === 'true';
      if (isCurrentlyExpanded) {
        state.expandedTreeFolderIds.delete(folderId);
        state.collapsedTreeFolderIds.add(folderId);
      } else {
        state.collapsedTreeFolderIds.delete(folderId);
        state.expandedTreeFolderIds.add(folderId);
      }
      renderAssetTreeView(getFilteredFiles());
    } else if (action === 'tree-toggle-uniform') {
      const folderId = btn.dataset.folderId;
      if (!folderId) return;
      if (state.expandedUniformGroupIds.has(folderId)) {
        state.expandedUniformGroupIds.delete(folderId);
      } else {
        state.expandedUniformGroupIds.add(folderId);
      }
      renderAssetTreeView(getFilteredFiles());
    } else if (action === 'tree-inspect-file') {
      const fileId = btn.dataset.fileId;
      if (!fileId) return;
      state.inspectedFileId = fileId;
      renderFileInspector();
      document.querySelectorAll('#asset-tree-list .tree-node-row').forEach(r => {
        const isHit = r.dataset.fileId === fileId;
        r.classList.toggle('inspected', isHit);
        r.classList.toggle('active', isHit);
      });
    }
  });

  // 兼容旧右侧/左侧标签切换器（如存在）
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  $('toggle-right-pane-btn')?.addEventListener('click', () => {
    setRightPaneCollapsed(!state.rightPaneCollapsed);
  });

  document.querySelectorAll('.left-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.leftTab;
      if (targetTab === 'batch-links') {
        switchMainNav('folder-links');
        setFolderLinksSubTab('batch');
        return;
      }
      if (targetTab === 'ownership-transfer') {
        switchMainNav('folder-links');
        setFolderLinksSubTab('transfer');
        return;
      }
      switchMainNav('assets');
    });
  });

  // 1.5 单文件协作者检查器 (File Inspector)、安全加固开关、浮动批量 Dock 与 Dry-Run 预览弹窗
  $('inspector-close-btn')?.addEventListener('click', () => {
    state.inspectedFileId = '';
    renderFileInspector();
    document.querySelectorAll('#asset-tree-list .tree-node-row').forEach(r => {
      r.classList.remove('inspected', 'active');
    });
  });

  $('inspector-toggle-writers-share')?.addEventListener('click', () =>
    handleInspectorToggleSecurity('writersCanShare')
  );
  $('inspector-toggle-copy-lock')?.addEventListener('click', () =>
    handleInspectorToggleSecurity('copyRequiresWriterPermission')
  );
  $('inspector-toggle-content-lock')?.addEventListener('click', () =>
    handleInspectorToggleSecurity('contentLock')
  );

  $('dock-open-direct-btn')?.addEventListener('click', () => openBatchActionModal('direct'));
  $('dock-open-group-btn')?.addEventListener('click', () => openBatchActionModal('group'));
  $('dock-open-harden-btn')?.addEventListener('click', () => openBatchActionModal('harden'));
  $('dock-open-cleanup-btn')?.addEventListener('click', () => openBatchActionModal('cleanup'));
  $('dock-save-bundle-btn')?.addEventListener('click', () => openBatchActionModal('save-group'));
  $('batch-save-group-select')?.addEventListener('change', e => {
    if (e.target.value === '__new__') {
      $('batch-save-group-new-name')?.focus?.();
    }
  });
  $('batch-save-group-run-btn')?.addEventListener('click', handleBatchSaveSelectedToGroup);
  bindImeSafeEnter($('batch-save-group-new-name'), handleBatchSaveSelectedToGroup);
  $('batch-modal-close-btn')?.addEventListener('click', () => closeBatchActionModal());
  $('batch-action-modal')?.addEventListener('close', () => {
    $('batch-action-modal')?.classList?.add('hidden');
  });
  $('batch-harden-run-btn')?.addEventListener('click', handleBatchHardenSelected);

  $('inspector-add-perm-btn')?.addEventListener('click', handleInspectorAddPerm);
  bindImeSafeEnter($('inspector-add-email'), handleInspectorAddPerm);

  $('inspector-align-parent-btn')?.addEventListener('click', () => {
    const target = state.files.find(f => f.id === state.inspectedFileId);
    if (target) handleAlignFilesToParent([target]);
  });

  $('batch-task-stop-btn')?.addEventListener('click', () => {
    if (state.batchTaskRunning) {
      state.batchTaskStopRequested = true;
      const stopBtn = $('batch-task-stop-btn');
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.textContent = '正在安全停止…';
      }
      toast('已发出中止指令，当前并发请求完成后立即停止');
    }
  });

  $('batch-task-retry-btn')?.addEventListener('click', () => {
    if (!state.batchTaskRunning && state.batchTaskRetryFn && state.batchTaskFailedItems.length > 0) {
      const itemsToRetry = [...state.batchTaskFailedItems];
      const fn = state.batchTaskRetryFn;
      fn(itemsToRetry);
    }
  });

  $('batch-task-dismiss-btn')?.addEventListener('click', () => {
    clearTimeout(runControllableBatchTask._hideTimer);
    if (!state.batchTaskRunning) {
      $('batch-task-bar')?.classList.add('hidden');
    }
  });

  $('file-inspector-card')?.addEventListener('change', e => {
    const sel = e.target.closest('select[data-action="inspector-role-change"]');
    if (!sel) return;
    handleInlineRoleChange(sel.dataset.fileId, sel.dataset.permId, sel.value);
  });

  $('file-inspector-card')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'inspector-remove-perm') {
      handleRemoveSinglePerm(btn.dataset.fileId, btn.dataset.permId);
    } else if (action === 'inspector-complete-group') {
      handleInspectorCompleteGroup(btn.dataset.fileId, btn.dataset.group);
    } else if (action === 'inspector-enforce-file') {
      const target = state.files.find(f => f.id === btn.dataset.fileId);
      if (target) handleEnforceFiles([target]);
    }
  });

  $('dry-run-close-btn')?.addEventListener('click', () => closeDryRunModal(false));
  $('dry-run-cancel-btn')?.addEventListener('click', () => closeDryRunModal(false));
  $('dry-run-confirm-btn')?.addEventListener('click', () => closeDryRunModal(true));
  const dryRunModal = $('dry-run-modal');
  dryRunModal?.addEventListener('close', () => {
    const ret = dryRunModal.returnValue;
    dryRunModal.returnValue = '';
    resolveActiveDryRun(ret === 'confirm');
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

  document.addEventListener('click', e => {
    $('type-dropdown-menu')?.classList.add('hidden');
    $('batch-group-dropdown-menu')?.classList.add('hidden');
    const gotoGroupsBtn = e.target?.closest?.(
      '[data-action="goto-manage-groups"], #goto-manage-groups-btn, #batch-manage-groups-btn'
    );
    if (gotoGroupsBtn) {
      closeBatchActionModal();
      switchMainNav('groups');
      setGroupsSubTab('dir');
    }
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
      $('scan-scope-select').value = 'owned';
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

  $('clear-diff-flags')?.addEventListener('click', async () => {
    try {
      if (typeof clearScanDiffFlags === 'function') {
        await clearScanDiffFlags();
      } else {
        const snap = await getSnapshot();
        await saveSnapshot({ ...snap, permDiffs: {} });
      }
      state.permDiffs = {};
      for (const f of state.files) {
        f.hasPermDiff = false;
        delete f.permDiff;
        delete f._permDiff;
      }
      if (typeof hydrateFilesPermissionDiffs === 'function') {
        hydrateFilesPermissionDiffs(state.files, {});
      }
      renderAll();
      toast('已清除权限变动标记');
    } catch (error) {
      toast(`清除权限变动标记失败：${error?.message || error}`);
    }
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
    if ($('scan-scope-select') && [...$('scan-scope-select').options].some(o => o.value === 'owned')) {
      $('scan-scope-select').value = 'owned';
      $('custom-folders-scan-bar')?.classList.add('hidden');
    }
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

  $('batch-select-filtered-btn')?.addEventListener('click', () => {
    const filtered = getFilteredFiles();
    if (!filtered.length) {
      toast('当前筛选列表暂无可选文件');
      return;
    }
    for (const f of filtered) state.selectedFileIds.add(f.id);
    renderFilesTab();
    toast(`已勾选当前列表全部 ${filtered.length} 项`);
  });

  $('batch-clear-selection-btn')?.addEventListener('click', () => {
    if (!state.selectedFileIds.size) return;
    state.selectedFileIds.clear();
    renderFilesTab();
    toast('已取消全部勾选');
  });

  $('batch-direct-grant-btn')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleDirectEmailsBatch('grant');
  });
  $('batch-direct-revoke-btn')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleDirectEmailsBatch('revoke');
  });

  $('batch-grant-groups')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleGroupBatchOperation('grant');
  });
  $('batch-keep-only-groups')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleGroupBatchOperation('keep_only_groups');
  });
  $('batch-revoke-groups')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleGroupBatchOperation('revoke_groups');
  });
  $('batch-group-op-mode')?.addEventListener('change', syncBatchOpButtonStyles);
  $('batch-group-op-run-btn')?.addEventListener('click', () => {
    closeBatchActionModal();
    const mode = $('batch-group-op-mode')?.value || 'grant';
    handleGroupBatchOperation(mode);
  });

  $('batch-enforce')?.addEventListener('click', () => {
    closeBatchActionModal();
    const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
    handleEnforceFiles(selected);
  });
  $('batch-downgrade-all')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleBatchQuickAction('downgrade_all');
  });
  $('batch-remove-public')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleBatchQuickAction('remove_public');
  });
  $('batch-revoke-all')?.addEventListener('click', () => {
    closeBatchActionModal();
    handleBatchQuickAction('revoke_all');
  });
  $('batch-quick-action-select')?.addEventListener('change', syncBatchOpButtonStyles);
  $('batch-quick-action-run-btn')?.addEventListener('click', () => {
    closeBatchActionModal();
    const mode = $('batch-quick-action-select')?.value || 'enforce';
    if (mode === 'enforce') {
      const selected = state.files.filter(f => state.selectedFileIds.has(f.id));
      handleEnforceFiles(selected);
    } else {
      handleBatchQuickAction(mode);
    }
  });

  // 5.5 批量输入链接 + 批量邮箱直通授权/关闭权限（左侧第二标签页大工作台）
  const updateBatchLinksParsedInfo = () => {
    const fileIds = parseDriveLinksInput($('batch-links-input')?.value || '');
    const emails = extractEmailsFromText($('batch-emails-input')?.value || '');
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

  // 可搜索单点即用选择器：已有文件/文件夹 -> A 列；分组/成员邮箱 -> B 列
  $('batch-links-asset-search')?.addEventListener('input', renderBatchLinksAssetPicker);
  $('batch-links-asset-type-filter')?.addEventListener('change', renderBatchLinksAssetPicker);
  $('batch-links-asset-picker-list')?.addEventListener('change', e => {
    const chk = e.target.closest('input[data-action="batch-pick-asset"]');
    if (!chk) return;
    const fid = chk.dataset.fileId || '';
    if (!fid) return;
    if (chk.checked) state.pickedBatchAssetIds.add(fid);
    else state.pickedBatchAssetIds.delete(fid);
  });
  $('batch-links-add-picked-assets-btn')?.addEventListener('click', () => {
    const chosenFiles = state.files.filter(f => state.pickedBatchAssetIds.has(f.id));
    if (!chosenFiles.length) {
      toast('请先在列表中勾选至少 1 个已扫描文件或文件夹');
      return;
    }
    const added = appendAssetsToBatchLinksColumnA(chosenFiles);
    state.pickedBatchAssetIds.clear();
    renderBatchLinksAssetPicker();
    if ($('batch-links-asset-picker-disclosure')) {
      $('batch-links-asset-picker-disclosure').open = false;
    }
    toast(added > 0 ? `已将 ${added} 项已扫描资产加入表格 A 列` : '所选资产已在表格 A 列中');
  });

  $('batch-links-email-search')?.addEventListener('input', renderBatchLinksEmailPicker);
  $('batch-links-email-picker-list')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'batch-pick-group-emails') {
      const gName = btn.dataset.group || '';
      const members = (state.directory.contacts || [])
        .filter(c => (c.groups || []).includes(gName))
        .map(c => normalizeEntry(c.email))
        .filter(Boolean);
      if (!members.length) {
        toast(`分组「${gName}」暂无成员邮箱`);
        return;
      }
      const added = appendEmailsToBatchLinksColumnB(members);
      toast(added > 0 ? `已单击带入「${gName}」共 ${added} 个邮箱到 B 列` : `分组「${gName}」的邮箱均已在 B 列中`);
    } else if (action === 'batch-pick-single-email') {
      const em = normalizeEntry(btn.dataset.email || '');
      if (!em) return;
      const added = appendEmailsToBatchLinksColumnB([em]);
      toast(added > 0 ? `已单击添加 ${em} 到 B 列` : `${em} 已在 B 列中`);
    }
  });

  const resetBatchFilterInputs = () => {
    if ($('batch-filter-keyword')) $('batch-filter-keyword').value = '';
    if ($('batch-filter-my-access')) {
      const accEl = $('batch-filter-my-access');
      accEl.value = [...(accEl.options || [])].some(o => o.value === 'owner') ? 'owner' : 'all';
    }
    if ($('batch-filter-link-perm')) $('batch-filter-link-perm').value = 'all';
    if ($('batch-filter-type')) $('batch-filter-type').value = 'all';
    if ($('batch-filter-exec-status')) $('batch-filter-exec-status').value = 'all';
  };
  resetBatchFilterInputs();

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
    const checkEmails = extractEmailsFromText($('batch-emails-input')?.value || '');
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

  const handleApplyPublicModeToLinks = async (targetFileIds, publicMode, retryQueue = null) => {
    if (!Array.isArray(retryQueue)) {
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
    }

    $('batch-links-public-apply-btn').disabled = true;
    $('progress').textContent = `正在批量设置链接公开权限…`;
    try {
      await runControllableBatchTask({
        title: Array.isArray(retryQueue) ? '重试批量链接公开权限设置' : '批量设置链接公开权限',
        retryFn: failedItems => handleApplyPublicModeToLinks(targetFileIds, publicMode, failedItems),
        async runFn({ shouldStop, updateProgress }) {
          const res = await executeBatchLinksPublicAccess({
            fileIds: targetFileIds,
            publicMode,
            existingFiles: state.files,
            targetAccount: state.activeAccount,
            shouldStop,
            retryQueue,
            onProgress(p) {
              if (p?.message) $('progress').textContent = p.message;
              updateProgress({
                done: p?.done ?? 0,
                total: p?.total ?? (Array.isArray(retryQueue) ? retryQueue.length : targetFileIds.length),
                message: p?.message || ''
              });
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

          const summaryDetail = `成功 ${res.successCount} 个 · 失败 ${res.failCount} 个`;
          $('progress').textContent = `${res.stopped ? '公开权限设置已暂停' : '公开权限设置完成'}：${summaryDetail}`;
          toast(`${res.stopped ? '已暂停' : '完成'}：成功设置 ${res.successCount} 个链接，失败 ${res.failCount} 个`);
          return { ...res, summaryDetail };
        }
      });
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
    const existingEmails = extractEmailsFromText($('batch-emails-input')?.value || '');
    const merged = [...new Set([...existingEmails, ...uniqueAccEmails])];
    if ($('batch-emails-input')) $('batch-emails-input').value = merged.join('\n');
    syncInputsToBatchSheet();
    updateBatchLinksParsedInfo();
    toast(`已将 ${uniqueAccEmails.length} 个已导入账号填入 B 列，点击「🔍 扫描链接权限」即可核查可读性`);
  });

  $('batch-links-fill-group')?.addEventListener('change', e => {
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
    const existingEmails = extractEmailsFromText($('batch-emails-input')?.value || '');
    const merged = [...new Set([...existingEmails, ...members])];
    if ($('batch-emails-input')) $('batch-emails-input').value = merged.join('\n');
    e.target.value = '';
    syncInputsToBatchSheet();
    updateBatchLinksParsedInfo();
    toast(`已带入「${gName}」共 ${members.length} 个邮箱到 B 列`);
  });

  $('batch-links-pick-folder')?.addEventListener('change', e => {
    const pickVal = e.target.value;
    if (!pickVal) return;
    e.target.value = '';

    const scoped = getScopedFilesByAccount();
    const sourceFiles = scoped.length ? scoped : state.files;
    const folders = sourceFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    if (!folders.length) {
      toast('当前扫描记录中暂无文件夹，请先执行一次扫描');
      return;
    }

    const folderIdSet = new Set(folders.map(f => f.id));
    const hierarchyMap = buildDriveHierarchyInfo(sourceFiles);
    const orderedFolders = sortItemsByHierarchyTree(folders, hierarchyMap);
    const rootFolders = orderedFolders.filter(f => {
      const pid = Array.isArray(f.parents) && f.parents[0] ? String(f.parents[0]) : '';
      return !pid || !folderIdSet.has(pid);
    });

    let targetFolders = [];
    if (pickVal === '__all_root_folders__') {
      targetFolders = rootFolders;
    } else if (pickVal === '__all_folders__') {
      targetFolders = orderedFolders;
    } else {
      const matched = orderedFolders.find(f => f.id === pickVal);
      if (matched) targetFolders = [matched];
    }

    if (!targetFolders.length) return;

    syncBatchSheetToInputs();
    const rows = (state.batchMasterRows || []).map(r => [...r]);
    const existingIds = new Set(
      rows
        .map(r => parseDriveLinksInput(String(r?.[0] || ''))[0] || '')
        .filter(Boolean)
    );

    let addedCount = 0;
    let emptyScanIdx = 0;
    for (const folder of targetFolders) {
      if (existingIds.has(folder.id)) continue;
      existingIds.add(folder.id);
      const folderLink = formatDriveCanonicalLink(folder) || `https://drive.google.com/drive/folders/${folder.id}`;
      while (emptyScanIdx < rows.length && String(rows[emptyScanIdx]?.[0] || '').trim()) {
        emptyScanIdx++;
      }
      if (emptyScanIdx < rows.length) {
        rows[emptyScanIdx][0] = folderLink;
        rows[emptyScanIdx][2] = '📁 文件夹';
        rows[emptyScanIdx][3] = folder.name || folder.id;
        emptyScanIdx++;
      } else {
        rows.push([folderLink, '', '📁 文件夹', folder.name || folder.id, '', '', '', '']);
        emptyScanIdx = rows.length;
      }
      addedCount++;
    }

    state.batchMasterRows = rows;
    renderBatchMasterToSheet();
    syncBatchSheetToInputs();
    updateBatchLinksParsedInfo();
    toast(
      addedCount > 0
        ? `已将 ${addedCount} 个已扫描文件夹带入表格 A 列`
        : '所选文件夹已在表格 A 列中'
    );
  });

  const handleBatchLinksAction = async (mode = 'grant', retryQueue = null, inheritedExpiresAt = '') => {
    syncBatchSheetToInputs();
    const fileIds = getActiveBatchFileIds();
    const emails = extractEmailsFromText($('batch-emails-input')?.value || '');
    const role = $('batch-links-role').value || 'reader';
    let ttlSel = { preset: 'none', expiresAt: '', label: '长期有效' };

    if (Array.isArray(retryQueue)) {
      const retryExpires = inheritedExpiresAt || retryQueue[0]?.expiresAt || '';
      if (mode === 'grant' && retryExpires) {
        ttlSel = {
          preset: 'custom',
          expiresAt: retryExpires,
          label: `限时至 ${formatTime(retryExpires)}`
        };
      }
    } else {
      if (!fileIds.length) {
        toast('请先在表格 A 列粘贴至少 1 个 Google 文件或文件夹链接');
        return;
      }
      if (!emails.length) {
        toast('请先在表格 B 列输入至少 1 个目标邮箱（或从分组带入）');
        return;
      }

      if (mode === 'grant') {
        try {
          ttlSel = resolveTtlSelection('batch-links-ttl', 'batch-links-ttl-custom');
        } catch (ttlError) {
          toast(ttlError.message);
          return;
        }
      }

      const actionDesc =
        mode === 'grant'
          ? `批量开通「${roleLabel(role)}」权限${ttlSel.expiresAt ? `（${ttlSel.label}，到期自动回收）` : ''}`
          : '批量关闭/移除这些邮箱的权限';

      if (
        !confirm(
          `确认对当前筛选/列表中的 ${fileIds.length} 个链接、${emails.length} 个邮箱执行：\n「${actionDesc}」？\n（全程静默处理，不发送骚扰邮件通知）`
        )
      ) {
        return;
      }
    }

    $('batch-links-grant-btn').disabled = true;
    $('batch-links-revoke-btn').disabled = true;
    $('progress').textContent = `正在启动批量链接权限处理…`;

    try {
      await runControllableBatchTask({
        title: Array.isArray(retryQueue)
          ? '重试批量链接权限失败项'
          : mode === 'grant'
          ? `批量链接开通${roleLabel(role)}`
          : '批量链接移除邮箱权限',
        retryFn: failedItems => handleBatchLinksAction(mode, failedItems, ttlSel.expiresAt),
        async runFn({ shouldStop, updateProgress }) {
          state.localTtlMutatingCount += 1;
          state.localTtlMutationEpoch += 1;
          let res;
          try {
            res = await executeBatchLinksPermissions({
              fileIds,
              emails,
              role,
              mode,
              existingFiles: state.files,
              targetAccount: state.activeAccount,
              expiresAt: mode === 'grant' ? ttlSel.expiresAt : '',
              expireAction: 'revoke',
              shouldStop,
              retryQueue,
              onProgress(p) {
                if (p?.message) $('progress').textContent = p.message;
                updateProgress({
                  done: p?.done ?? 0,
                  total: p?.total ?? (Array.isArray(retryQueue) ? retryQueue.length : fileIds.length * emails.length),
                  message: p?.message || ''
                });
              }
            });
            await saveCurrentFilesSnapshot();
          } finally {
            state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
            state.localTtlMutationEpoch += 1;
          }
          state.logs = await getAuditLogs();
          await refreshTtlQueueState();
          if (mode === 'grant' && ttlSel.expiresAt && !res.stopped && !(res.failCount > 0) && !Array.isArray(retryQueue)) {
            resetTtlControls('batch-links-ttl', 'batch-links-ttl-custom');
          }
          renderAll();

          if (state.batchLinksSheet) {
            const failedFileIdSet = new Set((res.failedItems || []).map(it => it.fileId).filter(Boolean));
            const targetSet = new Set(
              Array.isArray(retryQueue) ? retryQueue.map(it => it.fileId).filter(Boolean) : fileIds
            );
            const rows = state.batchMasterRows || [];
            for (let rIdx = 0; rIdx < rows.length; rIdx++) {
              const parsed = parseDriveLinksInput(rows[rIdx]?.[0] || '');
              if (!parsed.length || !targetSet.has(parsed[0])) continue;
              if (failedFileIdSet.has(parsed[0])) {
                rows[rIdx][7] = `❌ 部分邮箱处理失败（可点击顶部重试）`;
              } else if (!res.stopped) {
                rows[rIdx][7] =
                  mode === 'grant'
                    ? `✅ 已对 ${emails.length} 个邮箱开通${roleLabel(role)}${ttlSel.expiresAt ? ' (限时)' : ''}`
                    : `✅ 已移除 ${emails.length} 个邮箱权限`;
              }
            }
            renderBatchMasterToSheet();
          }

          const summaryDetail = `成功 ${res.successCount} 项 · 失败 ${res.failCount} 项`;
          $('progress').textContent = `${res.stopped ? '批量链接处理已暂停' : '批量链接处理完成'}：${summaryDetail}`;
          toast(
            `${res.stopped ? '已暂停' : '完成'}：成功 ${res.successCount} 项，失败 ${res.failCount} 项`
          );
          return { ...res, summaryDetail };
        }
      });
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

  // 5.8 IMPORTRANGE A列来源表 -> B列目标表 极速批授权与跨表引用核查
  $('ir-batch-run-btn')?.addEventListener('click', () => handleIrBatchAuthRun());
  $('ir-pause-formulas-btn')?.addEventListener('click', () => handleIrToggleFormulas(true));
  $('ir-resume-formulas-btn')?.addEventListener('click', () => handleIrToggleFormulas(false));
  $('ir-import-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (file) await handleIrImportFile(file);
    e.target.value = '';
  });
  $('ir-export-csv-btn')?.addEventListener('click', handleIrExportCsv);
  $('ir-clear-table-btn')?.addEventListener('click', handleIrClearTable);

  $('ir-pick-donor-sheet')?.addEventListener('change', e => {
    const pickedId = (e.target.value || '').trim();
    if (!pickedId) return;
    e.target.value = '';
    const sheetObj = state.files.find(f => f.id === pickedId);
    const link = sheetObj
      ? formatDriveCanonicalLink(sheetObj)
      : `https://docs.google.com/spreadsheets/d/${pickedId}/edit`;
    const added = appendIrBatchPairsToTable([{ donorInput: link, donorId: pickedId, targetInput: '', status: '' }]);
    toast(added > 0 ? `已将「${sheetObj?.name || pickedId}」填入 A 列（来源表）` : '该来源表已在 A 列中');
  });

  $('ir-pick-target-sheet')?.addEventListener('change', e => {
    const pickedId = (e.target.value || '').trim();
    if (!pickedId) return;
    e.target.value = '';
    const sheetObj = state.files.find(f => f.id === pickedId);
    const link = sheetObj
      ? formatDriveCanonicalLink(sheetObj)
      : `https://docs.google.com/spreadsheets/d/${pickedId}/edit`;
    if ($('ir-target-sheet-input')) $('ir-target-sheet-input').value = link;
    syncIrSheetToRows();
    if (!state.irBatchRows.length) state.irBatchRows = Array.from({ length: 30 }, () => ['', '', '']);
    state.irBatchRows[0][1] = link;
    renderIrBatchSheet();
    toast(`已将「${sheetObj?.name || pickedId}」设为 B 列首行目标汇总表（后续行 B 列留空将自动继承）`);
  });

  $('ir-target-sheet-picker')?.addEventListener('change', e => {
    const picked = (e.target.value || '').trim();
    if (picked && $('ir-target-sheet-input')) {
      $('ir-target-sheet-input').value = picked;
    }
  });
  $('ir-scan-btn')?.addEventListener('click', handleScanImportRangeDeps);
  bindImeSafeEnter($('ir-target-sheet-input'), handleScanImportRangeDeps);

  $('ir-fix-all-source-perms-btn')?.addEventListener('click', () => {
    const deps = state.importRangeReport?.dependencies || [];
    const fixableIds = [
      ...new Set(
        deps
          .filter(
            d =>
              d.status === 'missing_source_perm' ||
              (!d.targetOwnerHasAccess && d.canFixSourcePerm !== false)
          )
          .map(d => d.sourceSpreadsheetId || d.sourceId)
          .filter(Boolean)
      )
    ];
    if (!fixableIds.length) {
      toast('当前没有需要补齐源表只读权限的上游表格');
      return;
    }
    handleGrantImportRangeSources(fixableIds);
  });

  $('ir-deps-rows')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="ir-grant-single-source"]');
    if (!btn) return;
    const srcId = (btn.dataset.sourceId || '').trim();
    if (srcId) handleGrantImportRangeSources([srcId]);
  });

  // 5.9 邮箱分组批量添加与跨组批量删除
  $('group-quick-add-btn')?.addEventListener('click', handleGroupQuickAddEmails);
  $('group-batch-remove-btn')?.addEventListener('click', handleGroupBatchRemoveEmails);

  // 6. 人员与分组、岗位权限包、外部合作方生命周期管理
  $('collab-subtab-groups-btn')?.addEventListener('click', () => setCollabSubTab('groups'));
  $('collab-subtab-people-btn')?.addEventListener('click', () => setCollabSubTab('people'));

  $('collab-group-filter')?.addEventListener('change', renderCollaboratorsTab);
  $('collab-search')?.addEventListener('input', renderCollaboratorsTab);
  $('collab-filter')?.addEventListener('change', renderCollaboratorsTab);
  $('collab-domain-category-filter')?.addEventListener('change', renderCollaboratorsTab);
  $('collab-view-people-btn')?.addEventListener('click', () => setCollabViewMode('people'));
  $('collab-view-domains-btn')?.addEventListener('click', () => setCollabViewMode('domains'));

  $('offboard-run-btn')?.addEventListener('click', () => handleOffboardPerson());
  const offboardInputEl = $('offboard-email-input');
  if (offboardInputEl) {
    if (offboardInputEl.tagName === 'TEXTAREA') {
      offboardInputEl.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          handleOffboardPerson();
        }
      });
    } else {
      bindImeSafeEnter(offboardInputEl, () => handleOffboardPerson());
    }
  }
  $('offboard-export-receipt-btn')?.addEventListener('click', exportLastOffboardReceiptCsv);

  $('quick-filter-left-by-group')?.addEventListener('click', () => {
    const g = $('collab-group-filter')?.value || 'all';
    if ($('file-group-filter')) $('file-group-filter').value = g === 'all' ? 'all' : `grp:${g}`;
    switchMainNav('assets');
    setAssetsSubTab('list');
    renderFilesTab();
    toast(g === 'all' ? '已切换至资产视图显示全部文件' : `已在资产视图筛选含「${g}」的文件`);
  });

  const handleGroupListChangeRole = async (gName, nextRole) => {
    if (!gName || !nextRole) return;
    const groups = (state.directory.groups || []).map(g =>
      g.name === gName
        ? { ...g, defaultRole: nextRole, policyTier: nextRole === 'writer' ? 'writer' : 'reader' }
        : g
    );
    state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已将分组「${gName}」默认权限设为${groupRoleDisplayLabel(nextRole)}`);
  };

  const handleDeleteGroupByName = async gName => {
    if (!gName) return;
    const groups = (state.directory.groups || []).filter(g => g.name !== gName);
    const contacts = (state.directory.contacts || []).map(c => {
      const nextGroupRoles =
        c.groupRoles && typeof c.groupRoles === 'object' ? { ...c.groupRoles } : {};
      delete nextGroupRoles[gName];
      return {
        ...c,
        groups: (c.groups || []).filter(g => g !== gName),
        groupRoles: nextGroupRoles
      };
    });
    state.selectedBatchGroups.delete(gName);
    state.directory = await saveDirectory({ groups, contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已删除分组「${gName}」`);
  };

  const handleFilterFilesByGroupAction = gName => {
    if (!gName) return;
    switchMainNav('assets');
    setAssetsSubTab('list');
    if ($('file-group-filter')) $('file-group-filter').value = `grp:${gName}`;
    renderFilesTab();
    toast(`已在资产视图筛选分组「${gName}」关联与绑定的文件`);
  };

  // 岗位权限包（Role Bundles）事件绑定
  $('bundle-save-btn')?.addEventListener('click', handleSaveRoleBundle);
  $('bundle-onboard-run-btn')?.addEventListener('click', handleBundleOnboardRun);
  $('bundle-transfer-run-btn')?.addEventListener('click', handleBundleTransferRun);
  $('bundles-list')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const bundleId = btn.dataset.bundleId || '';
    const target = (state.roleBundles || []).find(b => b.id === bundleId);
    if (!target) return;

    if (action === 'bundle-pick-onboard') {
      if ($('bundle-onboard-select')) $('bundle-onboard-select').value = target.id;
      $('bundle-onboard-emails')?.focus?.();
      toast(`已选中岗位包「${target.name}」，可输入新成员邮箱一键入职授权`);
    } else if (action === 'bundle-edit') {
      state.editingBundleId = target.id;
      if ($('bundle-name-input')) $('bundle-name-input').value = target.name || '';
      if ($('bundle-desc-input')) $('bundle-desc-input').value = target.description || '';
      if ($('bundle-assets-textarea')) {
        $('bundle-assets-textarea').value = (target.items || target.assets || [])
          .map(a => `${a.fileId || ''}, ${a.role || 'reader'}${a.fileName ? `, ${a.fileName}` : ''}`)
          .join('\n');
      }
      $('bundle-name-input')?.focus?.();
      toast(`已载入岗位包「${target.name}」至编辑区`);
    } else if (action === 'bundle-delete') {
      if (!confirm(`确认删除岗位权限包「${target.name}」？（不影响已在 Drive 上授予的现有权限）`)) {
        return;
      }
      const next = (state.roleBundles || []).filter(b => b.id !== bundleId);
      if (state.editingBundleId === bundleId) state.editingBundleId = '';
      if (typeof saveRoleBundles === 'function') {
        state.roleBundles = await saveRoleBundles(next);
      } else {
        state.roleBundles = next;
      }
      renderAll();
      toast(`已删除岗位权限包「${target.name}」`);
    }
  });

  // 外部合作方档案（Partner Profiles）事件绑定
  $('partner-save-btn')?.addEventListener('click', handleSavePartnerProfile);
  $('partners-list')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const partnerId = btn.dataset.partnerId || '';
    const partner = (state.partnerProfiles || []).find(p => p.id === partnerId);
    if (!partner) return;

    if (action === 'partner-filter-files') {
      switchMainNav('assets');
      setAssetsSubTab('list');
      if ($('search-match-mode')) $('search-match-mode').value = 'or';
      if ($('file-exclude-search')) $('file-exclude-search').value = '';
      if ($('file-group-filter')) $('file-group-filter').value = 'all';
      if ($('file-status-filter')) $('file-status-filter').value = 'all';
      if ($('file-name-pattern')) $('file-name-pattern').value = 'default';
      if ($('hide-private')) $('hide-private').checked = false;
      state.coreNameFilter = '';
      state.selectedTypeCats = new Set(ALL_TYPE_CATS);
      syncTypeDropdownUI();
      syncQuickExcludeButtons();
      const queryTokens = [
        ...(partner.domains || []).map(d => `domain:${d}`),
        ...(partner.emails || [])
      ];
      if ($('file-search')) $('file-search').value = queryTokens.join(' ');
      renderFilesTab();
      toast(`已在资产视图筛选合作方「${partner.name}」关联文件`);
    } else if (action === 'partner-offboard-all') {
      const scoped = getScopedFilesByAccount();
      let matchedEmails = [];
      if (typeof matchFilesForPartner === 'function') {
        const info = matchFilesForPartner(scoped, partner, Date.now());
        matchedEmails = info?.matchedEmails || [];
      }
      const allTargets = [...new Set([...(partner.emails || []), ...matchedEmails].map(normalizeEntry).filter(Boolean))];
      if (!allTargets.length) {
        toast(`合作方「${partner.name}」当前未匹配到可清退的共享邮箱`);
        return;
      }
      await handleOffboardPerson(allTargets.join('\n'));
    } else if (action === 'partner-delete') {
      if (!confirm(`确认删除外部合作方档案「${partner.name}」？`)) return;
      const next = (state.partnerProfiles || []).filter(p => p.id !== partnerId);
      if (typeof savePartnerProfiles === 'function') {
        state.partnerProfiles = await savePartnerProfiles(next);
      } else {
        state.partnerProfiles = next;
      }
      renderAll();
      toast(`已删除合作方档案「${partner.name}」`);
    }
  });

  // 共享委派处理器：同时挂在 #view-groups、#view-partners 与兼容占位 #panel-collaborators
  const handleCollabViewChange = async e => {
    const grpRoleSel = e.target.closest('select[data-action="change-group-role"]');
    if (grpRoleSel) {
      await handleGroupListChangeRole(grpRoleSel.dataset.group, grpRoleSel.value);
      return;
    }

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
  };

  const handleCollabViewClick = async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'delete-group') {
      await handleDeleteGroupByName(btn.dataset.group);
    } else if (action === 'filter-files-by-group') {
      handleFilterFilesByGroupAction(btn.dataset.group);
    } else if (action === 'remove-person-group') {
      const email = normalizeEntry(btn.dataset.email);
      const grp = btn.dataset.group;
      const contacts = (state.directory.contacts || []).map(c => {
        if (normalizeEntry(c.email) !== email) return c;
        const nextGroupRoles =
          c.groupRoles && typeof c.groupRoles === 'object' ? { ...c.groupRoles } : {};
        delete nextGroupRoles[grp];
        return {
          ...c,
          groups: (c.groups || []).filter(g => g !== grp),
          groupRoles: nextGroupRoles
        };
      });
      state.directory = await saveDirectory({ groups: state.directory.groups, contacts });
      state.policy = await getPolicy();
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
    } else if (action === 'person-offboard-drive') {
      switchMainNav('partners');
      handleOffboardPerson(btn.dataset.email || '');
    } else if (action === 'domain-filter-files') {
      const domain = (btn.dataset.domain || '').trim().toLowerCase();
      if (!domain) return;
      switchMainNav('assets');
      setAssetsSubTab('list');
      if ($('search-match-mode')) $('search-match-mode').value = 'or';
      if ($('file-exclude-search')) $('file-exclude-search').value = '';
      if ($('file-group-filter')) $('file-group-filter').value = 'all';
      if ($('file-status-filter')) $('file-status-filter').value = 'all';
      if ($('file-name-pattern')) $('file-name-pattern').value = 'default';
      if ($('hide-private')) $('hide-private').checked = false;
      state.coreNameFilter = '';
      state.selectedTypeCats = new Set(ALL_TYPE_CATS);
      syncTypeDropdownUI();
      syncQuickExcludeButtons();
      if ($('file-search')) $('file-search').value = `domain:${domain}`;
      renderFilesTab();
      toast(`已在资产视图筛选含 @${domain} 协作者的共享文件`);
    } else if (action === 'domain-filter-people') {
      const domain = (btn.dataset.domain || '').trim().toLowerCase();
      if (!domain) return;
      if ($('collab-group-filter')) $('collab-group-filter').value = 'all';
      if ($('collab-filter')) $('collab-filter').value = 'all';
      if ($('collab-search')) $('collab-search').value = `@${domain}`;
      switchMainNav('partners');
      setCollabViewMode('people');
      toast(`已按域名 @${domain} 过滤人员列表`);
    }
  };

  for (const containerId of ['view-groups', 'view-partners', 'panel-collaborators']) {
    const el = $(containerId);
    if (!el) continue;
    el.addEventListener('change', handleCollabViewChange);
    el.addEventListener('click', handleCollabViewClick);
  }

  // 7. 安全加固、一键关链、排除目录、第三方关联应用守卫、沉睡高权与日志
  $('security-close-public-btn')?.addEventListener('click', handleClosePublicLinksQuick);
  $('security-harden-writers-btn')?.addEventListener('click', () => handleRadarBulkHarden('writers'));
  $('security-harden-copy-btn')?.addEventListener('click', () => handleRadarBulkHarden('copy'));

  // 7.1 排除扫描目录视图事件绑定
  $('excluded-folder-search')?.addEventListener('input', renderExcludedFoldersView);
  $('excluded-folder-picker-list')?.addEventListener('change', e => {
    const chk = e.target.closest('input[data-action="excluded-pick-folder"]');
    if (!chk) return;
    const fid = chk.dataset.folderId || '';
    if (!fid) return;
    if (chk.checked) state.pickedExcludedFolderIds.add(fid);
    else state.pickedExcludedFolderIds.delete(fid);
  });
  $('excluded-add-picked-btn')?.addEventListener('click', handleExcludedAddPicked);
  $('excluded-add-url-btn')?.addEventListener('click', handleExcludedAddUrl);
  bindImeSafeEnter($('excluded-folder-url-input'), handleExcludedAddUrl);
  bindImeSafeEnter($('excluded-folder-note-input'), handleExcludedAddUrl);
  $('excluded-folders-list')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="remove-excluded-folder"]');
    if (!btn) return;
    const fid = (btn.dataset.folderId || '').trim();
    if (fid) handleRemoveExcludedFolder(fid);
  });

  // 7.2 第三方关联应用拦截与权限守卫事件绑定
  $('oauth-guard-enabled-chk')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ thirdPartyOAuthGuardEnabled: e.target.checked });
  });
  $('oauth-guard-mode-select')?.addEventListener('change', e => {
    const mode = e.target.value === 'alert' ? 'alert' : 'block';
    syncPolicyAndSchedule({ oauthGuardMode: mode });
    toast(mode === 'block' ? '已切换为主动拦截阻断模式' : '已切换为仅桌面提醒模式');
  });
  $('oauth-block-drive-chk')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ blockThirdPartyDriveScope: e.target.checked });
  });
  $('oauth-block-sheets-chk')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ blockThirdPartySheetsScope: e.target.checked });
  });
  $('oauth-guard-keywords-tags')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="remove-oauth-keyword"]');
    if (!btn) return;
    handleRemoveOAuthKeyword(btn.dataset.keyword || '');
  });
  $('oauth-guard-save-btn')?.addEventListener('click', handleSaveOAuthGuardKeywords);
  for (const fieldId of ['oauth-guard-keywords-input', 'oauth-guard-trusted-input']) {
    const el = $(fieldId);
    if (!el) continue;
    if (el.tagName === 'TEXTAREA') {
      el.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          handleSaveOAuthGuardKeywords();
        }
      });
    } else {
      bindImeSafeEnter(el, handleSaveOAuthGuardKeywords);
    }
  }
  $('open-google-connections-btn')?.addEventListener('click', () =>
    openExternalPageSafe('https://myaccount.google.com/connections')
  );
  $('open-google-activity-btn')?.addEventListener('click', () =>
    openExternalPageSafe('https://myaccount.google.com/notifications')
  );
  $('oauth-guard-clear-btn')?.addEventListener('click', handleClearOAuthGuardAlerts);

  $('security-radar-rows')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const fileId = btn.dataset.fileId || '';
    const file = state.files.find(f => f.id === fileId);
    if (!file) return;

    const opts = { files: [file] };
    if (action === 'radar-harden-writers') {
      opts.writersCanShare = false;
    } else if (action === 'radar-harden-copy') {
      opts.copyRequiresWriterPermission = true;
    } else if (action === 'radar-toggle-lock') {
      opts.contentLock = !(file.contentRestrictions || []).some(r => r && r.readOnly);
      opts.lockReason = '由安全雷达面板锁定保护';
    } else {
      return;
    }

    btn.disabled = true;
    try {
      state.localTtlMutatingCount += 1;
      state.localTtlMutationEpoch += 1;
      let res;
      try {
        res = await execSecurityHardeningCompat(opts);
        await saveCurrentFilesSnapshot();
      } finally {
        state.localTtlMutatingCount = Math.max(0, state.localTtlMutatingCount - 1);
        state.localTtlMutationEpoch += 1;
      }
      state.logs = await getAuditLogs();
      renderAll();
      if (res?.failedCount > 0) {
        toast(`安全加固失败：${res.failedItems?.[0]?.errorMessage || res.failedItems?.[0]?.error || '请检查账号权限'}`);
      } else {
        toast(`已更新「${file.name || file.id}」的安全防扩散设置`);
      }
    } catch (error) {
      toast(`安全加固失败：${error?.message || error}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('dormant-days-select')?.addEventListener('change', () => {
    renderDormantRadar();
  });
  $('dormant-scan-btn')?.addEventListener('click', () => {
    renderDormantRadar();
    const days = Number($('dormant-days-select')?.value || 90) || 90;
    toast(`沉睡高权扫描完成：发现 ${state.dormantEntries.length} 条超过 ${days} 天未活跃的编辑权限`);
  });
  $('dormant-downgrade-all-btn')?.addEventListener('click', () => {
    handleExecuteDormantEntries(state.dormantEntries || [], 'downgrade_reader');
  });
  $('dormant-rows')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    const entry = Number.isInteger(idx) ? (state.dormantEntries || [])[idx] : null;
    if (!entry) return;
    if (btn.dataset.action === 'dormant-downgrade-one') {
      handleExecuteDormantEntries([entry], 'downgrade_reader');
    } else if (btn.dataset.action === 'dormant-revoke-one') {
      handleExecuteDormantEntries([entry], 'revoke');
    }
  });
  $('ttl-reap-expired-btn')?.addEventListener('click', handleReapExpiredTtl);
  $('ttl-queue-rows')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'ttl-revoke-now' || action === 'ttl-keep-permanent') {
      await handleTtlQueueAction(action, btn.dataset.ttlId || '');
    }
  });
  $('log-filter').addEventListener('change', renderLogsTab);
  $('batch-restore-logs-btn')?.addEventListener('click', handleBatchRestoreLogs);
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

  // 8. 分组新建、批量建组、Google 表格读取与系统设置
  $('oauth-json-file')?.addEventListener('change', async e => {
    await handleOAuthFilesUpload(e.target.files || []);
    e.target.value = '';
  });
  $('add-account-btn')?.addEventListener('click', () => handleAddMoreAccount('', ''));

  $('create-group-btn')?.addEventListener('click', async () => {
    const name = ($('new-group-name')?.value || '').trim();
    const defaultRole = $('new-group-role')?.value || 'reader';
    if (!name) {
      toast('请输入新分组名称（如：财务组、审计组）');
      $('new-group-name')?.focus?.();
      return;
    }
    const groups = [...(state.directory.groups || [])];
    const existing = groups.find(g => g.name === name);
    if (existing) {
      existing.defaultRole = defaultRole;
      existing.policyTier = defaultRole === 'writer' ? 'writer' : 'reader';
    } else {
      groups.push({
        name,
        defaultRole,
        policyTier: defaultRole === 'writer' ? 'writer' : 'reader'
      });
    }
    if ($('new-group-name')) $('new-group-name').value = '';
    state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(`已保存分组「${name}」（默认${groupRoleDisplayLabel(defaultRole)}）`);
  });
  bindImeSafeEnter($('new-group-name'), () => $('create-group-btn')?.click());

  $('batch-create-groups-btn')?.addEventListener('click', async () => {
    const textareaEl = $('batch-groups-textarea');
    const rawText = (textareaEl?.value || '').trim();
    const fallbackRole = $('batch-groups-default-role')?.value || 'reader';
    if (!rawText) {
      toast('请先输入要批量建立的分组名称（每行一个，可选附带权限如：财务组, 可编辑）');
      textareaEl?.focus?.();
      return;
    }

    let parsedGroups = [];
    if (typeof parseBatchGroupsText === 'function') {
      parsedGroups = parseBatchGroupsText(rawText, fallbackRole);
    } else {
      for (const rawLine of rawText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split(/[\t,，:：|]+/).map(s => s.trim()).filter(Boolean);
        if (!parts.length) continue;
        const gName = parts[0];
        let gRole = fallbackRole;
        if (parts[1]) {
          if (typeof normalizePermissionRole === 'function') {
            const matched = normalizePermissionRole(parts[1], '');
            if (matched) gRole = matched;
          } else if (/edit|write|编辑|读写|修改/i.test(parts[1])) {
            gRole = 'writer';
          } else if (/comment|评论|批注/i.test(parts[1])) {
            gRole = 'commenter';
          } else if (/read|view|查看|只读|浏览/i.test(parts[1])) {
            gRole = 'reader';
          }
        }
        parsedGroups.push({
          name: gName,
          defaultRole: gRole,
          policyTier: gRole === 'writer' ? 'writer' : 'reader'
        });
      }
    }

    if (!parsedGroups.length) {
      toast('未识别到有效的分组名称');
      return;
    }

    const groups = [...(state.directory.groups || [])];
    let createdCount = 0;
    let updatedCount = 0;
    for (const item of parsedGroups) {
      const existing = groups.find(g => g.name === item.name);
      if (existing) {
        existing.defaultRole = item.defaultRole;
        existing.policyTier = item.policyTier || (item.defaultRole === 'writer' ? 'writer' : 'reader');
        updatedCount++;
      } else {
        groups.push({
          name: item.name,
          defaultRole: item.defaultRole,
          policyTier: item.policyTier || (item.defaultRole === 'writer' ? 'writer' : 'reader')
        });
        createdCount++;
      }
    }

    if (textareaEl) textareaEl.value = '';
    if ($('batch-create-groups-disclosure')) $('batch-create-groups-disclosure').open = false;
    state.directory = await saveDirectory({ groups, contacts: state.directory.contacts });
    state.policy = await getPolicy();
    renderAll();
    toast(
      `批量建组完成：新建 ${createdCount} 个分组${updatedCount > 0 ? ` · 更新 ${updatedCount} 个已有分组` : ''}`
    );
  });

  const resolveTargetGroupFallbackRole = grpName => {
    if (!grpName) return 'reader';
    const matched = (state.directory.groups || []).find(g => g.name === grpName);
    return matched?.defaultRole || 'reader';
  };

  $('import-contacts-csv')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const targetGrp = $('import-target-group-select')?.value || '';
      const rows = parseTabularContactsText(text, targetGrp, resolveTargetGroupFallbackRole(targetGrp));
      await importParsedContacts(rows, targetGrp);
    } catch (error) {
      toast(`读取 CSV 失败：${error.message}`);
    } finally {
      e.target.value = '';
    }
  });

  $('parse-paste-contacts-btn')?.addEventListener('click', async () => {
    const text = ($('paste-contacts-textarea')?.value || '').trim();
    if (!text) {
      toast('请先粘贴表格内容（A列邮箱 · B列权限，可选C列组名）');
      return;
    }
    const targetGrp = $('import-target-group-select')?.value || '';
    const rows = parseTabularContactsText(text, targetGrp, resolveTargetGroupFallbackRole(targetGrp));
    await importParsedContacts(rows, targetGrp);
    if ($('paste-contacts-textarea')) $('paste-contacts-textarea').value = '';
  });

  $('fetch-drive-sheet-contacts-btn')?.addEventListener('click', async () => {
    const idOrUrl = ($('drive-sheet-url-input')?.value || '').trim() || $('drive-sheet-picker')?.value || '';
    if (!idOrUrl) {
      toast('请先粘贴 Google 表格链接或从下拉框选择已扫描表格');
      return;
    }
    const btn = $('fetch-drive-sheet-contacts-btn');
    const origText = btn?.textContent || '读取表格导入';
    if (btn) btn.disabled = true;
    try {
      const targetGrp = $('import-target-group-select')?.value || '';
      const token = await getValidTokenForAccount(state.activeAccount !== 'all' ? state.activeAccount : '', true);
      const rows = await fetchContactsFromGoogleSheet(
        token,
        idOrUrl,
        targetGrp,
        resolveTargetGroupFallbackRole(targetGrp)
      );
      await importParsedContacts(rows, targetGrp);
    } catch (error) {
      toast(`读取 Google 表格失败：${error.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText;
      }
    }
  });

  $('policy-schedule-enabled')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ scheduleEnabled: e.target.checked });
  });
  $('policy-schedule-minutes')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ scheduleMinutes: Number(e.target.value) || 720 });
  });
  $('policy-startup-scan-chk')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ scanOnBrowserStartup: e.target.checked });
  });
  $('auto-enforce-select')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ autoEnforce: e.target.value === 'enforce' });
  });
  $('policy-public-rule')?.addEventListener('change', e => {
    syncPolicyAndSchedule({ publicLinkRule: e.target.value });
  });

  $('add-writer-btn').addEventListener('click', async () => {
    const items = parseKeywords($('add-writer-input').value);
    if (!items.length) return;
    $('add-writer-input').value = '';
    await syncPolicyAndSchedule({ writers: [...state.policy.writers, ...items] });
  });
  bindImeSafeEnter($('add-writer-input'), () => $('add-writer-btn')?.click());

  $('add-reader-btn').addEventListener('click', async () => {
    const items = parseKeywords($('add-reader-input').value);
    if (!items.length) return;
    $('add-reader-input').value = '';
    await syncPolicyAndSchedule({ readers: [...state.policy.readers, ...items] });
  });
  bindImeSafeEnter($('add-reader-input'), () => $('add-reader-btn')?.click());

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

  const handleSettingsViewClick = async e => {
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
      await handleDeleteGroupByName(btn.dataset.group);
    } else if (action === 'filter-files-by-group') {
      handleFilterFilesByGroupAction(btn.dataset.group);
    } else if (action === 'del-writer') {
      await syncPolicyAndSchedule({
        writers: state.policy.writers.filter(x => x !== btn.dataset.val)
      });
    } else if (action === 'del-reader') {
      await syncPolicyAndSchedule({
        readers: state.policy.readers.filter(x => x !== btn.dataset.val)
      });
    }
  };
  $('view-settings')?.addEventListener('click', handleSettingsViewClick);
  $('panel-settings')?.addEventListener('click', handleSettingsViewClick);

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
  bindImeSafeEnter($('transfer-source-folder-input'), handleTransferScanSpecificFolder);

  $('toggle-transfer-log-btn')?.addEventListener('click', () => {
    const drawer = $('transfer-log-drawer');
    if (!drawer) return;
    const isCollapsed = drawer.classList.toggle('collapsed');
    $('toggle-transfer-log-btn')?.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    const caret = $('transfer-log-caret');
    if (caret) {
      caret.textContent = isCollapsed ? '▴ 展开' : '▾ 收起';
    }
    if (!isCollapsed) {
      const box = $('transfer-log-console');
      if (box) box.scrollTop = box.scrollHeight;
    }
  });
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
  $('transfer-restore-spam-trash-btn')?.addEventListener('click', handleTransferRestoreSpamAndTrash);
  $('transfer-verify-compare-btn')?.addEventListener('click', handleTransferVerifyCompare);

  let pendingWebAcceptOpened = false;
  let pendingWebSpamOpened = false;
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

  $('transfer-open-web-spam-btn')?.addEventListener('click', () => {
    pendingWebSpamOpened = true;
    const url = 'https://drive.google.com/drive/spam';
    try {
      chrome.tabs.create({ url });
    } catch (_e) {
      window.open?.(url, '_blank');
    }
    appendTransferLog(
      '🧹 已打开 Google Drive 网页端「垃圾内容 (drive.google.com/drive/spam)」文件夹：请在网页按 Ctrl+A 全选所有被误判的文件 -> 右键点击「不是垃圾内容 (Not spam)」；操作完切回本插件窗口时，将自动把恢复出来的文件重新归位回原文件夹！',
      true
    );
    toast('已打开『垃圾内容』页：按 Ctrl+A 全选 -> 右键「不是垃圾内容」，切回本页将自动归位目录！');
  });

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', () => {
      if (pendingWebAcceptOpened && !state.transferRunning && (state.transferState?.items || []).some(it => it.stage === 'pending_accept')) {
        pendingWebAcceptOpened = false;
        handleTransferVerifyCompare();
      }
      if (pendingWebSpamOpened && !state.transferRunning) {
        pendingWebSpamOpened = false;
        handleTransferMountToRoot();
      }
    });
  }

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

  // 9. 加载存储数据并首次渲染（含全盘所有权转移断点缓存、岗位包、合作方档案、权限变更 Diff 与限时权限队列自动恢复）
  try {
    const [policy, directory, presets, logs, oauthClients, accounts, snapshot, transferState] = await Promise.all([
      getPolicy(),
      getDirectory(),
      getFilterPresets(),
      getAuditLogs(),
      getOAuthClients(),
      getAuthorizedAccounts(),
      getSnapshot(),
      getOwnershipTransferState(),
      refreshTtlQueueState(),
      refreshBundlesAndPartnersState(),
      refreshAutoPatrolCheckpointState(),
      refreshThirdPartyAppAlertsState(),
      windowIdReadyPromise
    ]);

    state.policy = policy;
    state.directory = directory;
    state.filterPresets = presets;
    state.logs = logs;
    state.oauthClients = oauthClients;
    state.accounts = accounts;
    applySnapshotToState(snapshot);
    state.transferState = transferState;

    if (state.lastScanAt) {
      $('progress').textContent = `上次扫描：${formatTime(state.lastScanAt)}（共 ${state.files.length} 个文件）`;
    }
  } catch (error) {
    console.error('加载缓存失败:', error);
  }

  switchMainNav(state.activeNav || 'assets');
  setAssetsSubTab(state.assetsSubTab || 'list');
  setFolderLinksSubTab(state.flSubTab || 'batch');
  setGroupsSubTab(state.groupsSubTab || 'dir');
  setAssetsViewMode(state.assetsViewMode || 'tree');
  renderAll();

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(async (message, sender) => {
      if (sender?.id !== chrome.runtime.id) return;
      if (message?.type === 'SCAN_UPDATED') {
        try {
          const [snapshot, logs] = await Promise.all([getSnapshot(), getAuditLogs()]);
          applySnapshotToState(snapshot);
          state.logs = logs;
          await Promise.all([refreshTtlQueueState(), refreshAutoPatrolCheckpointState()]);
          renderAll();
        } catch (_e) {
          // ignore background sync refresh error
        }
      } else if (message?.type === 'TTL_UPDATED') {
        try {
          if (state.localTtlMutatingCount > 0) {
            await refreshTtlQueueState();
            renderTtlQueue();
            return;
          }
          const epochBeforeRead = state.localTtlMutationEpoch;
          const [snapshot, logs] = await Promise.all([getSnapshot(), getAuditLogs()]);
          await refreshTtlQueueState();
          if (state.localTtlMutatingCount > 0 || state.localTtlMutationEpoch !== epochBeforeRead) {
            renderTtlQueue();
            return;
          }
          applySnapshotToState(snapshot);
          state.logs = logs;
          renderAll();
        } catch (_e) {
          // ignore background ttl sync refresh error
        }
      } else if (message?.type === 'FOCUS_FILE_IN_DASHBOARD') {
        try {
          await focusFileInDashboard(message);
        } catch (_e) {
          // ignore focus file error
        }
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName === 'local') {
        if (changes?.thirdPartyAppAlerts) {
          const nextAlerts = changes.thirdPartyAppAlerts.newValue;
          state.thirdPartyAppAlerts = Array.isArray(nextAlerts) ? nextAlerts : [];
          renderThirdPartyAppAlerts();
        }
        if (changes?.autoScanCheckpoint) {
          state.autoScanCheckpoint = changes.autoScanCheckpoint.newValue || null;
          renderAutoPatrolCheckpointInfo();
        }
        if (changes?.policy?.newValue && typeof changes.policy.newValue === 'object') {
          const mergedPolicy = { ...DEFAULT_POLICY, ...changes.policy.newValue };
          if (JSON.stringify(state.policy) !== JSON.stringify(mergedPolicy)) {
            state.policy = mergedPolicy;
            pruneExcludedSelectionAndInspector();
            renderAll();
          }
        }
      }
      if (areaName === 'local' && changes?.ttlPermissionsQueue) {
        try {
          const nextQueue = changes.ttlPermissionsQueue.newValue;
          if (Array.isArray(nextQueue)) {
            state.ttlQueue = nextQueue;
          } else {
            await refreshTtlQueueState();
          }
          if (state.localTtlMutatingCount > 0) {
            renderTtlQueue();
            return;
          }
          const epochBeforeRead = state.localTtlMutationEpoch;
          const [snapshot, logs] = await Promise.all([getSnapshot(), getAuditLogs()]);
          if (state.localTtlMutatingCount > 0 || state.localTtlMutationEpoch !== epochBeforeRead) {
            renderTtlQueue();
            return;
          }
          applySnapshotToState(snapshot);
          state.logs = logs;
          renderAll();
        } catch (_e) {
          // ignore ttl storage sync error
        }
      } else if (
        areaName === 'local' &&
        (Array.isArray(changes?.scanSnapshot?.newValue?.files) || Array.isArray(changes?.auditLogs?.newValue))
      ) {
        if (
          state.localTtlMutatingCount > 0 ||
          state.batchTaskRunning ||
          state.transferRunning ||
          Boolean($('scan')?.disabled)
        ) {
          return;
        }
        try {
          let hasChanged = false;
          const nextSnapFiles = changes?.scanSnapshot?.newValue?.files;
          if (Array.isArray(nextSnapFiles) && state.files.length > 0) {
            const incomingById = new Map();
            for (const sf of nextSnapFiles) {
              if (sf && sf.id) incomingById.set(sf.id, sf);
            }
            for (const localFile of state.files) {
              const inc = incomingById.get(localFile.id);
              if (!inc) continue;
              if (
                typeof inc.writersCanShare === 'boolean' &&
                localFile.writersCanShare !== inc.writersCanShare
              ) {
                localFile.writersCanShare = inc.writersCanShare;
                hasChanged = true;
              }
              if (
                typeof inc.copyRequiresWriterPermission === 'boolean' &&
                localFile.copyRequiresWriterPermission !== inc.copyRequiresWriterPermission
              ) {
                localFile.copyRequiresWriterPermission = inc.copyRequiresWriterPermission;
                hasChanged = true;
              }
              const nextLocked = Boolean(
                inc.contentLocked || inc.contentRestrictions?.some?.(r => Boolean(r?.readOnly))
              );
              const prevLocked = Boolean(
                localFile.contentLocked || localFile.contentRestrictions?.some?.(r => Boolean(r?.readOnly))
              );
              if (prevLocked !== nextLocked) {
                localFile.contentLocked = nextLocked;
                hasChanged = true;
              }
              const nextReason = String(
                inc.contentLockReason ||
                  inc.contentRestrictions?.find?.(r => Boolean(r?.readOnly))?.reason ||
                  ''
              );
              const prevReason = String(localFile.contentLockReason || '');
              if (prevReason !== nextReason) {
                localFile.contentLockReason = nextReason;
                hasChanged = true;
              }
              if (Array.isArray(inc.contentRestrictions)) {
                const prevRestr = JSON.stringify(localFile.contentRestrictions || []);
                const nextRestr = JSON.stringify(inc.contentRestrictions);
                if (prevRestr !== nextRestr) {
                  localFile.contentRestrictions = inc.contentRestrictions;
                  hasChanged = true;
                }
              } else if (!nextLocked && Array.isArray(localFile.contentRestrictions) && localFile.contentRestrictions.length > 0) {
                localFile.contentRestrictions = [];
                hasChanged = true;
              }
            }
          }
          const nextLogs = changes?.auditLogs?.newValue;
          if (Array.isArray(nextLogs)) {
            const prevTopId = state.logs[0]?.id || '';
            const nextTopId = nextLogs[0]?.id || '';
            if (state.logs.length !== nextLogs.length || prevTopId !== nextTopId) {
              state.logs = nextLogs;
              hasChanged = true;
            }
          }
          if (hasChanged) {
            renderAll();
          }
        } catch (_e) {
          // ignore sidepanel security snapshot sync error
        }
      } else if (areaName === 'session' && changes?.pendingFocusFileId?.newValue) {
        try {
          await focusFileInDashboard(changes.pendingFocusFileId.newValue);
        } catch (_e) {
          // ignore session focus error
        }
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
    try {
      const sessionData = await chrome.storage.session.get('pendingFocusFileId');
      if (sessionData?.pendingFocusFileId) {
        await focusFileInDashboard(sessionData.pendingFocusFileId);
      }
    } catch (_e) {
      // ignore session storage read error
    }
  }
}

init();
