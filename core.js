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

/**
 * 防配额溢出安全写入封装（自动处理 Resource::kQuotaBytes quota exceeded）
 * 1. manifest.json 已开启 unlimitedStorage 权限（刷新扩展后即可解除 10MB 限制）
 * 2. 若用户尚未刷新扩展或单次写入超大，自动清理历史缓存快照并降级重试，确保账号授权与扫描永不因存储配额报错中断
 */
async function safeStorageSet(payload) {
  try {
    await chrome.storage.local.set(payload);
    return true;
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (/quota|QuotaBytes/i.test(msg)) {
      // 如果当前保存的不是 scanSnapshot（例如保存免登录账号、OAuth凭据、全盘转移进度），先清除占空间最大的 scanSnapshot 缓存再重试
      if (!('scanSnapshot' in payload)) {
        try {
          await chrome.storage.local.remove('scanSnapshot');
          await chrome.storage.local.set(payload);
          return true;
        } catch (_retryErr) {
          // 如果保存的是全盘转移状态且依然超限，自动精简日志与非核心字段后重试
          if (payload.ownershipTransferState) {
            const st = payload.ownershipTransferState;
            const slimState = {
              ...st,
              logs: Array.isArray(st.logs) ? st.logs.slice(-150) : [],
              items: Array.isArray(st.items)
                ? st.items.map(it => ({
                    id: it.id,
                    name: it.name,
                    mimeType: it.mimeType,
                    isFolder: it.isFolder,
                    sourceOwner: it.sourceOwner,
                    targetOwner: it.targetOwner,
                    currentOwner: it.currentOwner,
                    targetPermissionId: it.targetPermissionId || '',
                    stage: it.stage,
                    statusText: it.statusText,
                    error: it.error || ''
                  }))
                : []
            };
            await chrome.storage.local.set({ ownershipTransferState: slimState });
            return true;
          }
        }
      }
    }
    throw err;
  }
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
  await safeStorageSet({ directory: nextDir });
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
  await safeStorageSet({ policy: nextPolicy });
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

function extractOAuthClientsFromJson(parsed, fileName = '') {
  if (!parsed || typeof parsed !== 'object') return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const clients = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;

    // 1. 支持 Google Cloud Service Account 服务账号 JSON (如 sa-140@sa-140.iam.gserviceaccount.com)
    if (item.type === 'service_account' && item.client_email && item.private_key) {
      const clientEmail = normalizeEntry(item.client_email);
      clients.push({
        uid: `sa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}`,
        fileName: fileName || `${clientEmail.split('@')[0]}.json`,
        client_id: String(item.client_id || clientEmail).trim(),
        client_email: clientEmail,
        private_key: String(item.private_key),
        private_key_id: String(item.private_key_id || ''),
        project_id: String(item.project_id || '').trim(),
        token_uri: item.token_uri || 'https://oauth2.googleapis.com/token',
        client_type: 'service_account',
        boundEmail: clientEmail,
        importedAt: new Date().toISOString()
      });
      continue;
    }

    // 2. 支持常规 Google OAuth 桌面/Web 客户端 JSON
    const raw = item.installed || item.web || (item.client_id && item.client_secret ? item : null);
    if (raw && raw.client_id && raw.client_secret) {
      const clientId = String(raw.client_id).trim();
      clients.push({
        uid: `cred_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}`,
        fileName: fileName || `oauth_${i + 1}.json`,
        client_id: clientId,
        client_secret: String(raw.client_secret).trim(),
        project_id: String(raw.project_id || '').trim(),
        auth_uri: raw.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: raw.token_uri || 'https://oauth2.googleapis.com/token',
        redirect_uri: pickRedirectUri(raw.redirect_uris),
        client_type: item.installed ? 'installed' : item.web ? 'web' : 'custom',
        boundEmail: '',
        importedAt: new Date().toISOString()
      });
    }
  }
  return clients;
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeStr(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem = '') {
  const b64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function mintServiceAccountAccessToken({ clientEmail, privateKey, tokenUri }) {
  if (!clientEmail || !privateKey) {
    throw new Error('服务账号配置缺少 client_email 或 private_key');
  }
  const targetUri = tokenUri || 'https://oauth2.googleapis.com/token';
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: targetUri,
    iat: nowSec - 30,
    exp: nowSec + 3500
  };

  const unsignedJwt = `${base64UrlEncodeStr(JSON.stringify(header))}.${base64UrlEncodeStr(JSON.stringify(claimSet))}`;
  const keyBuffer = pemToArrayBuffer(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedJwt)
  );
  const signedJwt = `${unsignedJwt}.${base64UrlEncodeBytes(signature)}`;

  const response = await fetch(targetUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt
    }).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `服务账号签发令牌失败 (${response.status})`);
  }
  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 3500
  };
}

async function getOAuthClients() {
  const data = await chrome.storage.local.get('oauthClients');
  return Array.isArray(data.oauthClients) ? data.oauthClients : [];
}

async function saveOAuthClients(newClients) {
  const list = Array.isArray(newClients) ? newClients : [newClients];
  const current = await getOAuthClients();
  const merged = [...current];

  for (const c of list) {
    if (!c || !c.client_id) continue;
    const uid = c.uid || `cred_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const idx = merged.findIndex(x => (x.uid && x.uid === uid) || (!x.uid && x.client_id === c.client_id && x.fileName === c.fileName));
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...c, uid: merged[idx].uid || uid };
    } else {
      merged.push({ ...c, uid });
    }
  }
  await safeStorageSet({ oauthClients: merged });
  return merged;
}

async function removeOAuthClient(uidOrClientId) {
  const current = await getOAuthClients();
  const next = current.filter(c => (c.uid || c.client_id) !== uidOrClientId);
  await safeStorageSet({ oauthClients: next });
  return next;
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
  await safeStorageSet({ authorizedAccounts: next });
  return mergedAccount;
}

async function removeAuthorizedAccount(email) {
  const normEmail = normalizeEntry(email);
  const current = await getAuthorizedAccounts();
  const next = current.filter(a => normalizeEntry(a.email) !== normEmail);
  await safeStorageSet({ authorizedAccounts: next });
  return next;
}

/**
 * 导出已授权账号通行证 JSON（包含 refreshToken / clientSecret / ServiceAccount 私钥及可选的全盘转移进度），
 * 复制到任意其他电脑导入后，无需在浏览器登录 Google 账号即可直接使用所有权限管理与转移功能。
 */
async function buildAuthorizedPassportBundle({ onlyEmail = '', includeTransferState = true } = {}) {
  const [oauthClients, authorizedAccounts, policy, directory, transferState] = await Promise.all([
    getOAuthClients(),
    getAuthorizedAccounts(),
    getPolicy(),
    getDirectory(),
    getOwnershipTransferState()
  ]);

  const normOnly = normalizeEntry(onlyEmail);
  const filteredAccounts = normOnly
    ? authorizedAccounts.filter(a => normalizeEntry(a.email) === normOnly)
    : authorizedAccounts;

  const filteredClients = normOnly
    ? oauthClients.filter(
        c =>
          c.client_id === filteredAccounts[0]?.clientId ||
          normalizeEntry(c.boundEmail || '') === normOnly ||
          (Array.isArray(c.boundEmails) && c.boundEmails.map(normalizeEntry).includes(normOnly))
      )
    : oauthClients;

  const payload = {
    bundleType: 'google_drive_auth_passport_v1',
    exportedAt: new Date().toISOString(),
    description: 'Google Drive 权限管理插件 - 免浏览器登录已授权通行证（复制到其他电脑导入即可直接使用）',
    oauthClients: filteredClients,
    authorizedAccounts: filteredAccounts
  };

  if (!normOnly) {
    payload.policy = policy;
    payload.directory = directory;
    if (includeTransferState && transferState?.items?.length) {
      payload.ownershipTransferState = transferState;
    }
  }
  return payload;
}

/**
 * 识别并导入「免登录已授权通行证 JSON」或含 refresh_token 的 token.json 文件（无需弹出浏览器登录）
 */
async function importAuthorizedPassportFromObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { imported: false, accountCount: 0, clientCount: 0, restoredTransferCount: 0 };
  }

  let rawClients = [];
  let rawAccounts = [];

  if (parsed.bundleType === 'google_drive_auth_passport_v1' || Array.isArray(parsed.authorizedAccounts)) {
    rawClients = Array.isArray(parsed.oauthClients) ? parsed.oauthClients : [];
    rawAccounts = Array.isArray(parsed.authorizedAccounts) ? parsed.authorizedAccounts : [];
  } else if (
    (parsed.refreshToken && parsed.clientId && parsed.clientSecret) ||
    (parsed.refresh_token && parsed.client_id && parsed.client_secret)
  ) {
    // 兼容单账号导出或标准 Google OAuth token.json (含 refresh_token)
    const cid = String(parsed.clientId || parsed.client_id).trim();
    const csec = String(parsed.clientSecret || parsed.client_secret).trim();
    const rtok = String(parsed.refreshToken || parsed.refresh_token).trim();
    const turi = parsed.tokenUri || parsed.token_uri || 'https://oauth2.googleapis.com/token';
    rawClients.push({
      uid: `cred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fileName: 'imported_token.json',
      client_id: cid,
      client_secret: csec,
      token_uri: turi,
      redirect_uri: 'http://localhost',
      client_type: 'installed',
      boundEmail: normalizeEntry(parsed.email || '')
    });
    rawAccounts.push({
      email: normalizeEntry(parsed.email || ''),
      displayName: parsed.displayName || '',
      clientId: cid,
      clientSecret: csec,
      refreshToken: rtok,
      accessToken: parsed.accessToken || parsed.token || '',
      tokenUri: turi,
      expiresAt: Number(parsed.expiresAt) || 0
    });
  } else {
    return { imported: false, accountCount: 0, clientCount: 0, restoredTransferCount: 0 };
  }

  if (rawClients.length > 0) {
    await saveOAuthClients(rawClients);
  }

  let accountCount = 0;
  for (const acc of rawAccounts) {
    if (!acc || typeof acc !== 'object') continue;
    let email = normalizeEntry(acc.email || '');
    let accessToken = acc.accessToken || '';
    let expiresAt = Number(acc.expiresAt) || 0;

    // 导入免登录通行证时，只要有 refreshToken 就优先静默刷新一次最新 accessToken（若离线暂不可达则将 expiresAt 置 0 以便首次扫描时自动刷新）
    if (acc.refreshToken && acc.clientId && acc.clientSecret) {
      try {
        const tokenUri = acc.tokenUri || 'https://oauth2.googleapis.com/token';
        const resp = await fetch(tokenUri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: acc.clientId,
            client_secret: acc.clientSecret,
            refresh_token: acc.refreshToken,
            grant_type: 'refresh_token'
          }).toString()
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.access_token) {
          accessToken = data.access_token;
          expiresAt = Date.now() + (Number(data.expires_in) || 3500) * 1000;
          if (!email) {
            const about = await fetchAboutUser(accessToken);
            email = normalizeEntry(about.email || '');
          }
        } else {
          expiresAt = 0;
        }
      } catch (_e) {
        expiresAt = 0;
      }
    }

    if (!email) continue;
    await saveAuthorizedAccount({
      ...acc,
      email,
      accessToken,
      expiresAt,
      authorizedAt: acc.authorizedAt || new Date().toISOString()
    });
    accountCount++;
  }

  let restoredTransferCount = 0;
  if (parsed.ownershipTransferState && Array.isArray(parsed.ownershipTransferState.items) && parsed.ownershipTransferState.items.length > 0) {
    const curTf = await getOwnershipTransferState();
    if (!curTf.items || curTf.items.length === 0) {
      await saveOwnershipTransferState(parsed.ownershipTransferState);
      restoredTransferCount = parsed.ownershipTransferState.items.length;
    }
  }

  return {
    imported: rawClients.length > 0 || accountCount > 0,
    accountCount,
    clientCount: rawClients.length,
    restoredTransferCount
  };
}

async function refreshAccountAccessToken(account) {
  if (account.isServiceAccount && account.privateKey) {
    const minted = await mintServiceAccountAccessToken({
      clientEmail: account.email,
      privateKey: account.privateKey,
      tokenUri: account.tokenUri
    });
    const updatedSa = await saveAuthorizedAccount({
      ...account,
      accessToken: minted.accessToken,
      expiresAt: Date.now() + minted.expiresIn * 1000
    });
    return updatedSa.accessToken;
  }

  let clientId = account.clientId || '';
  let clientSecret = account.clientSecret || '';
  let tokenUri = account.tokenUri || 'https://oauth2.googleapis.com/token';

  if ((!clientId || !clientSecret) && account.email) {
    const allClients = await getOAuthClients();
    const normEm = normalizeEntry(account.email);
    const matchedClient =
      allClients.find(c => c.client_id === clientId) ||
      allClients.find(
        c =>
          normalizeEntry(c.boundEmail || '') === normEm ||
          (Array.isArray(c.boundEmails) && c.boundEmails.map(normalizeEntry).includes(normEm))
      ) ||
      allClients.find(c => c.client_type !== 'service_account' && c.client_id && c.client_secret);
    if (matchedClient) {
      clientId = clientId || matchedClient.client_id;
      clientSecret = clientSecret || matchedClient.client_secret;
      tokenUri = account.tokenUri || matchedClient.token_uri || tokenUri;
    }
  }

  if (!account.refreshToken || !clientId || !clientSecret) {
    throw new Error(`账号 ${account.email} 缺少 refreshToken 或客户端密钥，请重新授权或重新导出含完整凭证的免登录通行证 JSON`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let response;
  try {
    response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`刷新账号 ${account.email} 令牌超时（请检查网络是否能连接 oauth2.googleapis.com）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `刷新令牌失败 (${response.status})`);
  }
  const updated = await saveAuthorizedAccount({
    ...account,
    clientId,
    clientSecret,
    tokenUri,
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000
  });
  return updated.accessToken;
}

async function getValidTokenForAccount(email, interactive = false, forceRefresh = false) {
  const accounts = await getAuthorizedAccounts();
  const normEmail = normalizeEntry(email);
  const target = normEmail
    ? accounts.find(a => normalizeEntry(a.email) === normEmail)
    : accounts[0];

  if (target) {
    if (!forceRefresh && target.accessToken && Date.now() < (target.expiresAt || 0) - 60000) {
      return target.accessToken;
    }
    if (target.isServiceAccount && target.privateKey) {
      return refreshAccountAccessToken(target);
    }
    if (target.refreshToken) {
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
    if (!forceRefresh && target.accessToken) return target.accessToken;
  }

  const manifestClientId = chrome.runtime.getManifest().oauth2?.client_id || '';
  if (manifestClientId && !manifestClientId.includes('替换')) {
    return getChromeIdentityToken(interactive);
  }

  throw new Error('尚未找到可用的已授权账号令牌。请先导入免登录通行证 JSON 或点击「🌐 授权新邮箱」完成授权。');
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
  if (client && (client.client_type === 'service_account' || (client.client_email && client.private_key))) {
    const email = normalizeEntry(client.client_email);
    const minted = await mintServiceAccountAccessToken({
      clientEmail: email,
      privateKey: client.private_key,
      tokenUri: client.token_uri
    });
    const savedAccount = await saveAuthorizedAccount({
      email,
      displayName: email.split('@')[0],
      clientId: client.client_id || email,
      isServiceAccount: true,
      privateKey: client.private_key,
      tokenUri: client.token_uri || 'https://oauth2.googleapis.com/token',
      accessToken: minted.accessToken,
      expiresAt: Date.now() + minted.expiresIn * 1000,
      authorizedAt: new Date().toISOString()
    });
    await saveOAuthClients([{ ...client, boundEmail: email }]);
    return savedAccount;
  }

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
          const hint =
            err === 'access_denied'
              ? '（若第二个邮箱提示 403/未完成验证，请在 Google Cloud 控制台 -> OAuth 同意屏幕 -> 将该邮箱加入「测试用户」或点击「发布应用」，或切换使用该邮箱对应的 JSON 凭证）'
              : '';
          reject(new Error(`Google 授权被拒绝或取消：${err}${hint}`));
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
    clientUid: client.uid || '',
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

  if (client.uid) {
    const allClients = await getOAuthClients();
    const targetClient = allClients.find(c => c.uid === client.uid) || allClients.find(c => c.client_id === client.client_id);
    if (targetClient) {
      const prevList = Array.isArray(targetClient.boundEmails)
        ? targetClient.boundEmails
        : targetClient.boundEmail
        ? [targetClient.boundEmail]
        : [];
      targetClient.boundEmails = [...new Set([...prevList, savedAccount.email].filter(Boolean))];
      targetClient.boundEmail = targetClient.boundEmails.join(', ');
      await safeStorageSet({ oauthClients: allClients });
    }
  }

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
  await safeStorageSet({ policy: next });
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

/**
 * 压缩扫描快照后再写入本地缓存，剔除冗余的深层嵌套字段，将体积减小 60%~75%，
 * 同时如果遇到用户尚未刷新插件（10MB 限制仍生效）的极端情况，自动截取缓存项且绝不抛出异常中断扫描。
 */
function compactSnapshotForStorage(snapshot, maxFiles = 0) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const rawFiles = Array.isArray(snapshot.files) ? snapshot.files : [];
  const sliceFiles = maxFiles > 0 && rawFiles.length > maxFiles ? rawFiles.slice(0, maxFiles) : rawFiles;

  const compactFiles = sliceFiles.map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    webViewLink: f.webViewLink || '',
    modifiedTime: f.modifiedTime || '',
    ownedByMe: Boolean(f.ownedByMe),
    shared: Boolean(f.shared),
    ownerAccount: f.ownerAccount || '',
    scannedByAccount: f.scannedByAccount || '',
    isNew: Boolean(f.isNew),
    owners: Array.isArray(f.owners)
      ? f.owners.slice(0, 2).map(o => ({
          emailAddress: o.emailAddress || '',
          displayName: o.displayName || ''
        }))
      : [],
    capabilities: f.capabilities
      ? {
          canEdit: Boolean(f.capabilities.canEdit),
          canComment: Boolean(f.capabilities.canComment),
          canShare: Boolean(f.capabilities.canShare)
        }
      : undefined,
    permissions: Array.isArray(f.permissions)
      ? f.permissions.map(p => {
          const inherited = Boolean(
            p._inherited || (Array.isArray(p.permissionDetails) && p.permissionDetails.some(d => d.inherited))
          );
          const cp = {
            id: p.id,
            type: p.type,
            role: p.role
          };
          if (p.emailAddress) cp.emailAddress = p.emailAddress;
          if (p.domain) cp.domain = p.domain;
          if (p.displayName && p.displayName !== p.emailAddress) cp.displayName = p.displayName;
          if (p.pendingOwner) cp.pendingOwner = true;
          if (inherited) cp._inherited = true;
          return cp;
        })
      : []
  }));

  const knownIds = Array.isArray(snapshot.knownFileIds) ? snapshot.knownFileIds : [];
  return {
    lastScanAt: snapshot.lastScanAt || '',
    lastScanSource: snapshot.lastScanSource || '',
    accountEmail: snapshot.accountEmail || '',
    files: compactFiles,
    knownFileIds: maxFiles > 0 && knownIds.length > maxFiles * 2 ? knownIds.slice(-maxFiles * 2) : knownIds,
    newFileIds: Array.isArray(snapshot.newFileIds) ? snapshot.newFileIds.slice(0, 5000) : []
  };
}

async function saveSnapshot(snapshot) {
  try {
    const compacted = compactSnapshotForStorage(snapshot, 0);
    await chrome.storage.local.set({ scanSnapshot: compacted });
  } catch (err) {
    // 若用户尚未在 chrome://extensions 点击刷新激活 unlimitedStorage，导致超过默认 10MB 配额，自动降级缓存条数，绝不中断前端扫描展示
    const limits = [4000, 2000, 800];
    let saved = false;
    for (const lim of limits) {
      try {
        const fallbackSnap = compactSnapshotForStorage(snapshot, lim);
        await chrome.storage.local.set({ scanSnapshot: fallbackSnap });
        saved = true;
        break;
      } catch (_e) {
        // 继续尝试更小的缓存上限
      }
    }
    if (!saved) {
      try {
        await chrome.storage.local.remove('scanSnapshot');
      } catch (_e2) {}
    }
  }
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
  const merged = [...list, ...current].slice(0, 500);
  await safeStorageSet({ auditLogs: merged });
  return merged;
}

async function markAuditLogRestored(logId) {
  const current = await getAuditLogs();
  const updated = current.map(item =>
    item.id === logId ? { ...item, restored: true, restoredAt: new Date().toISOString() } : item
  );
  await safeStorageSet({ auditLogs: updated });
  return updated;
}

async function clearAuditLogs() {
  await safeStorageSet({ auditLogs: [] });
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
  return Boolean(permission?._inherited || (permission?.permissionDetails || []).some(detail => detail.inherited));
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

function normalizeScannedFileItem(file, accountEmail = '') {
  file.ownerAccount = normalizeEntry(accountEmail || file.owners?.[0]?.emailAddress || '');
  file.scannedByAccount = normalizeEntry(accountEmail || '');
  if (Array.isArray(file.permissions) && file.permissions.length > 0) {
    file.permissionsLoading = false;
    file.permissionError = '';
  } else if (file.shared === false && file.ownedByMe) {
    file.permissions = [
      {
        id: 'owner',
        type: 'user',
        role: 'owner',
        emailAddress: file.ownerAccount
      }
    ];
    file.permissionsLoading = false;
    file.permissionError = '';
  } else if (file.ownedByMe || file.capabilities?.canShare) {
    file.permissions = [];
    file.permissionsLoading = true;
  } else {
    file.permissions = [];
    file.permissionsLoading = false;
    file.permissionError = '';
  }
  return file;
}

/**
 * 扫描单个账号下的所有文件与文件夹及权限（支持全网盘扫描、指定多个文件夹递归扫描 & 内联权限极速获取）
 * scanScope:
 * - 'all_drive': 扫描整个网盘（含全部文件夹 + 文件 + 我的云盘 + 与我共享 + 共享云端硬盘）
 * - 'custom_folders': 扫描指定的 1 个或多个文件夹 ID（支持递归扫描所有子文件夹与内部文件）
 * - 'owned': 仅扫描我拥有的全部文件夹与文件
 * - 'folders_only': 仅扫描所有文件夹（目录结构权限巡检）
 * - 'shared_only': 仅扫描已对外共享的文件夹与文件
 */
async function scanSingleAccount(
  accountEmail,
  token,
  onProgress = null,
  accountPrefix = '',
  onPartialFiles = null,
  scanScope = 'all_drive',
  customFolderIds = [],
  recursive = true
) {
  let files = [];
  const seenFileIds = new Set();
  let lastPartialEmit = 0;

  const INLINE_FILE_FIELDS =
    'id,name,mimeType,webViewLink,createdTime,modifiedTime,ownedByMe,shared,owners(emailAddress,displayName),capabilities(canEdit,canComment,canShare),permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited,inheritedFrom,permissionType)),parents';

  if (scanScope === 'custom_folders') {
    const cleanRootIds = [...new Set((customFolderIds || []).filter(Boolean))];
    if (!cleanRootIds.length) {
      throw new Error('请先输入至少 1 个有效的 Google Drive 文件夹链接或文件夹 ID');
    }

    const visitedFolderIds = new Set();
    let frontierFolderIds = [];

    // 1. 先并发读取所输入的根文件夹（或文件）本身的元数据与权限
    await Promise.all(
      cleanRootIds.map(async rootId => {
        try {
          const meta = await driveApi(
            token,
            `/files/${encodeURIComponent(rootId)}?supportsAllDrives=true&fields=${encodeURIComponent(INLINE_FILE_FIELDS)}`
          );
          if (meta && meta.id && !seenFileIds.has(meta.id)) {
            seenFileIds.add(meta.id);
            normalizeScannedFileItem(meta, accountEmail);
            files.push(meta);
            if (meta.mimeType === 'application/vnd.google-apps.folder') {
              frontierFolderIds.push(meta.id);
            }
          }
        } catch (_err) {
          // 若根文件夹元数据未直接返回但可能可枚举子项，仍尝试将其作为父目录查询
          frontierFolderIds.push(rootId);
        }
      })
    );

    if (onPartialFiles && files.length > 0) {
      onPartialFiles(files);
    }

    // 2. 广度优先（按层批量）扫描文件夹下的子文件夹与文件
    let depth = 0;
    while (frontierFolderIds.length > 0) {
      depth++;
      const currentBatchIds = frontierFolderIds.filter(id => !visitedFolderIds.has(id));
      if (!currentBatchIds.length) break;
      for (const id of currentBatchIds) visitedFolderIds.add(id);

      const nextFrontier = [];
      // 每 15 个父文件夹合并为一次 Drive API 查询，大幅提速
      for (let i = 0; i < currentBatchIds.length; i += 15) {
        const chunk = currentBatchIds.slice(i, i + 15);
        const parentClause = chunk.map(fid => `'${fid.replace(/'/g, "\\'")}' in parents`).join(' or ');
        const q = `(${parentClause}) and trashed = false`;
        let pageToken = '';

        do {
          const params = new URLSearchParams({
            q,
            pageSize: '200',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
            fields: `nextPageToken,incompleteSearch,files(${INLINE_FILE_FIELDS})`
          });
          if (pageToken) params.set('pageToken', pageToken);
          const data = await driveApi(token, `/files?${params}`);
          const pageItems = data.files || [];

          for (const item of pageItems) {
            if (!item?.id || seenFileIds.has(item.id)) continue;
            seenFileIds.add(item.id);
            normalizeScannedFileItem(item, accountEmail);
            files.push(item);

            if (recursive && item.mimeType === 'application/vnd.google-apps.folder' && !visitedFolderIds.has(item.id)) {
              nextFrontier.push(item.id);
            }
          }

          pageToken = data.nextPageToken || '';
          const folderCount = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder').length;
          if (onProgress) {
            onProgress({
              phase: 'files',
              count: files.length,
              message: `${accountPrefix}正在扫描指定文件夹（第 ${depth} 层）：已发现 ${files.length} 项（含 ${folderCount} 个文件夹）…`
            });
          }
          const now = Date.now();
          if (onPartialFiles && (now - lastPartialEmit >= 650 || !pageToken)) {
            lastPartialEmit = now;
            onPartialFiles(files);
          }
        } while (pageToken);
      }

      if (!recursive) break;
      frontierFolderIds = nextFrontier;
    }
  } else {
    let pageToken = '';
    let q = 'trashed = false';
    if (scanScope === 'owned') {
      q = "'me' in owners and trashed = false";
    } else if (scanScope === 'folders_only') {
      q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    }

    do {
      const params = new URLSearchParams({
        q,
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        fields: `nextPageToken,incompleteSearch,files(${INLINE_FILE_FIELDS})`
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await driveApi(token, `/files?${params}`);
      let pageItems = data.files || [];

      if (scanScope === 'owned') {
        pageItems = pageItems.filter(file => file.ownedByMe !== false);
      } else if (scanScope === 'shared_only') {
        pageItems = pageItems.filter(
          file => file.shared === true || (Array.isArray(file.permissions) && file.permissions.length > 1)
        );
      }

      for (const file of pageItems) {
        if (!file?.id || seenFileIds.has(file.id)) continue;
        seenFileIds.add(file.id);
        normalizeScannedFileItem(file, accountEmail);
        files.push(file);
      }

      pageToken = data.nextPageToken || '';

      const folderCount = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder').length;
      if (onProgress) {
        onProgress({
          phase: 'files',
          count: files.length,
          message: `${accountPrefix}已扫描 ${files.length} 项（含 ${folderCount} 个文件夹）…`
        });
      }
      const now = Date.now();
      if (onPartialFiles && (now - lastPartialEmit >= 650 || !pageToken)) {
        lastPartialEmit = now;
        onPartialFiles(files);
      }
    } while (pageToken);
  }

  // 仅对 files.list 未内联返回 permissions 且当前账号有权限管理能力的项补充请求
  const needPermFiles = files.filter(f => f.permissionsLoading);
  if (needPermFiles.length > 0) {
    let cursor = 0;
    let finished = 0;
    let lastEmitAt = 0;

    const workers = Array.from({ length: Math.min(10, needPermFiles.length) }, async () => {
      while (cursor < needPermFiles.length) {
        const index = cursor++;
        const file = needPermFiles[index];
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
        } finally {
          file.permissionsLoading = false;
        }
        finished++;

        const now = Date.now();
        if (finished === needPermFiles.length || now - lastEmitAt >= 650) {
          lastEmitAt = now;
          if (onProgress) {
            onProgress({
              phase: 'permissions',
              finished,
              total: needPermFiles.length,
              message: `${accountPrefix}正在补充读取权限明细 ${finished}/${needPermFiles.length}…`
            });
          }
          if (onPartialFiles) {
            onPartialFiles(files);
          }
        }
      }
    });

    await Promise.all(workers);
  }

  return files;
}

/**
 * 执行完整扫描（支持多账号并发、扫描范围选择 scanScope & 边扫边展示 onPartialFiles）
 */
async function runFullScan({
  interactive = false,
  source = 'manual',
  targetAccount = 'all',
  scanScope = 'all_drive',
  customFolderIds = [],
  recursive = true,
  onProgress = null,
  onPartialFiles = null
} = {}) {
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

  const scannedAccountSet = new Set(targetAccounts.map(a => normalizeEntry(a.email)));
  const otherAccountFiles =
    scanScope !== 'custom_folders' && targetAccount !== 'all' && prevSnapshot.files?.length
      ? prevSnapshot.files.filter(f => f.ownerAccount && !scannedAccountSet.has(normalizeEntry(f.ownerAccount)))
      : [];

  const perAccountFiles = new Map();

  // 多账号全网盘扫描时按 file.id 去重，优先保留 ownedByMe 或权限信息更完整的项
  const mergeAndDedupeFiles = () => {
    const byId = new Map();
    const allLists = [...perAccountFiles.values(), otherAccountFiles];
    for (const list of allLists) {
      for (const file of list) {
        if (!file?.id) continue;
        const prev = byId.get(file.id);
        if (!prev || (!prev.ownedByMe && file.ownedByMe) || ((file.permissions?.length || 0) > (prev.permissions?.length || 0))) {
          byId.set(file.id, file);
        }
      }
    }
    return [...byId.values()];
  };

  const emitPartialCombined = () => {
    if (!onPartialFiles) return;
    const combined = mergeAndDedupeFiles();
    for (const file of combined) {
      file.isNew = (!isFirstScan && !knownSet.has(file.id)) || prevNewSet.has(file.id);
    }
    onPartialFiles(combined);
  };

  // 多账号多线程并发扫描
  await Promise.all(
    targetAccounts.map(async acc => {
      const prefix = targetAccounts.length > 1 ? `[${acc.email}] ` : '';
      let token = await getValidTokenForAccount(acc.email, interactive, false);
      let accFiles;
      try {
        accFiles = await scanSingleAccount(
          acc.email,
          token,
          onProgress,
          prefix,
          partialList => {
            perAccountFiles.set(acc.email, partialList);
            emitPartialCombined();
          },
          scanScope,
          customFolderIds,
          recursive
        );
      } catch (err) {
        if (/401|Invalid Credentials|UNAUTHENTICATED|authError/i.test(String(err?.message || ''))) {
          token = await getValidTokenForAccount(acc.email, interactive, true);
          accFiles = await scanSingleAccount(
            acc.email,
            token,
            onProgress,
            prefix,
            partialList => {
              perAccountFiles.set(acc.email, partialList);
              emitPartialCombined();
            },
            scanScope,
            customFolderIds,
            recursive
          );
        } else {
          throw err;
        }
      }
      perAccountFiles.set(acc.email, accFiles);
      emitPartialCombined();
    })
  );

  const mergedFiles = mergeAndDedupeFiles();

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


/* ==================== 批量输入链接 + 批量邮箱直通赋权/撤权 ==================== */

/**
 * 从多行文本中提取所有 Google Drive 文件/表格/文档/文件夹 ID
 * 支持：
 * - https://docs.google.com/spreadsheets/d/FILE_ID/edit...
 * - https://drive.google.com/file/d/FILE_ID/view...
 * - https://drive.google.com/drive/folders/FOLDER_ID...
 * - https://drive.google.com/open?id=FILE_ID
 * - 直接粘贴的原始 File ID
 */
function parseDriveLinksInput(rawText = '') {
  const tokens = String(rawText)
    .split(/[\r\n\s,，;；]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const ids = [];
  const seen = new Set();

  for (const token of tokens) {
    let id = '';
    const dMatch = token.match(/\/d\/([a-zA-Z0-9_-]{15,})/);
    const folderMatch = token.match(/\/folders\/([a-zA-Z0-9_-]{15,})/);
    const idParamMatch = token.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);

    if (dMatch) {
      id = dMatch[1];
    } else if (folderMatch) {
      id = folderMatch[1];
    } else if (idParamMatch) {
      id = idParamMatch[1];
    } else if (/^[a-zA-Z0-9_-]{18,65}$/.test(token) && !token.includes('@')) {
      id = token;
    }

    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

/**
 * 从多行文本中提取所有有效邮箱地址（支持直接粘贴「姓名 + 邮箱」两列或逗号/换行分隔）
 */
function parseEmailsInput(rawText = '') {
  const matches = String(rawText).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(matches.map(normalizeEntry).filter(Boolean))];
}

/**
 * 对一批文件/文件夹 ID (fileIds) 和一批邮箱 (emails) 批量开通查看/编辑/评论或关闭权限
 */
async function executeBatchLinksPermissions({
  fileIds = [],
  emails = [],
  role = 'reader', // 'reader' | 'writer' | 'commenter'
  mode = 'grant',  // 'grant' | 'revoke'
  existingFiles = [],
  targetAccount = 'all',
  onProgress = null
}) {
  const cleanFileIds = [...new Set(fileIds.filter(Boolean))];
  const cleanEmails = [...new Set(emails.map(normalizeEntry).filter(Boolean))];
  if (!cleanFileIds.length || !cleanEmails.length) {
    throw new Error('请至少提供 1 个有效链接（文件ID）和 1 个有效邮箱');
  }

  // 构建可用 Token 池（支持多账号/多凭证轮询与自动匹配文件所属账号）
  const accounts = await getAuthorizedAccounts();
  const tokenPool = [];
  if (accounts.length > 0) {
    const ordered =
      targetAccount && targetAccount !== 'all'
        ? [
            ...accounts.filter(a => normalizeEntry(a.email) === normalizeEntry(targetAccount)),
            ...accounts.filter(a => normalizeEntry(a.email) !== normalizeEntry(targetAccount))
          ]
        : accounts;
    for (const acc of ordered) {
      try {
        const t = await getValidTokenForAccount(acc.email, false);
        if (t) tokenPool.push({ email: normalizeEntry(acc.email), token: t });
      } catch (_e) {
        // ignore expired single account
      }
    }
  }
  if (!tokenPool.length) {
    const fallbackToken = await getValidTokenForAccount(
      targetAccount !== 'all' ? targetAccount : '',
      true
    );
    tokenPool.push({ email: '', token: fallbackToken });
  }

  const existingMap = new Map(existingFiles.map(f => [f.id, f]));
  const fileMetaMap = new Map();

  // 并发解析每个 fileId 对应的文件名与可用 token（避免逐个串行等待）
  let metaCursor = 0;
  const metaWorkers = Array.from({ length: Math.min(10, cleanFileIds.length) }, async () => {
    while (metaCursor < cleanFileIds.length) {
      const fid = cleanFileIds[metaCursor++];
      const localFile = existingMap.get(fid);
      const preferredEmail = normalizeEntry(localFile?.ownerAccount || localFile?.owners?.[0]?.emailAddress || '');
      const preferredEntry = tokenPool.find(x => x.email && x.email === preferredEmail) || tokenPool[0];

      let resolvedToken = preferredEntry.token;
      let resolvedAccount = preferredEntry.email;
      let fileName = localFile?.name || `文件 (${fid.slice(0, 8)}…)`;
      let webViewLink = localFile?.webViewLink || `https://drive.google.com/open?id=${fid}`;

      if (!localFile) {
        for (const entry of tokenPool) {
          try {
            const meta = await driveApi(
              entry.token,
              `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=id,name,webViewLink,owners(emailAddress)`
            );
            if (meta) {
              resolvedToken = entry.token;
              resolvedAccount = entry.email || normalizeEntry(meta.owners?.[0]?.emailAddress || '');
              fileName = meta.name || fileName;
              webViewLink = meta.webViewLink || webViewLink;
              break;
            }
          } catch (_e) {
            // try next account token
          }
        }
      }

      fileMetaMap.set(fid, {
        fileId: fid,
        fileName,
        webViewLink,
        token: resolvedToken,
        accountEmail: resolvedAccount,
        localFile
      });
    }
  });
  await Promise.all(metaWorkers);

  // 构建任务队列
  const tasks = [];
  if (mode === 'grant') {
    for (const fid of cleanFileIds) {
      for (const email of cleanEmails) {
        tasks.push({ type: 'grant', fileId: fid, email, role });
      }
    }
  } else {
    // mode === 'revoke': 并发读取每个文件的权限列表，找出命中 cleanEmails 的权限项
    const emailSet = new Set(cleanEmails);
    let revCursor = 0;
    const revWorkers = Array.from({ length: Math.min(10, cleanFileIds.length) }, async () => {
      while (revCursor < cleanFileIds.length) {
        const fid = cleanFileIds[revCursor++];
        const meta = fileMetaMap.get(fid);
        try {
          let perms = meta.localFile?.permissions;
          if (!perms || !perms.length) {
            const data = await driveApi(
              meta.token,
              `/files/${encodeURIComponent(fid)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress)`
            );
            perms = data?.permissions || [];
          }
          for (const p of perms) {
            if (p.role === 'owner') continue;
            const em = normalizeEntry(p.emailAddress || '');
            if (em && emailSet.has(em)) {
              tasks.push({ type: 'revoke', fileId: fid, email: em, permissionId: p.id, previousRole: p.role });
            }
          }
        } catch (_e) {
          // ignore
        }
      }
    });
    await Promise.all(revWorkers);
  }

  let successCount = 0;
  let failCount = 0;
  let done = 0;
  let cursor = 0;
  const logs = [];

  const workers = Array.from({ length: 12 }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const meta = fileMetaMap.get(task.fileId);
      try {
        if (task.type === 'grant') {
          const created = await createPermission(meta.token, task.fileId, {
            type: 'user',
            role: task.role,
            emailAddress: task.email
          });

          if (meta.localFile) {
            meta.localFile.permissions = meta.localFile.permissions || [];
            const existPerm = meta.localFile.permissions.find(
              p => normalizeEntry(p.emailAddress || '') === task.email
            );
            if (existPerm) {
              existPerm.role = task.role;
            } else {
              meta.localFile.permissions.push({
                id: created?.id || `link-${Date.now()}-${Math.random()}`,
                type: 'user',
                role: task.role,
                emailAddress: task.email
              });
            }
          }

          successCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            accountEmail: meta.accountEmail,
            fileId: task.fileId,
            fileName: meta.fileName,
            webViewLink: meta.webViewLink,
            permissionId: created?.id || '',
            targetType: 'user',
            targetEmail: task.email,
            targetLabel: task.email,
            previousRole: '',
            newRole: task.role,
            restored: false,
            message: `批量链接授权：授予「${roleLabel(task.role)}」权限`
          });
        } else if (task.type === 'revoke') {
          await deletePermission(meta.token, task.fileId, task.permissionId);
          if (meta.localFile && meta.localFile.permissions) {
            meta.localFile.permissions = meta.localFile.permissions.filter(p => p.id !== task.permissionId);
          }
          successCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: meta.accountEmail,
            fileId: task.fileId,
            fileName: meta.fileName,
            webViewLink: meta.webViewLink,
            permissionId: task.permissionId,
            targetType: 'user',
            targetEmail: task.email,
            targetLabel: task.email,
            previousRole: task.previousRole || '',
            newRole: '',
            restored: false,
            message: `批量链接撤权：移除 ${task.email} 的权限`
          });
        }
      } catch (error) {
        failCount++;
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'error',
          accountEmail: meta.accountEmail,
          fileId: task.fileId,
          fileName: meta.fileName,
          webViewLink: meta.webViewLink,
          targetType: 'user',
          targetEmail: task.email,
          targetLabel: task.email,
          restored: false,
          message: `批量链接操作失败 (${task.email})：${error.message}`
        });
      } finally {
        done++;
        if (onProgress) {
          onProgress({
            done,
            total: tasks.length,
            successCount,
            failCount,
            message: `正在处理链接权限 ${done}/${tasks.length}（成功 ${successCount}，失败 ${failCount}）…`
          });
        }
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) await appendAuditLogs(logs);

  return {
    fileCount: cleanFileIds.length,
    emailCount: cleanEmails.length,
    totalTasks: tasks.length,
    successCount,
    failCount
  };
}


/**
 * 免填邮箱：对一批链接直接设置公开权限（所有人可编辑 / 所有人可查看 / 所有人可评论 / 关闭公开链接）
 * mode: 'anyone_writer' | 'anyone_reader' | 'anyone_commenter' | 'anyone_off'
 */
async function executeBatchLinksPublicAccess({
  fileIds = [],
  publicMode = 'anyone_writer',
  existingFiles = [],
  targetAccount = 'all',
  onProgress = null
}) {
  const cleanFileIds = [...new Set(fileIds.filter(Boolean))];
  if (!cleanFileIds.length) {
    throw new Error('请先输入至少 1 个有效链接');
  }

  const accounts = await getAuthorizedAccounts();
  const tokenPool = [];
  if (accounts.length > 0) {
    const ordered =
      targetAccount && targetAccount !== 'all'
        ? [
            ...accounts.filter(a => normalizeEntry(a.email) === normalizeEntry(targetAccount)),
            ...accounts.filter(a => normalizeEntry(a.email) !== normalizeEntry(targetAccount))
          ]
        : accounts;
    for (const acc of ordered) {
      try {
        const t = await getValidTokenForAccount(acc.email, false);
        if (t) tokenPool.push({ email: normalizeEntry(acc.email), token: t });
      } catch (_e) {
        // ignore
      }
    }
  }
  if (!tokenPool.length) {
    const fallbackToken = await getValidTokenForAccount(targetAccount !== 'all' ? targetAccount : '', true);
    tokenPool.push({ email: '', token: fallbackToken });
  }

  const existingMap = new Map(existingFiles.map(f => [f.id, f]));
  const desiredRole =
    publicMode === 'anyone_writer' ? 'writer' : publicMode === 'anyone_commenter' ? 'commenter' : 'reader';

  let successCount = 0;
  let failCount = 0;
  let done = 0;
  let cursor = 0;
  const logs = [];

  const workers = Array.from({ length: Math.min(10, cleanFileIds.length) }, async () => {
    while (cursor < cleanFileIds.length) {
      const fid = cleanFileIds[cursor++];
      const localFile = existingMap.get(fid);
      let fileName = localFile?.name || `文件 (${fid.slice(0, 8)}…)`;
      let webViewLink = localFile?.webViewLink || `https://drive.google.com/open?id=${fid}`;
      let usedAccount = '';

      try {
        // 找到可操作此文件的 token
        let activeToken = tokenPool[0].token;
        usedAccount = tokenPool[0].email;
        for (const entry of tokenPool) {
          try {
            const meta = await driveApi(
              entry.token,
              `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=id,name,webViewLink,capabilities(canShare)`
            );
            if (meta) {
              activeToken = entry.token;
              usedAccount = entry.email;
              fileName = meta.name || fileName;
              webViewLink = meta.webViewLink || webViewLink;
              if (meta.capabilities?.canShare) break;
            }
          } catch (_e) {
            // try next
          }
        }

        if (publicMode === 'anyone_off') {
          const permData = await driveApi(
            activeToken,
            `/files/${encodeURIComponent(fid)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role)`
          );
          const pubPerms = (permData?.permissions || []).filter(p => p.type === 'anyone' || p.type === 'domain');
          for (const pp of pubPerms) {
            await deletePermission(activeToken, fid, pp.id);
          }
          if (localFile && localFile.permissions) {
            localFile.permissions = localFile.permissions.filter(p => p.type !== 'anyone' && p.type !== 'domain');
          }
          successCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: usedAccount,
            fileId: fid,
            fileName,
            webViewLink,
            targetType: 'anyone',
            targetLabel: '公开链接 (任何人)',
            restored: false,
            message: `批量关闭公开链接（恢复受限访问）`
          });
        } else {
          // 设为任何人可编辑 / 查看 / 评论（每个链接只需 1 次请求，无需填邮箱）
          const created = await createPermission(activeToken, fid, {
            type: 'anyone',
            role: desiredRole
          });
          if (localFile) {
            localFile.permissions = localFile.permissions || [];
            const existAnyone = localFile.permissions.find(p => p.type === 'anyone');
            if (existAnyone) {
              existAnyone.role = desiredRole;
            } else {
              localFile.permissions.push({
                id: created?.id || 'anyoneWithLink',
                type: 'anyone',
                role: desiredRole
              });
            }
          }
          successCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            accountEmail: usedAccount,
            fileId: fid,
            fileName,
            webViewLink,
            permissionId: created?.id || 'anyoneWithLink',
            targetType: 'anyone',
            targetLabel: '公开链接 (任何人)',
            newRole: desiredRole,
            restored: false,
            message: `批量设置公开链接：任何人「${roleLabel(desiredRole)}」`
          });
        }
      } catch (error) {
        failCount++;
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'error',
          accountEmail: usedAccount,
          fileId: fid,
          fileName,
          webViewLink,
          targetType: 'anyone',
          targetLabel: '公开链接 (任何人)',
          restored: false,
          message: `设置公开链接失败：${error.message}`
        });
      } finally {
        done++;
        if (onProgress) {
          onProgress({
            done,
            total: cleanFileIds.length,
            successCount,
            failCount,
            message: `正在设置链接公开权限 ${done}/${cleanFileIds.length}（成功 ${successCount}，失败 ${failCount}）…`
          });
        }
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) await appendAuditLogs(logs);
  return { total: cleanFileIds.length, successCount, failCount };
}

/**
 * 扫描一批输入的链接：查看「我对该链接有什么权限」以及「目前该链接对外是什么权限（如任何人可编辑/查看/受限）」
 */
async function scanBatchLinksStatus({
  fileIds = [],
  checkEmails = [],
  targetAccount = 'all',
  onProgress = null,
  onPartialResults = null
}) {
  const cleanFileIds = [...new Set(fileIds.filter(Boolean))];
  if (!cleanFileIds.length) {
    throw new Error('请先粘贴要扫描的链接');
  }
  const cleanCheckEmails = [...new Set((checkEmails || []).map(e => normalizeEntry(e)).filter(Boolean))];

  const accounts = await getAuthorizedAccounts();
  const tokenPool = [];
  if (accounts.length > 0) {
    const ordered =
      targetAccount && targetAccount !== 'all'
        ? [
            ...accounts.filter(a => normalizeEntry(a.email) === normalizeEntry(targetAccount)),
            ...accounts.filter(a => normalizeEntry(a.email) !== normalizeEntry(targetAccount))
          ]
        : accounts;
    for (const acc of ordered) {
      try {
        const t = await getValidTokenForAccount(acc.email, false);
        if (t) tokenPool.push({ email: normalizeEntry(acc.email), token: t });
      } catch (_e) {
        // ignore
      }
    }
  }
  if (!tokenPool.length) {
    const fallbackToken = await getValidTokenForAccount(targetAccount !== 'all' ? targetAccount : '', true);
    tokenPool.push({ email: '', token: fallbackToken });
  }
  const tokenByEmail = new Map(tokenPool.filter(t => t.email).map(t => [t.email, t.token]));

  const results = cleanFileIds.map((fid, idx) => ({
    index: idx + 1,
    fileId: fid,
    name: `正在检测 (${fid.slice(0, 10)}…)`,
    mimeType: '',
    webViewLink: `https://drive.google.com/open?id=${fid}`,
    loading: true,
    accessible: false,
    matchedAccount: '',
    ownerEmail: '',
    myAccessLabel: '⏳ 检测中…',
    myAccessClass: 'private',
    canShare: false,
    linkStatusLabel: '⏳ 检测中…',
    linkStatusClass: 'private',
    linkPublicRole: 'none', // 'writer' | 'commenter' | 'reader' | 'domain' | 'restricted' | 'unknown'
    permissions: [],
    emailCheckSummary: null,
    error: ''
  }));

  if (onPartialResults) onPartialResults(results);

  let cursor = 0;
  let finished = 0;

  const workers = Array.from({ length: Math.min(10, cleanFileIds.length) }, async () => {
    while (cursor < cleanFileIds.length) {
      const i = cursor++;
      const item = results[i];
      const fid = item.fileId;

      let bestMeta = null;
      let bestEntry = null;
      let lastErr = '';

      // 尝试用已授权账号读取该链接元数据与能力 (capabilities)
      for (const entry of tokenPool) {
        try {
          const meta = await driveApi(
            entry.token,
            `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,ownedByMe,shared,owners(emailAddress,displayName),capabilities(canEdit,canComment,canShare)`
          );
          if (meta) {
            bestMeta = meta;
            bestEntry = entry;
            // 如果当前账号拥有所有权或分享管理权，优先采用该账号
            if (meta.ownedByMe || meta.capabilities?.canShare || meta.capabilities?.canEdit) {
              break;
            }
          }
        } catch (err) {
          lastErr = err.message;
        }
      }

      if (!bestMeta) {
        item.loading = false;
        item.accessible = false;
        item.name = `无法访问 (${fid.slice(0, 12)}…)`;
        item.myAccessLabel = '❌ 无权限访问 / 链接无效';
        item.myAccessClass = 'danger';
        item.linkStatusLabel = '🔒 受限（当前账号无权打开）';
        item.linkStatusClass = 'danger';
        item.error = lastErr || '无访问权限';
      } else {
        item.accessible = true;
        item.name = bestMeta.name || fid;
        item.mimeType = bestMeta.mimeType || '';
        item.webViewLink = bestMeta.webViewLink || item.webViewLink;
        item.matchedAccount = bestEntry.email || '';
        item.ownerEmail = normalizeEntry(bestMeta.owners?.[0]?.emailAddress || '');
        item.canShare = Boolean(bestMeta.ownedByMe || bestMeta.capabilities?.canShare);

        // 1. 判定「我对这个链接有什么权限」
        if (bestMeta.ownedByMe) {
          item.myAccessLabel = '👑 我是所有者 (最高权限)';
          item.myAccessClass = 'ok';
        } else if (bestMeta.capabilities?.canEdit && bestMeta.capabilities?.canShare) {
          item.myAccessLabel = '✏️ 我可编辑 (且可改权限)';
          item.myAccessClass = 'ok';
        } else if (bestMeta.capabilities?.canEdit) {
          item.myAccessLabel = '✏️ 我可编辑 (不可改权限)';
          item.myAccessClass = 'warning';
        } else if (bestMeta.capabilities?.canComment) {
          item.myAccessLabel = '💬 我仅可评论 (不可编辑)';
          item.myAccessClass = 'warning';
        } else {
          item.myAccessLabel = '👁️ 我仅可查看 (只读)';
          item.myAccessClass = 'private';
        }

        // 2. 读取权限明细，判定「目前这个链接对外是什么权限（如任何人可编辑/查看/受限）」
        try {
          const permRes = await driveApi(
            bestEntry.token,
            `/files/${encodeURIComponent(fid)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,domain,displayName)`
          );
          const perms = permRes?.permissions || [];
          item.permissions = perms;

          const anyonePerm = perms.find(p => p.type === 'anyone');
          const domainPerm = perms.find(p => p.type === 'domain');

          if (anyonePerm) {
            item.linkPublicRole = anyonePerm.role;
            if (anyonePerm.role === 'writer' || anyonePerm.role === 'organizer' || anyonePerm.role === 'fileOrganizer') {
              item.linkStatusLabel = '🌐 任何人可编辑 (公开可编辑)';
              item.linkStatusClass = 'danger';
            } else if (anyonePerm.role === 'commenter') {
              item.linkStatusLabel = '🌐 任何人可评论 (公开可评论)';
              item.linkStatusClass = 'warning';
            } else {
              item.linkStatusLabel = '🌐 任何人可查看 (公开只读)';
              item.linkStatusClass = 'ok';
            }
          } else if (domainPerm) {
            item.linkPublicRole = 'domain';
            item.linkStatusLabel = `🏢 域内公开 (${domainPerm.domain || '组织内'} · ${roleLabel(domainPerm.role)})`;
            item.linkStatusClass = 'warning';
          } else {
            item.linkPublicRole = 'restricted';
            const nonOwners = perms.filter(
              p => p.role !== 'owner' && normalizeEntry(p.emailAddress || '') !== item.ownerEmail
            );
            item.linkStatusLabel =
              nonOwners.length > 0
                ? `🔒 受限（仅指定 ${nonOwners.length} 个邮箱可访问）`
                : '🔒 私密（仅所有者本人可访问）';
            item.linkStatusClass = 'private';
          }
        } catch (_permErr) {
          // 当我对该文件只有“仅查看”权限时，Google 可能不允许列出全部他人权限
          item.linkPublicRole = 'unknown';
          if (bestMeta.capabilities?.canEdit) {
            item.linkStatusLabel = '🌐 公开可编辑 或 已对我授权编辑';
            item.linkStatusClass = 'warning';
          } else {
            item.linkStatusLabel = '👁️ 对我只读（非管理员无法查看完整权限列表）';
            item.linkStatusClass = 'private';
          }
        }
      }

      // 3. 如果 B 列填写了待核查邮箱（如 sa-140 ~ sa-149），逐一核查这些账号对该链接是否有读取/编辑权限
      if (cleanCheckEmails.length > 0) {
        const permByEmail = new Map();
        for (const p of item.permissions || []) {
          const em = normalizeEntry(p.emailAddress || '');
          if (em) permByEmail.set(em, p.role || 'reader');
        }
        if (item.ownerEmail && !permByEmail.has(item.ownerEmail)) {
          permByEmail.set(item.ownerEmail, 'owner');
        }
        const anyonePerm = (item.permissions || []).find(p => p.type === 'anyone');
        const domainPerm = (item.permissions || []).find(p => p.type === 'domain');

        let readableCount = 0;
        let explicitCount = 0;
        let writerCount = 0;
        let readerCount = 0;
        const readableEmails = [];
        const missingEmails = [];
        const perEmailStatus = [];

        for (const targetEm of cleanCheckEmails) {
          let canRead = false;
          let explicit = false;
          let role = 'none';

          if (permByEmail.has(targetEm)) {
            canRead = true;
            explicit = true;
            role = permByEmail.get(targetEm);
          } else if (anyonePerm) {
            canRead = true;
            explicit = false;
            role = anyonePerm.role || 'reader';
          } else if (domainPerm && domainPerm.domain && targetEm.endsWith('@' + normalizeEntry(domainPerm.domain))) {
            canRead = true;
            explicit = false;
            role = domainPerm.role || 'reader';
          } else if ((!item.permissions || item.permissions.length === 0) && tokenByEmail.has(targetEm)) {
            // 当无法直接列出完整 permissions 时，若该待查邮箱本身已在插件中授权（如导入了 Service Account JSON），直接用其自身 Token 实测读取权限
            if (item.accessible && item.matchedAccount === targetEm) {
              canRead = true;
              explicit = true;
              role = item.myAccessLabel.includes('可编辑') || item.myAccessLabel.includes('所有者') ? 'writer' : 'reader';
            } else {
              try {
                const probeMeta = await driveApi(
                  tokenByEmail.get(targetEm),
                  `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canComment)`
                );
                if (probeMeta) {
                  canRead = true;
                  explicit = true;
                  role = probeMeta.capabilities?.canEdit ? 'writer' : 'reader';
                }
              } catch (_probeErr) {
                canRead = false;
              }
            }
          }

          if (canRead) {
            readableCount++;
            if (explicit) explicitCount++;
            if (role === 'owner' || role === 'organizer' || role === 'fileOrganizer' || role === 'writer') {
              writerCount++;
            } else {
              readerCount++;
            }
            readableEmails.push(targetEm);
          } else {
            missingEmails.push(targetEm);
          }
          perEmailStatus.push({ email: targetEm, canRead, explicit, role });
        }

        item.emailCheckSummary = {
          total: cleanCheckEmails.length,
          readableCount,
          explicitCount,
          writerCount,
          readerCount,
          viaPublicLink: Boolean(anyonePerm),
          readableEmails,
          missingEmails,
          perEmailStatus
        };
      }

      item.loading = false;
      finished++;
      if (onProgress) {
        onProgress({
          done: finished,
          total: cleanFileIds.length,
          message: `正在扫描链接权限 ${finished}/${cleanFileIds.length}…`
        });
      }
      if (onPartialResults) {
        onPartialResults(results);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/* ==================== 全盘所有权转移中心（来源邮箱 ➔ 接收邮箱 · 断点续传 · 对比与日志） ==================== */

const OWNERSHIP_TRANSFER_STORAGE_KEY = 'ownershipTransferState';

async function getOwnershipTransferState() {
  const data = await chrome.storage.local.get(OWNERSHIP_TRANSFER_STORAGE_KEY);
  const st = data[OWNERSHIP_TRANSFER_STORAGE_KEY];
  if (!st || typeof st !== 'object') {
    return {
      sourceEmail: '',
      targetEmail: '',
      autoAccept: true,
      lastScannedAt: '',
      lastUpdatedAt: '',
      items: [],
      logs: []
    };
  }
  return {
    sourceEmail: normalizeEntry(st.sourceEmail || ''),
    targetEmail: normalizeEntry(st.targetEmail || ''),
    autoAccept: st.autoAccept !== false,
    lastScannedAt: st.lastScannedAt || '',
    lastUpdatedAt: st.lastUpdatedAt || '',
    items: Array.isArray(st.items) ? st.items : [],
    logs: Array.isArray(st.logs) ? st.logs.slice(-600) : []
  };
}

async function saveOwnershipTransferState(partial = {}) {
  const current = await getOwnershipTransferState();
  const next = {
    ...current,
    ...partial,
    sourceEmail: normalizeEntry(partial.sourceEmail !== undefined ? partial.sourceEmail : current.sourceEmail),
    targetEmail: normalizeEntry(partial.targetEmail !== undefined ? partial.targetEmail : current.targetEmail),
    lastUpdatedAt: new Date().toISOString()
  };
  if (Array.isArray(next.logs) && next.logs.length > 600) {
    next.logs = next.logs.slice(-600);
  }
  await safeStorageSet({ [OWNERSHIP_TRANSFER_STORAGE_KEY]: next });
  return next;
}

async function clearOwnershipTransferState() {
  const empty = {
    sourceEmail: '',
    targetEmail: '',
    autoAccept: true,
    lastScannedAt: '',
    lastUpdatedAt: '',
    items: [],
    logs: []
  };
  await safeStorageSet({ [OWNERSHIP_TRANSFER_STORAGE_KEY]: empty });
  return empty;
}

/**
 * 将扫描到的原始 Drive 文件数组转换为所有权转移条目列表（供每页边扫边展示与最终汇总共用）
 */
function buildTransferItemsFromRawFiles(
  rawFiles = [],
  { normSource = '', normTarget = '', existingItems = [], mergeMode = false, includeHistoricalMerged = false } = {}
) {
  const sorted = [...rawFiles].sort((a, b) => {
    const aFolder = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    const bFolder = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });

  const prevById = new Map((existingItems || []).map(it => [it.id, it]));
  const nextItems = [];
  const seenIds = new Set();

  for (const f of sorted) {
    if (!f?.id || seenIds.has(f.id)) continue;
    seenIds.add(f.id);

    const prev = prevById.get(f.id);
    const ownerEm = normalizeEntry(f.owners?.[0]?.emailAddress || normSource);
    const perms = Array.isArray(f.permissions) ? f.permissions : [];
    const targetPerm = normTarget ? perms.find(p => normalizeEntry(p.emailAddress || '') === normTarget) : null;

    let stage = 'pending_init'; // 'pending_init' | 'pending_accept' | 'completed' | 'failed'
    let statusText = '⏳ 待发起转移 (仍归来源邮箱)';
    let currentOwner = ownerEm;

    if (normTarget && ownerEm === normTarget) {
      stage = 'completed';
      currentOwner = normTarget;
      statusText = '✅ 已归属接收邮箱';
    } else if (targetPerm?.role === 'owner') {
      stage = 'completed';
      currentOwner = normTarget;
      statusText = '✅ 已归属接收邮箱';
    } else if (targetPerm?.pendingOwner === true) {
      stage = 'pending_accept';
      statusText = '📨 已发起邀请 (待接收邮箱确认)';
    } else if (mergeMode && prev && (prev.stage === 'completed' || prev.stage === 'pending_accept')) {
      stage = prev.stage;
      statusText = prev.statusText || statusText;
      currentOwner = prev.currentOwner || currentOwner;
    }

    nextItems.push({
      id: f.id,
      name: f.name || '(无名称)',
      mimeType: f.mimeType || '',
      webViewLink: f.webViewLink || `https://drive.google.com/open?id=${f.id}`,
      sourceOwner: normSource,
      targetOwner: normTarget,
      currentOwner,
      targetPermissionId: targetPerm?.id || prev?.targetPermissionId || '',
      stage,
      statusText,
      error: '',
      updatedAt: prev?.updatedAt || new Date().toISOString()
    });
  }

  // 如果是增量合并模式，保留之前已经成功转给接收邮箱（因而不再出现在来源账号 'me' in owners 列表中）的历史完成项
  if (mergeMode && includeHistoricalMerged && existingItems?.length) {
    for (const oldItem of existingItems) {
      if (!seenIds.has(oldItem.id)) {
        if (oldItem.stage === 'completed' || oldItem.stage === 'pending_accept') {
          nextItems.push({
            ...oldItem,
            stage: 'completed',
            currentOwner: normTarget || oldItem.targetOwner || oldItem.currentOwner,
            statusText: '✅ 已转出 (不再归属来源邮箱)'
          });
        }
      }
    }
  }

  return nextItems;
}

/**
 * 扫描来源邮箱名下所有「我是所有者 ('me' in owners)」的文件夹与文件（支持边扫边展示 onPartialItems、首次全盘扫描或增量合并扫描）
 */
async function scanSourceOwnedItemsForTransfer({
  sourceEmail = '',
  targetEmail = '',
  existingItems = [],
  mergeMode = false,
  onProgress = null,
  onPartialItems = null,
  shouldStop = null
}) {
  const normSource = normalizeEntry(sourceEmail);
  const normTarget = normalizeEntry(targetEmail);
  if (!normSource) {
    throw new Error('请先在左侧选择「来源邮箱（原所有者）」');
  }

  if (onProgress) {
    onProgress({
      phase: 'auth',
      page: 0,
      count: 0,
      message: `正在校验来源邮箱 (${normSource}) 的免登录授权令牌…`
    });
  }

  let sourceToken = await getValidTokenForAccount(normSource, true, false);

  if (onProgress) {
    onProgress({
      phase: 'token_ready',
      page: 0,
      count: 0,
      message: `✅ 来源邮箱 (${normSource}) 令牌校验通过，正在请求第 1 页文件与文件夹…`
    });
  }

  const rawFiles = [];
  let pageToken = '';
  let page = 0;
  const q = "trashed = false and 'me' in owners and mimeType != 'application/vnd.google-apps.shortcut'";

  do {
    if (shouldStop && shouldStop()) {
      break;
    }
    page++;
    if (onProgress) {
      onProgress({
        phase: 'scanning',
        page,
        count: rawFiles.length,
        message: `正在扫描来源邮箱 (${normSource})：正在拉取第 ${page} 页（当前已发现 ${rawFiles.length} 项）…`
      });
    }

    const apiPath = `/files?pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,ownedByMe,owners(emailAddress,displayName),permissions(id,type,role,emailAddress,pendingOwner))${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;

    let res;
    try {
      res = await driveApi(sourceToken, apiPath);
    } catch (apiErr) {
      // 若导入的免登录通行证中的旧 accessToken 已失效 (401)，自动用 refreshToken 强制刷新一次并无缝重试
      if (page === 1 && /401|Invalid Credentials|UNAUTHENTICATED|authError/i.test(String(apiErr?.message || ''))) {
        if (onProgress) {
          onProgress({
            phase: 'auth_refresh',
            page: 1,
            count: 0,
            message: `🔄 检测到缓存令牌已过期，正在使用免登录 refreshToken 自动换取新令牌…`
          });
        }
        sourceToken = await getValidTokenForAccount(normSource, false, true);
        res = await driveApi(sourceToken, apiPath);
      } else {
        throw apiErr;
      }
    }

    const pageFiles = Array.isArray(res?.files) ? res.files : [];
    if (pageFiles.length > 0) {
      rawFiles.push(...pageFiles);
    }
    pageToken = res?.nextPageToken || '';

    // 每扫完一页立即构建当前列表并触发边扫边展示回调（表格、统计卡片、进度条、日志同步刷新）
    if (onPartialItems) {
      const partialItems = buildTransferItemsFromRawFiles(rawFiles, {
        normSource,
        normTarget,
        existingItems,
        mergeMode,
        includeHistoricalMerged: !pageToken
      });
      await onPartialItems(partialItems, {
        page,
        pageAdded: pageFiles.length,
        total: partialItems.length,
        hasMore: Boolean(pageToken)
      });
      // 让出 15ms 给浏览器主线程立即重绘表格与日志界面，实现丝滑的「边扫描边出来」
      await new Promise(r => setTimeout(r, 15));
    }
  } while (pageToken);

  return buildTransferItemsFromRawFiles(rawFiles, {
    normSource,
    normTarget,
    existingItems,
    mergeMode,
    includeHistoricalMerged: true
  });
}

/**
 * 接收方账号尝试通过 API 自动接受单个文件/文件夹的所有权 (transferOwnership=true, role='owner')
 */
async function acceptSingleItemOwnership({ targetToken, item, targetEmail }) {
  const normTarget = normalizeEntry(targetEmail || item.targetOwner);
  if (!targetToken || !normTarget) {
    return {
      accepted: false,
      stage: item.stage || 'pending_accept',
      statusText: '📨 待接收 (接收邮箱尚未在插件内授权)',
      logMsg: `接收邮箱 ${normTarget} 未授权 Token，保留待接收状态`
    };
  }

  let permId = item.targetPermissionId || '';
  try {
    const permRes = await driveApi(
      targetToken,
      `/files/${encodeURIComponent(item.id)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,pendingOwner)`
    );
    const perms = permRes?.permissions || [];
    const myPerm = perms.find(p => normalizeEntry(p.emailAddress || '') === normTarget);
    if (myPerm?.role === 'owner') {
      return {
        accepted: true,
        stage: 'completed',
        currentOwner: normTarget,
        targetPermissionId: myPerm.id,
        statusText: '✅ 已归属接收邮箱',
        logMsg: `核验发现 ${normTarget} 已经是《${item.name}》的所有者`
      };
    }
    if (myPerm?.id) {
      permId = myPerm.id;
    }
  } catch (_e) {
    // ignore permission list error, fallback to cached permId
  }

  let acceptErr = '';
  if (permId) {
    try {
      const updated = await driveApi(
        targetToken,
        `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?transferOwnership=true&moveToNewOwnersRoot=false&supportsAllDrives=true`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: 'owner' })
        }
      );
      if (updated?.role === 'owner') {
        return {
          accepted: true,
          stage: 'completed',
          currentOwner: normTarget,
          targetPermissionId: permId,
          statusText: '✅ 接收方 API 已自动接受所有权',
          logMsg: `接收方 ${normTarget} 已通过 API 自动接管《${item.name}》所有权`
        };
      }
    } catch (err) {
      acceptErr = err.message || 'API 接受受限';
    }
  } else {
    try {
      const created = await driveApi(
        targetToken,
        `/files/${encodeURIComponent(item.id)}/permissions?transferOwnership=true&moveToNewOwnersRoot=false&supportsAllDrives=true`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'user', role: 'owner', emailAddress: normTarget })
        }
      );
      if (created?.role === 'owner') {
        return {
          accepted: true,
          stage: 'completed',
          currentOwner: normTarget,
          targetPermissionId: created.id || '',
          statusText: '✅ 接收方 API 已自动接受所有权',
          logMsg: `接收方 ${normTarget} 已通过 API 自动接管《${item.name}》所有权`
        };
      }
    } catch (err) {
      acceptErr = err.message || 'API 接受受限';
    }
  }

  // 再次实测该文件对接收方是否已变为 ownedByMe
  try {
    const checkMeta = await driveApi(
      targetToken,
      `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id,ownedByMe,owners(emailAddress)`
    );
    const realOwner = normalizeEntry(checkMeta?.owners?.[0]?.emailAddress || '');
    if (checkMeta?.ownedByMe || realOwner === normTarget) {
      return {
        accepted: true,
        stage: 'completed',
        currentOwner: normTarget,
        targetPermissionId: permId,
        statusText: '✅ 已归属接收邮箱',
        logMsg: `确认《${item.name}》当前实际所有者已变更为 ${normTarget}`
      };
    }
  } catch (_e) {
    // ignore
  }

  return {
    accepted: false,
    stage: 'pending_accept',
    currentOwner: item.currentOwner || item.sourceOwner,
    targetPermissionId: permId,
    statusText: '📨 已发邀请(Pending) · 需网页全选确认',
    logMsg: `《${item.name}》已处于待接收(pendingOwner)状态（Google 个人号策略需在网页汇总页全选接受：${acceptErr}）`
  };
}

/**
 * 单个文件/文件夹发起所有权转移（含自动前置赋予 writer + 设置 pendingOwner/transferOwnership + 可选自动调用接收方接受）
 */
async function transferSingleItemOwnership({
  sourceToken,
  targetToken = '',
  item,
  targetEmail,
  autoAccept = true
}) {
  const normTarget = normalizeEntry(targetEmail || item.targetOwner);
  if (!sourceToken) throw new Error('缺少来源邮箱授权令牌');
  if (!normTarget) throw new Error('缺少接收邮箱地址');

  const logs = [];
  let permId = item.targetPermissionId || '';
  let existingRole = '';
  let alreadyPending = false;

  // 1. 先检查该文件当前权限列表
  try {
    const permRes = await driveApi(
      sourceToken,
      `/files/${encodeURIComponent(item.id)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,pendingOwner)`
    );
    const perms = permRes?.permissions || [];
    const targetPerm = perms.find(p => normalizeEntry(p.emailAddress || '') === normTarget);
    if (targetPerm) {
      permId = targetPerm.id || permId;
      existingRole = targetPerm.role || '';
      alreadyPending = Boolean(targetPerm.pendingOwner);
      if (existingRole === 'owner') {
        return {
          stage: 'completed',
          currentOwner: normTarget,
          targetPermissionId: permId,
          statusText: '✅ 已归属接收邮箱',
          error: '',
          logs: [`✅ 《${item.name}》所有者已经是 ${normTarget}，跳过发起`]
        };
      }
    }
  } catch (err) {
    // 如果来源账号已经不是所有者，检查是否已经转给了接收方
    if (targetToken) {
      const checkRes = await acceptSingleItemOwnership({ targetToken, item, targetEmail: normTarget });
      if (checkRes.accepted) {
        return {
          stage: 'completed',
          currentOwner: normTarget,
          targetPermissionId: checkRes.targetPermissionId || permId,
          statusText: checkRes.statusText,
          error: '',
          logs: [checkRes.logMsg]
        };
      }
    }
    throw new Error(`读取《${item.name}》权限失败: ${err.message}`);
  }

  // 2. 如果尚未处于 pendingOwner，先尝试直接一步转移（同域 Workspace 账号可直接成功），若需确认则自动走 writer + pendingOwner=true
  if (!alreadyPending) {
    let directTransferred = false;
    try {
      if (permId) {
        const directRes = await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?transferOwnership=true&moveToNewOwnersRoot=false&supportsAllDrives=true`,
          {
            method: 'PATCH',
            body: JSON.stringify({ role: 'owner' })
          }
        );
        if (directRes?.role === 'owner') {
          directTransferred = true;
        } else if (directRes?.pendingOwner) {
          alreadyPending = true;
        }
      } else {
        const directCreate = await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions?transferOwnership=true&moveToNewOwnersRoot=false&sendNotificationEmail=false&supportsAllDrives=true`,
          {
            method: 'POST',
            body: JSON.stringify({ type: 'user', role: 'owner', emailAddress: normTarget })
          }
        );
        permId = directCreate?.id || permId;
        if (directCreate?.role === 'owner') {
          directTransferred = true;
        } else if (directCreate?.pendingOwner) {
          alreadyPending = true;
        }
      }
    } catch (_directErr) {
      // 个人 @gmail.com 账号直接设 owner 会抛 consentRequiredForOwnershipTransfer，进入下面的标准两步法
    }

    if (directTransferred) {
      return {
        stage: 'completed',
        currentOwner: normTarget,
        targetPermissionId: permId,
        statusText: '✅ 已直接完成所有权转移',
        error: '',
        logs: [`✅ 来源号已将《${item.name}》直接转移所有权给 ${normTarget}`]
      };
    }

    // 标准两步法 Step 2A：确保接收邮箱先拥有 writer（可编辑）权限，避免 pendingOwnerWriterRequired 报错
    if (!permId) {
      const createdWriter = await driveApi(
        sourceToken,
        `/files/${encodeURIComponent(item.id)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normTarget })
        }
      );
      permId = createdWriter?.id || '';
      logs.push(`📤 已为《${item.name}》前置添加接收方 ${normTarget} 编辑权限 (permId=${permId})`);
    } else if (existingRole && existingRole !== 'writer' && existingRole !== 'organizer') {
      await driveApi(
        sourceToken,
        `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?supportsAllDrives=true`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: 'writer' })
        }
      );
      logs.push(`📤 已将《${item.name}》中 ${normTarget} 的权限升级为编辑者 (writer)`);
    }

    // 标准两步法 Step 2B：设置 pendingOwner: true 发起所有权转移邀请
    if (!alreadyPending && permId) {
      try {
        await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?supportsAllDrives=true`,
          {
            method: 'PATCH',
            body: JSON.stringify({ role: 'writer', pendingOwner: true })
          }
        );
        alreadyPending = true;
        logs.push(`📨 来源号已对《${item.name}》发起所有权转移邀请 (pendingOwner=true)`);
      } catch (_err1) {
        // 兼容部分接口要求带 transferOwnership=true 查询参数
        await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?transferOwnership=true&moveToNewOwnersRoot=false&supportsAllDrives=true`,
          {
            method: 'PATCH',
            body: JSON.stringify({ role: 'writer', pendingOwner: true })
          }
        );
        alreadyPending = true;
        logs.push(`📨 来源号已对《${item.name}》发起所有权转移邀请 (transferOwnership + pendingOwner=true)`);
      }
    }
  } else {
    logs.push(`ℹ️ 《${item.name}》此前已处于待 ${normTarget} 接收所有权状态 (pendingOwner=true)`);
  }

  // 3. 如果开启了接收方自动接受且接收方 Token 可用，立即用接收方 Token 尝试接管所有权
  const updatedItem = { ...item, targetPermissionId: permId, stage: 'pending_accept' };
  if (autoAccept && targetToken) {
    const acceptRes = await acceptSingleItemOwnership({
      targetToken,
      item: updatedItem,
      targetEmail: normTarget
    });
    logs.push(acceptRes.logMsg);
    return {
      stage: acceptRes.stage,
      currentOwner: acceptRes.currentOwner || item.sourceOwner,
      targetPermissionId: acceptRes.targetPermissionId || permId,
      statusText: acceptRes.statusText,
      error: '',
      logs
    };
  }

  return {
    stage: 'pending_accept',
    currentOwner: item.sourceOwner,
    targetPermissionId: permId,
    statusText: '📨 已发转移邀请 (待接收邮箱确认)',
    error: '',
    logs
  };
}

/**
 * 批量核对/对比来源邮箱与接收邮箱的实际归属状态（用于点击「核对左右邮箱实际归属」或网页端全选接受后刷新状态）
 */
async function verifyOwnershipTransferItems({
  sourceToken = '',
  targetToken = '',
  items = [],
  targetEmail = '',
  onProgress = null
}) {
  const normTarget = normalizeEntry(targetEmail);
  const probeToken = targetToken || sourceToken;
  if (!probeToken) {
    throw new Error('请至少授权来源邮箱或接收邮箱以执行归属对比核验');
  }

  let cursor = 0;
  let done = 0;
  const total = items.length;
  let newlyCompleted = 0;
  let stillPending = 0;
  let stillSource = 0;

  const workers = Array.from({ length: Math.min(8, Math.max(1, total)) }, async () => {
    while (cursor < total) {
      const idx = cursor++;
      const it = items[idx];
      try {
        const meta = await driveApi(
          probeToken,
          `/files/${encodeURIComponent(it.id)}?supportsAllDrives=true&fields=id,name,ownedByMe,owners(emailAddress),permissions(id,emailAddress,role,pendingOwner)`
        );
        const ownerEm = normalizeEntry(meta?.owners?.[0]?.emailAddress || '');
        const targetPerm = (meta?.permissions || []).find(
          p => normalizeEntry(p.emailAddress || '') === normTarget
        );
        if (ownerEm) it.currentOwner = ownerEm;
        if (targetPerm?.id) it.targetPermissionId = targetPerm.id;

        if ((normTarget && ownerEm === normTarget) || targetPerm?.role === 'owner' || (targetToken && probeToken === targetToken && meta?.ownedByMe)) {
          it.stage = 'completed';
          it.currentOwner = normTarget || ownerEm;
          it.statusText = '✅ 已归属接收邮箱 (对比确认)';
          it.error = '';
          newlyCompleted++;
        } else if (targetPerm?.pendingOwner === true) {
          it.stage = 'pending_accept';
          it.statusText = '📨 待接收邮箱确认 (Pending)';
          stillPending++;
        } else {
          it.stage = 'pending_init';
          it.statusText = '⏳ 仍归来源邮箱 (未发起或已撤回)';
          stillSource++;
        }
        it.updatedAt = new Date().toISOString();
      } catch (_e) {
        // keep current state if single file probe fails
      }
      done++;
      if (onProgress && (done % 5 === 0 || done === total)) {
        onProgress({
          done,
          total,
          message: `正在对比左右邮箱归属状态 ${done}/${total}（已归属接收方 ${newlyCompleted} 项）…`
        });
      }
    }
  });

  await Promise.all(workers);
  return { total, newlyCompleted, stillPending, stillSource };
}
