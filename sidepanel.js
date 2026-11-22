const $ = id => document.getElementById(id);

const spState = {
  windowId: null,
  accounts: [],
  preferredAccount: '',
  matchedAccount: '',
  currentFile: null,
  ancestorIds: [],
  policy: { ...DEFAULT_POLICY },
  directory: JSON.parse(JSON.stringify(DEFAULT_DIRECTORY)),
  evaluation: null,
  breakage: null,
  ttlEntries: [],
  activeActionTab: 'share',
  currentSource: 'tab',
  inspectLoading: false,
  inspectSeq: 0,
  busyAction: false
};

/* ==================== 工具函数：HTML 转义、外链净化与时间格式 ==================== */

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function sanitizeExternalUrl(url = '') {
  if (!url) return '#';
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch (_e) {
    // 拒绝非 http/https 协议
  }
  return '#';
}

function buildDefaultCustomDateTimeValue(offsetHours = 24) {
  const dt = new Date(Date.now() + offsetHours * 3600 * 1000);
  const pad = num => String(num).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function formatReadableDateTime(iso = '') {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso);
  return dt.toLocaleString('zh-CN', { hour12: false });
}

/* ==================== 现代交互组件：主题同步、IME 安全回车与 Top-Layer Toast ==================== */

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
  const toggleBtn = $('sp-theme-btn');
  if (toggleBtn) {
    const label = rendered === 'dark' ? '切换至浅色界面' : '切换至深色界面';
    toggleBtn.setAttribute?.('aria-label', label);
    toggleBtn.title = label;
  }
}

function toggleSidepanelColorScheme() {
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

function hideToastPopover() {
  const node = $('sp-toast');
  if (!node) return;
  toast._paused = false;
  toast._hovered = false;
  if (typeof node.hidePopover === 'function') {
    try {
      node.hidePopover();
    } catch (_e) {
      // 忽略已关闭状态
    }
  }
  node.classList.remove(':popover-open', 'show');
}

function scheduleToastAutoHide(delayMs = 4200) {
  const node = $('sp-toast');
  if (!node) return;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    if (toast._hovered || node.matches?.(':focus-within')) {
      toast._paused = true;
      return;
    }
    hideToastPopover();
  }, delayMs);
}

function toast(message) {
  const node = $('sp-toast');
  if (!node) return;
  const cleanMsg = String(message ?? '').replaceAll('\u2014', '·');

  if (typeof document !== 'undefined' && document.activeElement && !node.contains?.(document.activeElement)) {
    toast._priorFocus = document.activeElement;
  }

  const textNode = $('sp-toast-text');
  if (textNode) {
    textNode.textContent = cleanMsg;
  } else {
    node.textContent = cleanMsg;
  }

  if (typeof node.showPopover === 'function') {
    try {
      node.showPopover();
    } catch (_e) {
      // 已处于顶层打开状态
    }
  } else {
    node.classList.add(':popover-open');
  }

  if (typeof document !== 'undefined' && typeof document.ariaNotify === 'function') {
    try {
      document.ariaNotify(cleanMsg);
    } catch (_e) {
      // 回退至下方 aria-live
    }
  } else {
    const liveNode = $('sp-toast-live');
    if (liveNode) {
      liveNode.textContent = '';
      setTimeout(() => {
        liveNode.textContent = cleanMsg;
      }, 16);
    }
  }

  toast._paused = false;
  scheduleToastAutoHide(4200);
}

/* ==================== 对接 core.js 的安全兼容封装 ==================== */

function compatParseDriveUrlOrId(input = '') {
  if (typeof parseDriveUrlOrId === 'function') {
    return parseDriveUrlOrId(input);
  }
  const raw = String(input || '').trim();
  if (!raw) {
    return { fileId: '', kind: 'unknown', isDriveDomain: false, rawUrl: '' };
  }

  let isDriveDomain = false;
  let isUrl = false;
  try {
    const parsedUrl = new URL(raw);
    isUrl = true;
    const host = parsedUrl.hostname.toLowerCase();
    isDriveDomain =
      host === 'drive.google.com' ||
      host === 'docs.google.com' ||
      host === 'script.google.com';
  } catch (_e) {
    isUrl = false;
  }

  if (isUrl && !isDriveDomain) {
    return { fileId: '', kind: 'unknown', isDriveDomain: false, rawUrl: raw };
  }

  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) {
    return { fileId: folderMatch[1], kind: 'folder', isDriveDomain: true, rawUrl: raw };
  }
  const docMatch = raw.match(/\/(document|spreadsheets|presentation|forms|drawings|file)\/d\/([a-zA-Z0-9_-]{10,})/);
  if (docMatch) {
    return { fileId: docMatch[2], kind: docMatch[1], isDriveDomain: true, rawUrl: raw };
  }
  const genericDMatch = raw.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (genericDMatch) {
    return { fileId: genericDMatch[1], kind: 'file', isDriveDomain: true, rawUrl: raw };
  }
  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch) {
    return { fileId: idParamMatch[1], kind: 'file', isDriveDomain, rawUrl: raw };
  }
  if (!isUrl && /^[a-zA-Z0-9_-]{15,}$/.test(raw)) {
    return { fileId: raw, kind: 'id', isDriveDomain: false, rawUrl: raw };
  }
  return { fileId: '', kind: 'unknown', isDriveDomain, rawUrl: raw };
}

function compatResolveTtlExpiresAt(ttlPreset = 'none', customDateTime = '') {
  if (typeof resolveTtlExpiresAt === 'function') {
    return resolveTtlExpiresAt(ttlPreset, customDateTime);
  }
  const preset = String(ttlPreset || 'none').trim();
  if (!preset || preset === 'none' || preset === 'permanent') {
    return null;
  }
  const now = Date.now();
  const presetMsMap = {
    '1h': 3600 * 1000,
    '24h': 24 * 3600 * 1000,
    '7d': 7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000
  };
  if (presetMsMap[preset]) {
    return new Date(now + presetMsMap[preset]).toISOString();
  }
  if (preset === 'custom') {
    const rawCustom = String(customDateTime || '').trim();
    const ts = Date.parse(rawCustom);
    if (!rawCustom || Number.isNaN(ts)) {
      throw new Error('请选择有效的自定义权限到期时间');
    }
    if (ts < now + 30 * 1000) {
      throw new Error('自定义到期时间必须晚于当前时间至少 30 秒');
    }
    return new Date(ts).toISOString();
  }
  return null;
}

function compatFormatTtlRemaining(expiresAt, nowMs = Date.now()) {
  if (typeof formatTtlRemaining === 'function') {
    return String(formatTtlRemaining(expiresAt, nowMs) || '').replaceAll('\u2014', '·');
  }
  const ts = Date.parse(String(expiresAt || ''));
  if (Number.isNaN(ts)) return '';
  const diffMs = ts - nowMs;
  if (diffMs <= 0) return '已到期（待回收）';
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
  if (totalMinutes < 60) {
    return `剩余 ${totalMinutes} 分钟`;
  }
  const totalHours = Math.floor(diffMs / 3600000);
  if (totalHours < 48) {
    const ceilHours = Math.max(1, Math.ceil(diffMs / 3600000));
    return `剩余 ${ceilHours} 小时`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `剩余 ${days} 天 ${remHours} 小时` : `剩余 ${days} 天`;
}

async function compatGetTtlQueue() {
  if (typeof getTtlQueue === 'function') {
    return getTtlQueue();
  }
  try {
    const data = await chrome.storage.local.get('ttlPermissionsQueue');
    const list = Array.isArray(data?.ttlPermissionsQueue) ? data.ttlPermissionsQueue : [];
    return [...list].sort((a, b) => Date.parse(a?.expiresAt || '') - Date.parse(b?.expiresAt || ''));
  } catch (_e) {
    return [];
  }
}

function findMatchingExcludedEntry(file, excludedFolders = [], ancestorIds = spState.ancestorIds) {
  if (!file?.id || !Array.isArray(excludedFolders) || !excludedFolders.length) return null;
  const direct = excludedFolders.find(item => item && item.id === file.id);
  if (direct) return direct;
  const candidateAncestors = [
    ...(Array.isArray(file.parents) ? file.parents : []),
    ...(spState.currentFile?.id === file.id && Array.isArray(ancestorIds) ? ancestorIds : [])
  ].filter(Boolean);
  if (candidateAncestors.length > 0) {
    const ancestorSet = new Set(candidateAncestors);
    const ancestorHit = excludedFolders.find(
      item => item && item.includeSubitems !== false && ancestorSet.has(item.id)
    );
    if (ancestorHit) return ancestorHit;
  }
  return null;
}

function compatIsFileExcluded(file, policy = spState.policy) {
  if (!file?.id) return false;
  const excludedFolders = Array.isArray(policy?.excludedFolders) ? policy.excludedFolders : [];
  if (!excludedFolders.length) return false;
  if (findMatchingExcludedEntry(file, excludedFolders, spState.ancestorIds)) {
    return true;
  }
  if (typeof isFileInExcludedFolders === 'function') {
    return Boolean(isFileInExcludedFolders(file, excludedFolders));
  }
  return false;
}

async function compatAddExcludedFolders(entries = []) {
  if (typeof addExcludedFolders === 'function') {
    return addExcludedFolders(entries);
  }
  const curPolicy = await getPolicy();
  const prevList = Array.isArray(curPolicy.excludedFolders) ? curPolicy.excludedFolders : [];
  const byId = new Map(prevList.filter(x => x?.id).map(x => [x.id, x]));
  const nowIso = new Date().toISOString();
  for (const item of Array.isArray(entries) ? entries : [entries]) {
    if (!item?.id) continue;
    byId.set(item.id, {
      id: String(item.id).trim(),
      name: String(item.name || '(未命名目录)').trim(),
      webViewLink: String(item.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(item.id)}`),
      includeSubitems: item.includeSubitems !== false,
      note: String(item.note || '').trim(),
      addedAt: item.addedAt || nowIso
    });
  }
  const nextPolicy = {
    ...curPolicy,
    excludedFolders: [...byId.values()]
  };
  await safeStorageSet({ policy: nextPolicy });
  return nextPolicy;
}

async function compatRemoveExcludedFolder(folderId = '') {
  const cleanId = String(folderId || '').trim();
  if (!cleanId) return getPolicy();
  if (typeof removeExcludedFolder === 'function') {
    return removeExcludedFolder(cleanId);
  }
  const curPolicy = await getPolicy();
  const prevList = Array.isArray(curPolicy.excludedFolders) ? curPolicy.excludedFolders : [];
  const nextPolicy = {
    ...curPolicy,
    excludedFolders: prevList.filter(item => item && item.id !== cleanId)
  };
  await safeStorageSet({ policy: nextPolicy });
  return nextPolicy;
}

function compatAssessWidePermissionRisk(file, policy, accountEmail = '') {
  if (!file || compatIsFileExcluded(file, policy)) {
    return {
      isWide: false,
      isExcluded: Boolean(file && compatIsFileExcluded(file, policy)),
      severity: 'none',
      reasons: [],
      hasPublicWriter: false,
      hasPublicReader: false,
      hasDomainLink: false,
      externalCount: 0,
      allowsWritersShare: false
    };
  }
  if (typeof assessWidePermissionRisk === 'function') {
    return assessWidePermissionRisk(file, policy, accountEmail);
  }

  const ownerNorm = normalizeEntry(
    file.owners?.[0]?.emailAddress || file.ownerAccount || accountEmail || ''
  );
  const perms = Array.isArray(file.permissions) ? file.permissions : [];
  let hasPublicWriter = false;
  let hasPublicReader = false;
  let hasDomainLink = false;
  let externalCount = 0;

  for (const p of perms) {
    if (!p) continue;
    if (p.type === 'anyone') {
      if (p.role === 'reader') {
        hasPublicReader = true;
      } else {
        hasPublicWriter = true;
      }
    } else if (p.type === 'domain') {
      hasDomainLink = true;
    } else if (p.role !== 'owner' && normalizeEntry(p.emailAddress || '') !== ownerNorm) {
      externalCount++;
    }
  }

  const allowsWritersShare = Boolean(
    (externalCount > 0 || file.shared || hasPublicWriter || hasPublicReader || hasDomainLink) &&
      file.writersCanShare !== false
  );
  const ev = evaluateFile(file, policy, ownerNorm);
  const reasons = [];

  if (hasPublicWriter) reasons.push('开启了任何人可编辑公开链接');
  else if (hasPublicReader) reasons.push('开启了任何人可查看公开链接');
  if (hasDomainLink) reasons.push('开启了全公司/域内共享链接');
  if (ev.removeCount > 0) reasons.push(`含非白名单人员 ${ev.removeCount} 项`);
  if (ev.downgradeCount > 0) reasons.push(`含越权编辑 ${ev.downgradeCount} 项`);
  if (externalCount >= 3) reasons.push(`外部或跨账号协作者较多（${externalCount} 人）`);
  if (allowsWritersShare) reasons.push('允许编辑者继续拉人分享');

  let severity = 'none';
  if (hasPublicWriter || hasPublicReader || hasDomainLink || ev.removeCount > 0) {
    severity = 'high';
  } else if (ev.downgradeCount > 0 || externalCount >= 3 || allowsWritersShare) {
    severity = 'medium';
  }

  return {
    isWide: severity !== 'none',
    severity,
    reasons,
    hasPublicWriter,
    hasPublicReader,
    hasDomainLink,
    externalCount,
    allowsWritersShare
  };
}

async function compatInspectSingleDriveItem(fileId, { preferredAccount = '' } = {}) {
  if (typeof inspectSingleDriveItem === 'function') {
    return inspectSingleDriveItem(fileId, { preferredAccount });
  }

  const cleanId = String(fileId || '').trim();
  if (!cleanId) {
    throw new Error('未识别到有效的 Google Drive 文件或文件夹 ID');
  }
  const accounts = await getAuthorizedAccounts();
  if (!accounts.length) {
    throw new Error('尚未授权任何 Google 账号，请先前往全屏工作台完成授权');
  }

  const prefNorm = normalizeEntry(preferredAccount || '');
  const orderedAccounts = prefNorm
    ? [
        ...accounts.filter(a => normalizeEntry(a.email) === prefNorm),
        ...accounts.filter(a => normalizeEntry(a.email) !== prefNorm)
      ]
    : accounts;

  const FILE_FIELDS =
    'id,name,mimeType,webViewLink,createdTime,modifiedTime,viewedByMeTime,ownedByMe,shared,writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason),owners(emailAddress,displayName),capabilities(canEdit,canComment,canShare),permissions(id,type,role,emailAddress,domain,displayName,expirationTime,permissionDetails(role,inherited,inheritedFrom,permissionType)),parents';

  let matchedFile = null;
  let matchedAccount = '';
  let matchedToken = '';
  let lastErr = null;

  for (const acc of orderedAccounts) {
    const accEmail = normalizeEntry(acc.email);
    try {
      const token = await getValidTokenForAccount(accEmail, false);
      const meta = await driveApi(
        token,
        `/files/${encodeURIComponent(cleanId)}?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`
      );
      if (meta && meta.id) {
        if (!Array.isArray(meta.permissions) || meta.permissions.length === 0) {
          try {
            const pData = await driveApi(
              token,
              `/files/${encodeURIComponent(cleanId)}/permissions?supportsAllDrives=true&pageSize=100&fields=${encodeURIComponent('permissions(id,type,role,emailAddress,domain,displayName,expirationTime,permissionDetails(role,inherited,inheritedFrom,permissionType))')}`
            );
            if (Array.isArray(pData?.permissions)) {
              meta.permissions = pData.permissions;
            }
          } catch (_pe) {
            // 只读协作者可能无法枚举完整权限明细
          }
        }
        normalizeScannedFileItem(meta, accEmail);
        meta.permissionsLoading = false;
        matchedFile = meta;
        matchedAccount = accEmail;
        matchedToken = token;
        break;
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (!matchedFile) {
    throw new Error(lastErr?.message || '当前已授权账号无权访问该文件，或文件 ID 不存在');
  }

  const [policy, directory, allTtl] = await Promise.all([
    getPolicy(),
    getDirectory(),
    compatGetTtlQueue()
  ]);

  const itemsForBreakage = [matchedFile];
  const ancestorIds = [];
  const parentId = Array.isArray(matchedFile.parents) && matchedFile.parents[0] ? String(matchedFile.parents[0]) : '';
  if (parentId && matchedToken) {
    ancestorIds.push(parentId);
    try {
      const parentMeta = await driveApi(
        matchedToken,
        `/files/${encodeURIComponent(parentId)}?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`
      );
      if (parentMeta && parentMeta.id) {
        normalizeScannedFileItem(parentMeta, matchedAccount);
        parentMeta.permissionsLoading = false;
        itemsForBreakage.push(parentMeta);
        let cursorParent = Array.isArray(parentMeta.parents) && parentMeta.parents[0] ? String(parentMeta.parents[0]) : '';
        let depth = 1;
        while (cursorParent && depth < 6 && !ancestorIds.includes(cursorParent)) {
          ancestorIds.push(cursorParent);
          depth++;
          try {
            const ancMeta = await driveApi(
              matchedToken,
              `/files/${encodeURIComponent(cursorParent)}?supportsAllDrives=true&fields=id,name,parents`
            );
            cursorParent = Array.isArray(ancMeta?.parents) && ancMeta.parents[0] ? String(ancMeta.parents[0]) : '';
          } catch (_ancErr) {
            break;
          }
        }
      }
    } catch (_parentErr) {
      // 父目录不可读时由 analyzeInheritanceBreakage 自动回退至 permissionDetails 判断
    }
  }

  const breakageMap = analyzeInheritanceBreakage(itemsForBreakage);
  const breakage = breakageMap.get(matchedFile.id) || null;
  const trueOwner = normalizeEntry(matchedFile.owners?.[0]?.emailAddress || matchedFile.ownerAccount || matchedAccount);
  const rawEvaluation = evaluateFile(matchedFile, policy, trueOwner);
  const matchedExcludedFolder = findMatchingExcludedEntry(matchedFile, policy?.excludedFolders || [], ancestorIds);
  const evaluation = matchedExcludedFolder
    ? {
        ...rawEvaluation,
        removeCount: 0,
        downgradeCount: 0,
        inheritedIssueCount: 0,
        hasActionableViolation: false,
        isExcluded: true
      }
    : rawEvaluation;
  const ttlEntries = (allTtl || []).filter(it => it && it.fileId === matchedFile.id && it.status !== 'completed');

  return {
    file: matchedFile,
    ancestorIds,
    matchedExcludedFolder,
    matchedAccount,
    policy,
    directory,
    evaluation,
    breakage,
    ttlEntries
  };
}

function compatIsGoogleGroupEmail(email = '', contact = null) {
  const norm = normalizeEntry(email);
  if (!norm) return false;
  if (contact?.memberType === 'group') return true;
  if (typeof isGoogleGroupEmail === 'function') {
    return Boolean(isGoogleGroupEmail(norm));
  }
  return /@googlegroups\.com$|\bgooglegroups\./i.test(norm);
}

function compatInferPermissionTargetType(email = '', explicitType = '', directory = spState.directory) {
  const norm = normalizeEntry(email);
  const contact = Array.isArray(directory?.contacts)
    ? directory.contacts.find(c => normalizeEntry(c?.email || '') === norm) || null
    : null;
  if (explicitType === 'group' || explicitType === 'user') {
    return explicitType;
  }
  if (contact?.memberType === 'group') {
    return 'group';
  }
  if (typeof inferPermissionTargetType === 'function') {
    return inferPermissionTargetType(norm, explicitType);
  }
  return compatIsGoogleGroupEmail(norm, contact) ? 'group' : 'user';
}

async function compatGrantPermissionWithTtl({
  accountEmail = '',
  file = null,
  fileId = '',
  type = 'auto',
  role = 'reader',
  emailAddress = '',
  domain = '',
  expiresAt = '',
  expireAction = 'revoke'
} = {}) {
  const resolvedInitialType =
    type && type !== 'auto'
      ? type
      : emailAddress
        ? compatInferPermissionTargetType(emailAddress, '', spState.directory)
        : 'user';

  if (typeof grantPermissionWithTtl === 'function') {
    return grantPermissionWithTtl({
      accountEmail,
      file,
      fileId,
      type: resolvedInitialType,
      role,
      emailAddress,
      domain,
      expiresAt,
      expireAction
    });
  }
  const targetFileId = fileId || file?.id || '';
  const token = await getValidTokenForAccount(accountEmail || file?.ownerAccount || '', true);
  let resolvedType = resolvedInitialType;
  let createdPermission = null;
  try {
    createdPermission = await createPermission(token, targetFileId, {
      type: resolvedType,
      role,
      emailAddress: emailAddress || undefined,
      domain: domain || undefined
    });
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (
      emailAddress &&
      (resolvedType === 'user' || resolvedType === 'group') &&
      /400|group|not a user|not a group|invalid|shareable/i.test(msg)
    ) {
      resolvedType = resolvedType === 'user' ? 'group' : 'user';
      createdPermission = await createPermission(token, targetFileId, {
        type: resolvedType,
        role,
        emailAddress
      });
    } else {
      throw err;
    }
  }
  resolvedType = createdPermission?.resolvedType || createdPermission?.type || resolvedType;
  let ttlEntry = null;
  if (expiresAt && typeof enqueueTtlPermissions === 'function') {
    const queued = await enqueueTtlPermissions({
      id: `ttl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fileId: targetFileId,
      fileName: file?.name || '(无名称)',
      mimeType: file?.mimeType || '',
      webViewLink: file ? formatDriveCanonicalLink(file) : '',
      accountEmail: normalizeEntry(accountEmail || file?.ownerAccount || ''),
      permissionId: createdPermission?.id || '',
      targetType: resolvedType,
      targetEmail: normalizeEntry(emailAddress || ''),
      domain: domain || '',
      targetLabel: emailAddress || domain || resolvedType,
      grantedRole: role,
      expireAction,
      expiresAt,
      createdAt: new Date().toISOString(),
      nativeExpirationApplied: false
    });
    ttlEntry = Array.isArray(queued) ? queued[0] || null : queued;
  }
  return {
    createdPermission,
    resolvedType,
    nativeExpirationApplied: false,
    ttlEntry
  };
}

function isFileContentLocked(file) {
  if (!file) return false;
  if (Array.isArray(file.contentRestrictions) && file.contentRestrictions.length > 0) {
    return file.contentRestrictions.some(r => Boolean(r?.readOnly));
  }
  return Boolean(file.contentLocked);
}

async function compatApplyFileSecurityHardening({
  files = [],
  writersCanShare = undefined,
  copyRequiresWriterPermission = undefined,
  contentLock = undefined,
  lockReason = '由 Drive 权限管理中心锁定保护',
  onProgress = null,
  shouldStop = null
} = {}) {
  if (typeof applyFileSecurityHardening === 'function') {
    return applyFileSecurityHardening({
      files,
      writersCanShare,
      copyRequiresWriterPermission,
      contentLock,
      lockReason,
      onProgress,
      shouldStop
    });
  }

  let changedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const failedItems = [];
  const auditEntries = [];

  for (const file of files || []) {
    if (!file?.id) {
      skippedCount++;
      continue;
    }
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const patchBody = {};
    if (typeof writersCanShare === 'boolean') {
      patchBody.writersCanShare = writersCanShare;
    }
    if (typeof copyRequiresWriterPermission === 'boolean' && !isFolder) {
      patchBody.copyRequiresWriterPermission = copyRequiresWriterPermission;
    }
    if (typeof contentLock === 'boolean' && !isFolder) {
      patchBody.contentRestrictions = [
        contentLock
          ? { readOnly: true, reason: lockReason || '由 Drive 权限管理中心锁定保护' }
          : { readOnly: false }
      ];
    }
    if (Object.keys(patchBody).length === 0) {
      skippedCount++;
      continue;
    }

    const actingEmail = normalizeEntry(
      file.ownerAccount || spState.matchedAccount || file.owners?.[0]?.emailAddress || ''
    );
    try {
      const token = await getValidTokenForAccount(actingEmail, true);
      const updated = await driveApi(
        token,
        `/files/${encodeURIComponent(file.id)}?supportsAllDrives=true&fields=${encodeURIComponent('id,writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason)')}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patchBody)
        }
      );
      if (typeof patchBody.writersCanShare === 'boolean') {
        file.writersCanShare =
          typeof updated?.writersCanShare === 'boolean' ? updated.writersCanShare : patchBody.writersCanShare;
      }
      if (typeof patchBody.copyRequiresWriterPermission === 'boolean') {
        file.copyRequiresWriterPermission =
          typeof updated?.copyRequiresWriterPermission === 'boolean'
            ? updated.copyRequiresWriterPermission
            : patchBody.copyRequiresWriterPermission;
      }
      if (typeof contentLock === 'boolean') {
        file.contentRestrictions = Array.isArray(updated?.contentRestrictions)
          ? updated.contentRestrictions
          : contentLock
            ? [{ readOnly: true, reason: lockReason || '由 Drive 权限管理中心锁定保护' }]
            : [];
        file.contentLocked = isFileContentLocked(file);
        file.contentLockReason = file.contentLocked ? lockReason || '' : '';
      }
      changedCount++;
      auditEntries.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        source: 'manual',
        actionType: 'harden',
        accountEmail: actingEmail,
        fileId: file.id,
        fileName: file.name || '(无名称)',
        webViewLink: formatDriveCanonicalLink(file),
        permissionId: '',
        targetType: 'file_security',
        targetLabel: file.name || file.id,
        previousRole: '',
        newRole: '',
        restored: false,
        message: `伴随栏修改编辑与下载权限：已更新《${file.name || file.id}》`
      });
    } catch (err) {
      failedCount++;
      failedItems.push({ fileId: file.id, errorMessage: err?.message || String(err) });
    }
  }

  if (changedCount > 0) {
    try {
      const rawSnapData = await chrome.storage.local.get('scanSnapshot');
      const snap = rawSnapData?.scanSnapshot;
      if (snap && Array.isArray(snap.files)) {
        let snapTouched = false;
        for (const f of files || []) {
          if (!f?.id) continue;
          const idx = snap.files.findIndex(sf => sf && sf.id === f.id);
          if (idx !== -1) {
            snap.files[idx] = {
              ...snap.files[idx],
              writersCanShare: f.writersCanShare,
              copyRequiresWriterPermission: f.copyRequiresWriterPermission,
              contentLocked: isFileContentLocked(f),
              contentLockReason: f.contentLockReason || '',
              contentRestrictions: f.contentRestrictions
            };
            snapTouched = true;
          }
        }
        if (snapTouched && typeof saveSnapshot === 'function') {
          await saveSnapshot(snap);
        }
      }
    } catch (_snapErr) {
      // 忽略快照同步异常
    }
  }

  if (auditEntries.length > 0) {
    await appendAuditLogs(auditEntries);
  }
  return { changedCount, failedCount, skippedCount, failedItems, stopped: false };
}

/* ==================== 全屏工作台联动 ==================== */

async function openDashboard(fileId = '') {
  const cleanFileId = String(fileId || '').trim();
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const res = await chrome.runtime.sendMessage({
        type: 'OPEN_DASHBOARD',
        fileId: cleanFileId
      });
      if (res && res.ok === false) {
        throw new Error(res.error || '未能打开工作台');
      }
      return;
    }
    throw new Error('runtime 不可用');
  } catch (_err) {
    try {
      if (cleanFileId && typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
        await chrome.storage.session.set({ pendingFocusFileId: cleanFileId });
      }
    } catch (_sessionErr) {
      // 忽略 session 存储回退异常
    }
    try {
      const dashboardUrl = chrome.runtime.getURL('popup.html');
      await chrome.tabs.create({ url: dashboardUrl });
    } catch (tabErr) {
      toast(`打开全屏工作台失败：${tabErr?.message || String(tabErr)}`);
    }
  }
}

/* ==================== 视图状态切换、三层优先级渲染与二段式操作卡 ==================== */

function setActiveTabHint(text, isLinked = false) {
  const hintNode = $('sp-tab-status');
  if (!hintNode) return;
  hintNode.textContent = String(text || '').replaceAll('\u2014', '·');
  hintNode.classList.toggle('ok', Boolean(isLinked));
}

function showNoAccountState() {
  $('sp-no-account-box')?.classList.remove('hidden');
  $('sp-empty-box')?.classList.add('hidden');
  $('sp-file-view')?.classList.add('hidden');
}

function showEmptyState(title = '', desc = '') {
  $('sp-no-account-box')?.classList.add('hidden');
  $('sp-file-view')?.classList.add('hidden');
  const box = $('sp-empty-box');
  if (!box) return;
  box.classList.remove('hidden');

  const titleEl = $('sp-empty-title');
  const descEl = $('sp-empty-desc');
  if (titleEl) {
    titleEl.textContent = (title || '点开云端文档即可自动核查权限').replaceAll('\u2014', '·');
  }
  if (descEl) {
    descEl.textContent = (
      desc ||
      '在当前窗口浏览 Google 文档、表格、幻灯片或 Drive 文件夹时，此侧栏会自动识别文件并优先展示风险预警与谁有权限；您也可以展开上方「手输链接」粘贴任意链接核查。'
    ).replaceAll('\u2014', '·');
  }
}

function switchSidepanelActionTab(tabKey = 'share') {
  const nextTab = tabKey === 'lock' ? 'lock' : 'share';
  spState.activeActionTab = nextTab;

  const shareBtn = $('sp-act-tab-share-btn');
  const lockBtn = $('sp-act-tab-lock-btn');
  const sharePanel = $('sp-act-panel-share');
  const lockPanel = $('sp-act-panel-lock');

  if (shareBtn) {
    const active = nextTab === 'share';
    shareBtn.classList.toggle('active', active);
    shareBtn.setAttribute?.('aria-selected', active ? 'true' : 'false');
  }
  if (lockBtn) {
    const active = nextTab === 'lock';
    lockBtn.classList.toggle('active', active);
    lockBtn.setAttribute?.('aria-selected', active ? 'true' : 'false');
  }
  sharePanel?.classList.toggle('hidden', nextTab !== 'share');
  lockPanel?.classList.toggle('hidden', nextTab !== 'lock');
}

function findMatchingTtlEntry(perm, ttlEntries = []) {
  if (!perm || !Array.isArray(ttlEntries) || !ttlEntries.length) return null;
  const pEmail = normalizeEntry(perm.emailAddress || '');
  const pDom = normalizeEntry(perm.domain || '');
  for (const item of ttlEntries) {
    if (!item || item.status === 'completed') continue;
    if (spState.currentFile?.id && item.fileId && item.fileId !== spState.currentFile.id) continue;
    if (item.permissionId && perm.id && item.permissionId === perm.id) return item;
    if (pEmail && item.targetEmail && normalizeEntry(item.targetEmail) === pEmail) return item;
    if (perm.type === 'anyone' && item.targetType === 'anyone') return item;
    if (perm.type === 'domain' && item.targetType === 'domain' && normalizeEntry(item.domain || '') === pDom) {
      return item;
    }
  }
  return null;
}

function buildPermissionComplianceTag(perm, ev, policy, isOwner, isPureInherited, isExcludedFile = false) {
  if (isOwner) {
    return { cls: 'info', text: '所有者' };
  }
  if (isExcludedFile) {
    if (perm.type === 'anyone' || perm.type === 'domain') {
      return { cls: 'info', text: '豁免公开/域内' };
    }
    return { cls: 'ok', text: isPureInherited ? '继承 · 已豁免' : '已豁免排除' };
  }

  const email = normalizeEntry(perm.emailAddress || '');

  if (isPureInherited) {
    if (ev.inheritedViolation === 'violation_remove') {
      return { cls: 'warning', text: '继承 · 非白名单' };
    }
    if (ev.inheritedViolation === 'violation_downgrade') {
      return { cls: 'warning', text: '继承 · 越权编辑' };
    }
    if (perm.type === 'anyone' || perm.type === 'domain') {
      return { cls: 'info', text: '继承 · 公开链接' };
    }
    return { cls: 'private', text: '继承自父目录' };
  }

  if (perm.type === 'anyone' || perm.type === 'domain') {
    if (ev.status === 'violation_remove') {
      return { cls: 'danger', text: '违规 · 公开链接' };
    }
    if (ev.status === 'violation_downgrade') {
      return { cls: 'warning', text: '越权 · 公开可编辑' };
    }
    return { cls: 'info', text: '公开链接 · 合规' };
  }

  if (ev.status === 'violation_remove') {
    return { cls: 'danger', text: '非白名单' };
  }
  if (ev.status === 'violation_downgrade') {
    return { cls: 'warning', text: '越权 · 应为只读' };
  }
  if (email && matchesAllowlist(email, policy?.writers || [])) {
    return { cls: 'ok', text: '白名单编辑' };
  }
  if (email && matchesAllowlist(email, policy?.readers || [])) {
    return { cls: 'ok', text: perm.role === 'commenter' ? '白名单可评论' : '白名单只读' };
  }
  return { cls: 'ok', text: '符合策略' };
}

function formatGroupRoleShortLabel(role = 'reader') {
  if (role === 'writer') return '可编辑';
  if (role === 'commenter') return '可评论';
  return '仅查看';
}

function resolveContactRoleInGroup(contact, groupName = '', fallbackRole = 'reader') {
  const safeFallback =
    fallbackRole === 'writer' || fallbackRole === 'commenter' ? fallbackRole : 'reader';
  const raw =
    (groupName && contact?.groupRoles && typeof contact.groupRoles === 'object'
      ? contact.groupRoles[groupName]
      : '') ||
    contact?.role ||
    safeFallback;
  if (typeof normalizePermissionRole === 'function') {
    return normalizePermissionRole(raw, safeFallback) || safeFallback;
  }
  if (raw === 'writer' || raw === 'commenter' || raw === 'reader') {
    return raw;
  }
  return safeFallback;
}

function renderGroupSection() {
  const file = spState.currentFile;
  const directory = spState.directory || DEFAULT_DIRECTORY;
  const groups = Array.isArray(directory.groups) ? directory.groups : [];
  const contacts = Array.isArray(directory.contacts) ? directory.contacts : [];

  const covBox = $('sp-group-coverage');
  if (covBox && file) {
    const coverages = getFileGroupCoverage(file, directory);
    const boundGroups = groups.filter(
      g => Array.isArray(g.assets) && g.assets.some(a => a && a.fileId === file.id)
    );
    const boundBadgeHtml = boundGroups.length
      ? boundGroups
          .map(g => `<span class="group-cov-badge"><span>已归组：${escapeHtml(g.name)}</span></span>`)
          .join('')
      : '';
    if (!contacts.length && !boundGroups.length) {
      covBox.innerHTML = `<span class="muted">暂未配置分组人员，可在全屏工作台「邮箱分组与模板」读取表格或建组</span>`;
    } else if (!coverages.length && !boundGroups.length) {
      covBox.innerHTML = `<span class="muted">当前文件尚未命中任何已配置分组</span>`;
    } else {
      const covHtml = coverages
        .map(cov => {
          const isPartial = cov.status === 'partial';
          const completeBtn = isPartial
            ? `<button type="button" class="btn-text" data-action="sp-complete-group" data-group="${escapeHtml(cov.groupName)}" title="按表格个人权限或组默认角色补齐该组缺失成员权限">+补齐</button>`
            : '';
          return `<span class="group-cov-badge ${isPartial ? 'partial' : ''}">
            <span>${escapeHtml(cov.groupName)}：${cov.grantedCount}/${cov.totalCount} 人</span>
            ${completeBtn}
          </span>`;
        })
        .join('');
      covBox.innerHTML = `${boundBadgeHtml}${covHtml}`;
    }
  }

  const groupSelect = $('sp-group-select');
  if (groupSelect) {
    const prevVal = groupSelect.value;
    if (!groups.length) {
      groupSelect.innerHTML = `<option value="">暂无可用分组</option>`;
      groupSelect.disabled = true;
      if ($('sp-group-grant-btn')) $('sp-group-grant-btn').disabled = true;
      if ($('sp-group-revoke-btn')) $('sp-group-revoke-btn').disabled = true;
    } else {
      groupSelect.disabled = spState.busyAction;
      groupSelect.innerHTML = groups
        .map(g => {
          const groupMembers = contacts.filter(c => (c.groups || []).includes(g.name));
          const cnt = groupMembers.length;
          const defRole =
            g.defaultRole === 'writer' || g.defaultRole === 'commenter' ? g.defaultRole : 'reader';
          const defRoleText = formatGroupRoleShortLabel(defRole);
          const memberRoleSet = new Set(
            groupMembers.map(c => resolveContactRoleInGroup(c, g.name, defRole))
          );
          const hasCustomMemberRole =
            groupMembers.some(c => Boolean(c.groupRoles?.[g.name] || c.role)) &&
            (memberRoleSet.size > 1 || (memberRoleSet.size === 1 && !memberRoleSet.has(defRole)));
          const roleText = hasCustomMemberRole ? `个人权限/${defRoleText}` : defRoleText;
          return `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${roleText} · ${cnt}人)</option>`;
        })
        .join('');
      if ([...groupSelect.options].some(o => o.value === prevVal)) {
        groupSelect.value = prevVal;
      }
      if ($('sp-group-grant-btn')) $('sp-group-grant-btn').disabled = spState.busyAction;
      if ($('sp-group-revoke-btn')) $('sp-group-revoke-btn').disabled = spState.busyAction;
    }
  }
}

function renderPermissionsList(trueOwnerEmail, isExcludedFile = false) {
  const file = spState.currentFile;
  const listNode = $('sp-perm-list');
  const countNode = $('sp-perm-count');
  if (!listNode || !file) return;

  const perms = Array.isArray(file.permissions) ? file.permissions : [];
  const contactLookup = buildContactLookup(spState.directory);
  const ownerNorm = normalizeEntry(trueOwnerEmail || file.owners?.[0]?.emailAddress || file.ownerAccount || '');

  const nonOwnerCount = perms.filter(
    p => p && p.role !== 'owner' && normalizeEntry(p.emailAddress || '') !== ownerNorm
  ).length;
  if (countNode) {
    countNode.textContent = nonOwnerCount > 0 ? `共 ${perms.length} 项（外部/协作 ${nonOwnerCount} 项）` : '仅所有者可见';
  }

  if (!perms.length) {
    if (file.permissionError) {
      listNode.innerHTML = `<div class="muted">当前账号仅具查看权限，无法列出完整协作者明细（${escapeHtml(file.permissionError)}）</div>`;
    } else {
      listNode.innerHTML = `<div class="muted">仅所有者自己可见，暂无其他协作者或共享链接</div>`;
    }
    return;
  }

  const nowMs = Date.now();
  const sortedPerms = [...perms].sort((a, b) => {
    const aOwner = a?.role === 'owner' || (a?.emailAddress && normalizeEntry(a.emailAddress) === ownerNorm) ? 1 : 0;
    const bOwner = b?.role === 'owner' || (b?.emailAddress && normalizeEntry(b.emailAddress) === ownerNorm) ? 1 : 0;
    if (bOwner !== aOwner) return bOwner - aOwner;
    const aLink = a?.type === 'anyone' || a?.type === 'domain' ? 1 : 0;
    const bLink = b?.type === 'anyone' || b?.type === 'domain' ? 1 : 0;
    if (bLink !== aLink) return bLink - aLink;
    return permissionRoleRank(b?.role || '') - permissionRoleRank(a?.role || '');
  });

  listNode.innerHTML = sortedPerms
    .map(perm => {
      if (!perm) return '';
      const pEmail = normalizeEntry(perm.emailAddress || '');
      const isOwner = perm.role === 'owner' || Boolean(pEmail && ownerNorm && pEmail === ownerNorm);
      const isInherited = permIsInherited(perm);
      const hasDirect = permHasDirectGrant(perm);
      const isPureInherited = Boolean(isInherited && !hasDirect);

      const ev = evaluatePermission(perm, spState.policy, ownerNorm);
      const compTag = buildPermissionComplianceTag(
        perm,
        ev,
        spState.policy,
        isOwner,
        isPureInherited,
        isExcludedFile
      );

      let displayName = permissionLabel(perm, contactLookup);
      const contact = pEmail ? contactLookup.get(pEmail) || null : null;
      if (perm.type === 'anyone') {
        displayName = '公开链接（知道链接的任何人）';
      } else if (perm.type === 'domain') {
        displayName = `域内共享（@${perm.domain || '未知域'}）`;
      } else if (contact?.name && !displayName.includes(contact.name)) {
        displayName = `${contact.name} (${pEmail})`;
      }

      const isGroupPerm = Boolean(
        perm.type === 'group' || compatIsGoogleGroupEmail(pEmail, contact)
      );
      const groupBadgeHtml = isGroupPerm
        ? `<span class="group-email-badge">👥 群组</span>`
        : '';
      const cleanNote = String(contact?.note || '').replaceAll('\u2014', '·').trim();
      const noteHtml =
        cleanNote && !displayName.includes(cleanNote)
          ? `<div class="member-note-text">备注：${escapeHtml(cleanNote)}</div>`
          : '';

      const matchedTtl = findMatchingTtlEntry(perm, spState.ttlEntries);
      const effectiveExpiresAt = matchedTtl?.expiresAt || perm.expirationTime || '';
      let ttlHtml = '';
      if (effectiveExpiresAt && !isOwner) {
        const remText = compatFormatTtlRemaining(effectiveExpiresAt, nowMs);
        if (remText) {
          const expMs = Date.parse(effectiveExpiresAt);
          const ttlVariant = !Number.isNaN(expMs) && expMs <= nowMs
            ? 'expired'
            : !Number.isNaN(expMs) && expMs - nowMs <= 24 * 3600 * 1000
              ? 'warning'
              : '';
          ttlHtml = `<span class="sp-ttl-text ${ttlVariant}" title="到期时间：${escapeHtml(formatReadableDateTime(effectiveExpiresAt))}">限时：${escapeHtml(remText)}</span>`;
        }
      }

      const inheritRoleHint = isPureInherited
        ? `<span>角色：${escapeHtml(roleLabel(perm.role))}</span>`
        : isInherited && hasDirect
          ? `<span>含子项独立提权</span>`
          : '';

      const rowStatusCls =
        !isExcludedFile &&
        !isOwner &&
        !isPureInherited &&
        (ev.status === 'violation_remove' || ev.status === 'violation_downgrade')
          ? ev.status
          : '';

      let actionsHtml = '';
      if (isOwner) {
        actionsHtml = `<span class="meta-inline">所有者</span>`;
      } else if (isPureInherited || !perm.id) {
        actionsHtml = `<span class="meta-inline">继承</span>`;
      } else {
        const currentRole =
          perm.role === 'writer' || perm.role === 'organizer' || perm.role === 'fileOrganizer'
            ? 'writer'
            : perm.role === 'commenter'
              ? 'commenter'
              : 'reader';
        actionsHtml = `<div class="sp-perm-actions">
          <select class="perm-select" data-action="sp-role-change" data-perm-id="${escapeHtml(perm.id)}" aria-label="修改 ${escapeHtml(displayName)} 的角色" ${spState.busyAction ? 'disabled' : ''}>
            <option value="writer" ${currentRole === 'writer' ? 'selected' : ''}>可编辑</option>
            <option value="commenter" ${currentRole === 'commenter' ? 'selected' : ''}>可评论</option>
            <option value="reader" ${currentRole === 'reader' ? 'selected' : ''}>仅查看</option>
          </select>
          <button type="button" class="btn danger btn-xs" data-action="sp-remove-perm" data-perm-id="${escapeHtml(perm.id)}" aria-label="移除 ${escapeHtml(displayName)} 的权限" title="移除该权限" ${spState.busyAction ? 'disabled' : ''}>×</button>
        </div>`;
      }

      return `<div class="sp-perm-row ${escapeHtml(rowStatusCls)}">
        <div class="sp-perm-info">
          <span class="sp-perm-name">${escapeHtml(displayName)}</span>
          ${noteHtml}
          <div class="sp-perm-meta">
            ${groupBadgeHtml}
            <span class="status-pill ${escapeHtml(compTag.cls)}">${escapeHtml(compTag.text)}</span>
            ${inheritRoleHint}
            ${ttlHtml}
          </div>
        </div>
        ${actionsHtml}
      </div>`;
    })
    .join('');
}

function renderSecurityAndAlignmentPanel() {
  const file = spState.currentFile;
  const bar = $('sp-security-bar');
  if (!bar || !file) return;

  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  const writersShareBlocked = file.writersCanShare === false;
  const copyLocked = Boolean(file.copyRequiresWriterPermission);
  const contentLocked = isFileContentLocked(file);

  const writersBtn = $('sp-toggle-writers-share');
  if (writersBtn) {
    writersBtn.classList.toggle('active', writersShareBlocked);
    writersBtn.setAttribute?.('aria-pressed', writersShareBlocked ? 'true' : 'false');
    writersBtn.textContent = writersShareBlocked ? '✓ 禁编辑拉人' : '禁编辑拉人';
    writersBtn.disabled = spState.busyAction;
  }

  const copyBtn = $('sp-toggle-copy-lock');
  if (copyBtn) {
    copyBtn.classList.toggle('active', copyLocked);
    copyBtn.setAttribute?.('aria-pressed', copyLocked ? 'true' : 'false');
    copyBtn.textContent = copyLocked ? '✓ 禁下载复制' : '禁下载复制';
    copyBtn.disabled = spState.busyAction || isFolder;
    copyBtn.title = isFolder
      ? '文件夹本身不支持禁下载复制限制，请进入具体子文件设置'
      : '开启后禁止仅查看与可评论人员下载、打印或复制';
  }

  const lockBtn = $('sp-toggle-content-lock');
  if (lockBtn) {
    lockBtn.classList.toggle('active', contentLocked);
    lockBtn.setAttribute?.('aria-pressed', contentLocked ? 'true' : 'false');
    lockBtn.textContent = contentLocked ? '✓ 锁定防误改' : '锁定防误改';
    lockBtn.disabled = spState.busyAction || isFolder;
    lockBtn.title = isFolder
      ? '文件夹不支持内容只读锁定，请对具体文档或表格执行锁定'
      : contentLocked && file.contentLockReason
        ? `已锁定：${file.contentLockReason}（点击解除锁定）`
        : '锁定文件内容为只读状态以防误改';
  }

  const statusBadge = $('sp-security-status');
  if (statusBadge) {
    statusBadge.classList.remove('ok', 'warning', 'info', 'danger');
    if (isFolder) {
      if (writersShareBlocked) {
        statusBadge.classList.add('ok');
        statusBadge.textContent = '已禁编辑拉人';
      } else {
        statusBadge.classList.add('warning');
        statusBadge.textContent = '未禁编辑拉人';
      }
    } else {
      const activeCount = Number(writersShareBlocked) + Number(copyLocked) + Number(contentLocked);
      if (activeCount === 3) {
        statusBadge.classList.add('ok');
        statusBadge.textContent = '已设限 3/3 · 已锁定';
      } else if (activeCount > 0) {
        statusBadge.classList.add(writersShareBlocked && copyLocked ? 'ok' : 'info');
        statusBadge.textContent = contentLocked
          ? `已锁定 · 设限 ${activeCount}/3`
          : `已设限 ${activeCount}/3 项`;
      } else {
        const hasExternalOrShared = Boolean(spState.evaluation?.hasNonOwner || file.shared);
        statusBadge.classList.add(hasExternalOrShared ? 'warning' : 'info');
        statusBadge.textContent = hasExternalOrShared ? '允许拉人/下载' : '默认状态';
      }
    }
  }

  const parentAlignDesc = $('sp-parent-align-desc');
  const panelAlignBtn = $('sp-panel-align-parent-btn');
  if (spState.breakage?.broken) {
    if (parentAlignDesc) {
      parentAlignDesc.textContent = String(
        spState.breakage.summaryText || '检测到子项权限宽于上级父目录，存在独立提权逃逸。'
      ).replaceAll('\u2014', '·');
    }
    if (panelAlignBtn) {
      panelAlignBtn.classList.remove('hidden');
      panelAlignBtn.disabled = spState.busyAction;
    }
  } else {
    if (parentAlignDesc) {
      parentAlignDesc.textContent = '当前文件权限与父目录保持一致，无子项独立提权逃逸。';
    }
    panelAlignBtn?.classList.add('hidden');
  }
}

function renderWideAlertAndExcludedBanner(file, evalStat, matchedAcc, isExcluded) {
  const excludedBanner = $('sp-excluded-banner');
  const excludedText = $('sp-excluded-text');
  const wideAlertBar = $('sp-wide-alert-bar');
  const matchedExcludedEntry = findMatchingExcludedEntry(file, spState.policy?.excludedFolders || []);

  const toggleExcludeBtn = $('sp-toggle-exclude-btn');
  if (toggleExcludeBtn) {
    toggleExcludeBtn.disabled = spState.busyAction;
    toggleExcludeBtn.classList.toggle('active', isExcluded);
    if (isExcluded) {
      toggleExcludeBtn.textContent = '移出排除目录';
      toggleExcludeBtn.title =
        matchedExcludedEntry && matchedExcludedEntry.id !== file.id
          ? `移出上级排除目录《${matchedExcludedEntry.name || matchedExcludedEntry.id}》`
          : '将此项从排除扫描目录中移出，恢复常规合规核查';
    } else {
      toggleExcludeBtn.textContent = '设为排除目录';
      toggleExcludeBtn.title = '将此对外公开文件夹或文件设为排除项，巡检与一键关链将自动跳过';
    }
  }

  if (isExcluded) {
    if (excludedBanner) {
      excludedBanner.classList.remove('hidden');
      if (excludedText) {
        if (matchedExcludedEntry && matchedExcludedEntry.id !== file.id) {
          excludedText.textContent = `🛡️ 所属目录《${matchedExcludedEntry.name || '上级目录'}》已设为对外排除目录，不自动关链`;
        } else {
          excludedText.textContent = '🛡️ 已设为对外排除目录，不自动关链';
        }
      }
    }
    wideAlertBar?.classList.add('hidden');
    return;
  }

  excludedBanner?.classList.add('hidden');
  if (!wideAlertBar) return;

  const wideRisk = compatAssessWidePermissionRisk(file, spState.policy, matchedAcc);
  const hasPublic = Boolean(
    evalStat.hasPublic || wideRisk.hasPublicWriter || wideRisk.hasPublicReader || wideRisk.hasDomainLink
  );
  const hasViolation = Boolean(evalStat.hasActionableViolation);
  const hasBreakage = Boolean(spState.breakage?.broken);
  const hasManyExternal = Number(wideRisk.externalCount || 0) >= 3;
  const allowsWritersShare = Boolean(
    wideRisk.allowsWritersShare ||
      ((evalStat.hasNonOwner || file.shared || hasPublic) && file.writersCanShare !== false)
  );

  const shouldShowWideAlert = Boolean(
    wideRisk.isWide || hasPublic || hasViolation || hasBreakage || hasManyExternal || allowsWritersShare
  );

  if (!shouldShowWideAlert) {
    wideAlertBar.classList.add('hidden');
    return;
  }

  const isHighSeverity = Boolean(
    wideRisk.severity === 'high' || hasPublic || evalStat.removeCount > 0
  );
  wideAlertBar.classList.remove('hidden', 'severity-high', 'severity-medium', 'danger', 'warning');
  wideAlertBar.classList.add(
    isHighSeverity ? 'severity-high' : 'severity-medium',
    isHighSeverity ? 'danger' : 'warning'
  );

  const titleEl = $('sp-wide-alert-title');
  if (titleEl) {
    if (hasPublic) {
      titleEl.textContent = '🔴 检测到公开或域内共享链接';
    } else if (hasViolation) {
      titleEl.textContent = '🚨 检测到白名单违规权限';
    } else if (hasBreakage) {
      titleEl.textContent = '⚠️ 子文件权限宽于父目录';
    } else {
      titleEl.textContent = '🟠 检测到较宽共享暴露范围';
    }
  }

  const descParts = [];
  if (Array.isArray(wideRisk.reasons) && wideRisk.reasons.length > 0) {
    for (const r of wideRisk.reasons) {
      const cleanR = String(r || '').replaceAll('\u2014', '·').trim();
      if (cleanR && !descParts.includes(cleanR)) descParts.push(cleanR);
    }
  } else {
    if (hasPublic) {
      const directPublic = (file.permissions || []).some(
        p => (p.type === 'anyone' || p.type === 'domain') && (!permIsInherited(p) || permHasDirectGrant(p))
      );
      descParts.push(directPublic ? '含直接公开或域内链接' : '含继承自父目录的公开或域内链接');
    }
    if (evalStat.removeCount > 0) descParts.push(`非白名单需移除 ${evalStat.removeCount} 项`);
    if (evalStat.downgradeCount > 0) descParts.push(`越权编辑需降级 ${evalStat.downgradeCount} 项`);
    if (hasManyExternal) descParts.push(`外部或跨账号协作者 ${wideRisk.externalCount} 人`);
    if (allowsWritersShare) descParts.push('允许编辑者继续拉人分享');
  }
  if (hasBreakage && spState.breakage?.summaryText) {
    const cleanBrk = String(spState.breakage.summaryText).replaceAll('\u2014', '·').trim();
    if (cleanBrk && !descParts.includes(cleanBrk)) descParts.push(cleanBrk);
  }

  const descEl = $('sp-wide-alert-desc');
  if (descEl) {
    descEl.textContent = descParts.join(' · ');
  }

  const closePubBtn = $('sp-close-public-btn');
  if (closePubBtn) {
    closePubBtn.classList.toggle('hidden', !hasPublic);
    closePubBtn.disabled = spState.busyAction;
  }

  const enforceBtn = $('sp-enforce-btn');
  if (enforceBtn) {
    enforceBtn.classList.toggle('hidden', !hasViolation);
    enforceBtn.disabled = spState.busyAction;
  }

  const alignBtn = $('sp-align-parent-btn');
  if (alignBtn) {
    alignBtn.classList.toggle('hidden', !hasBreakage);
    alignBtn.disabled = spState.busyAction;
  }

  const quickHardenWritersBtn = $('sp-quick-harden-writers-btn');
  if (quickHardenWritersBtn) {
    quickHardenWritersBtn.classList.toggle('hidden', !allowsWritersShare);
    quickHardenWritersBtn.disabled = spState.busyAction;
  }
}

function renderCurrentFileView() {
  const file = spState.currentFile;
  if (!file) {
    if (spState.accounts.length === 0) {
      showNoAccountState();
    } else {
      showEmptyState();
    }
    return;
  }

  $('sp-no-account-box')?.classList.add('hidden');
  $('sp-empty-box')?.classList.add('hidden');
  $('sp-file-view')?.classList.remove('hidden');

  const trueOwner = normalizeEntry(file.owners?.[0]?.emailAddress || file.ownerAccount || spState.matchedAccount || '');
  const matchedAcc = normalizeEntry(spState.matchedAccount || file.ownerAccount || spState.accounts[0]?.email || '');
  const isExcluded = compatIsFileExcluded(file, spState.policy);
  const rawEvaluation = evaluateFile(file, spState.policy, trueOwner);
  spState.evaluation = isExcluded
    ? {
        ...rawEvaluation,
        removeCount: 0,
        downgradeCount: 0,
        inheritedIssueCount: 0,
        hasActionableViolation: false,
        isExcluded: true
      }
    : {
        ...rawEvaluation,
        isExcluded: false
      };
  const evalStat = spState.evaluation;

  const typeNode = $('sp-file-type');
  if (typeNode) {
    typeNode.textContent = fileCategoryLabel(file.mimeType, file.name);
  }

  const nameNode = $('sp-file-name');
  if (nameNode) {
    nameNode.textContent = file.name || '(未命名文件)';
    nameNode.title = file.name || '';
  }

  const driveLinkNode = $('sp-open-drive-link');
  if (driveLinkNode) {
    driveLinkNode.href = sanitizeExternalUrl(formatDriveCanonicalLink(file));
  }

  const accSelect = $('sp-account-select');
  if (accSelect) {
    const accountEmails = [...new Set([
      ...spState.accounts.map(a => normalizeEntry(a.email)).filter(Boolean),
      ...(matchedAcc ? [matchedAcc] : [])
    ])];
    accSelect.innerHTML = accountEmails
      .map(em => {
        const isOwner = Boolean(trueOwner && em === trueOwner);
        const suffix = isOwner ? '（所有者）' : '';
        return `<option value="${escapeHtml(em)}">账号：${escapeHtml(em)}${suffix}</option>`;
      })
      .join('');
    if (matchedAcc && accountEmails.includes(matchedAcc)) {
      accSelect.value = matchedAcc;
    }
    accSelect.disabled = spState.busyAction || accountEmails.length <= 1;
  }

  const ownerHintNode = $('sp-owner-hint');
  if (ownerHintNode) {
    if (trueOwner && matchedAcc && trueOwner !== matchedAcc) {
      ownerHintNode.textContent = `所有者：${trueOwner}`;
      ownerHintNode.classList.remove('hidden');
    } else {
      ownerHintNode.textContent = '';
      ownerHintNode.classList.add('hidden');
    }
  }

  const compPill = $('sp-compliance-status');
  if (compPill) {
    compPill.classList.remove('ok', 'danger', 'warning', 'info');
    if (isExcluded) {
      compPill.classList.add('info');
      compPill.textContent = '对外排除目录';
    } else if (evalStat.hasActionableViolation) {
      compPill.classList.add('danger');
      compPill.textContent = `待修正 ${evalStat.removeCount + evalStat.downgradeCount} 项`;
    } else if (spState.breakage?.broken) {
      compPill.classList.add('warning');
      compPill.textContent = '存在权限逃逸';
    } else if (evalStat.hasPublic) {
      compPill.classList.add('warning');
      compPill.textContent = '含公开/域内链接';
    } else {
      compPill.classList.add('ok');
      compPill.textContent = '符合白名单策略';
    }
  }

  if ($('sp-refresh-btn')) $('sp-refresh-btn').disabled = spState.busyAction || spState.inspectLoading;
  if ($('sp-add-perm-btn')) $('sp-add-perm-btn').disabled = spState.busyAction;

  const headerClosePubBtn = $('sp-header-close-public-btn');
  if (headerClosePubBtn) {
    const publicPerms = (file.permissions || []).filter(
      p => p && (p.type === 'anyone' || p.type === 'domain')
    );
    const hasAnyPublic = Boolean(evalStat.hasPublic || publicPerms.length > 0);
    const hasDirectRemovablePublic = publicPerms.some(
      p => (!permIsInherited(p) || permHasDirectGrant(p)) && p.id
    );
    if (isExcluded) {
      headerClosePubBtn.disabled = true;
      headerClosePubBtn.classList.remove('danger');
      headerClosePubBtn.textContent = '已排除豁免';
      headerClosePubBtn.title = '当前项属于对外排除目录，已豁免公开权限保护';
    } else if (hasAnyPublic) {
      headerClosePubBtn.disabled = spState.busyAction;
      headerClosePubBtn.classList.add('danger');
      headerClosePubBtn.textContent = '🔴 一键关闭公开权限';
      headerClosePubBtn.title = hasDirectRemovablePublic
        ? '立即撤销当前文件的全部公开与域内共享链接'
        : '公开链接继承自上级文件夹，点击查看详情';
    } else {
      headerClosePubBtn.disabled = true;
      headerClosePubBtn.classList.remove('danger');
      headerClosePubBtn.textContent = '无公开链接';
      headerClosePubBtn.title = '当前文件未开启公开或域内共享链接';
    }
  }

  renderWideAlertAndExcludedBanner(file, evalStat, matchedAcc, isExcluded);
  renderPermissionsList(trueOwner, isExcluded);
  renderGroupSection();
  renderSecurityAndAlignmentPanel();
  switchSidepanelActionTab(spState.activeActionTab);
}

/* ==================== 核心数据拉取与活动标签页感知 ==================== */

async function inspectAndRenderById(fileId, { source = 'tab', preferredAccount = '', silentToast = true } = {}) {
  const cleanId = String(fileId || '').trim();
  if (!cleanId) return false;

  spState.accounts = await getAuthorizedAccounts();
  if (spState.accounts.length === 0) {
    setActiveTabHint('尚未授权 Google 账号', false);
    showNoAccountState();
    return false;
  }

  const reqSeq = ++spState.inspectSeq;
  spState.inspectLoading = true;
  const inspectBtn = $('sp-inspect-btn');
  const refreshBtn = $('sp-refresh-btn');
  if (inspectBtn) inspectBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;

  const prefAcc = preferredAccount || spState.preferredAccount || '';
  if (source === 'tab') {
    setActiveTabHint('正在读取当前网页权限…', false);
  } else {
    setActiveTabHint('正在核查输入链接…', false);
  }

  try {
    const result = await compatInspectSingleDriveItem(cleanId, { preferredAccount: prefAcc });
    if (reqSeq !== spState.inspectSeq) return false;

    spState.currentFile = result.file || null;
    spState.ancestorIds = Array.isArray(result.ancestorIds) ? result.ancestorIds : [];
    spState.matchedAccount = normalizeEntry(result.matchedAccount || prefAcc || result.file?.ownerAccount || '');
    if (result.policy) spState.policy = result.policy;
    if (result.directory) spState.directory = result.directory;
    spState.evaluation = result.evaluation || null;
    spState.breakage = result.breakage || null;
    spState.ttlEntries = Array.isArray(result.ttlEntries)
      ? result.ttlEntries.filter(it => !it.fileId || it.fileId === result.file?.id)
      : [];
    spState.currentSource = source;

    const labelKind =
      result.file?.mimeType === 'application/vnd.google-apps.folder' ? '文件夹' : '云端文档';
    if (source === 'tab') {
      setActiveTabHint(`已关联当前页 · ${labelKind}`, true);
      const urlDisclosure = $('sp-url-disclosure');
      if (urlDisclosure && urlDisclosure.open) {
        urlDisclosure.open = false;
      }
    } else {
      setActiveTabHint(`手动核查 · ${result.file?.name || cleanId}`, true);
    }

    renderCurrentFileView();
    if (!silentToast) {
      toast(`已同步《${result.file?.name || cleanId}》的最新权限`);
    }
    return true;
  } catch (error) {
    if (reqSeq !== spState.inspectSeq) return false;
    const errMsg = String(error?.message || error || '读取文件失败').replaceAll('\u2014', '·');
    spState.currentFile = null;
    spState.ancestorIds = [];
    spState.evaluation = null;
    spState.breakage = null;
    setActiveTabHint('未能读取该文件权限', false);
    showEmptyState(
      '无法读取该云端文件的权限',
      `${errMsg}。请确认当前文件存在，且已在全屏工作台中授权拥有访问权限的对应 Google 账号。`
    );
    if (!silentToast || source === 'manual') {
      toast(`核查失败：${errMsg}`);
    }
    return false;
  } finally {
    if (reqSeq === spState.inspectSeq) {
      spState.inspectLoading = false;
      if (inspectBtn) inspectBtn.disabled = false;
      if (refreshBtn) refreshBtn.disabled = spState.busyAction;
    }
  }
}

async function refreshCurrentFile(silentToast = true) {
  if (!spState.currentFile?.id) return false;
  return inspectAndRenderById(spState.currentFile.id, {
    source: spState.currentSource,
    preferredAccount: spState.matchedAccount || spState.preferredAccount,
    silentToast
  });
}

async function syncFromActiveTab({ force = false, notifyIfEmpty = false } = {}) {
  try {
    spState.accounts = await getAuthorizedAccounts();
  } catch (_e) {
    spState.accounts = [];
  }

  let activeTab = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      const queryInfo =
        spState.windowId !== null
          ? { active: true, windowId: spState.windowId }
          : { active: true, currentWindow: true };
      const tabs = await chrome.tabs.query(queryInfo);
      activeTab = Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
      if (activeTab && spState.windowId === null && typeof activeTab.windowId === 'number') {
        spState.windowId = activeTab.windowId;
      }
    }
  } catch (_err) {
    activeTab = null;
  }

  const rawTabUrl = activeTab?.url || '';
  const parsed = compatParseDriveUrlOrId(rawTabUrl);
  const isGoogleUrl = rawTabUrl ? isTrustedGoogleWebUrl(rawTabUrl) || Boolean(parsed?.isDriveDomain) : false;
  const detectedFileId = isGoogleUrl ? String(parsed?.fileId || '').trim() : '';

  if (spState.accounts.length === 0) {
    setActiveTabHint(
      detectedFileId ? '已识别文档 · 请先授权账号' : '待授权 Google 账号',
      false
    );
    showNoAccountState();
    return;
  }

  if (detectedFileId) {
    const urlInput = $('sp-url-input');
    if (urlInput && (typeof document === 'undefined' || document.activeElement !== urlInput)) {
      urlInput.value = rawTabUrl;
    }
    if (
      !force &&
      spState.currentSource === 'tab' &&
      spState.currentFile?.id === detectedFileId &&
      !spState.inspectLoading
    ) {
      setActiveTabHint('已关联当前页', true);
      renderCurrentFileView();
      return;
    }
    await inspectAndRenderById(detectedFileId, {
      source: 'tab',
      preferredAccount: spState.preferredAccount,
      silentToast: !notifyIfEmpty
    });
    return;
  }

  if (parsed?.isDriveDomain || isGoogleUrl) {
    setActiveTabHint('位于云盘目录页 · 点开文档即核查', false);
  } else {
    setActiveTabHint('当前非云盘文档页', false);
  }

  if (notifyIfEmpty || spState.currentSource === 'tab' || !spState.currentFile) {
    spState.currentFile = null;
    spState.ancestorIds = [];
    spState.evaluation = null;
    spState.breakage = null;
    if (parsed?.isDriveDomain || isGoogleUrl) {
      showEmptyState(
        '当前位于 Google Drive 目录或列表页',
        '请在网页中双击打开任意具体的文档、表格、幻灯片，或进入某个具体子文件夹，侧栏将自动展示风险预警与谁有权限；也可展开上方「手输链接」直接粘贴核查。'
      );
    } else {
      showEmptyState(
        '当前标签页不是 Google Drive 文档',
        '切换到打开了 Google 文档或云端硬盘文件夹的标签页即可自动关联，或展开上方「手输链接」粘贴任意 Drive 链接 / ID 立即核查。'
      );
    }
    if (notifyIfEmpty) {
      toast('当前网页未识别到具体的 Google Drive 文件或文件夹 ID');
    }
  }
}

/* ==================== 就地治理、排除目录切换与快捷赋权动作 ==================== */

function setActionBusy(busy) {
  spState.busyAction = Boolean(busy);
  if (spState.currentFile) {
    renderCurrentFileView();
  }
}

function syncTtlCustomInputVisibility(selectId, customInputId) {
  const sel = $(selectId);
  const customInput = $(customInputId);
  if (!sel || !customInput) return;
  const isCustom = sel.value === 'custom';
  customInput.classList.toggle('hidden', !isCustom);
  if (isCustom && !customInput.value) {
    customInput.value = buildDefaultCustomDateTimeValue(24);
  }
}

function resolveTtlFromControls(selectId, customInputId) {
  const preset = $(selectId)?.value || 'none';
  const customVal = $(customInputId)?.value || '';
  return compatResolveTtlExpiresAt(preset, customVal) || '';
}

async function handleManualInspect() {
  const raw = ($('sp-url-input')?.value || '').trim();
  if (!raw) {
    const disc = $('sp-url-disclosure');
    if (disc) disc.open = true;
    toast('请先粘贴 Google Drive 文件/文件夹链接或 ID');
    $('sp-url-input')?.focus?.();
    return;
  }
  const parsed = compatParseDriveUrlOrId(raw);
  if (!parsed?.fileId) {
    toast('未能从输入内容中识别出有效的 Google Drive 文件或文件夹 ID');
    $('sp-url-input')?.focus?.();
    return;
  }
  await inspectAndRenderById(parsed.fileId, {
    source: 'manual',
    preferredAccount: spState.preferredAccount,
    silentToast: true
  });
}

async function handleToggleExcludeCurrentItem() {
  const file = spState.currentFile;
  if (!file || spState.busyAction) return;

  const currentlyExcluded = compatIsFileExcluded(file, spState.policy);
  const matchedEntry = findMatchingExcludedEntry(file, spState.policy?.excludedFolders || []);

  setActionBusy(true);
  try {
    if (currentlyExcluded) {
      const targetRemoveId = matchedEntry?.id || file.id;
      const targetName = matchedEntry?.name || file.name || targetRemoveId;
      spState.policy = await compatRemoveExcludedFolder(targetRemoveId);
      toast(`已将《${targetName}》移出排除目录，恢复常规风险核查`);
    } else {
      spState.policy = await compatAddExcludedFolders([
        {
          id: file.id,
          name: file.name || '(未命名目录)',
          webViewLink: formatDriveCanonicalLink(file),
          includeSubitems: true,
          note: '由伴随权限栏设为对外排除项',
          addedAt: new Date().toISOString()
        }
      ]);
      toast(`已将《${file.name || file.id}》设为对外排除目录，扫描与自动关链将自动跳过`);
    }
  } catch (error) {
    toast(`更新排除目录设置失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
    renderCurrentFileView();
  }
}

async function handleEnforceCurrentFile() {
  if (!spState.currentFile || spState.busyAction) return;
  if (compatIsFileExcluded(spState.currentFile, spState.policy)) {
    toast('当前项已设为对外排除目录，如需按白名单修正请先移出排除目录');
    return;
  }
  const targetAccount = spState.matchedAccount || spState.currentFile.ownerAccount || '';
  setActionBusy(true);
  try {
    const workingFile = {
      ...spState.currentFile,
      ownerAccount: targetAccount || spState.currentFile.ownerAccount || '',
      permissions: Array.isArray(spState.currentFile.permissions)
        ? spState.currentFile.permissions.map(p => ({ ...p }))
        : []
    };
    const res = await enforceFilesByPolicy(
      null,
      [workingFile],
      spState.policy,
      targetAccount,
      'manual'
    );
    const detail = `移除 ${res.removed} 项 · 降级 ${res.downgraded} 项${res.failed > 0 ? ` · 失败 ${res.failed} 项` : ''}`;
    toast(`已按白名单修正当前文件：${detail}`);
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`按白名单修正失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
  }
}

async function handleClosePublicLinks() {
  const file = spState.currentFile;
  if (!file || spState.busyAction) return;
  if (compatIsFileExcluded(file, spState.policy)) {
    toast('当前项处于排除目录保护中，不会关闭其对外公开链接');
    return;
  }

  const publicPerms = (file.permissions || []).filter(
    p => p && (p.type === 'anyone' || p.type === 'domain')
  );
  if (!publicPerms.length) {
    toast('当前文件未开启公开或域内共享链接');
    return;
  }

  const removable = publicPerms.filter(p => (!permIsInherited(p) || permHasDirectGrant(p)) && p.id);
  if (!removable.length) {
    toast('公开或域内链接继承自上级文件夹，请打开父文件夹移除');
    return;
  }

  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  setActionBusy(true);
  try {
    const token = await getValidTokenForAccount(actingAccount, true);
    const auditEntries = [];
    let removedCount = 0;

    for (const perm of removable) {
      await deletePermission(token, file.id, perm.id);
      removedCount++;
      auditEntries.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        source: 'manual',
        actionType: 'revoke',
        accountEmail: actingAccount,
        fileId: file.id,
        fileName: file.name || '(无名称)',
        webViewLink: formatDriveCanonicalLink(file),
        permissionId: perm.id,
        targetType: perm.type,
        domain: perm.domain || '',
        targetLabel: permissionLabel(perm),
        previousRole: perm.role || 'reader',
        newRole: '',
        restored: false,
        message: `伴随栏关闭公开或域内链接：${permissionLabel(perm)}（原角色：${roleLabel(perm.role)}）`
      });
    }

    if (auditEntries.length > 0) {
      await appendAuditLogs(auditEntries);
    }
    toast(`已关闭 ${removedCount} 项公开或域内共享链接`);
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`关闭公开链接失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
  }
}

async function handleAlignToParent() {
  const file = spState.currentFile;
  if (!file || !spState.breakage?.broken || spState.busyAction) return;

  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  setActionBusy(true);
  try {
    const workingFile = {
      ...file,
      ownerAccount: actingAccount || file.ownerAccount || '',
      permissions: Array.isArray(file.permissions) ? file.permissions.map(p => ({ ...p })) : []
    };
    const res = await alignFilesToParentPermissions({
      files: [workingFile],
      breakageMap: new Map([[workingFile.id, spState.breakage]])
    });
    const detail = `移除 ${res.removedCount} 项 · 降级 ${res.downgradedCount} 项${res.failedCount > 0 ? ` · 失败 ${res.failedCount} 项` : ''}`;
    toast(`已对齐父目录权限：${detail}`);
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`对齐父目录失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
  }
}

async function handleSecurityHardeningToggle(kind) {
  const file = spState.currentFile;
  if (!file || spState.busyAction) return;

  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  if (isFolder && (kind === 'copy_lock' || kind === 'content_lock')) {
    toast('文件夹不支持该项限制，请打开具体文档或表格设置');
    return;
  }

  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  file.ownerAccount = actingAccount || file.ownerAccount || '';

  const payload = { files: [file] };
  let actionLabel = '';
  if (kind === 'writers_share') {
    const nextWritersCanShare = file.writersCanShare === false ? true : false;
    payload.writersCanShare = nextWritersCanShare;
    actionLabel = nextWritersCanShare === false ? '已开启「禁编辑拉人」' : '已解除「禁编辑拉人」限制';
  } else if (kind === 'copy_lock') {
    const nextCopyLock = !Boolean(file.copyRequiresWriterPermission);
    payload.copyRequiresWriterPermission = nextCopyLock;
    actionLabel = nextCopyLock ? '已开启「禁下载复制」' : '已解除「禁下载复制」限制';
  } else if (kind === 'content_lock') {
    const nextContentLock = !isFileContentLocked(file);
    payload.contentLock = nextContentLock;
    payload.lockReason = '由 Drive 权限管理中心锁定保护';
    actionLabel = nextContentLock ? '已开启「锁定防误改」' : '已解除文件只读锁定';
  } else {
    return;
  }

  setActionBusy(true);
  try {
    const res = await compatApplyFileSecurityHardening(payload);
    if (res?.failedCount > 0 && !(res?.changedCount > 0)) {
      const firstErr = res.failedItems?.[0]?.errorMessage || '当前账号无权修改该文件的编辑与下载权限';
      throw new Error(firstErr);
    }
    if (typeof payload.writersCanShare === 'boolean') {
      file.writersCanShare = payload.writersCanShare;
    }
    if (typeof payload.copyRequiresWriterPermission === 'boolean') {
      file.copyRequiresWriterPermission = payload.copyRequiresWriterPermission;
    }
    if (typeof payload.contentLock === 'boolean') {
      file.contentLocked = payload.contentLock;
      if (!payload.contentLock) {
        file.contentRestrictions = [];
        file.contentLockReason = '';
      } else if (!Array.isArray(file.contentRestrictions) || !file.contentRestrictions.some(r => r?.readOnly)) {
        file.contentRestrictions = [{ readOnly: true, reason: payload.lockReason }];
        file.contentLockReason = payload.lockReason;
      }
    }
    toast(actionLabel);
  } catch (error) {
    toast(`修改编辑与下载权限失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
    renderCurrentFileView();
  }
}

async function handleGroupAction(mode = 'grant', explicitGroupName = '') {
  const file = spState.currentFile;
  if (!file || spState.busyAction) return;

  const grp = String(explicitGroupName || $('sp-group-select')?.value || '').trim();
  if (!grp) {
    toast('请先选择一个人员分组');
    return;
  }

  const members = (spState.directory?.contacts || []).filter(c => (c.groups || []).includes(grp));
  if (!members.length) {
    toast(`分组「${grp}」下暂无成员邮箱，请先在全屏工作台「邮箱分组与模板」读取表格或添加成员`);
    return;
  }

  const roleOption = explicitGroupName ? 'group_default' : ($('sp-group-role')?.value || 'group_default');
  let expiresAt = '';
  if (mode === 'grant' && !explicitGroupName) {
    try {
      expiresAt = resolveTtlFromControls('sp-group-ttl', 'sp-group-ttl-custom');
    } catch (ttlErr) {
      toast(ttlErr?.message || String(ttlErr));
      $('sp-group-ttl-custom')?.focus?.();
      return;
    }
  }

  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  setActionBusy(true);
  try {
    const workingFile = {
      ...file,
      ownerAccount: actingAccount || file.ownerAccount || '',
      permissions: Array.isArray(file.permissions) ? file.permissions.map(p => ({ ...p })) : []
    };
    const res = await executeGroupBatchOnFiles({
      files: [workingFile],
      groupNames: [grp],
      mode,
      roleOption,
      directory: spState.directory,
      expiresAt
    });

    if (mode === 'revoke_groups') {
      toast(
        `已撤除分组「${grp}」权限：移除 ${res.removedCount} 人${res.failedCount > 0 ? ` · 失败 ${res.failedCount} 人` : ''}`
      );
    } else {
      const ttlTip = expiresAt ? ` · ${compatFormatTtlRemaining(expiresAt)}` : '';
      toast(
        `分组「${grp}」赋权完成：新增 ${res.createdCount} 人 · 更新 ${res.updatedCount} 人${ttlTip}${res.failedCount > 0 ? ` · 失败 ${res.failedCount} 人` : ''}`
      );
    }
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`分组权限操作失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
  }
}

async function handleAddCollaborator() {
  const file = spState.currentFile;
  if (!file || spState.busyAction) return;

  const emailInput = $('sp-add-email');
  const emailAddress = normalizeEntry(emailInput?.value || '');
  if (!emailAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
    toast('请输入有效的个人或 Google 群组邮箱地址');
    emailInput?.focus?.();
    return;
  }

  const role = $('sp-add-role')?.value || 'reader';
  let expiresAt = '';
  try {
    expiresAt = resolveTtlFromControls('sp-add-ttl', 'sp-add-ttl-custom');
  } catch (ttlErr) {
    toast(ttlErr?.message || String(ttlErr));
    $('sp-add-ttl-custom')?.focus?.();
    return;
  }

  const inferredType = compatInferPermissionTargetType(emailAddress, '', spState.directory);
  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  setActionBusy(true);
  try {
    const grantRes = await compatGrantPermissionWithTtl({
      accountEmail: actingAccount,
      file,
      fileId: file.id,
      type: inferredType,
      role,
      emailAddress,
      expiresAt
    });

    const resolvedType =
      grantRes?.resolvedType || grantRes?.createdPermission?.type || inferredType;
    const contact = buildContactLookup(spState.directory).get(emailAddress) || null;
    const targetLabel = contact?.name ? `${contact.name} (${emailAddress})` : emailAddress;
    const kindPrefix = resolvedType === 'group' ? '群组 ' : '';
    const ttlDesc = expiresAt ? `（限时：${compatFormatTtlRemaining(expiresAt)}）` : '';

    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'grant',
      accountEmail: actingAccount,
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: formatDriveCanonicalLink(file),
      permissionId: grantRes?.createdPermission?.id || '',
      targetType: resolvedType,
      targetEmail: emailAddress,
      targetLabel,
      previousRole: '',
      newRole: role,
      restored: false,
      message: `伴随栏授予${kindPrefix}${targetLabel}「${roleLabel(role)}」权限${ttlDesc}`
    });

    if (emailInput) emailInput.value = '';
    toast(`已为${kindPrefix}${targetLabel} 开通${roleLabel(role)}权限${ttlDesc}`);
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`添加协作者失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
  }
}

const handleAddPerm = handleAddCollaborator;

async function handlePermissionRoleChange(permId, newRole) {
  const file = spState.currentFile;
  if (!file || !permId || !newRole || spState.busyAction) return;

  const perm = (file.permissions || []).find(p => p.id === permId);
  if (!perm || perm.role === newRole) return;

  const prevRole = perm.role;
  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  const label = permissionLabel(perm, buildContactLookup(spState.directory));

  setActionBusy(true);
  try {
    const token = await getValidTokenForAccount(actingAccount, true);
    await updatePermissionRole(token, file.id, permId, newRole);
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'downgrade',
      accountEmail: actingAccount,
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: formatDriveCanonicalLink(file),
      permissionId: permId,
      targetType: perm.type || 'user',
      targetEmail: perm.emailAddress || '',
      domain: perm.domain || '',
      targetLabel: permissionLabel(perm),
      previousRole: prevRole,
      newRole,
      restored: false,
      message: `伴随栏修改角色：${roleLabel(prevRole)} -> ${roleLabel(newRole)}`
    });
    toast(`已将 ${label} 调整为${roleLabel(newRole)}`);
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`修改角色失败：${error?.message || String(error)}`);
    renderCurrentFileView();
  } finally {
    setActionBusy(false);
  }
}

async function handleRemovePermission(permId) {
  const file = spState.currentFile;
  if (!file || !permId || spState.busyAction) return;

  const perm = (file.permissions || []).find(p => p.id === permId);
  if (!perm) return;

  const actingAccount = spState.matchedAccount || file.ownerAccount || '';
  const label = permissionLabel(perm, buildContactLookup(spState.directory));

  setActionBusy(true);
  try {
    const token = await getValidTokenForAccount(actingAccount, true);
    await deletePermission(token, file.id, permId);
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'manual',
      actionType: 'revoke',
      accountEmail: actingAccount,
      fileId: file.id,
      fileName: file.name || '(无名称)',
      webViewLink: formatDriveCanonicalLink(file),
      permissionId: permId,
      targetType: perm.type || 'user',
      targetEmail: perm.emailAddress || '',
      domain: perm.domain || '',
      targetLabel: permissionLabel(perm),
      previousRole: perm.role || 'reader',
      newRole: '',
      restored: false,
      message: `伴随栏移除权限：${permissionLabel(perm)}（原角色：${roleLabel(perm.role)}）`
    });
    toast(`已移除 ${label} 的访问权限`);
    await refreshCurrentFile(true);
  } catch (error) {
    toast(`移除权限失败：${error?.message || String(error)}`);
  } finally {
    setActionBusy(false);
  }
}

/* ==================== 初始化与全局监听绑定 ==================== */

async function initSidepanel() {
  syncThemeControlsUI();

  // 1. 主题切换与跨窗口实时同步
  $('sp-theme-btn')?.addEventListener('click', toggleSidepanelColorScheme);
  if (typeof window !== 'undefined') {
    const schemeMql = window.matchMedia?.('(prefers-color-scheme: dark)');
    schemeMql?.addEventListener?.('change', () => {
      applyColorSchemeMeta(getStoredColorScheme());
      syncThemeControlsUI();
    });
    window.addEventListener?.('storage', e => {
      if (!e || e.key === 'color-scheme' || e.key === null) {
        applyColorSchemeMeta(getStoredColorScheme());
        syncThemeControlsUI();
      }
    });
  }

  // 2. Toast 悬停与焦点暂留支持
  const toastNode = $('sp-toast');
  toastNode?.addEventListener('mouseenter', () => {
    toast._hovered = true;
    clearTimeout(toast._timer);
  });
  toastNode?.addEventListener('mouseleave', () => {
    toast._hovered = false;
    if (!toastNode.matches?.(':focus-within')) {
      scheduleToastAutoHide(1800);
    }
  });
  toastNode?.addEventListener('focusout', e => {
    if (toast._paused && !toastNode.contains?.(e.relatedTarget)) {
      toast._paused = false;
      scheduleToastAutoHide(1800);
    }
  });
  $('sp-toast-close-btn')?.addEventListener('click', () => {
    const hadFocusInside = Boolean(
      typeof document !== 'undefined' && toastNode?.contains?.(document.activeElement)
    );
    const prior = toast._priorFocus;
    hideToastPopover();
    if (hadFocusInside && prior && typeof prior.focus === 'function' && prior.isConnected) {
      prior.focus();
    }
  });

  // 3. 顶栏与空状态全屏工作台联动
  $('sp-open-dashboard-btn')?.addEventListener('click', () => {
    return openDashboard(spState.currentFile?.id || '');
  });
  $('sp-go-onboarding-btn')?.addEventListener('click', () => {
    return openDashboard('');
  });
  $('sp-open-in-dashboard-btn')?.addEventListener('click', () => {
    return openDashboard(spState.currentFile?.id || '');
  });

  // 4. 折叠手输链接条与读取当前标签页（含 IME 安全回车）
  $('sp-read-tab-btn')?.addEventListener('click', () => {
    return syncFromActiveTab({ force: true, notifyIfEmpty: true });
  });
  $('sp-inspect-btn')?.addEventListener('click', () => {
    return handleManualInspect();
  });
  bindImeSafeEnter($('sp-url-input'), () => {
    return handleManualInspect();
  });

  // 5. 二段式快捷操作卡切换
  $('sp-act-tab-share-btn')?.addEventListener('click', () => {
    switchSidepanelActionTab('share');
  });
  $('sp-act-tab-lock-btn')?.addEventListener('click', () => {
    switchSidepanelActionTab('lock');
  });

  // 6. 单文件身份卡、排除目录切换与宽权限紧急止血按钮
  $('sp-account-select')?.addEventListener('change', async e => {
    const nextAcc = normalizeEntry(e.target.value || '');
    spState.preferredAccount = nextAcc;
    if (spState.currentFile?.id) {
      await inspectAndRenderById(spState.currentFile.id, {
        source: spState.currentSource,
        preferredAccount: nextAcc,
        silentToast: false
      });
    }
  });

  $('sp-header-close-public-btn')?.addEventListener('click', () => {
    return handleClosePublicLinks();
  });
  $('sp-refresh-btn')?.addEventListener('click', () => {
    return refreshCurrentFile(false);
  });
  $('sp-toggle-exclude-btn')?.addEventListener('click', () => {
    return handleToggleExcludeCurrentItem();
  });
  $('sp-enforce-btn')?.addEventListener('click', () => {
    return handleEnforceCurrentFile();
  });
  $('sp-close-public-btn')?.addEventListener('click', () => {
    return handleClosePublicLinks();
  });
  $('sp-align-parent-btn')?.addEventListener('click', () => {
    return handleAlignToParent();
  });
  $('sp-panel-align-parent-btn')?.addEventListener('click', () => {
    return handleAlignToParent();
  });
  $('sp-quick-harden-writers-btn')?.addEventListener('click', () => {
    return handleSecurityHardeningToggle('writers_share');
  });

  // 7. 修改编辑与下载权限开关
  $('sp-toggle-writers-share')?.addEventListener('click', () => {
    return handleSecurityHardeningToggle('writers_share');
  });
  $('sp-toggle-copy-lock')?.addEventListener('click', () => {
    return handleSecurityHardeningToggle('copy_lock');
  });
  $('sp-toggle-content-lock')?.addEventListener('click', () => {
    return handleSecurityHardeningToggle('content_lock');
  });

  // 8. 分组快捷赋权与 TTL 选择联动
  $('sp-group-ttl')?.addEventListener('change', () => {
    syncTtlCustomInputVisibility('sp-group-ttl', 'sp-group-ttl-custom');
  });
  $('sp-group-grant-btn')?.addEventListener('click', () => {
    return handleGroupAction('grant');
  });
  $('sp-group-revoke-btn')?.addEventListener('click', () => {
    return handleGroupAction('revoke_groups');
  });
  $('sp-group-coverage')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="sp-complete-group"]');
    if (btn?.dataset?.group) {
      handleGroupAction('grant', btn.dataset.group);
    }
  });

  // 9. 单人协作者添加与 TTL 选择联动（含 IME 安全回车）
  $('sp-add-ttl')?.addEventListener('change', () => {
    syncTtlCustomInputVisibility('sp-add-ttl', 'sp-add-ttl-custom');
  });
  $('sp-add-perm-btn')?.addEventListener('click', () => {
    return handleAddCollaborator();
  });
  bindImeSafeEnter($('sp-add-email'), () => {
    return handleAddCollaborator();
  });

  // 10. 协作者列表事件委托（行内秒改角色 / 移除权限）
  $('sp-perm-list')?.addEventListener('change', e => {
    const sel = e.target.closest('select[data-action="sp-role-change"]');
    if (sel?.dataset?.permId) {
      handlePermissionRoleChange(sel.dataset.permId, sel.value);
    }
  });
  $('sp-perm-list')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action="sp-remove-perm"]');
    if (btn?.dataset?.permId) {
      handleRemovePermission(btn.dataset.permId);
    }
  });

  // 11. 获取当前窗口 ID 与初始缓存策略/通讯录
  try {
    if (typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
      const currentWin = await chrome.windows.getCurrent();
      if (currentWin && typeof currentWin.id === 'number') {
        spState.windowId = currentWin.id;
      }
    }
  } catch (_winErr) {
    spState.windowId = null;
  }

  try {
    const [policy, directory, accounts] = await Promise.all([
      getPolicy(),
      getDirectory(),
      getAuthorizedAccounts()
    ]);
    spState.policy = policy;
    spState.directory = directory;
    spState.accounts = accounts;
  } catch (_initErr) {
    // 使用默认策略兜底
  }

  // 12. 监听当前窗口活动标签页切换与 URL 更新（250ms 防抖）
  let tabSyncTimer = null;
  const triggerDebouncedTabSync = () => {
    clearTimeout(tabSyncTimer);
    tabSyncTimer = setTimeout(() => {
      syncFromActiveTab({ force: false, notifyIfEmpty: false });
    }, 250);
  };

  if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
    chrome.tabs.onActivated.addListener(activeInfo => {
      if (spState.windowId !== null && activeInfo?.windowId !== spState.windowId) {
        return;
      }
      triggerDebouncedTabSync();
    });
  }

  if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (!tab?.active) return;
      if (spState.windowId !== null && tab.windowId !== spState.windowId) return;
      if (typeof changeInfo?.url === 'string' || changeInfo?.status === 'complete') {
        triggerDebouncedTabSync();
      }
    });
  }

  // 13. 监听本地存储与后台消息实时双向联动（含排除目录、白名单、分组与快照同步）
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== 'local') return;
      try {
        if (changes.authorizedAccounts) {
          const prevCount = spState.accounts.length;
          spState.accounts = await getAuthorizedAccounts();
          if (spState.accounts.length === 0) {
            showNoAccountState();
            return;
          }
          if (prevCount === 0 && spState.accounts.length > 0) {
            await syncFromActiveTab({ force: true, notifyIfEmpty: false });
            return;
          }
        }
        let needRerender = false;
        if (changes.policy) {
          spState.policy = await getPolicy();
          needRerender = true;
        }
        if (changes.directory) {
          spState.directory = await getDirectory();
          needRerender = true;
        }
        if (changes.ttlPermissionsQueue && spState.currentFile?.id) {
          const allTtl = await compatGetTtlQueue();
          spState.ttlEntries = allTtl.filter(it => it && it.fileId === spState.currentFile.id && it.status !== 'completed');
          needRerender = true;
        }
        if (changes.scanSnapshot && spState.currentFile?.id && !spState.busyAction && !spState.inspectLoading) {
          const snapFiles = changes.scanSnapshot.newValue?.files;
          if (Array.isArray(snapFiles)) {
            const matchedSnap = snapFiles.find(f => f && f.id === spState.currentFile.id);
            if (matchedSnap) {
              if (typeof matchedSnap.writersCanShare === 'boolean') {
                spState.currentFile.writersCanShare = matchedSnap.writersCanShare;
              }
              if (typeof matchedSnap.copyRequiresWriterPermission === 'boolean') {
                spState.currentFile.copyRequiresWriterPermission = matchedSnap.copyRequiresWriterPermission;
              }
              if (typeof matchedSnap.contentLocked === 'boolean') {
                spState.currentFile.contentLocked = matchedSnap.contentLocked;
                spState.currentFile.contentLockReason = matchedSnap.contentLockReason || '';
              }
              if (Array.isArray(matchedSnap.contentRestrictions)) {
                spState.currentFile.contentRestrictions = matchedSnap.contentRestrictions;
              }
              if (Array.isArray(matchedSnap.permissions) && matchedSnap.permissions.length > 0) {
                spState.currentFile.permissions = matchedSnap.permissions.map(p => ({ ...p }));
              }
              needRerender = true;
            }
          }
        }
        if (needRerender && spState.currentFile) {
          renderCurrentFileView();
        }
      } catch (_storageErr) {
        // 忽略后台状态同步异常
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(async (message, sender) => {
      if (sender?.id && chrome.runtime?.id && sender.id !== chrome.runtime.id) return;
      if (message?.type === 'TTL_UPDATED' && spState.currentFile?.id && !spState.busyAction) {
        await refreshCurrentFile(true);
      }
    });
  }

  // 14. 首次启动立即同步当前活动标签页
  await syncFromActiveTab({ force: true, notifyIfEmpty: false });
}

initSidepanel();
