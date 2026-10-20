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

/* ==================== OAuth 桌面 JSON 凭证与多账号存储 ==================== */

function pickRedirectUri(uris = []) {
  if (Array.isArray(uris)) {
    const local = uris.find(u => /^http:\/\/(localhost|127\.0\.0\.1)/i.test(u));
    if (local) return local;
  }
  return 'http://localhost';
}

function extractOAuthClientsFromJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const clients = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const raw = item.installed || item.web || (item.client_id && item.client_secret ? item : null);
    if (raw && raw.client_id && raw.client_secret) {
      clients.push({
        client_id: String(raw.client_id).trim(),
        client_secret: String(raw.client_secret).trim(),
        project_id: String(raw.project_id || '').trim(),
        auth_uri: raw.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: raw.token_uri || 'https://oauth2.googleapis.com/token',
        redirect_uri: pickRedirectUri(raw.redirect_uris),
        client_type: item.installed ? 'installed' : item.web ? 'web' : 'custom',
        importedAt: new Date().toISOString()
      });
    }
  }
  return clients;
}

async function getOAuthClients() {
  const data = await chrome.storage.local.get('oauthClients');
  return Array.isArray(data.oauthClients) ? data.oauthClients : [];
}

async function saveOAuthClients(newClients) {
  const list = Array.isArray(newClients) ? newClients : [newClients];
  const current = await getOAuthClients();
  const map = new Map();
  for (const c of current) map.set(c.client_id, c);
  for (const c of list) {
    if (c && c.client_id) map.set(c.client_id, c);
  }
  const merged = [...map.values()];
  await chrome.storage.local.set({ oauthClients: merged });
  return merged;
}

async function getAuthorizedAccounts() {
  const data = await chrome.storage.local.get('authorizedAccounts');
  return Array.isArray(data.authorizedAccounts) ? data.authorizedAccounts : [];
}

async function saveAuthorizedAccount(account) {
  const current = await getAuthorizedAccounts();
  const normEmail = normalizeEntry(account.email);
  const existing = current.find(a => normalizeEntry(a.email) === normEmail);
  const mergedAccount = {
    ...existing,
    ...account,
    email: normEmail,
    refreshToken: account.refreshToken || existing?.refreshToken || ''
  };
  const next = [mergedAccount, ...current.filter(a => normalizeEntry(a.email) !== normEmail)];
  await chrome.storage.local.set({ authorizedAccounts: next });
  return mergedAccount;
}

async function removeAuthorizedAccount(email) {
  const normEmail = normalizeEntry(email);
  const current = await getAuthorizedAccounts();
  const next = current.filter(a => normalizeEntry(a.email) !== normEmail);
  await chrome.storage.local.set({ authorizedAccounts: next });
  return next;
}

async function refreshAccountAccessToken(account) {
  if (!account.refreshToken || !account.clientId || !account.clientSecret) {
    throw new Error(`账号 ${account.email} 授权已过期，请重新点击授权`);
  }
  const tokenUri = account.tokenUri || 'https://oauth2.googleapis.com/token';
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `刷新令牌失败 (${response.status})`);
  }
  const updated = await saveAuthorizedAccount({
    ...account,
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000
  });
  return updated.accessToken;
}

async function getValidTokenForAccount(email, interactive = false) {
  const accounts = await getAuthorizedAccounts();
  const normEmail = normalizeEntry(email);
  const target = normEmail
    ? accounts.find(a => normalizeEntry(a.email) === normEmail)
    : accounts[0];

  if (target) {
    if (target.accessToken && Date.now() < (target.expiresAt || 0) - 60000) {
      return target.accessToken;
    }
    if (target.refreshToken && target.clientId && target.clientSecret) {
      return refreshAccountAccessToken(target);
    }
    if (interactive && target.clientId && target.clientSecret) {
      const reauthed = await authorizeWithOAuthClient({
        client_id: target.clientId,
        client_secret: target.clientSecret,
        token_uri: target.tokenUri,
        redirect_uri: target.redirectUri || 'http://localhost'
      }, target.email);
      return reauthed.accessToken;
    }
    if (target.accessToken) return target.accessToken;
  }

  // 兼容：若用户在 manifest.json 配置了 Chrome 扩展 Client ID，也可回退使用 chrome.identity
  const manifestClientId = chrome.runtime.getManifest().oauth2?.client_id || '';
  if (manifestClientId && !manifestClientId.includes('替换')) {
    return getChromeIdentityToken(interactive);
  }

  throw new Error('尚未授权账号。请先点击「🔑 导入桌面 JSON 授权」导入 Google OAuth JSON 文件完成授权。');
}

function getChromeIdentityToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!result) {
        reject(new Error('未取得 Google 授权令牌'));
      } else {
        resolve(typeof result === 'string' ? result : result.token);
      }
    });
  });
}

/**
 * 使用导入的桌面端/Web 端 OAuth JSON (installed / web) 发起标准 OAuth2 授权并获取 refresh_token
 */
async function authorizeWithOAuthClient(client, loginHint = '') {
  if (!client || !client.client_id || !client.client_secret) {
    throw new Error('无效的 OAuth 客户端配置（缺少 client_id 或 client_secret）');
  }

  const redirectUri = client.redirect_uri || 'http://localhost';
  const oauthState = `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const authEndpoint = client.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth';

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent select_account');
  authUrl.searchParams.set('state', oauthState);
  if (loginHint) {
    authUrl.searchParams.set('login_hint', loginHint);
  }

  const code = await new Promise((resolve, reject) => {
    let authTabId = null;
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
    };

    const tryParseRedirect = urlStr => {
      if (!urlStr || settled) return false;
      if (!urlStr.startsWith(redirectUri) && !/^http:\/\/(localhost|127\.0\.0\.1)(\/|:\d+|\?)/i.test(urlStr)) {
        return false;
      }
      try {
        const parsedUrl = new URL(urlStr);
        const err = parsedUrl.searchParams.get('error');
        const authCode = parsedUrl.searchParams.get('code');
        if (!err && !authCode) return false;

        settled = true;
        cleanup();
        if (authTabId !== null) {
          chrome.tabs.remove(authTabId).catch(() => {});
        }
        if (err) {
          reject(new Error(`Google 授权被拒绝或取消：${err}`));
        } else {
          resolve(authCode);
        }
        return true;
      } catch (_e) {
        return false;
      }
    };

    const onTabUpdated = (tabId, changeInfo, tab) => {
      if (tabId !== authTabId) return;
      const candidate = changeInfo.url || tab?.pendingUrl || tab?.url || '';
      tryParseRedirect(candidate);
    };

    const onTabRemoved = tabId => {
      if (tabId === authTabId && !settled) {
        settled = true;
        cleanup();
        reject(new Error('授权窗口已关闭，未完成授权'));
      }
    };

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);

    chrome.tabs.create({ url: authUrl.toString(), active: true }, tab => {
      if (chrome.runtime.lastError || !tab) {
        settled = true;
        cleanup();
        reject(new Error(chrome.runtime.lastError?.message || '无法打开授权标签页'));
        return;
      }
      authTabId = tab.id;
    });
  });

  // 用授权码换取 access_token 与 refresh_token
  const tokenUri = client.token_uri || 'https://oauth2.googleapis.com/token';
  const tokenRes = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString()
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || `换取令牌失败 (${tokenRes.status})`);
  }

  const about = await fetchAboutUser(tokenData.access_token);
  if (!about.email) {
    throw new Error('未能获取到当前授权账号的邮箱信息');
  }

  const savedAccount = await saveAuthorizedAccount({
    email: about.email,
    displayName: about.displayName || '',
    clientId: client.client_id,
    clientSecret: client.client_secret,
    projectId: client.project_id || '',
    tokenUri,
    redirectUri,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || '',
    expiresAt: Date.now() + (Number(tokenData.expires_in) || 3500) * 1000,
    authorizedAt: new Date().toISOString()
  });

  return savedAccount;
}

/* ==================== 策略、快照与审计日志存储 ==================== */

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
  const updated = current.map(item =>
    item.id === logId ? { ...item, restored: true, restoredAt: new Date().toISOString() } : item
  );
  await chrome.storage.local.set({ auditLogs: updated });
  return updated;
}

async function clearAuditLogs() {
  await chrome.storage.local.set({ auditLogs: [] });
}

/* ==================== Drive API 请求封装 ==================== */

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
    email: normalizeEntry(data.user?.emailAddress || ''),
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
  if (
    mimeType === 'application/vnd.google-apps.spreadsheet' ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel')
  ) {
    return 'sheet';
  }
  if (mimeType === 'application/vnd.google-apps.folder') {
    return 'folder';
  }
  if (
    mimeType === 'application/vnd.google-apps.document' ||
    mimeType.includes('document') ||
    mimeType.includes('word')
  ) {
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
          reason: inherited
            ? '继承的公开可编辑链接（需在上级文件夹降为只读）'
            : '越权：公开/域内链接当前可编辑，策略最高仅允许只读'
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

function evaluateFile(file, policy, fallbackOwnerEmail = '') {
  const ownerEmail = file.ownerAccount || file.owners?.[0]?.emailAddress || fallbackOwnerEmail;
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
  let anomalousFiles = 0;

  for (const file of files) {
    if (file.isNew || newFileIdSet.has(file.id)) {
      newFiles++;
    }
    const stat = evaluateFile(file, policy, ownerEmail);
    if (stat.hasNonOwner) shared++;
    if (stat.hasPublic) publicFiles++;
    if (stat.removeCount > 0) unauthorizedFiles++;
    if (stat.downgradeCount > 0) overprivilegedFiles++;
    if (stat.hasActionableViolation) anomalousFiles++;
    actionablePermissions += stat.removeCount + stat.downgradeCount;
  }

  return {
    total,
    shared,
    newFiles,
    unauthorizedFiles,
    overprivilegedFiles,
    anomalousFiles,
    publicFiles,
    actionablePermissions
  };
}

async function updateExtensionBadge(files, policy, ownerEmail = '') {
  try {
    const summary = computeSummary(files, policy, ownerEmail);
    const count = summary.anomalousFiles;
    if (count > 0) {
      await chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
      await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (_e) {
    // 忽略 badge 异常
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
 * 对指定文件列表按当前白名单与公开策略执行修正（自动匹配每个文件所属授权账号的 Token）
 */
async function enforceFilesByPolicy(fallbackToken, files, policy, fallbackOwnerEmail, source = 'manual', onProgress = null) {
  const queue = [];
  for (const file of files) {
    const fileOwner = file.ownerAccount || file.owners?.[0]?.emailAddress || fallbackOwnerEmail;
    for (const permission of file.permissions || []) {
      const evalResult = evaluatePermission(permission, policy, fileOwner);
      if (evalResult.desiredAction === 'remove' || evalResult.desiredAction === 'downgrade') {
        queue.push({
          file,
          fileOwner,
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

  const tokenCache = new Map();
  async function resolveTokenForOwner(ownerEmail) {
    const key = normalizeEntry(ownerEmail);
    if (tokenCache.has(key)) return tokenCache.get(key);
    try {
      const t = await getValidTokenForAccount(key, false);
      tokenCache.set(key, t);
      return t;
    } catch (_e) {
      if (fallbackToken) return fallbackToken;
      throw _e;
    }
  }

  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const { file, fileOwner, permission, action, targetRole, reason } = item;
      const targetLabel = permissionLabel(permission);
      try {
        const token = await resolveTokenForOwner(fileOwner);
        if (action === 'remove') {
          await deletePermission(token, file.id, permission.id);
          file.permissions = (file.permissions || []).filter(p => p.id !== permission.id);
          removed++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source,
            actionType: 'revoke',
            accountEmail: fileOwner,
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
            accountEmail: fileOwner,
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
          accountEmail: fileOwner,
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
 * 扫描单个账号下的所有文件与权限
 */
async function scanSingleAccount(accountEmail, token, onProgress = null, accountPrefix = '') {
  let files = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      q: "'me' in owners and trashed = false",
      corpora: 'user',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields:
        'nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,ownedByMe,owners(emailAddress),parents)'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await driveApi(token, `/files?${params}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
    if (onProgress) {
      onProgress({
        phase: 'files',
        count: files.length,
        message: `${accountPrefix}已找到 ${files.length} 个文件…`
      });
    }
  } while (pageToken);

  files = files.filter(file => file.ownedByMe !== false);
  for (const file of files) {
    file.ownerAccount = normalizeEntry(accountEmail || file.owners?.[0]?.emailAddress || '');
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
            fields:
              'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited,inheritedFrom,permissionType))'
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
          message: `${accountPrefix}正在读取权限 ${finished}/${files.length}…`
        });
      }
    }
  });

  await Promise.all(workers);
  return files;
}

/**
 * 执行完整扫描（支持多账号并发/顺序扫描、前台交互与后台定时任务调用）
 */
async function runFullScan({ interactive = false, source = 'manual', targetAccount = 'all', onProgress = null } = {}) {
  const policy = await getPolicy();
  const prevSnapshot = await getSnapshot();
  const accounts = await getAuthorizedAccounts();

  const knownSet = new Set(prevSnapshot.knownFileIds || []);
  const prevNewSet = new Set(prevSnapshot.newFileIds || []);
  const isFirstScan = knownSet.size === 0;

  let targetAccounts = [];
  if (accounts.length > 0) {
    if (targetAccount && targetAccount !== 'all') {
      const found = accounts.find(a => normalizeEntry(a.email) === normalizeEntry(targetAccount));
      targetAccounts = found ? [found] : accounts;
    } else {
      targetAccounts = accounts;
    }
  } else {
    // 尝试回退使用已导入的第一个桌面 OAuth 凭证进行交互式授权，或使用 manifest.json
    const oauthClients = await getOAuthClients();
    if (interactive && oauthClients.length > 0) {
      const newAcc = await authorizeWithOAuthClient(oauthClients[0]);
      targetAccounts = [newAcc];
    } else {
      const token = await getValidTokenForAccount('', interactive);
      const about = await fetchAboutUser(token);
      targetAccounts = [{ email: about.email, accessToken: token }];
    }
  }

  let scannedFiles = [];
  for (let i = 0; i < targetAccounts.length; i++) {
    const acc = targetAccounts[i];
    const prefix = targetAccounts.length > 1 ? `[账号 ${i + 1}/${targetAccounts.length}: ${acc.email}] ` : '';
    const token = await getValidTokenForAccount(acc.email, interactive);
    const accFiles = await scanSingleAccount(acc.email, token, onProgress, prefix);
    scannedFiles.push(...accFiles);
  }

  // 如果只扫描了单个账号，保留其它账号已缓存的文件
  let mergedFiles = scannedFiles;
  if (targetAccount !== 'all' && prevSnapshot.files?.length) {
    const scannedAccountSet = new Set(targetAccounts.map(a => normalizeEntry(a.email)));
    const otherAccountFiles = prevSnapshot.files.filter(
      f => f.ownerAccount && !scannedAccountSet.has(normalizeEntry(f.ownerAccount))
    );
    mergedFiles = [...scannedFiles, ...otherAccountFiles];
  }

  const newlyDiscoveredIds = [];
  for (const file of mergedFiles) {
    if (!isFirstScan && !knownSet.has(file.id)) {
      file.isNew = true;
      newlyDiscoveredIds.push(file.id);
    } else if (prevNewSet.has(file.id)) {
      file.isNew = true;
    } else {
      file.isNew = false;
    }
  }

  const updatedKnownIds = [...new Set([...knownSet, ...mergedFiles.map(f => f.id)])];
  const updatedNewIds = [...new Set([...prevNewSet, ...newlyDiscoveredIds])];
  const primaryEmail = targetAccounts[0]?.email || prevSnapshot.accountEmail || '';

  let autoEnforceResult = null;
  if (source === 'schedule' && policy.autoEnforce) {
    autoEnforceResult = await enforceFilesByPolicy(null, mergedFiles, policy, primaryEmail, 'auto');
  }

  const snapshot = {
    lastScanAt: new Date().toISOString(),
    lastScanSource: source,
    accountEmail: primaryEmail,
    files: mergedFiles,
    knownFileIds: updatedKnownIds,
    newFileIds: updatedNewIds
  };

  await saveSnapshot(snapshot);
  await updateExtensionBadge(mergedFiles, policy, primaryEmail);

  const summary = computeSummary(mergedFiles, policy, primaryEmail, new Set(updatedNewIds));

  if (source === 'schedule') {
    await appendAuditLogs({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: snapshot.lastScanAt,
      source: 'scan',
      actionType: 'scan_summary',
      fileId: '',
      fileName: `全盘定时巡检 (${targetAccounts.length} 个账号)`,
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
    accounts: await getAuthorizedAccounts(),
    policy,
    snapshot,
    summary,
    newlyDiscoveredCount: newlyDiscoveredIds.length,
    autoEnforceResult
  };
}
