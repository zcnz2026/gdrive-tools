const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const ALARM_NAME = 'drive_permission_periodic_scan';

const DEFAULT_POLICY = {
  writers: [],          // 允许编辑的邮箱或 @domain.com
  readers: [],          // 仅允许查看的邮箱或 @domain.com
  publicLinkRule: 'forbid', // 'forbid' | 'reader_only' | 'allow'
  scheduleEnabled: false,
  scheduleMinutes: 60,
  autoEnforce: false    // false = 仅提醒, true = 后台自动撤权/降级
};

function normalizeEntry(value = '') {
  return String(value).trim().toLowerCase();
}

function normalizeEmailList(list = []) {
  return [...new Set(list.map(normalizeEntry).filter(Boolean))];
}

async function getPolicy() {
  const data = await chrome.storage.local.get('policy');
  const saved = data.policy || {};
  return {
    ...DEFAULT_POLICY,
    ...saved,
    writers: normalizeEmailList(saved.writers || []),
    readers: normalizeEmailList(saved.readers || [])
  };
}

async function savePolicy(partialPolicy) {
  const current = await getPolicy();
  const next = {
    ...current,
    ...partialPolicy
  };
  next.writers = normalizeEmailList(next.writers || []);
  // 若某邮箱已在 writers 中，则从 readers 中移除避免冲突
  const writerSet = new Set(next.writers);
  next.readers = normalizeEmailList((next.readers || []).filter(item => !writerSet.has(item)));
  await chrome.storage.local.set({ policy: next });
  return next;
}

async function getSnapshot() {
  const data = await chrome.storage.local.get('scanSnapshot');
  return data.scanSnapshot || {
    lastScanAt: '',
    lastScanSource: '',
    accountEmail: '',
    files: [],
    knownFileIds: [],
    newFileIds: []
  };
}

async function saveSnapshot(snapshot) {
  await chrome.storage.local.set({ scanSnapshot: snapshot });
  return snapshot;
}

async function getAuditLogs() {
  const data = await chrome.storage.local.get('auditLogs');
  return Array.isArray(data.auditLogs) ? data.auditLogs : [];
}

async function appendAuditLogs(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (!list.length) return;
  const current = await getAuditLogs();
  const merged = [...list, ...current].slice(0, 600);
  await chrome.storage.local.set({ auditLogs: merged });
  return merged;
}

async function markAuditLogRestored(logId) {
  const current = await getAuditLogs();
  const updated = current.map(item => item.id === logId ? { ...item, restored: true, restoredAt: new Date().toISOString() } : item);
  await chrome.storage.local.set({ auditLogs: updated });
  return updated;
}

async function clearAuditLogs() {
  await chrome.storage.local.set({ auditLogs: [] });
}

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!result) {
        reject(new Error('未取得 Google 授权令牌'));
      } else {
        // 兼容部分 Chrome 版本返回对象 { token } 或字符串
        resolve(typeof result === 'string' ? result : result.token);
      }
    });
  });
}

async function driveApi(token, path, options = {}, retry = 0) {
  const response = await fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if ((response.status === 429 || response.status === 403 || response.status >= 500) && retry < 5) {
    const body = await response.clone().json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason;
    if (
      response.status !== 429 &&
      response.status < 500 &&
      !['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'].includes(reason)
    ) {
      throw new Error(body?.error?.message || `Drive API 错误 ${response.status}`);
    }
    await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** retry + Math.random() * 500, 16000)));
    return driveApi(token, path, options, retry + 1);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Drive API 错误 ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function fetchAboutUser(token) {
  const data = await driveApi(token, '/about?fields=user(emailAddress,displayName)');
  return {
    email: data.user?.emailAddress || '',
    displayName: data.user?.displayName || ''
  };
}

function permIsInherited(permission) {
  return (permission?.permissionDetails || []).some(detail => detail.inherited);
}

function roleLabel(role) {
  const map = {
    owner: '所有者',
    organizer: '管理者',
    fileOrganizer: '内容管理者',
    writer: '可编辑',
    commenter: '可评论',
    reader: '仅查看'
  };
  return map[role] || role || '未知';
}

function permissionLabel(permission) {
  if (!permission) return '';
  if (permission.type === 'anyone') return '公开链接 (任何人)';
  if (permission.type === 'domain') return `域内共享 (${permission.domain || '未知域'})`;
  return permission.emailAddress || permission.displayName || permission.type;
}

function fileCategory(mimeType = '') {
  if (mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return 'sheet';
  }
  if (mimeType === 'application/vnd.google-apps.folder') {
    return 'folder';
  }
  if (mimeType === 'application/vnd.google-apps.document' || mimeType.includes('document') || mimeType.includes('word')) {
    return 'doc';
  }
  if (mimeType === 'application/vnd.google-apps.presentation' || mimeType.includes('presentation')) {
    return 'slide';
  }
  return 'other';
}

function fileCategoryLabel(mimeType = '') {
  const cat = fileCategory(mimeType);
  const labels = {
    sheet: '📊 表格',
    folder: '📁 文件夹',
    doc: '📝 文档',
    slide: '📽️ 幻灯片',
    other: '📄 文件'
  };
  return labels[cat] || '📄 文件';
}

function matchesAllowlist(email = '', list = []) {
  const target = normalizeEntry(email);
  if (!target) return false;
  const domainPart = target.includes('@') ? '@' + target.split('@')[1] : '';
  for (const item of list) {
    const rule = normalizeEntry(item);
    if (!rule) continue;
    if (rule === target) return true;
    if (rule.startsWith('@') && domainPart && rule === domainPart) return true;
  }
  return false;
}

/**
 * 评估单条权限的合规状态
 * 返回:
 * - status: 'owner' | 'inherited' | 'compliant' | 'violation_downgrade' | 'violation_remove'
 * - desiredAction: null | 'downgrade' | 'remove'
 * - targetRole: 'reader' | null
 * - reason: string
 */
function evaluatePermission(permission, policy, ownerEmail = '') {
  if (!permission) {
    return { status: 'compliant', desiredAction: null, targetRole: null, reason: '' };
  }
  const email = normalizeEntry(permission.emailAddress || '');
  const owner = normalizeEntry(ownerEmail);

  if (permission.role === 'owner' || (email && owner && email === owner)) {
    return { status: 'owner', desiredAction: null, targetRole: null, reason: '文件所有者' };
  }

  const inherited = permIsInherited(permission);

  if (permission.type === 'anyone' || permission.type === 'domain') {
    const rule = policy?.publicLinkRule || 'forbid';
    if (rule === 'forbid') {
      return {
        status: inherited ? 'inherited' : 'violation_remove',
        inheritedViolation: inherited ? 'violation_remove' : null,
        desiredAction: inherited ? null : 'remove',
        targetRole: null,
        reason: inherited ? '继承的公开/域内链接（需在上级文件夹移除）' : '违规：策略禁止公开/域内链接'
      };
    }
    if (rule === 'reader_only') {
      if (permission.role !== 'reader') {
        return {
          status: inherited ? 'inherited' : 'violation_downgrade',
          inheritedViolation: inherited ? 'violation_downgrade' : null,
          desiredAction: inherited ? null : 'downgrade',
          targetRole: 'reader',
          reason: inherited ? '继承的公开可编辑链接（需在上级文件夹降为只读）' : '越权：公开/域内链接当前可编辑，策略最高仅允许只读'
        };
      }
      return {
        status: inherited ? 'inherited' : 'compliant',
        desiredAction: null,
        targetRole: null,
        reason: '公开/域内只读链接（符合策略）'
      };
    }
    return {
      status: inherited ? 'inherited' : 'compliant',
      desiredAction: null,
      targetRole: null,
      reason: '允许公开/域内链接'
    };
  }

  if (permission.type === 'user' || permission.type === 'group') {
    const inWriters = matchesAllowlist(email, policy?.writers || []);
    const inReaders = matchesAllowlist(email, policy?.readers || []);

    if (inWriters) {
      return {
        status: inherited ? 'inherited' : 'compliant',
        desiredAction: null,
        targetRole: null,
        reason: '在「允许编辑」白名单内'
      };
    }

    if (inReaders) {
      if (permission.role === 'reader') {
        return {
          status: inherited ? 'inherited' : 'compliant',
          desiredAction: null,
          targetRole: null,
          reason: '在「仅限查看」白名单内（当前只读）'
        };
      }
      return {
        status: inherited ? 'inherited' : 'violation_downgrade',
        inheritedViolation: inherited ? 'violation_downgrade' : null,
        desiredAction: inherited ? null : 'downgrade',
        targetRole: 'reader',
        reason: inherited
          ? `继承越权：在「仅限查看」名单内，但继承了${roleLabel(permission.role)}权限`
          : `越权：在「仅限查看」名单内，当前为${roleLabel(permission.role)}（应降为只读）`
      };
    }

    return {
      status: inherited ? 'inherited' : 'violation_remove',
      inheritedViolation: inherited ? 'violation_remove' : null,
      desiredAction: inherited ? null : 'remove',
      targetRole: null,
      reason: inherited ? '继承的非白名单人员（需在上级文件夹移除）' : '违规：不在白名单内'
    };
  }

  return { status: 'compliant', desiredAction: null, targetRole: null, reason: '' };
}

function evaluateFile(file, policy, ownerEmail = '') {
  const perms = file.permissions || [];
  let hasNonOwner = false;
  let hasPublic = false;
  let removeCount = 0;
  let downgradeCount = 0;
  let inheritedIssueCount = 0;

  for (const p of perms) {
    const evalResult = evaluatePermission(p, policy, ownerEmail);
    if (evalResult.status !== 'owner') {
      hasNonOwner = true;
    }
    if (p.type === 'anyone' || p.type === 'domain') {
      hasPublic = true;
    }
    if (evalResult.status === 'violation_remove') {
      removeCount++;
    } else if (evalResult.status === 'violation_downgrade') {
      downgradeCount++;
    } else if (evalResult.inheritedViolation) {
      inheritedIssueCount++;
    }
  }

  return {
    hasNonOwner,
    hasPublic,
    removeCount,
    downgradeCount,
    inheritedIssueCount,
    hasActionableViolation: removeCount > 0 || downgradeCount > 0
  };
}

function computeSummary(files = [], policy = DEFAULT_POLICY, ownerEmail = '', newFileIdSet = new Set()) {
  let total = files.length;
  let shared = 0;
  let newFiles = 0;
  let unauthorizedFiles = 0;
  let overprivilegedFiles = 0;
  let publicFiles = 0;
  let actionablePermissions = 0;

  for (const file of files) {
    if (file.isNew || newFileIdSet.has(file.id)) {
      newFiles++;
    }
    const stat = evaluateFile(file, policy, ownerEmail);
    if (stat.hasNonOwner) shared++;
    if (stat.hasPublic) publicFiles++;
    if (stat.removeCount > 0) unauthorizedFiles++;
    if (stat.downgradeCount > 0) overprivilegedFiles++;
    actionablePermissions += stat.removeCount + stat.downgradeCount;
  }

  return {
    total,
    shared,
    newFiles,
    unauthorizedFiles,
    overprivilegedFiles,
    anomalousFiles: files.filter(f => evaluateFile(f, policy, ownerEmail).hasActionableViolation).length,
    publicFiles,
    actionablePermissions
  };
}

async function updateExtensionBadge(files, policy, ownerEmail) {
  try {
    const summary = computeSummary(files, policy, ownerEmail);
    const count = summary.anomalousFiles;
    if (count > 0) {
      await chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
      await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    // 忽略 badge 设置异常
  }
}

async function deletePermission(token, fileId, permissionId) {
  return driveApi(
    token,
    `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
    { method: 'DELETE' }
  );
}

async function updatePermissionRole(token, fileId, permissionId, role) {
  return driveApi(
    token,
    `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      body: JSON.stringify({ role })
    }
  );
}

async function createPermission(token, fileId, { type = 'user', role = 'reader', emailAddress, domain }) {
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  if (type === 'user' || type === 'group') {
    params.set('sendNotificationEmail', 'false');
  }
  const body = { type, role };
  if (emailAddress) body.emailAddress = emailAddress;
  if (domain) body.domain = domain;
  return driveApi(
    token,
    `/files/${encodeURIComponent(fileId)}/permissions?${params}`,
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  );
}

/**
 * 对指定文件列表按当前白名单与公开策略执行修正（移除非白名单 + 越权降为只读）
 */
async function enforceFilesByPolicy(token, files, policy, ownerEmail, source = 'manual', onProgress = null) {
  const queue = [];
  for (const file of files) {
    for (const permission of file.permissions || []) {
      const evalResult = evaluatePermission(permission, policy, ownerEmail);
      if (evalResult.desiredAction === 'remove' || evalResult.desiredAction === 'downgrade') {
        queue.push({
          file,
          permission,
          action: evalResult.desiredAction,
          targetRole: evalResult.targetRole || 'reader',
          reason: evalResult.reason
        });
      }
    }
  }

  let removed = 0;
  let downgraded = 0;
  let failed = 0;
  const logs = [];
  let cursor = 0;

  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const { file, permission, action, targetRole, reason } = item;
      const targetLabel = permissionLabel(permission);
      try {
        if (action === 'remove') {
          await deletePermission(token, file.id, permission.id);
          file.permissions = (file.permissions || []).filter(p => p.id !== permission.id);
          removed++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source,
            actionType: 'revoke',
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: permission.id,
            targetType: permission.type,
            targetEmail: permission.emailAddress || '',
            domain: permission.domain || '',
            targetLabel,
            previousRole: permission.role || '',
            newRole: '',
            restored: false,
            message: `${reason} → 已移除权限（原角色：${roleLabel(permission.role)}）`
          });
        } else if (action === 'downgrade') {
          const prevRole = permission.role;
          await updatePermissionRole(token, file.id, permission.id, targetRole);
          permission.role = targetRole;
          downgraded++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source,
            actionType: 'downgrade',
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: permission.id,
            targetType: permission.type,
            targetEmail: permission.emailAddress || '',
            domain: permission.domain || '',
            targetLabel,
            previousRole: prevRole,
            newRole: targetRole,
            restored: false,
            message: `${reason} → 已降级为${roleLabel(targetRole)}（原角色：${roleLabel(prevRole)}）`
          });
        }
      } catch (error) {
        failed++;
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source,
          actionType: 'error',
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          permissionId: permission.id,
          targetType: permission.type,
          targetEmail: permission.emailAddress || '',
          targetLabel,
          previousRole: permission.role || '',
          newRole: '',
          restored: false,
          message: `处理失败 (${targetLabel})：${error.message}`
        });
      }

      if (onProgress) {
        onProgress({
          done: removed + downgraded + failed,
          total: queue.length,
          removed,
          downgraded,
          failed
        });
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) {
    await appendAuditLogs(logs);
  }

  return { removed, downgraded, failed, total: queue.length, logs };
}

/**
 * 执行完整扫描（支持前台交互调用与后台定时任务调用）
 */
async function runFullScan({ interactive = false, source = 'manual', onProgress = null } = {}) {
  const token = await getAuthToken(interactive);
  const about = await fetchAboutUser(token);
  const policy = await getPolicy();
  const prevSnapshot = await getSnapshot();

  const knownSet = new Set(prevSnapshot.knownFileIds || []);
  const prevNewSet = new Set(prevSnapshot.newFileIds || []);
  const isFirstScan = knownSet.size === 0;

  let files = [];
  let pageToken = '';

  if (onProgress) onProgress({ phase: 'files', count: 0, message: '正在拉取文件清单…' });

  do {
    const params = new URLSearchParams({
      q: "'me' in owners and trashed = false",
      corpora: 'user',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,ownedByMe,owners(emailAddress),parents)'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await driveApi(token, `/files?${params}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
    if (onProgress) {
      onProgress({ phase: 'files', count: files.length, message: `已找到 ${files.length} 个文件…` });
    }
  } while (pageToken);

  files = files.filter(file => file.ownedByMe !== false);

  const newlyDiscoveredIds = [];
  for (const file of files) {
    if (!isFirstScan && !knownSet.has(file.id)) {
      file.isNew = true;
      newlyDiscoveredIds.push(file.id);
    } else if (prevNewSet.has(file.id)) {
      file.isNew = true;
    } else {
      file.isNew = false;
    }
  }

  let cursor = 0;
  let finished = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index];
      try {
        let pToken = '';
        const permissions = [];
        do {
          const params = new URLSearchParams({
            supportsAllDrives: 'true',
            pageSize: '100',
            fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited,inheritedFrom,permissionType))'
          });
          if (pToken) params.set('pageToken', pToken);
          const data = await driveApi(token, `/files/${encodeURIComponent(file.id)}/permissions?${params}`);
          permissions.push(...(data.permissions || []));
          pToken = data.nextPageToken || '';
        } while (pToken);
        file.permissions = permissions;
        file.permissionError = '';
      } catch (error) {
        file.permissions = [];
        file.permissionError = error.message;
      }
      finished++;
      if (onProgress && (finished % 15 === 0 || finished === files.length)) {
        onProgress({
          phase: 'permissions',
          finished,
          total: files.length,
          message: `正在读取文件权限 ${finished}/${files.length}…`
        });
      }
    }
  });

  await Promise.all(workers);

  const updatedKnownIds = [...new Set([...knownSet, ...files.map(f => f.id)])];
  const updatedNewIds = [...new Set([...prevNewSet, ...newlyDiscoveredIds])];

  let autoEnforceResult = null;
  if (source === 'schedule' && policy.autoEnforce) {
    autoEnforceResult = await enforceFilesByPolicy(token, files, policy, about.email, 'auto');
  }

  const snapshot = {
    lastScanAt: new Date().toISOString(),
    lastScanSource: source,
    accountEmail: about.email,
    files,
    knownFileIds: updatedKnownIds,
    newFileIds: updatedNewIds
  };

  await saveSnapshot(snapshot);
  await updateExtensionBadge(files, policy, about.email);

  const summary = computeSummary(files, policy, about.email, new Set(updatedNewIds));

  if (source === 'schedule') {
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: snapshot.lastScanAt,
      source: 'scan',
      actionType: 'scan_summary',
      fileId: '',
      fileName: '全盘定时巡检',
      webViewLink: '',
      permissionId: '',
      targetType: '',
      targetEmail: '',
      targetLabel: `共 ${summary.total} 个文件（新增 ${newlyDiscoveredIds.length} 个）`,
      previousRole: '',
      newRole: '',
      restored: false,
      message: autoEnforceResult
        ? `定时巡检完成：自动移除 ${autoEnforceResult.removed} 项违规权限，自动降级 ${autoEnforceResult.downgraded} 项越权编辑。`
        : `定时巡检完成：发现 ${summary.anomalousFiles} 个异常文件（${summary.actionablePermissions} 项待处理权限）。`
    });
  }

  return {
    token,
    about,
    policy,
    snapshot,
    summary,
    newlyDiscoveredCount: newlyDiscoveredIds.length,
    autoEnforceResult
  };
}
