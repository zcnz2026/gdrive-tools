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

const DEFAULT_DIRECTORY = {
  groups: [
    { name: '1组', defaultRole: 'writer', policyTier: 'writer' },
    { name: '2组', defaultRole: 'reader', policyTier: 'reader' }
  ],
  contacts: [] // { email, name, groups: ['1组'] }
};

function normalizeEntry(value = '') {
  return String(value).trim().toLowerCase();
}

function normalizeEmailList(list = []) {
  return [...new Set(list.map(normalizeEntry).filter(Boolean))];
}

/* ==================== 通讯录与邮箱分组（A列名称 / B列邮箱 / 分组） ==================== */

async function getDirectory() {
  const data = await chrome.storage.local.get('directory');
  const saved = data.directory;
  if (!saved || typeof saved !== 'object') {
    return JSON.parse(JSON.stringify(DEFAULT_DIRECTORY));
  }
  const groups = Array.isArray(saved.groups) ? saved.groups : DEFAULT_DIRECTORY.groups;
  const contacts = Array.isArray(saved.contacts) ? saved.contacts : [];
  return { groups, contacts };
}

async function saveDirectory(directory) {
  const cleanGroups = [];
  const seenGroup = new Set();
  for (const g of directory.groups || []) {
    const name = String(g.name || '').trim();
    if (!name || seenGroup.has(name)) continue;
    seenGroup.add(name);
    cleanGroups.push({
      name,
      defaultRole: g.defaultRole === 'writer' ? 'writer' : 'reader',
      policyTier: ['writer', 'reader', 'none'].includes(g.policyTier) ? g.policyTier : 'writer'
    });
  }

  const contactMap = new Map();
  for (const c of directory.contacts || []) {
    const email = normalizeEntry(c.email);
    if (!email || !email.includes('@')) continue;
    const prev = contactMap.get(email);
    const mergedGroups = [...new Set([...(prev?.groups || []), ...(c.groups || [])].map(x => String(x).trim()).filter(Boolean))];
    contactMap.set(email, {
      email,
      name: String(c.name || prev?.name || '').trim(),
      groups: mergedGroups
    });
    for (const gName of mergedGroups) {
      if (!seenGroup.has(gName)) {
        seenGroup.add(gName);
        cleanGroups.push({ name: gName, defaultRole: 'reader', policyTier: 'reader' });
      }
    }
  }

  const nextDir = {
    groups: cleanGroups,
    contacts: [...contactMap.values()]
  };
  await chrome.storage.local.set({ directory: nextDir });
  await syncDirectoryToPolicy(nextDir);
  return nextDir;
}

/**
 * 将分组中设置了白名单策略（policyTier: writer / reader）的成员同步到白名单
 */
async function syncDirectoryToPolicy(directory) {
  const currentPolicy = await getPolicy();
  const writerGroupNames = new Set(
    (directory.groups || []).filter(g => g.policyTier === 'writer').map(g => g.name)
  );
  const readerGroupNames = new Set(
    (directory.groups || []).filter(g => g.policyTier === 'reader').map(g => g.name)
  );

  const writers = new Set(currentPolicy.writers || []);
  const readers = new Set(currentPolicy.readers || []);

  for (const c of directory.contacts || []) {
    const inW = (c.groups || []).some(g => writerGroupNames.has(g));
    const inR = (c.groups || []).some(g => readerGroupNames.has(g));
    if (inW) {
      writers.add(c.email);
      readers.delete(c.email);
    } else if (inR && !writers.has(c.email)) {
      readers.add(c.email);
    }
  }

  const nextPolicy = {
    ...currentPolicy,
    writers: [...writers],
    readers: [...readers]
  };
  await chrome.storage.local.set({ policy: nextPolicy });
  return nextPolicy;
}

/**
 * 解析从表格复制粘贴或 CSV 导入的文本
 * 默认支持：A列 = 名称，B列 = 邮箱，可选 C列 = 分组名
 * 同时智能识别如果某列含 @ 则自动作为邮箱列
 */
function parseTabularContactsText(rawText = '', fallbackGroup = '') {
  const lines = String(rawText)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const results = [];
  for (const line of lines) {
    // 支持制表符(Excel/Sheets复制)、逗号、分号分隔
    const cells = line.includes('\t')
      ? line.split('\t').map(s => s.trim().replace(/^"|"$/g, ''))
      : line.split(/[,;，；]/).map(s => s.trim().replace(/^"|"$/g, ''));

    if (!cells.length) continue;

    // 寻找包含 @ 的单元格作为邮箱
    const emailIdx = cells.findIndex(c => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c));
    if (emailIdx === -1) {
      // 可能是表头行（如：名称, 邮箱, 分组），自动跳过
      continue;
    }

    const email = normalizeEntry(cells[emailIdx]);
    let name = '';
    let group = fallbackGroup ? String(fallbackGroup).trim() : '';

    if (emailIdx === 1) {
      // 标准情况：A列是名称 (index 0)，B列是邮箱 (index 1)，C列可选是分组 (index 2)
      name = cells[0] || '';
      if (cells[2]) group = cells[2];
    } else if (emailIdx === 0) {
      // A列直接是邮箱，B列可能是名称或分组
      name = cells[1] || '';
      if (cells[2]) group = cells[2];
    } else {
      name = cells[0] || '';
      if (cells[emailIdx + 1]) group = cells[emailIdx + 1];
    }

    results.push({
      name: name.trim(),
      email,
      group: group.trim()
    });
  }
  return results;
}

function extractDriveFileId(input = '') {
  const str = String(input).trim();
  const match = str.match(/\/d\/([a-zA-Z0-9_-]{15,})/);
  if (match) return match[1];
  const idParam = str.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (idParam) return idParam[1];
  return str;
}

async function fetchContactsFromGoogleSheet(token, sheetIdOrUrl, fallbackGroup = '') {
  const fileId = extractDriveFileId(sheetIdOrUrl);
  if (!fileId) throw new Error('请输入有效的 Google 表格链接或文件 ID');
  const response = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `读取 Google 表格失败 (${response.status})`);
  }
  const csvText = await response.text();
  return parseTabularContactsText(csvText, fallbackGroup);
}

function buildContactLookup(directory) {
  const byEmail = new Map();
  for (const c of directory?.contacts || []) {
    byEmail.set(normalizeEntry(c.email), c);
  }
  return byEmail;
}

function formatCollaboratorDisplay(email, displayName, contactLookup) {
  const norm = normalizeEntry(email);
  const contact = contactLookup ? contactLookup.get(norm) : null;
  if (contact) {
    const groupPrefix = contact.groups?.length ? `[${contact.groups.join('/')}] ` : '';
    const namePart = contact.name ? `${contact.name} (${norm})` : norm;
    return `${groupPrefix}${namePart}`;
  }
  if (displayName && normalizeEntry(displayName) !== norm) {
    return `${displayName} (${norm})`;
  }
  return norm;
}

/**
 * 计算某个文件上各个邮箱分组的授权覆盖情况
 * 返回数组: [{ groupName, grantedCount, totalCount, roles: Set, status: 'full' | 'partial' }]
 */
function getFileGroupCoverage(file, directory) {
  if (!directory?.groups?.length || !directory?.contacts?.length) return [];
  const fileUserRoles = new Map();
  for (const p of file.permissions || []) {
    if (p.type === 'user' || p.type === 'group') {
      const em = normalizeEntry(p.emailAddress || '');
      if (em) fileUserRoles.set(em, p.role);
    }
  }

  const ownerNorm = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
  const result = [];

  for (const grp of directory.groups) {
    const members = directory.contacts.filter(c => (c.groups || []).includes(grp.name));
    if (!members.length) continue;

    let grantedCount = 0;
    const roles = new Set();
    for (const m of members) {
      const em = normalizeEntry(m.email);
      if (em === ownerNorm) {
        grantedCount++;
        roles.add('owner');
      } else if (fileUserRoles.has(em)) {
        grantedCount++;
        roles.add(fileUserRoles.get(em));
      }
    }

    if (grantedCount > 0) {
      result.push({
        groupName: grp.name,
        grantedCount,
        totalCount: members.length,
        roles: [...roles],
        status: grantedCount === members.length ? 'full' : 'partial'
      });
    }
  }
  return result;
}

/* ==================== 高级文件名搜索、不规范名称归并 & 类型过滤 ==================== */

function fileDetailedCategory(mimeType = '', fileName = '') {
  const m = String(mimeType).toLowerCase();
  const n = String(fileName).toLowerCase();

  if (m === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  if (
    m.includes('spreadsheet') ||
    m.includes('excel') ||
    m === 'text/csv' ||
    /\.(xlsx|xls|csv|tsv|ods)$/.test(n)
  ) {
    return 'excel';
  }
  if (m === 'application/vnd.google-apps.folder') return 'folder';
  if (m === 'application/vnd.google-apps.document') return 'doc';
  if (
    m.includes('word') ||
    m === 'application/pdf' ||
    m === 'text/plain' ||
    /\.(docx|doc|pdf|txt|md|rtf)$/.test(n)
  ) {
    return 'word_pdf';
  }
  if (m.includes('presentation') || m.includes('powerpoint') || /\.(pptx|ppt|key)$/.test(n)) {
    return 'slide';
  }
  if (m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/')) {
    return 'media';
  }
  return 'other';
}

function fileCategory(mimeType = '', fileName = '') {
  const det = fileDetailedCategory(mimeType, fileName);
  if (det === 'excel') return 'sheet';
  if (det === 'word_pdf') return 'doc';
  return det;
}

function fileCategoryLabel(mimeType = '', fileName = '') {
  const det = fileDetailedCategory(mimeType, fileName);
  const labels = {
    sheet: '📊 Google 表格',
    excel: '📗 Excel/CSV',
    folder: '📁 文件夹',
    doc: '📝 Google 文档',
    word_pdf: '📕 Word/PDF',
    slide: '📽️ 幻灯片',
    media: '🖼️ 媒体/图片',
    other: '📦 其他文件'
  };
  return labels[det] || '📄 文件';
}

/**
 * 提取不规范文件名的「核心词根」（剥离日期、版本号、副本、(1)、扩展名和标点）
 * 用于将相似/同系列的表聚合在一起
 */
function extractCoreFileName(rawName = '') {
  let s = String(rawName).trim().toLowerCase();
  // 去掉常见扩展名
  s = s.replace(/\.(xlsx|xls|csv|tsv|docx|doc|pdf|pptx|ppt|txt|zip|rar|7z|png|jpg|jpeg|mp4)$/i, '');
  // 去掉 Copy of / 的副本 / 副本 / 备份 / 模板 / 测试 / 旧版
  s = s.replace(/^(copy of\s+|副本\s*[-_]?)/i, '');
  s = s.replace(/([-_\s]*(的副本|副本|备份|backup|bak|copy|最终版|定稿|修改版|旧版|测试|test))+\d*$/gi, '');
  // 去掉括号编号如 (1), （2）, [1]
  s = s.replace(/[\(（\[]\s*\d+\s*[\)）\]]/g, '');
  // 去掉版本号如 v1, v2.1
  s = s.replace(/\bv\d+(\.\d+)?\b/gi, '');
  // 去掉常见日期如 2026-10-20, 20261020, 10月20日
  s = s.replace(/\b20\d{2}[-_./年]?\d{1,2}([-_./月]?\d{1,2}日?)?\b/g, '');
  s = s.replace(/\b\d{1,2}月(\d{1,2}日)?\b/g, '');
  // 去掉标点与多余空白
  s = s.replace(/[-_—·\s()（）【】\[\]《》<>.,，。、/\\]+/g, '');
  return s || String(rawName).trim().toLowerCase();
}

/**
 * 检测文件名是否不规范（包含重复词段，或者带有 副本/(1)/Copy 等冗余后缀）
 */
function analyzeMessyFileName(rawName = '') {
  const name = String(rawName).trim();
  const hasCopySuffix = /(的副本|副本|copy of|\(\d+\)|（\d+）|备份|bak)/i.test(name);

  // 按标点或空白切分词段，看是否有重复出现的词段（如 "财务报表-财务报表"）
  const tokens = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .split(/[-_—·\s()（）【】\[\].,，。/\\]+/)
    .filter(t => t.length >= 2);
  const seen = new Set();
  let hasRepeatedToken = false;
  for (const t of tokens) {
    if (seen.has(t)) {
      hasRepeatedToken = true;
      break;
    }
    seen.add(t);
  }

  // 检测连续重复子串（如 "日报表日报表"）
  if (!hasRepeatedToken && /(.{2,})\1/.test(name.replace(/\s+/g, ''))) {
    hasRepeatedToken = true;
  }

  return {
    hasCopySuffix,
    hasRepeatedToken,
    isMessy: hasCopySuffix || hasRepeatedToken
  };
}

/**
 * 模糊规范化字符串（忽略标点、空格、大小写）
 */
function normalizeForFuzzy(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[-_—·\s()（）【】\[\]《》<>.,，。、/\\'":;：；!！?？]+/g, '');
}

function fuzzyMatchTerm(targetText = '', term = '') {
  const normTarget = normalizeForFuzzy(targetText);
  const normTerm = normalizeForFuzzy(term);
  if (!normTerm) return true;
  if (normTarget.includes(normTerm)) return true;

  // 子序列模糊匹配（例如搜 "财务月报" 可匹配 "财务2026年10月报表"）
  let tIdx = 0;
  for (let i = 0; i < normTarget.length && tIdx < normTerm.length; i++) {
    if (normTarget[i] === normTerm[tIdx]) tIdx++;
  }
  return tIdx === normTerm.length;
}

async function getFilterPresets() {
  const data = await chrome.storage.local.get('filterPresets');
  return Array.isArray(data.filterPresets) ? data.filterPresets : [];
}

async function saveFilterPresets(presets) {
  await chrome.storage.local.set({ filterPresets: presets });
  return presets;
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
      const reauthed = await authorizeWithOAuthClient(
        {
          client_id: target.clientId,
          client_secret: target.clientSecret,
          token_uri: target.tokenUri,
          redirect_uri: target.redirectUri || 'http://localhost'
        },
        target.email
      );
      return reauthed.accessToken;
    }
    if (target.accessToken) return target.accessToken;
  }

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

function permissionLabel(permission, contactLookup = null) {
  if (!permission) return '';
  if (permission.type === 'anyone') return '公开链接 (任何人)';
  if (permission.type === 'domain') return `域内共享 (${permission.domain || '未知域'})`;
  const email = permission.emailAddress || '';
  if (email && contactLookup) {
    return formatCollaboratorDisplay(email, permission.displayName, contactLookup);
  }
  return email || permission.displayName || permission.type;
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
 * 按选定的「邮箱分组」对多个文件批量执行授权 / 对齐 / 撤权
 * mode:
 * - 'grant': 给所选组全体成员开通指定角色（若写成 'group_default' 则按各组默认角色）
 * - 'keep_only_groups': 仅保留所选组成员权限（同时为组内未授权成员补齐权限），移除组外其他直接协作者
 * - 'revoke_groups': 从所选文件中移除所选组全部成员的直接权限
 */
async function executeGroupBatchOnFiles({
  files,
  groupNames,
  mode = 'grant',
  roleOption = 'group_default',
  directory,
  onProgress = null
}) {
  const groupSet = new Set(groupNames);
  const groupRoleMap = new Map();
  for (const g of directory.groups || []) {
    groupRoleMap.set(g.name, g.defaultRole || 'reader');
  }

  // 计算目标成员及其目标角色（若一人在多个选中组，writer 优先于 reader）
  const targetMemberRole = new Map();
  const targetMemberName = new Map();
  for (const c of directory.contacts || []) {
    const matchedGroups = (c.groups || []).filter(g => groupSet.has(g));
    if (!matchedGroups.length) continue;
    const email = normalizeEntry(c.email);
    targetMemberName.set(email, c.name || email);

    let desiredRole = 'reader';
    if (roleOption === 'writer' || roleOption === 'reader') {
      desiredRole = roleOption;
    } else {
      // 按组默认角色，只要有一个组是 writer 即给 writer
      if (matchedGroups.some(g => groupRoleMap.get(g) === 'writer')) {
        desiredRole = 'writer';
      }
    }
    if (targetMemberRole.get(email) === 'writer') {
      desiredRole = 'writer';
    }
    targetMemberRole.set(email, desiredRole);
  }

  const operations = [];
  for (const file of files) {
    const fileOwner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    const perms = file.permissions || [];
    const existingByEmail = new Map();
    for (const p of perms) {
      if (p.type === 'user' || p.type === 'group') {
        const em = normalizeEntry(p.emailAddress || '');
        if (em) existingByEmail.set(em, p);
      }
    }

    if (mode === 'grant' || mode === 'keep_only_groups') {
      for (const [email, desiredRole] of targetMemberRole.entries()) {
        if (email === fileOwner) continue;
        const existing = existingByEmail.get(email);
        if (!existing) {
          operations.push({
            type: 'create',
            file,
            fileOwner,
            email,
            name: targetMemberName.get(email),
            role: desiredRole
          });
        } else if (!permIsInherited(existing) && existing.role !== 'owner' && existing.role !== desiredRole) {
          operations.push({
            type: 'update',
            file,
            fileOwner,
            permission: existing,
            email,
            name: targetMemberName.get(email),
            role: desiredRole
          });
        }
      }
    }

    if (mode === 'keep_only_groups') {
      for (const p of perms) {
        if (p.role === 'owner' || permIsInherited(p)) continue;
        const em = normalizeEntry(p.emailAddress || '');
        if (em && em === fileOwner) continue;
        if (!em || !targetMemberRole.has(em)) {
          operations.push({
            type: 'delete',
            file,
            fileOwner,
            permission: p,
            email: em,
            name: permissionLabel(p)
          });
        }
      }
    } else if (mode === 'revoke_groups') {
      for (const p of perms) {
        if (p.role === 'owner' || permIsInherited(p)) continue;
        const em = normalizeEntry(p.emailAddress || '');
        if (em && targetMemberRole.has(em)) {
          operations.push({
            type: 'delete',
            file,
            fileOwner,
            permission: p,
            email: em,
            name: targetMemberName.get(em) || em
          });
        }
      }
    }
  }

  let createdCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  let failedCount = 0;
  const logs = [];
  let cursor = 0;

  const tokenCache = new Map();
  async function getToken(owner) {
    if (tokenCache.has(owner)) return tokenCache.get(owner);
    const t = await getValidTokenForAccount(owner, true);
    tokenCache.set(owner, t);
    return t;
  }

  const groupTitle = groupNames.join('、');

  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < operations.length) {
      const op = operations[cursor++];
      const { file, fileOwner } = op;
      try {
        const token = await getToken(fileOwner);
        if (op.type === 'create') {
          const created = await createPermission(token, file.id, {
            type: 'user',
            role: op.role,
            emailAddress: op.email
          });
          file.permissions = file.permissions || [];
          file.permissions.push({
            id: created?.id || `grp-${Date.now()}-${Math.random()}`,
            type: 'user',
            role: op.role,
            emailAddress: op.email,
            displayName: op.name
          });
          createdCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: created?.id || '',
            targetType: 'user',
            targetEmail: op.email,
            targetLabel: `[${groupTitle}] ${op.name} (${op.email})`,
            previousRole: '',
            newRole: op.role,
            restored: false,
            message: `按组【${groupTitle}】批量授予「${roleLabel(op.role)}」权限`
          });
        } else if (op.type === 'update') {
          const prevRole = op.permission.role;
          await updatePermissionRole(token, file.id, op.permission.id, op.role);
          op.permission.role = op.role;
          updatedCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'downgrade',
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: op.permission.id,
            targetType: op.permission.type,
            targetEmail: op.email,
            targetLabel: `[${groupTitle}] ${op.name} (${op.email})`,
            previousRole: prevRole,
            newRole: op.role,
            restored: false,
            message: `按组【${groupTitle}】调整角色：${roleLabel(prevRole)} → ${roleLabel(op.role)}`
          });
        } else if (op.type === 'delete') {
          await deletePermission(token, file.id, op.permission.id);
          file.permissions = (file.permissions || []).filter(x => x.id !== op.permission.id);
          removedCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: op.permission.id,
            targetType: op.permission.type,
            targetEmail: op.email,
            domain: op.permission.domain || '',
            targetLabel: op.name,
            previousRole: op.permission.role,
            newRole: '',
            restored: false,
            message: `按组【${groupTitle}】操作移除权限（原角色：${roleLabel(op.permission.role)}）`
          });
        }
      } catch (error) {
        failedCount++;
      }

      if (onProgress) {
        onProgress({
          done: createdCount + updatedCount + removedCount + failedCount,
          total: operations.length,
          createdCount,
          updatedCount,
          removedCount,
          failedCount
        });
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) await appendAuditLogs(logs);
  return { createdCount, updatedCount, removedCount, failedCount, total: operations.length };
}

/**
 * 对指定文件列表按当前白名单与公开策略执行修正
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
 * 执行完整扫描
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
