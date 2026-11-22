const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const ALARM_NAME = 'drive_permission_periodic_scan';
const TTL_ALARM_NAME = 'gdrive-ttl-reaper';

const DEFAULT_BLOCKED_APP_KEYWORDS = [
  'chatgpt',
  'openai',
  'grok',
  'xai',
  'muse',
  'claude',
  'cursor',
  'notion',
  'zapier',
  'make'
];

const DEFAULT_POLICY = {
  writers: [],          // 允许编辑的邮箱或 @domain.com
  readers: [],          // 仅允许查看的邮箱或 @domain.com
  publicLinkRule: 'forbid', // 'forbid' | 'reader_only' | 'allow'
  scheduleEnabled: true,
  scheduleMinutes: 720, // 默认每 12 小时定期巡检
  scanOnBrowserStartup: true,
  autoEnforce: false,   // false = 仅提醒, true = 后台自动撤权/降级
  excludedFolders: [],  // [{ id, name, webViewLink, includeSubitems: true, note: '', addedAt }]
  thirdPartyOAuthGuardEnabled: true,
  oauthGuardMode: 'block', // 'block' | 'alert'
  blockThirdPartyDriveScope: true,
  blockThirdPartySheetsScope: true,
  blockedAppKeywords: [...DEFAULT_BLOCKED_APP_KEYWORDS],
  trustedOAuthKeywords: []
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
      // 如果当前保存的不是 scanSnapshot（例如保存账号授权状态、OAuth凭据、全盘转移进度），先清除占空间最大的 scanSnapshot 缓存再重试
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

/* ==================== 通讯录、分组与权限角色解析（A列邮箱 · B列权限 · 可选C列分组） ==================== */

const WRITER_ROLE_TOKENS = new Set([
  'writer',
  'edit',
  'editor',
  'write',
  'can_edit',
  'canedit',
  '可编辑',
  '编辑',
  '编辑者',
  '允许编辑',
  '读写',
  '修改'
]);

const COMMENTER_ROLE_TOKENS = new Set([
  'commenter',
  'comment',
  'can_comment',
  'cancomment',
  '可评论',
  '评论',
  '评论者',
  '允许评论',
  '仅评论',
  '批注'
]);

const READER_ROLE_TOKENS = new Set([
  'reader',
  'read',
  'view',
  'viewer',
  'readonly',
  'read-only',
  'can_view',
  'canview',
  '仅查看',
  '仅限查看',
  '只读',
  '查看',
  '查看者',
  '浏览'
]);

/**
 * 归一化权限角色词：
 * - 命中编辑词 -> 'writer'
 * - 命中评论词 -> 'commenter'
 * - 命中查看词 -> 'reader'
 * - 未命中时返回 fallback（当 fallback === '' 时返回 ''）
 */
function normalizePermissionRole(raw, fallback = 'reader') {
  const clean = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^['"「【\s]+|['"」】\s]+$/g, '');
  if (!clean) return fallback;
  if (WRITER_ROLE_TOKENS.has(clean)) return 'writer';
  if (COMMENTER_ROLE_TOKENS.has(clean)) return 'commenter';
  if (READER_ROLE_TOKENS.has(clean)) return 'reader';
  return fallback;
}

/**
 * 计算成员在指定分组下的有效目标角色：
 * 优先级：c.groupRoles?.[groupName] -> c.role -> group.defaultRole -> 'reader'
 */
function getEffectiveMemberRoleInGroup(contact, groupName = '', groupObj = null) {
  if (groupName && contact?.groupRoles && contact.groupRoles[groupName]) {
    const gr = normalizePermissionRole(contact.groupRoles[groupName], '');
    if (gr) return gr;
  }
  if (contact?.role) {
    const cr = normalizePermissionRole(contact.role, '');
    if (cr) return cr;
  }
  if (groupObj?.defaultRole) {
    return normalizePermissionRole(groupObj.defaultRole, 'reader');
  }
  return 'reader';
}

/**
 * 批量解析多行分组创建文本：
 * 支持 `财务组, 可编辑`、`审计组\t仅查看`、`外包组：可评论`、`设计组 可编辑` 或每行一个纯组名
 * 返回 [{ name, defaultRole, policyTier }]
 */
function parseBatchGroupsText(rawText = '', fallbackRole = 'reader') {
  const cleanFallback = normalizePermissionRole(fallbackRole, 'reader') || 'reader';
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const byName = new Map();
  for (const line of lines) {
    let name = '';
    let defaultRole = cleanFallback;

    const parts = line
      .split(/[\t,，;；:：|]+/)
      .map(s => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);

    if (parts.length >= 2) {
      const rSecond = normalizePermissionRole(parts[1], '');
      const rLast = normalizePermissionRole(parts[parts.length - 1], '');
      const rFirst = normalizePermissionRole(parts[0], '');
      if (rSecond) {
        name = parts[0];
        defaultRole = rSecond;
      } else if (rLast) {
        name = parts.slice(0, -1).join(' ');
        defaultRole = rLast;
      } else if (rFirst && !normalizePermissionRole(parts[1], '')) {
        name = parts[1];
        defaultRole = rFirst;
      } else {
        name = parts[0];
        defaultRole = cleanFallback;
      }
    } else if (parts.length === 1) {
      const single = parts[0];
      const tailMatch = single.match(/^(.+?)(?:\s+-\s+|\s+)(\S+)$/);
      const tailRole = tailMatch ? normalizePermissionRole(tailMatch[2], '') : '';
      if (tailMatch && tailRole) {
        name = tailMatch[1].trim();
        defaultRole = tailRole;
      } else {
        name = single.trim();
        defaultRole = cleanFallback;
      }
    }

    const cleanName = String(name || '').trim();
    if (!cleanName) continue;
    const policyTier = defaultRole === 'writer' ? 'writer' : 'reader';
    byName.set(cleanName, {
      name: cleanName,
      defaultRole,
      policyTier
    });
  }

  return [...byName.values()];
}

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
  const groupByName = new Map();
  for (const g of directory?.groups || []) {
    const name = String(g?.name || '').trim();
    if (!name || groupByName.has(name)) continue;
    const defaultRole = normalizePermissionRole(g.defaultRole, 'reader') || 'reader';
    const policyTier = ['writer', 'reader', 'none'].includes(g.policyTier)
      ? g.policyTier
      : defaultRole === 'writer'
        ? 'writer'
        : 'reader';
    const cleanAssets = [];
    const seenAssetIds = new Set();
    if (Array.isArray(g.assets)) {
      for (const rawAsset of g.assets) {
        if (!rawAsset) continue;
        const fid = String(rawAsset.fileId || rawAsset.id || '').trim();
        if (!fid || seenAssetIds.has(fid)) continue;
        seenAssetIds.add(fid);
        cleanAssets.push({
          fileId: fid,
          fileName: String(rawAsset.fileName || rawAsset.name || '(无名称)').trim(),
          mimeType: String(rawAsset.mimeType || ''),
          webViewLink: String(
            rawAsset.webViewLink || formatDriveCanonicalLink({ id: fid, mimeType: rawAsset.mimeType || '' })
          )
        });
      }
    }
    const grpObj = { name, defaultRole, policyTier, assets: cleanAssets };
    groupByName.set(name, grpObj);
    cleanGroups.push(grpObj);
  }

  const contactMap = new Map();
  for (const c of directory?.contacts || []) {
    const email = normalizeEntry(c?.email || '');
    if (!email || !email.includes('@')) continue;
    const prev = contactMap.get(email);
    const incomingGroups = Array.isArray(c.groups)
      ? c.groups.map(x => String(x || '').trim()).filter(Boolean)
      : [];
    const mergedGroups = [...new Set([...(prev?.groups || []), ...incomingGroups])];

    for (const gName of mergedGroups) {
      if (!groupByName.has(gName)) {
        const autoRole = normalizePermissionRole(c.groupRoles?.[gName] || c.role, 'reader') || 'reader';
        const newGrp = {
          name: gName,
          defaultRole: 'reader',
          policyTier: autoRole === 'writer' ? 'writer' : 'reader'
        };
        groupByName.set(gName, newGrp);
        cleanGroups.push(newGrp);
      }
    }

    const mergedGroupRoles = { ...(prev?.groupRoles || {}) };
    if (c.groupRoles && typeof c.groupRoles === 'object') {
      for (const [gk, gv] of Object.entries(c.groupRoles)) {
        const cleanGk = String(gk || '').trim();
        const cleanGv = normalizePermissionRole(gv, '');
        if (cleanGk && cleanGv) {
          mergedGroupRoles[cleanGk] = cleanGv;
        }
      }
    }

    const explicitRole = c.role ? normalizePermissionRole(c.role, '') : '';
    if (explicitRole && c.hasExplicitRole && incomingGroups.length > 0 && !c.groupRoles) {
      for (const gName of incomingGroups) {
        mergedGroupRoles[gName] = explicitRole;
      }
    }

    let finalRole = explicitRole || prev?.role || '';
    if (!finalRole) {
      let bestRank = 0;
      for (const gName of mergedGroups) {
        const gRole = mergedGroupRoles[gName] || groupByName.get(gName)?.defaultRole || 'reader';
        const rank = PERMISSION_ROLE_RANKS[gRole] || 0;
        if (rank > bestRank) {
          bestRank = rank;
          finalRole = gRole;
        }
      }
      if (!finalRole) finalRole = 'reader';
    }

    contactMap.set(email, {
      email,
      name: String(c.name || prev?.name || '').trim(),
      groups: mergedGroups,
      role: finalRole,
      groupRoles: mergedGroupRoles
    });
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
 * 将名录与分组中的成员按有效角色同步到合规白名单：
 * - 有效角色为 'writer' 同步入 writers
 * - 有效角色为 'reader' | 'commenter' 同步入 readers
 */
async function syncDirectoryToPolicy(directory) {
  const currentPolicy = await getPolicy();
  const groupByName = new Map();
  for (const g of directory?.groups || []) {
    if (g?.name) groupByName.set(g.name, g);
  }

  const writers = new Set(currentPolicy.writers || []);
  const readers = new Set(currentPolicy.readers || []);

  for (const c of directory?.contacts || []) {
    const email = normalizeEntry(c?.email || '');
    if (!email) continue;

    const memberGroups = Array.isArray(c.groups) ? c.groups.filter(Boolean) : [];
    let effectiveRole = '';

    if (memberGroups.length > 0) {
      const activeGroups = memberGroups.filter(gName => groupByName.get(gName)?.policyTier !== 'none');
      if (activeGroups.length === 0) continue;

      let bestRank = 0;
      for (const gName of activeGroups) {
        const grp = groupByName.get(gName);
        const r = getEffectiveMemberRoleInGroup(c, gName, grp);
        const rank = PERMISSION_ROLE_RANKS[r] || 0;
        if (rank > bestRank) {
          bestRank = rank;
          effectiveRole = r;
        }
      }
    } else {
      effectiveRole = normalizePermissionRole(c.role, 'reader') || 'reader';
    }

    if (effectiveRole === 'writer') {
      writers.add(email);
      readers.delete(email);
    } else if ((effectiveRole === 'reader' || effectiveRole === 'commenter') && !writers.has(email)) {
      readers.add(email);
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

function splitTabularRowCells(line = '') {
  if (line.includes('\t')) {
    return line.split('\t').map(s => s.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
  }
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && (ch === ',' || ch === ';' || ch === '，' || ch === '；')) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells.map(s => s.replace(/^"|"$/g, '').trim());
}

function extractEmailAndInlineNameFromCell(cell = '') {
  const str = String(cell || '').trim();
  if (!str) return null;
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(str)) {
    return { email: normalizeEntry(str), inlineName: '' };
  }
  const angleMatch = str.match(/^(.*?)<\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*>$/);
  if (angleMatch) {
    return {
      email: normalizeEntry(angleMatch[2]),
      inlineName: angleMatch[1].trim().replace(/^["']|["']$/g, '').trim()
    };
  }
  return null;
}

/**
 * 解析从 Google 表格、CSV 或粘贴文本读取的成员与权限：
 * - 标准优先格式：A列邮箱 (index 0)，B列权限角色，可选 C列分组名，可选 D列姓名；
 *   若 B列非角色词，则兼容旧表识别组名/姓名并回退 fallbackRole。
 * - 兼容旧格式：B列邮箱 (index 1)，A列姓名，自动识别 C/D 列中的角色词与分组名。
 */
function parseTabularContactsText(rawText = '', fallbackGroup = '', fallbackRole = 'reader') {
  const cleanFallbackGroup = fallbackGroup ? String(fallbackGroup).trim() : '';
  const defaultRole = normalizePermissionRole(fallbackRole, 'reader') || 'reader';
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const results = [];
  for (const line of lines) {
    const cells = splitTabularRowCells(line);
    if (!cells.length) continue;

    let emailIdx = -1;
    let extracted = null;
    for (let i = 0; i < cells.length; i++) {
      const hit = extractEmailAndInlineNameFromCell(cells[i]);
      if (hit) {
        emailIdx = i;
        extracted = hit;
        break;
      }
    }
    if (emailIdx === -1 || !extracted) {
      // 表头行或无邮箱行自动跳过
      continue;
    }

    const email = extracted.email;
    let name = extracted.inlineName || '';
    let group = cleanFallbackGroup;
    let role = defaultRole;
    let hasExplicitRole = false;

    if (emailIdx === 0) {
      // 标准优先格式：A列是邮箱
      const c1 = cells[1] || '';
      const c2 = cells[2] || '';
      const c3 = cells[3] || '';
      const role1 = normalizePermissionRole(c1, '');
      const role2 = !role1 ? normalizePermissionRole(c2, '') : '';

      if (role1) {
        role = role1;
        hasExplicitRole = true;
        if (c2) group = c2;
        if (c3) name = c3;
      } else if (role2) {
        role = role2;
        hasExplicitRole = true;
        if (c3) {
          name = c1;
          group = c3;
        } else if (cleanFallbackGroup) {
          name = c1;
          group = cleanFallbackGroup;
        } else {
          group = c1;
        }
      } else {
        if (c1 && c2) {
          name = c1;
          group = c2;
        } else if (c1) {
          if (cleanFallbackGroup) {
            name = c1;
          } else if (/组|部|科|中心|团队|项目|group|team|dept/i.test(c1)) {
            group = c1;
          } else {
            name = c1;
          }
        }
      }
    } else if (emailIdx === 1) {
      // 兼容旧格式：A列是姓名，B列是邮箱，C/D列为角色或分组
      name = cells[0] || name;
      const c2 = cells[2] || '';
      const c3 = cells[3] || '';
      const role2 = normalizePermissionRole(c2, '');
      const role3 = !role2 ? normalizePermissionRole(c3, '') : '';

      if (role2) {
        role = role2;
        hasExplicitRole = true;
        if (c3) group = c3;
      } else if (role3) {
        role = role3;
        hasExplicitRole = true;
        if (c2) group = c2;
      } else if (c2) {
        group = c2;
      }
    } else {
      name = cells[0] || name;
      for (let idx = 1; idx < cells.length; idx++) {
        if (idx === emailIdx) continue;
        const val = cells[idx] || '';
        if (!val) continue;
        const maybeRole = normalizePermissionRole(val, '');
        if (maybeRole && !hasExplicitRole) {
          role = maybeRole;
          hasExplicitRole = true;
        } else if (!group || group === cleanFallbackGroup) {
          group = val;
        }
      }
    }

    results.push({
      name: String(name || '').trim(),
      email,
      group: String(group || '').trim(),
      role,
      hasExplicitRole
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

function extractGoogleSheetGid(input = '') {
  const str = String(input || '').trim();
  const match = str.match(/[?&#]gid=(\d+)/i);
  return match ? match[1] : '';
}

async function fetchContactsFromGoogleSheet(token, sheetIdOrUrl, fallbackGroup = '', fallbackRole = 'reader') {
  const fileId = extractDriveFileId(sheetIdOrUrl);
  if (!fileId) throw new Error('请输入有效的 Google 表格链接或文件 ID');
  const gid = extractGoogleSheetGid(sheetIdOrUrl);
  const exportUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv${
    gid ? `&gid=${encodeURIComponent(gid)}` : ''
  }`;
  const response = await fetch(exportUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `读取 Google 表格失败 (${response.status})`);
  }
  const csvText = await response.text();
  return parseTabularContactsText(csvText, fallbackGroup, fallbackRole);
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
  const m = String(mimeType).toLowerCase();
  if (m === 'application/vnd.google-apps.form') return '📋 Google 表单';
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
 * 根据文件/文件夹的真实 MIME 类型生成专属标准直达链接：
 * - 文件夹 (folder) -> https://drive.google.com/drive/folders/{id}
 * - Google 表格 (spreadsheet) -> https://docs.google.com/spreadsheets/d/{id}/edit
 * - Google 文档 (document) -> https://docs.google.com/document/d/{id}/edit
 * - Google 幻灯片 (presentation) -> https://docs.google.com/presentation/d/{id}/edit
 * - Google 表单 (form) -> https://docs.google.com/forms/d/{id}/edit
 * - 其他文件 -> 优先使用非通用 webViewLink，否则生成 https://drive.google.com/file/d/{id}/view
 */
function escapeDriveQueryLiteral(value = '') {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function isTrustedGoogleWebUrl(urlStr = '') {
  try {
    const parsed = new URL(String(urlStr));
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'google.com' || host.endsWith('.google.com');
  } catch (_e) {
    return false;
  }
}

function formatDriveCanonicalLink(itemOrId, mimeType = '', webViewLink = '') {
  let id = '';
  let mime = mimeType;
  let rawLink = webViewLink;
  if (itemOrId && typeof itemOrId === 'object') {
    id = String(itemOrId.id || itemOrId.fileId || '').trim();
    mime = String(itemOrId.mimeType || mimeType || '').trim();
    rawLink = String(itemOrId.webViewLink || webViewLink || '').trim();
  } else {
    id = String(itemOrId || '').trim();
  }
  const safeRawLink = isTrustedGoogleWebUrl(rawLink) ? rawLink : '';
  if (!id) return safeRawLink;

  const safeId = encodeURIComponent(id);
  const m = mime.toLowerCase();
  if (m === 'application/vnd.google-apps.folder') {
    return `https://drive.google.com/drive/folders/${safeId}`;
  }
  if (m === 'application/vnd.google-apps.spreadsheet') {
    return `https://docs.google.com/spreadsheets/d/${safeId}/edit`;
  }
  if (m === 'application/vnd.google-apps.document') {
    return `https://docs.google.com/document/d/${safeId}/edit`;
  }
  if (m === 'application/vnd.google-apps.presentation') {
    return `https://docs.google.com/presentation/d/${safeId}/edit`;
  }
  if (m === 'application/vnd.google-apps.form') {
    return `https://docs.google.com/forms/d/${safeId}/edit`;
  }
  if (m === 'application/vnd.google-apps.drawing') {
    return `https://docs.google.com/drawings/d/${safeId}/edit`;
  }
  if (m === 'application/vnd.google-apps.script') {
    return `https://script.google.com/d/${safeId}/edit`;
  }
  if (safeRawLink && !safeRawLink.includes('drive.google.com/open?id=')) {
    return safeRawLink;
  }
  return `https://drive.google.com/file/d/${safeId}/view`;
}

/**
 * 为任意文件/文件夹集合（如指定文件夹递归扫描结果或全盘扫描结果）计算完整目录树层级信息：
 * 返回 Map<id, {
 *   depth, levelNumber, levelLabel,
 *   folderPath, fullPath, treeDisplayName,
 *   parentFolderId, parentFolderName, parentFolderLink,
 *   rootFolderId, rootFolderName, rootFolderLink,
 *   canonicalLink
 * }>
 */
function buildDriveHierarchyInfo(items = []) {
  const folderMap = new Map();
  for (const it of items || []) {
    if (it && it.id && it.mimeType === 'application/vnd.google-apps.folder') {
      folderMap.set(it.id, it);
    }
  }

  const hierarchyMap = new Map();
  for (const it of items || []) {
    if (!it || !it.id) continue;
    const ancestors = [];
    const visited = new Set([it.id]);
    let cur = it;
    while (cur) {
      const pList = Array.isArray(cur.parents) ? cur.parents : [];
      const parentFolder = pList.map(pid => folderMap.get(pid)).find(Boolean);
      if (!parentFolder || visited.has(parentFolder.id)) break;
      visited.add(parentFolder.id);
      ancestors.unshift(parentFolder);
      cur = parentFolder;
    }

    const depth = ancestors.length;
    const levelNumber = depth + 1;
    const levelLabel = `第 ${levelNumber} 层`;
    const isFolder = it.mimeType === 'application/vnd.google-apps.folder';
    const itemName = it.name || '(无名称)';

    const folderPath =
      ancestors.length > 0
        ? ancestors.map(a => a.name || a.id).join(' / ')
        : it.folderPath || (isFolder ? '顶层目录' : '根目录');
    const fullPath =
      ancestors.length > 0
        ? [...ancestors.map(a => a.name || a.id), itemName].join(' / ')
        : it.fullPath || itemName;
    const treeDisplayName = `${'　'.repeat(depth)}${depth > 0 ? '├─ ' : ''}${itemName}`;

    const immediateParent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    const rawParentId = (Array.isArray(it.parents) && it.parents[0]) || it.parentFolderId || '';
    const parentFolderId = immediateParent ? immediateParent.id : rawParentId;
    const isMyDriveRoot = parentFolderId === 'root' || /^0A[a-zA-Z0-9_-]+PVA$/.test(parentFolderId);
    const parentFolderName = immediateParent
      ? immediateParent.name || immediateParent.id
      : isMyDriveRoot
      ? '我的云端硬盘 (My Drive)'
      : it.parentFolderName || (rawParentId ? '上级目录' : '根目录');
    const parentFolderLink = isMyDriveRoot
      ? 'https://drive.google.com/drive/my-drive'
      : parentFolderId
      ? `https://drive.google.com/drive/folders/${encodeURIComponent(parentFolderId)}`
      : '';

    const topAncestor = ancestors.length > 0 ? ancestors[0] : isFolder ? it : null;
    const rootFolderId = topAncestor ? topAncestor.id : it.rootFolderId || '';
    const rootFolderName = topAncestor
      ? topAncestor.name || topAncestor.id
      : it.rootFolderName || '根目录直属文件';
    const rootFolderLink =
      rootFolderId && rootFolderId !== '__root_loose__'
        ? `https://drive.google.com/drive/folders/${encodeURIComponent(rootFolderId)}`
        : '';

    const canonicalLink = formatDriveCanonicalLink(it);

    hierarchyMap.set(it.id, {
      depth,
      levelNumber,
      levelLabel,
      folderPath,
      fullPath,
      treeDisplayName,
      parentFolderId,
      parentFolderName,
      parentFolderLink,
      rootFolderId,
      rootFolderName,
      rootFolderLink,
      canonicalLink
    });
  }

  return hierarchyMap;
}

/**
 * 将扫描出的文件/文件夹按目录树深度优先（DFS）顺序排列：
 * 父文件夹 -> 内部子文件夹（递归展开）与内部文件，使导出的 CSV 打开即呈现清晰的树状目录结构
 */
function sortItemsByHierarchyTree(items = [], existingHierarchyMap = null) {
  if (!Array.isArray(items) || items.length <= 1) return [...(items || [])];
  const hMap = existingHierarchyMap || buildDriveHierarchyInfo(items);
  const itemById = new Map(items.map(it => [it.id, it]));
  const childrenByParent = new Map();
  const rootItems = [];

  for (const it of items) {
    if (!it?.id) continue;
    const pList = Array.isArray(it.parents) ? it.parents : [];
    const parentInSet = pList.find(pid => pid !== it.id && itemById.has(pid));
    if (parentInSet) {
      if (!childrenByParent.has(parentInSet)) childrenByParent.set(parentInSet, []);
      childrenByParent.get(parentInSet).push(it);
    } else {
      rootItems.push(it);
    }
  }

  const compareSibling = (a, b) => {
    const aFolder = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    const bFolder = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  };

  rootItems.sort(compareSibling);
  for (const list of childrenByParent.values()) {
    list.sort(compareSibling);
  }

  const ordered = [];
  const visited = new Set();
  function dfs(node) {
    if (!node?.id || visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    const kids = childrenByParent.get(node.id) || [];
    for (const child of kids) {
      dfs(child);
    }
  }

  for (const r of rootItems) {
    dfs(r);
  }
  for (const it of items) {
    if (it?.id && !visited.has(it.id)) {
      dfs(it);
    }
  }
  return ordered;
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

const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_GOOGLE_AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';

function sanitizeGoogleTokenUri(uri = '') {
  if (!uri) return DEFAULT_GOOGLE_TOKEN_URI;
  try {
    const parsed = new URL(String(uri).trim());
    if (parsed.protocol !== 'https:') {
      throw new Error('OAuth token_uri 必须使用 HTTPS 协议');
    }
    const host = parsed.hostname.toLowerCase();
    const allowed =
      (host === 'oauth2.googleapis.com' && parsed.pathname.startsWith('/token')) ||
      (host === 'www.googleapis.com' && parsed.pathname.startsWith('/oauth2/')) ||
      (host === 'accounts.google.com' && parsed.pathname.startsWith('/o/oauth2/'));
    if (!allowed) {
      throw new Error(`拒绝不受信任的 OAuth token_uri 域名：${host}`);
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof Error && err.message.includes('token_uri')) throw err;
    throw new Error('无效的 OAuth token_uri 格式');
  }
}

function sanitizeGoogleAuthUri(uri = '') {
  if (!uri) return DEFAULT_GOOGLE_AUTH_URI;
  try {
    const parsed = new URL(String(uri).trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'accounts.google.com') {
      throw new Error(`拒绝不受信任的 OAuth auth_uri 域名：${parsed.hostname}`);
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof Error && err.message.includes('auth_uri')) throw err;
    throw new Error('无效的 OAuth auth_uri 格式');
  }
}

function sanitizeLoopbackRedirectUri(uri = '') {
  if (!uri) return 'http://localhost';
  try {
    const parsed = new URL(String(uri).trim());
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
  } catch (_e) {
    // fallback to default loopback URI
  }
  return 'http://localhost';
}

function pickRedirectUri(uris = []) {
  if (Array.isArray(uris)) {
    for (const u of uris) {
      try {
        const parsed = new URL(String(u).trim());
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
          return sanitizeLoopbackRedirectUri(u);
        }
      } catch (_e) {
        // ignore invalid uri candidate
      }
    }
  }
  return 'http://localhost';
}

function generateRandomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

async function computePkceChallengeS256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

const DEPRECATED_PASSPORT_ERROR_MSG =
  '已移除免授权通行证导入功能，请导入标准 Google OAuth 客户端 JSON 在浏览器中完成授权';

function isDeprecatedAuthPassportJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.bundleType === 'string' && /passport/i.test(obj.bundleType)) return true;
  if (obj.encryptedPassport) return true;
  if (obj.encrypted === true && obj.kdf && obj.cipher && typeof obj.ciphertext === 'string') return true;
  if (Array.isArray(obj.authorizedAccounts)) return true;
  if (obj.refreshToken || obj.refresh_token || obj.accessToken || obj.access_token) return true;
  return false;
}

function extractOAuthClientsFromJson(parsed, fileName = '') {
  if (!parsed || typeof parsed !== 'object') return [];
  if (isDeprecatedAuthPassportJson(parsed)) {
    throw new Error(DEPRECATED_PASSPORT_ERROR_MSG);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const clients = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    if (isDeprecatedAuthPassportJson(item)) {
      throw new Error(DEPRECATED_PASSPORT_ERROR_MSG);
    }

    // 1. 支持 Google Cloud Service Account 服务账号 JSON (如 sa-140@sa-140.iam.gserviceaccount.com)
    if (item.type === 'service_account' && item.client_email && item.private_key) {
      const clientEmail = normalizeEntry(item.client_email);
      clients.push({
        uid: `sa_${Date.now()}_${generateRandomBase64Url(6)}_${i}`,
        fileName: String(fileName || `${clientEmail.split('@')[0]}.json`),
        client_id: String(item.client_id || clientEmail).trim(),
        client_email: clientEmail,
        private_key: String(item.private_key),
        private_key_id: String(item.private_key_id || ''),
        project_id: String(item.project_id || '').trim(),
        token_uri: sanitizeGoogleTokenUri(item.token_uri),
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
        uid: `cred_${Date.now()}_${generateRandomBase64Url(6)}_${i}`,
        fileName: String(fileName || `oauth_${i + 1}.json`),
        client_id: clientId,
        client_secret: String(raw.client_secret).trim(),
        project_id: String(raw.project_id || '').trim(),
        auth_uri: sanitizeGoogleAuthUri(raw.auth_uri),
        token_uri: sanitizeGoogleTokenUri(raw.token_uri),
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

const OAUTH_DRIVE_AND_SHEETS_SCOPES =
  'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';

async function mintServiceAccountAccessToken({ clientEmail, privateKey, tokenUri }) {
  if (!clientEmail || !privateKey) {
    throw new Error('服务账号配置缺少 client_email 或 private_key');
  }
  const targetUri = sanitizeGoogleTokenUri(tokenUri);
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: OAUTH_DRIVE_AND_SHEETS_SCOPES,
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
  let tokenUri = account.tokenUri || DEFAULT_GOOGLE_TOKEN_URI;

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

  tokenUri = sanitizeGoogleTokenUri(tokenUri);

  if (!account.refreshToken || !clientId || !clientSecret) {
    throw new Error(
      `账号 ${account.email} 缺少 refreshToken 或客户端密钥，请导入标准 Google OAuth 客户端 JSON 并在浏览器中重新授权（或检查服务账号密钥 JSON）`
    );
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

  throw new Error('尚未找到可用的已授权账号令牌。请先导入 Google OAuth 客户端 JSON（或服务账号密钥 JSON）并在浏览器中完成授权。');
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
    const safeSaTokenUri = sanitizeGoogleTokenUri(client.token_uri);
    const minted = await mintServiceAccountAccessToken({
      clientEmail: email,
      privateKey: client.private_key,
      tokenUri: safeSaTokenUri
    });
    const savedAccount = await saveAuthorizedAccount({
      email,
      displayName: email.split('@')[0],
      clientId: client.client_id || email,
      isServiceAccount: true,
      privateKey: client.private_key,
      tokenUri: safeSaTokenUri,
      accessToken: minted.accessToken,
      expiresAt: Date.now() + minted.expiresIn * 1000,
      authorizedAt: new Date().toISOString()
    });
    await saveOAuthClients([{ ...client, token_uri: safeSaTokenUri, boundEmail: email }]);
    return savedAccount;
  }

  if (!client || !client.client_id || !client.client_secret) {
    throw new Error('无效的 OAuth 客户端配置（缺少 client_id 或 client_secret）');
  }

  const redirectUri = sanitizeLoopbackRedirectUri(client.redirect_uri);
  const expectedRedirect = new URL(redirectUri);
  const oauthState = `st_${generateRandomBase64Url(24)}`;
  const codeVerifier = generateRandomBase64Url(32);
  const codeChallenge = await computePkceChallengeS256(codeVerifier);
  const authEndpoint = sanitizeGoogleAuthUri(client.auth_uri);

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', OAUTH_DRIVE_AND_SHEETS_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent select_account');
  authUrl.searchParams.set('state', oauthState);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
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
      try {
        const parsedUrl = new URL(urlStr);
        const host = parsedUrl.hostname.toLowerCase();
        const isLoopback = parsedUrl.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1');
        if (!isLoopback) {
          return false;
        }
        if (expectedRedirect.port && parsedUrl.port !== expectedRedirect.port) {
          return false;
        }
        const err = parsedUrl.searchParams.get('error');
        const authCode = parsedUrl.searchParams.get('code');
        if (!err && !authCode) return false;

        const returnedState = parsedUrl.searchParams.get('state') || '';
        settled = true;
        cleanup();
        if (authTabId !== null) {
          chrome.tabs.remove(authTabId).catch(() => {});
        }
        if (returnedState !== oauthState) {
          reject(new Error('OAuth 授权回调 state 校验失败（已拦截可疑回调请求）'));
          return true;
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

  const tokenUri = sanitizeGoogleTokenUri(client.token_uri);
  const tokenRes = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
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

function sanitizeExcludedFoldersList(rawList = []) {
  const list = Array.isArray(rawList) ? rawList : [];
  const cleaned = [];
  const seenIds = new Set();
  const nowIso = new Date().toISOString();

  for (const raw of list) {
    if (!raw) continue;
    const isStr = typeof raw === 'string';
    const rawIdOrUrl = isStr
      ? raw
      : raw.id || raw.folderId || raw.url || raw.link || raw.webViewLink || '';
    const parsedId =
      typeof parseDriveUrlOrId === 'function'
        ? parseDriveUrlOrId(rawIdOrUrl).fileId
        : '';
    const id = String(parsedId || extractDriveFileId(rawIdOrUrl) || rawIdOrUrl || '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    cleaned.push({
      id,
      name: String((!isStr && (raw.name || raw.folderName)) || `排除目录 (${id.slice(0, 8)}…)`).trim(),
      webViewLink: String(
        (!isStr && raw.webViewLink) || `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
      ),
      includeSubitems: isStr ? true : raw.includeSubitems !== false,
      note: String((!isStr && raw.note) || '').trim(),
      addedAt: String((!isStr && raw.addedAt) || nowIso)
    });
  }

  return cleaned;
}

function sanitizeBlockedKeywordsList(rawInput) {
  if (rawInput === undefined || rawInput === null) {
    return [...DEFAULT_BLOCKED_APP_KEYWORDS];
  }
  const tokens = Array.isArray(rawInput)
    ? rawInput.map(x => String(x || ''))
    : String(rawInput || '').split(/[\s\r\n,，;；\t]+/);
  return [
    ...new Set(
      tokens
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

function sanitizeTrustedKeywordsList(rawInput) {
  if (rawInput === undefined || rawInput === null) {
    return [];
  }
  const tokens = Array.isArray(rawInput)
    ? rawInput.map(x => String(x || ''))
    : String(rawInput || '').split(/[\s\r\n,，;；\t]+/);
  return [
    ...new Set(
      tokens
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

async function getPolicy() {
  const data = await chrome.storage.local.get('policy');
  const saved = data.policy && typeof data.policy === 'object' ? data.policy : {};
  const rawMins = Number(saved.scheduleMinutes);
  const scheduleMinutes = Number.isFinite(rawMins) && rawMins >= 15
    ? Math.min(1440, Math.round(rawMins))
    : DEFAULT_POLICY.scheduleMinutes;
  const oauthGuardMode = saved.oauthGuardMode === 'alert' ? 'alert' : 'block';

  return {
    ...DEFAULT_POLICY,
    ...saved,
    writers: normalizeEmailList(saved.writers || []),
    readers: normalizeEmailList(saved.readers || []),
    scheduleEnabled:
      saved.scheduleEnabled !== undefined ? Boolean(saved.scheduleEnabled) : DEFAULT_POLICY.scheduleEnabled,
    scheduleMinutes,
    scanOnBrowserStartup:
      saved.scanOnBrowserStartup !== undefined
        ? Boolean(saved.scanOnBrowserStartup)
        : DEFAULT_POLICY.scanOnBrowserStartup,
    autoEnforce: Boolean(saved.autoEnforce),
    excludedFolders: sanitizeExcludedFoldersList(saved.excludedFolders || []),
    thirdPartyOAuthGuardEnabled:
      saved.thirdPartyOAuthGuardEnabled !== undefined
        ? Boolean(saved.thirdPartyOAuthGuardEnabled)
        : DEFAULT_POLICY.thirdPartyOAuthGuardEnabled,
    oauthGuardMode,
    blockThirdPartyDriveScope:
      saved.blockThirdPartyDriveScope !== undefined
        ? Boolean(saved.blockThirdPartyDriveScope)
        : DEFAULT_POLICY.blockThirdPartyDriveScope,
    blockThirdPartySheetsScope:
      saved.blockThirdPartySheetsScope !== undefined
        ? Boolean(saved.blockThirdPartySheetsScope)
        : DEFAULT_POLICY.blockThirdPartySheetsScope,
    blockedAppKeywords:
      saved.blockedAppKeywords !== undefined
        ? sanitizeBlockedKeywordsList(saved.blockedAppKeywords)
        : [...DEFAULT_BLOCKED_APP_KEYWORDS],
    trustedOAuthKeywords: sanitizeTrustedKeywordsList(saved.trustedOAuthKeywords)
  };
}

async function savePolicy(partialPolicy = {}) {
  const current = await getPolicy();
  const safePartial = partialPolicy && typeof partialPolicy === 'object' ? partialPolicy : {};
  const rawRule = safePartial.publicLinkRule !== undefined ? safePartial.publicLinkRule : current.publicLinkRule;
  const publicLinkRule = ['forbid', 'reader_only', 'allow'].includes(rawRule) ? rawRule : DEFAULT_POLICY.publicLinkRule;
  const rawMins =
    safePartial.scheduleMinutes !== undefined ? Number(safePartial.scheduleMinutes) : Number(current.scheduleMinutes);
  const scheduleMinutes = Number.isFinite(rawMins) ? Math.min(1440, Math.max(15, Math.round(rawMins))) : 720;

  const nextWriters = normalizeEmailList(
    safePartial.writers !== undefined ? safePartial.writers : current.writers || []
  );
  const writerSet = new Set(nextWriters);
  const rawReaders = safePartial.readers !== undefined ? safePartial.readers : current.readers || [];
  const nextReaders = normalizeEmailList(rawReaders.filter(item => !writerSet.has(item)));

  const nextExcludedFolders =
    safePartial.excludedFolders !== undefined
      ? sanitizeExcludedFoldersList(safePartial.excludedFolders)
      : sanitizeExcludedFoldersList(current.excludedFolders || []);

  const rawGuardMode =
    safePartial.oauthGuardMode !== undefined ? safePartial.oauthGuardMode : current.oauthGuardMode;
  const nextGuardMode = rawGuardMode === 'alert' ? 'alert' : 'block';

  const nextBlockedKeywords =
    safePartial.blockedAppKeywords !== undefined
      ? sanitizeBlockedKeywordsList(safePartial.blockedAppKeywords)
      : sanitizeBlockedKeywordsList(current.blockedAppKeywords);

  const nextTrustedKeywords =
    safePartial.trustedOAuthKeywords !== undefined
      ? sanitizeTrustedKeywordsList(safePartial.trustedOAuthKeywords)
      : sanitizeTrustedKeywordsList(current.trustedOAuthKeywords);

  const next = {
    writers: nextWriters,
    readers: nextReaders,
    publicLinkRule,
    scheduleEnabled:
      safePartial.scheduleEnabled !== undefined ? Boolean(safePartial.scheduleEnabled) : Boolean(current.scheduleEnabled),
    scheduleMinutes,
    scanOnBrowserStartup:
      safePartial.scanOnBrowserStartup !== undefined
        ? Boolean(safePartial.scanOnBrowserStartup)
        : Boolean(current.scanOnBrowserStartup),
    autoEnforce:
      safePartial.autoEnforce !== undefined ? Boolean(safePartial.autoEnforce) : Boolean(current.autoEnforce),
    excludedFolders: nextExcludedFolders,
    thirdPartyOAuthGuardEnabled:
      safePartial.thirdPartyOAuthGuardEnabled !== undefined
        ? Boolean(safePartial.thirdPartyOAuthGuardEnabled)
        : Boolean(current.thirdPartyOAuthGuardEnabled),
    oauthGuardMode: nextGuardMode,
    blockThirdPartyDriveScope:
      safePartial.blockThirdPartyDriveScope !== undefined
        ? Boolean(safePartial.blockThirdPartyDriveScope)
        : Boolean(current.blockThirdPartyDriveScope),
    blockThirdPartySheetsScope:
      safePartial.blockThirdPartySheetsScope !== undefined
        ? Boolean(safePartial.blockThirdPartySheetsScope)
        : Boolean(current.blockThirdPartySheetsScope),
    blockedAppKeywords: nextBlockedKeywords,
    trustedOAuthKeywords: nextTrustedKeywords
  };
  await safeStorageSet({ policy: next });
  return next;
}

async function getSnapshot() {
  const data = await chrome.storage.local.get('scanSnapshot');
  const snap = data.scanSnapshot || {
    lastScanAt: '',
    lastScanSource: '',
    accountEmail: '',
    files: [],
    knownFileIds: [],
    newFileIds: [],
    permFingerprints: {},
    permDiffs: {}
  };
  if (!snap.permFingerprints || typeof snap.permFingerprints !== 'object') {
    snap.permFingerprints = {};
  }
  if (!snap.permDiffs || typeof snap.permDiffs !== 'object') {
    snap.permDiffs = {};
  }
  if (Array.isArray(snap.files) && snap.files.length > 0) {
    hydrateFilesPermissionDiffs(snap.files, snap.permDiffs);
  }
  return snap;
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
    webViewLink: formatDriveCanonicalLink(f),
    parents: Array.isArray(f.parents) ? f.parents : [],
    createdTime: f.createdTime || '',
    modifiedTime: f.modifiedTime || '',
    viewedByMeTime: f.viewedByMeTime || '',
    writersCanShare: f.writersCanShare !== false,
    copyRequiresWriterPermission: Boolean(f.copyRequiresWriterPermission),
    contentLocked: Boolean(f.contentLocked || f.contentRestrictions?.some(r => r?.readOnly)),
    contentLockReason:
      f.contentLockReason || f.contentRestrictions?.find(r => r?.readOnly)?.reason || '',
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
          const details = Array.isArray(p.permissionDetails) ? p.permissionDetails : [];
          const inherited = Boolean(p._inherited || details.some(d => d.inherited));
          const hasDirectOverride = Boolean(
            p._hasDirectOverride || (details.length > 0 && details.some(d => d.inherited === false))
          );
          let inheritedRole = p._inheritedRole || '';
          if (!inheritedRole && details.length > 0) {
            for (const d of details) {
              if (d.inherited && d.role && permissionRoleRank(d.role) > permissionRoleRank(inheritedRole)) {
                inheritedRole = d.role;
              }
            }
          }
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
          if (hasDirectOverride) cp._hasDirectOverride = true;
          if (inheritedRole) cp._inheritedRole = inheritedRole;
          return cp;
        })
      : []
  }));

  const knownIds = Array.isArray(snapshot.knownFileIds) ? snapshot.knownFileIds : [];
  const rawFingerprints =
    snapshot.permFingerprints && typeof snapshot.permFingerprints === 'object' ? snapshot.permFingerprints : {};
  const rawDiffs = snapshot.permDiffs && typeof snapshot.permDiffs === 'object' ? snapshot.permDiffs : {};

  let compactFingerprints = rawFingerprints;
  let compactDiffs = rawDiffs;
  if (maxFiles > 0 && rawFiles.length > maxFiles) {
    const keptSet = new Set(sliceFiles.map(f => f?.id).filter(Boolean));
    compactFingerprints = {};
    compactDiffs = {};
    for (const id of keptSet) {
      if (rawFingerprints[id]) compactFingerprints[id] = rawFingerprints[id];
      if (rawDiffs[id]) compactDiffs[id] = rawDiffs[id];
    }
  }

  return {
    lastScanAt: snapshot.lastScanAt || '',
    lastScanSource: snapshot.lastScanSource || '',
    accountEmail: snapshot.accountEmail || '',
    files: compactFiles,
    knownFileIds: maxFiles > 0 && knownIds.length > maxFiles * 2 ? knownIds.slice(-maxFiles * 2) : knownIds,
    newFileIds: Array.isArray(snapshot.newFileIds) ? snapshot.newFileIds.slice(0, 5000) : [],
    permFingerprints: compactFingerprints,
    permDiffs: compactDiffs
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

/* ==================== Drive API 请求封装（含 AIMD 全局自适应平滑控速器） ==================== */

const globalWritePacer = {
  minIntervalMs: 95, // 初始写间隔 95ms (~10.5 req/s)，随成功自动下探至 60ms，遇 403 自动上调至 240ms
  nextAllowedAt: 0,
  consecutiveOk: 0
};

async function acquireWriteSlot() {
  const now = Date.now();
  const scheduled = Math.max(now, globalWritePacer.nextAllowedAt);
  globalWritePacer.nextAllowedAt = scheduled + globalWritePacer.minIntervalMs;
  const waitMs = scheduled - now;
  if (waitMs > 2) {
    await new Promise(r => setTimeout(r, waitMs));
  }
}

function reportWriteSuccess() {
  globalWritePacer.consecutiveOk++;
  if (globalWritePacer.consecutiveOk >= 8 && globalWritePacer.minIntervalMs > 60) {
    globalWritePacer.minIntervalMs = Math.max(60, globalWritePacer.minIntervalMs - 4);
    globalWritePacer.consecutiveOk = 0;
  }
}

function reportWriteRateLimit() {
  globalWritePacer.consecutiveOk = 0;
  globalWritePacer.minIntervalMs = Math.min(240, Math.round(globalWritePacer.minIntervalMs * 1.25) + 18);
}

async function driveApi(token, path, options = {}, retry = 0) {
  const method = String(options.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite) {
    await acquireWriteSlot();
  }

  const response = await fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if ((response.status === 429 || response.status === 403 || response.status >= 500) && retry < 8) {
    const body = await response.clone().json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason;
    if (
      response.status !== 429 &&
      response.status < 500 &&
      !['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'].includes(reason)
    ) {
      throw new Error(body?.error?.message || `Drive API 错误 ${response.status}`);
    }
    if (isWrite) {
      reportWriteRateLimit();
    }
    const waitMs = Math.min(260 * 1.5 ** retry + Math.random() * 150, 4500);
    await new Promise(r => setTimeout(r, waitMs));
    return driveApi(token, path, options, retry + 1);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Drive API 错误 ${response.status}`);
  }
  if (isWrite) {
    reportWriteSuccess();
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

const PERMISSION_ROLE_RANKS = {
  owner: 50,
  organizer: 45,
  fileOrganizer: 40,
  writer: 30,
  commenter: 20,
  reader: 10
};

function permissionRoleRank(role = '') {
  return PERMISSION_ROLE_RANKS[role] || 0;
}

function permIsInherited(permission) {
  return Boolean(permission?._inherited || (permission?.permissionDetails || []).some(detail => detail.inherited));
}

function permHasDirectGrant(permission) {
  if (!permission) return false;
  const details = Array.isArray(permission.permissionDetails) ? permission.permissionDetails : [];
  if (details.length > 0) {
    return details.some(detail => detail.inherited === false);
  }
  if (permission._hasDirectOverride) return true;
  return !Boolean(permission._inherited);
}

function getMaxInheritedRole(permission) {
  if (!permission) return '';
  if (permission._inheritedRole) return permission._inheritedRole;
  const details = Array.isArray(permission.permissionDetails) ? permission.permissionDetails : [];
  let best = '';
  for (const detail of details) {
    if (detail.inherited && detail.role && permissionRoleRank(detail.role) > permissionRoleRank(best)) {
      best = detail.role;
    }
  }
  if (!best && details.length > 0 && details.every(detail => detail.inherited)) {
    return permission.role || '';
  }
  if (!best && permission._inherited && !permission._hasDirectOverride) {
    return permission.role || '';
  }
  return best;
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

function evaluateFile(file, policy, fallbackOwnerEmail = '', excludedIdSet = null) {
  const ownerEmail = file?.ownerAccount || file?.owners?.[0]?.emailAddress || fallbackOwnerEmail;
  const perms = file?.permissions || [];
  const excludedList = policy?.excludedFolders || [];
  if (
    (excludedList.length > 0 || (excludedIdSet instanceof Set && excludedIdSet.size > 0)) &&
    isFileInExcludedFolders(file, excludedList, excludedIdSet)
  ) {
    let exHasNonOwner = false;
    let exHasPublic = false;
    for (const p of perms) {
      if (!p) continue;
      const em = normalizeEntry(p.emailAddress || '');
      if (p.role !== 'owner' && (!em || em !== normalizeEntry(ownerEmail))) {
        exHasNonOwner = true;
      }
      if (p.type === 'anyone' || p.type === 'domain') {
        exHasPublic = true;
      }
    }
    return {
      hasNonOwner: exHasNonOwner,
      hasPublic: exHasPublic,
      removeCount: 0,
      downgradeCount: 0,
      inheritedIssueCount: 0,
      hasActionableViolation: false,
      isExcluded: true
    };
  }

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
    hasActionableViolation: removeCount > 0 || downgradeCount > 0,
    isExcluded: false
  };
}

function setFileInheritanceBreakage(file, info) {
  if (!file || typeof file !== 'object') return;
  try {
    Object.defineProperty(file, '_inheritanceBreakage', {
      value: info || null,
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (_e) {
    // 忽略只读对象异常
  }
}

function getFileInheritanceBreakage(file, breakageMap = null) {
  if (!file || typeof file !== 'object') return null;
  if (breakageMap instanceof Map && file.id) {
    return breakageMap.get(file.id) || null;
  }
  return file._inheritanceBreakage || null;
}

/**
 * 子文件权限逃逸 / 继承断链检测：
 * 识别子文件或子目录权限宽于上级父文件夹（如额外开启公开/域内链接、单独新增外部协作者、或将只读成员单独提权为可编辑）
 * 返回 Map<fileId, { fileId, broken: true, parentId, parentName, escapedCount, escapedPermissions, summaryText }>
 */
function analyzeInheritanceBreakage(files = []) {
  const breakageMap = new Map();
  if (!Array.isArray(files) || !files.length) return breakageMap;

  const fileById = new Map();
  for (const f of files) {
    if (f && f.id) {
      fileById.set(f.id, f);
      setFileInheritanceBreakage(f, null);
    }
  }

  for (const file of files) {
    if (!file || !file.id || file.permissionsLoading) continue;
    const perms = Array.isArray(file.permissions) ? file.permissions : [];
    if (!perms.length) continue;

    const parentId = Array.isArray(file.parents) && file.parents[0] ? String(file.parents[0]) : '';
    const parentFile = parentId ? fileById.get(parentId) || null : null;
    const fileOwner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    const escapedPermissions = [];

    if (parentFile && Array.isArray(parentFile.permissions) && !parentFile.permissionsLoading) {
      let parentAnyonePerm = null;
      const parentDomainPerms = new Map();
      const parentUserPerms = new Map();

      const parentOwner = normalizeEntry(parentFile.ownerAccount || parentFile.owners?.[0]?.emailAddress || '');
      if (parentOwner) {
        parentUserPerms.set(parentOwner, { role: 'owner', type: 'user', emailAddress: parentOwner });
      }

      for (const pp of parentFile.permissions) {
        if (!pp) continue;
        if (pp.type === 'anyone') {
          if (!parentAnyonePerm || permissionRoleRank(pp.role) > permissionRoleRank(parentAnyonePerm.role)) {
            parentAnyonePerm = pp;
          }
        } else if (pp.type === 'domain') {
          const dKey = String(pp.domain || '').trim().toLowerCase();
          const prev = parentDomainPerms.get(dKey);
          if (!prev || permissionRoleRank(pp.role) > permissionRoleRank(prev.role)) {
            parentDomainPerms.set(dKey, pp);
          }
        } else if (pp.type === 'user' || pp.type === 'group') {
          const em = normalizeEntry(pp.emailAddress || '');
          if (em) {
            const prev = parentUserPerms.get(em);
            if (!prev || permissionRoleRank(pp.role) > permissionRoleRank(prev.role)) {
              parentUserPerms.set(em, pp);
            }
          }
        }
      }

      for (const p of perms) {
        if (!p) continue;
        const em = normalizeEntry(p.emailAddress || '');
        if (p.role === 'owner' || (em && em === fileOwner)) continue;

        if (p.type === 'anyone') {
          if (!parentAnyonePerm) {
            if (!permIsInherited(p) || permHasDirectGrant(p)) {
              escapedPermissions.push({
                permission: p,
                reason: '父文件夹未开启公开链接，子项单独开启了任何人访问',
                suggestedAction: 'remove',
                targetRole: null
              });
            }
          } else if (permissionRoleRank(p.role) > permissionRoleRank(parentAnyonePerm.role)) {
            escapedPermissions.push({
              permission: p,
              reason: `公开链接权限高于父文件夹（子项：${roleLabel(p.role)}，父目录：${roleLabel(parentAnyonePerm.role)}）`,
              suggestedAction: 'downgrade',
              targetRole: parentAnyonePerm.role
            });
          }
        } else if (p.type === 'domain') {
          const dKey = String(p.domain || '').trim().toLowerCase();
          const pDom = parentDomainPerms.get(dKey) || null;
          let effectiveParentLink = pDom;
          if (
            parentAnyonePerm &&
            (!effectiveParentLink || permissionRoleRank(parentAnyonePerm.role) > permissionRoleRank(effectiveParentLink.role))
          ) {
            effectiveParentLink = parentAnyonePerm;
          }

          if (!effectiveParentLink) {
            if (!permIsInherited(p) || permHasDirectGrant(p)) {
              escapedPermissions.push({
                permission: p,
                reason: `父文件夹未开启域内共享 (${p.domain || '未知域'})，子项单独开启`,
                suggestedAction: 'remove',
                targetRole: null
              });
            }
          } else if (permissionRoleRank(p.role) > permissionRoleRank(effectiveParentLink.role)) {
            escapedPermissions.push({
              permission: p,
              reason: `域内链接权限高于父文件夹（子项：${roleLabel(p.role)}，父目录：${roleLabel(effectiveParentLink.role)}）`,
              suggestedAction: 'downgrade',
              targetRole: effectiveParentLink.role
            });
          }
        } else if (p.type === 'user' || p.type === 'group') {
          const parentPerm = em ? parentUserPerms.get(em) : null;
          if (!parentPerm) {
            if (!permIsInherited(p) || permHasDirectGrant(p)) {
              escapedPermissions.push({
                permission: p,
                reason: `父文件夹无此协作者 (${em || permissionLabel(p)})，子项单独授予了${roleLabel(p.role)}权限`,
                suggestedAction: 'remove',
                targetRole: null
              });
            }
          } else if (permissionRoleRank(p.role) > permissionRoleRank(parentPerm.role)) {
            escapedPermissions.push({
              permission: p,
              reason: `协作者 ${em} 在父文件夹为${roleLabel(parentPerm.role)}，在子项被单独提权为${roleLabel(p.role)}`,
              suggestedAction: 'downgrade',
              targetRole: parentPerm.role
            });
          }
        }
      }
    } else {
      // 父文件夹不在当前扫描快照中：基于 permissionDetails 的继承与非继承混合特征检测逃逸
      const hasAnyInherited = perms.some(p => permIsInherited(p));
      for (const p of perms) {
        if (!p) continue;
        const em = normalizeEntry(p.emailAddress || '');
        if (p.role === 'owner' || (em && em === fileOwner)) continue;

        const inheritedRole = getMaxInheritedRole(p);
        if (
          permIsInherited(p) &&
          permHasDirectGrant(p) &&
          inheritedRole &&
          permissionRoleRank(p.role) > permissionRoleRank(inheritedRole)
        ) {
          escapedPermissions.push({
            permission: p,
            reason: `${em || permissionLabel(p)} 继承角色为${roleLabel(inheritedRole)}，在子项被单独提权为${roleLabel(p.role)}`,
            suggestedAction: 'downgrade',
            targetRole: inheritedRole
          });
        } else if (hasAnyInherited && !permIsInherited(p)) {
          if (p.type === 'anyone' || p.type === 'domain') {
            escapedPermissions.push({
              permission: p,
              reason: '子项在继承父目录权限之外单独开启了公开或域内链接',
              suggestedAction: 'remove',
              targetRole: null
            });
          } else if (p.type === 'user' || p.type === 'group') {
            escapedPermissions.push({
              permission: p,
              reason: `子项在继承父目录权限之外单独添加了协作者 (${em || permissionLabel(p)})`,
              suggestedAction: 'remove',
              targetRole: null
            });
          }
        }
      }
    }

    if (escapedPermissions.length > 0) {
      const parentName = parentFile?.name || (parentId ? '上级文件夹' : '继承目录');
      const removeNum = escapedPermissions.filter(x => x.suggestedAction === 'remove').length;
      const downgradeNum = escapedPermissions.filter(x => x.suggestedAction === 'downgrade').length;
      const summaryParts = [];
      if (removeNum > 0) summaryParts.push(`多出 ${removeNum} 项独立授权`);
      if (downgradeNum > 0) summaryParts.push(`${downgradeNum} 项高于父目录`);
      const entry = {
        fileId: file.id,
        broken: true,
        parentId,
        parentName,
        escapedCount: escapedPermissions.length,
        escapedPermissions,
        summaryText: `${summaryParts.join(' · ')}（父目录：${parentName}）`
      };
      breakageMap.set(file.id, entry);
      setFileInheritanceBreakage(file, entry);
    }
  }

  return breakageMap;
}

function computeSummary(files = [], policy = DEFAULT_POLICY, ownerEmail = '', newFileIdSet = new Set()) {
  const safeFiles = Array.isArray(files) ? files : [];
  const excludedList = policy?.excludedFolders || [];
  const excludedSet =
    excludedList.length > 0 ? buildExcludedFileIdSet(safeFiles, excludedList) : new Set();
  const effectiveFiles =
    excludedList.length > 0 || excludedSet.size > 0
      ? safeFiles.filter(f => f && !isFileInExcludedFolders(f, excludedList, excludedSet))
      : safeFiles;

  let total = effectiveFiles.length;
  let shared = 0;
  let newFiles = 0;
  let unauthorizedFiles = 0;
  let overprivilegedFiles = 0;
  let publicFiles = 0;
  let actionablePermissions = 0;
  let anomalousFiles = 0;
  let changedFiles = 0;
  let riskIncreasedFiles = 0;

  for (const file of effectiveFiles) {
    if (file.isNew || newFileIdSet.has(file.id)) {
      newFiles++;
    }
    const diffInfo = getFilePermissionDiff(file);
    if (diffInfo || file.hasPermDiff) {
      changedFiles++;
      if (diffInfo?.riskIncreased) {
        riskIncreasedFiles++;
      }
    }
    const stat = evaluateFile(file, policy, ownerEmail, excludedSet);
    if (stat.isExcluded) continue;
    if (stat.hasNonOwner) shared++;
    if (stat.hasPublic) publicFiles++;
    if (stat.removeCount > 0) unauthorizedFiles++;
    if (stat.downgradeCount > 0) overprivilegedFiles++;
    if (stat.hasActionableViolation) anomalousFiles++;
    actionablePermissions += stat.removeCount + stat.downgradeCount;
  }

  const breakageMap = analyzeInheritanceBreakage(effectiveFiles);

  return {
    total,
    shared,
    newFiles,
    unauthorizedFiles,
    overprivilegedFiles,
    anomalousFiles,
    publicFiles,
    actionablePermissions,
    inheritanceBrokenFiles: breakageMap.size,
    changedFiles,
    riskIncreasedFiles
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
 * 一键对齐父目录权限：清理子文件/子目录逃逸的独立权限或将其角色降回与父目录一致
 */
async function alignFilesToParentPermissions({
  files = [],
  breakageMap = null,
  shouldStop = null,
  retryQueue = null,
  onProgress = null
} = {}) {
  const fileById = new Map();
  for (const f of files || []) {
    if (f && f.id) fileById.set(f.id, f);
  }

  const queue = [];
  if (Array.isArray(retryQueue)) {
    for (const item of retryQueue) {
      if (!item || !item.fileId || !item.permissionId) continue;
      const liveFile = fileById.get(item.fileId) || null;
      const livePerm =
        liveFile && Array.isArray(liveFile.permissions)
          ? liveFile.permissions.find(p => p.id === item.permissionId) || null
          : null;
      queue.push({
        file: liveFile || {
          id: item.fileId,
          name: item.fileName || '(无名称)',
          webViewLink: item.webViewLink || '',
          ownerAccount: item.fileOwner || '',
          permissions: livePerm ? [livePerm] : []
        },
        fileOwner: item.fileOwner || normalizeEntry(liveFile?.ownerAccount || liveFile?.owners?.[0]?.emailAddress || ''),
        parentName: item.parentName || '父文件夹',
        permission: livePerm || item.permission || {
          id: item.permissionId,
          type: item.targetType || 'user',
          role: item.previousRole || 'writer',
          emailAddress: item.targetEmail || '',
          domain: item.domain || ''
        },
        suggestedAction: item.suggestedAction || 'remove',
        targetRole: item.targetRole || 'reader',
        reason: item.reason || '对齐父目录权限'
      });
    }
  } else {
    const activeMap = breakageMap instanceof Map ? breakageMap : analyzeInheritanceBreakage(files);
    for (const file of files || []) {
      if (!file || !file.id) continue;
      const info = activeMap.get(file.id);
      if (!info || !Array.isArray(info.escapedPermissions) || !info.escapedPermissions.length) continue;
      const fileOwner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
      for (const esc of info.escapedPermissions) {
        if (!esc?.permission?.id) continue;
        queue.push({
          file,
          fileOwner,
          parentName: info.parentName || '父文件夹',
          permission: esc.permission,
          suggestedAction: esc.suggestedAction || 'remove',
          targetRole: esc.targetRole || 'reader',
          reason: esc.reason || '对齐父目录权限'
        });
      }
    }
  }

  let removedCount = 0;
  let downgradedCount = 0;
  let failedCount = 0;
  let stopped = false;
  const alignedFileSet = new Set();
  const failedItems = [];
  const logs = [];
  let cursor = 0;

  const tokenCache = new Map();
  async function resolveToken(ownerEmail) {
    const key = normalizeEntry(ownerEmail);
    if (tokenCache.has(key)) return tokenCache.get(key);
    const t = await getValidTokenForAccount(key, true);
    tokenCache.set(key, t);
    return t;
  }

  const workerCount = Math.min(4, Math.max(1, queue.length));
  const workers = Array.from({ length: queue.length ? workerCount : 0 }, async () => {
    while (cursor < queue.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const item = queue[cursor++];
      const { file, fileOwner, parentName, permission, suggestedAction, targetRole, reason } = item;
      const targetLabel = permissionLabel(permission);
      try {
        const token = await resolveToken(fileOwner);
        if (suggestedAction === 'remove') {
          await deletePermission(token, file.id, permission.id);
          if (Array.isArray(file.permissions)) {
            file.permissions = file.permissions.filter(p => p.id !== permission.id);
          }
          removedCount++;
          alignedFileSet.add(file.id);
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: permission.id,
            targetType: permission.type || 'user',
            targetEmail: permission.emailAddress || '',
            domain: permission.domain || '',
            targetLabel,
            previousRole: permission.role || '',
            newRole: '',
            restored: false,
            message: `对齐父目录《${parentName}》：移除逃逸权限 ${targetLabel}（原角色：${roleLabel(permission.role)}）`
          });
        } else if (suggestedAction === 'downgrade') {
          const prevRole = permission.role;
          await updatePermissionRole(token, file.id, permission.id, targetRole);
          permission.role = targetRole;
          permission._hasDirectOverride = false;
          if (Array.isArray(permission.permissionDetails)) {
            permission.permissionDetails = permission.permissionDetails.filter(d => d.inherited);
          }
          downgradedCount++;
          alignedFileSet.add(file.id);
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'downgrade',
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: permission.id,
            targetType: permission.type || 'user',
            targetEmail: permission.emailAddress || '',
            domain: permission.domain || '',
            targetLabel,
            previousRole: prevRole,
            newRole: targetRole,
            restored: false,
            message: `对齐父目录《${parentName}》：将 ${targetLabel} 从${roleLabel(prevRole)}降回${roleLabel(targetRole)}`
          });
        }
      } catch (error) {
        failedCount++;
        const errMsg = error?.message || String(error);
        failedItems.push({
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          fileOwner,
          parentName,
          permissionId: permission.id,
          targetType: permission.type || 'user',
          targetEmail: permission.emailAddress || '',
          domain: permission.domain || '',
          previousRole: permission.role || '',
          permission: {
            id: permission.id,
            type: permission.type || 'user',
            role: permission.role || '',
            emailAddress: permission.emailAddress || '',
            domain: permission.domain || '',
            displayName: permission.displayName || ''
          },
          suggestedAction,
          targetRole,
          reason,
          errorMessage: errMsg
        });
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'error',
          accountEmail: fileOwner,
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          permissionId: permission.id,
          targetType: permission.type || 'user',
          targetEmail: permission.emailAddress || '',
          targetLabel,
          previousRole: permission.role || '',
          newRole: '',
          restored: false,
          message: `对齐父目录失败 (${targetLabel})：${errMsg}`
        });
      }

      if (onProgress) {
        onProgress({
          done: removedCount + downgradedCount + failedCount,
          total: queue.length,
          removedCount,
          downgradedCount,
          failedCount,
          stopped
        });
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) {
    await appendAuditLogs(logs);
  }
  if (Array.isArray(files) && files.length > 0) {
    analyzeInheritanceBreakage(files);
  }

  return {
    alignedFilesCount: alignedFileSet.size,
    removedCount,
    downgradedCount,
    failedCount,
    total: queue.length,
    stopped,
    failedItems,
    logs
  };
}

/**
 * 按选定的「邮箱分组」对多个文件批量执行授权 / 对齐 / 撤权
 * mode:
 * - 'grant': 给所选组全体成员开通指定角色（若写成 'group_default' 则按各组默认角色）
 * - 'keep_only_groups': 仅保留所选组成员权限（同时为组内未授权成员补齐权限），移除组外其他直接协作者
 * - 'revoke_groups': 从所选文件中移除所选组全部成员的直接权限
 */
async function executeGroupBatchOnFiles({
  files = [],
  groupNames = [],
  mode = 'grant',
  roleOption = 'group_default',
  directory = DEFAULT_DIRECTORY,
  expiresAt = '',
  expireAction = 'revoke',
  onProgress = null,
  shouldStop = null,
  retryQueue = null
}) {
  const validExpiresAt =
    expiresAt && Number.isFinite(Date.parse(expiresAt)) ? new Date(Date.parse(expiresAt)).toISOString() : '';

  const fileById = new Map();
  for (const f of files || []) {
    if (f && f.id) fileById.set(f.id, f);
  }

  const operations = [];
  if (Array.isArray(retryQueue)) {
    for (const item of retryQueue) {
      if (!item || !item.fileId || !item.type) continue;
      const liveFile =
        fileById.get(item.fileId) ||
        item.file || {
          id: item.fileId,
          name: item.fileName || '(无名称)',
          mimeType: item.mimeType || '',
          webViewLink: item.webViewLink || '',
          ownerAccount: item.fileOwner || '',
          permissions: []
        };
      const livePerm =
        item.permissionId && Array.isArray(liveFile.permissions)
          ? liveFile.permissions.find(p => p.id === item.permissionId) || item.permission
          : item.permission || null;
      operations.push({
        type: item.type,
        file: liveFile,
        fileOwner: item.fileOwner || normalizeEntry(liveFile.ownerAccount || liveFile.owners?.[0]?.emailAddress || ''),
        permission: livePerm,
        email: item.email || '',
        name: item.name || item.email || '',
        role: item.role || 'reader',
        groupTitle: item.groupTitle || '',
        expiresAt: item.expiresAt || validExpiresAt,
        expireAction: item.expireAction || expireAction || 'revoke'
      });
    }
  } else {
    const groupSet = new Set(groupNames || []);
    const groupObjMap = new Map();
    for (const g of directory?.groups || []) {
      groupObjMap.set(g.name, g);
    }

    // 计算目标成员及其目标角色（多组重叠时优先级 writer > commenter > reader）
    const targetMemberRole = new Map();
    const targetMemberName = new Map();
    for (const c of directory?.contacts || []) {
      const matchedGroups = (c.groups || []).filter(g => groupSet.has(g));
      if (!matchedGroups.length) continue;
      const email = normalizeEntry(c.email);
      if (!email) continue;
      targetMemberName.set(email, c.name || email);

      let desiredRole = 'reader';
      if (roleOption === 'writer' || roleOption === 'commenter' || roleOption === 'reader') {
        desiredRole = roleOption;
      } else {
        // roleOption === 'group_default'：优先按成员在该组的 c.groupRoles?.[g] || c.role || group.defaultRole 计算
        let bestRank = 0;
        for (const gName of matchedGroups) {
          const grp = groupObjMap.get(gName);
          const candidate = getEffectiveMemberRoleInGroup(c, gName, grp);
          const rank = permissionRoleRank(candidate);
          if (rank > bestRank) {
            bestRank = rank;
            desiredRole = candidate;
          }
        }
      }
      const existingTargetRole = targetMemberRole.get(email);
      if (existingTargetRole && permissionRoleRank(existingTargetRole) > permissionRoleRank(desiredRole)) {
        desiredRole = existingTargetRole;
      }
      targetMemberRole.set(email, desiredRole);
    }

    for (const file of files || []) {
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
              role: desiredRole,
              expiresAt: validExpiresAt,
              expireAction: expireAction || 'revoke'
            });
          } else if (
            !permIsInherited(existing) &&
            existing.role !== 'owner' &&
            (existing.role !== desiredRole || Boolean(validExpiresAt))
          ) {
            operations.push({
              type: 'update',
              file,
              fileOwner,
              permission: existing,
              email,
              name: targetMemberName.get(email),
              role: desiredRole,
              expiresAt: validExpiresAt,
              expireAction: expireAction || 'revoke'
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
  }

  let createdCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  let failedCount = 0;
  let stopped = false;
  const failedItems = [];
  const ttlBatchToEnqueue = [];
  const logs = [];
  let cursor = 0;

  const tokenCache = new Map();
  async function getToken(owner) {
    if (tokenCache.has(owner)) return tokenCache.get(owner);
    const t = await getValidTokenForAccount(owner, true);
    tokenCache.set(owner, t);
    return t;
  }

  const defaultGroupTitle = (groupNames || []).join('、') || '分组操作';

  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < operations.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const op = operations[cursor++];
      const { file, fileOwner } = op;
      const groupTitle = op.groupTitle || defaultGroupTitle;
      const activeExpiresAt = op.expiresAt || '';
      const activeExpireAction = op.expireAction || expireAction || 'revoke';
      try {
        const token = await getToken(fileOwner);
        if (op.type === 'create') {
          let created = null;
          let nativeExpirationApplied = false;
          if (activeExpiresAt) {
            const grantRes = await grantPermissionCoreApi(token, file, file.id, {
              type: 'user',
              role: op.role,
              emailAddress: op.email,
              expiresAt: activeExpiresAt
            });
            created = grantRes.createdPermission;
            nativeExpirationApplied = grantRes.nativeExpirationApplied;
          } else {
            created = await createPermission(token, file.id, {
              type: 'user',
              role: op.role,
              emailAddress: op.email
            });
          }
          const createdId = created?.id || `grp-${Date.now()}-${Math.random()}`;
          file.permissions = file.permissions || [];
          file.permissions.push({
            id: createdId,
            type: 'user',
            role: op.role,
            emailAddress: op.email,
            displayName: op.name
          });
          if (activeExpiresAt) {
            ttlBatchToEnqueue.push({
              fileId: file.id,
              fileName: file.name || '(无名称)',
              mimeType: file.mimeType || '',
              webViewLink: file.webViewLink || '',
              accountEmail: fileOwner,
              permissionId: created?.id || '',
              targetType: 'user',
              targetEmail: op.email,
              targetLabel: `[${groupTitle}] ${op.name} (${op.email})`,
              grantedRole: op.role,
              expireAction: activeExpireAction,
              expiresAt: activeExpiresAt,
              nativeExpirationApplied
            });
          }
          createdCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            isTtl: Boolean(activeExpiresAt),
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
            message: `按组【${groupTitle}】批量授予「${roleLabel(op.role)}」权限${
              activeExpiresAt ? `（限时：${formatTtlRemaining(activeExpiresAt)}）` : ''
            }`
          });
        } else if (op.type === 'update') {
          const prevRole = op.permission.role;
          if (prevRole !== op.role) {
            await updatePermissionRole(token, file.id, op.permission.id, op.role);
            op.permission.role = op.role;
          }
          if (activeExpiresAt) {
            ttlBatchToEnqueue.push({
              fileId: file.id,
              fileName: file.name || '(无名称)',
              mimeType: file.mimeType || '',
              webViewLink: file.webViewLink || '',
              accountEmail: fileOwner,
              permissionId: op.permission.id,
              targetType: op.permission.type || 'user',
              targetEmail: op.email,
              targetLabel: `[${groupTitle}] ${op.name} (${op.email})`,
              grantedRole: op.role,
              expireAction: activeExpireAction,
              expiresAt: activeExpiresAt,
              nativeExpirationApplied: false
            });
          }
          updatedCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'downgrade',
            isTtl: Boolean(activeExpiresAt),
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
            message: `按组【${groupTitle}】调整角色：${roleLabel(prevRole)} -> ${roleLabel(op.role)}${
              activeExpiresAt ? `（限时：${formatTtlRemaining(activeExpiresAt)}）` : ''
            }`
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
        failedItems.push({
          type: op.type,
          fileId: file.id,
          fileName: file.name || '(无名称)',
          mimeType: file.mimeType || '',
          webViewLink: file.webViewLink || '',
          fileOwner,
          permissionId: op.permission?.id || '',
          permission: op.permission
            ? {
                id: op.permission.id,
                type: op.permission.type,
                role: op.permission.role,
                emailAddress: op.permission.emailAddress || '',
                domain: op.permission.domain || ''
              }
            : null,
          email: op.email || '',
          name: op.name || '',
          role: op.role || '',
          groupTitle,
          expiresAt: activeExpiresAt,
          expireAction: activeExpireAction,
          errorMessage: error?.message || String(error)
        });
      }

      if (onProgress) {
        onProgress({
          done: createdCount + updatedCount + removedCount + failedCount,
          total: operations.length,
          createdCount,
          updatedCount,
          removedCount,
          failedCount,
          stopped
        });
      }
    }
  });

  await Promise.all(workers);
  if (ttlBatchToEnqueue.length) {
    await enqueueTtlPermissions(ttlBatchToEnqueue);
  }
  if (logs.length) await appendAuditLogs(logs);
  return {
    createdCount,
    updatedCount,
    removedCount,
    failedCount,
    total: operations.length,
    stopped,
    failedItems
  };
}

async function executeGroupBatchOperation(options = {}) {
  return executeGroupBatchOnFiles(options);
}

/**
 * 直接对传入的文件/文件夹列表批量授予或撤除指定邮箱集合的权限
 * 支持 'reader' | 'commenter' | 'writer' 角色、TTL 限时授权、暂停/取消与失败项重试
 */
async function executeDirectEmailsBatchOnFiles({
  files = [],
  emails = [],
  mode = 'grant',
  role = 'reader',
  expiresAt = '',
  expireAction = 'revoke',
  onProgress = null,
  shouldStop = null,
  retryQueue = null
} = {}) {
  const cleanRole = normalizePermissionRole(role, 'reader') || 'reader';
  const validExpiresAt =
    expiresAt && Number.isFinite(Date.parse(expiresAt)) ? new Date(Date.parse(expiresAt)).toISOString() : '';

  const fileById = new Map();
  for (const f of files || []) {
    if (f && f.id) fileById.set(f.id, f);
  }

  let contactLookup = null;
  try {
    const dir = await getDirectory();
    contactLookup = buildContactLookup(dir);
  } catch (_e) {
    contactLookup = null;
  }

  const operations = [];
  if (Array.isArray(retryQueue)) {
    for (const item of retryQueue) {
      if (!item || !item.fileId || !item.type) continue;
      const liveFile =
        fileById.get(item.fileId) ||
        item.file || {
          id: item.fileId,
          name: item.fileName || '(无名称)',
          mimeType: item.mimeType || '',
          webViewLink: item.webViewLink || '',
          ownerAccount: item.fileOwner || '',
          permissions: []
        };
      const livePerm =
        item.permissionId && Array.isArray(liveFile.permissions)
          ? liveFile.permissions.find(p => p.id === item.permissionId) || item.permission
          : item.permission || null;
      operations.push({
        type: item.type,
        file: liveFile,
        fileOwner: item.fileOwner || normalizeEntry(liveFile.ownerAccount || liveFile.owners?.[0]?.emailAddress || ''),
        permission: livePerm,
        email: normalizeEntry(item.email || ''),
        name: item.name || item.email || '',
        role: normalizePermissionRole(item.role, cleanRole) || cleanRole,
        expiresAt: item.expiresAt || validExpiresAt,
        expireAction: item.expireAction || expireAction || 'revoke'
      });
    }
  } else {
    const cleanEmails = Array.isArray(emails)
      ? parseEmailListInput(emails.join('\n'))
      : parseEmailListInput(String(emails || ''));
    if (!cleanEmails.length) {
      throw new Error('请至少输入 1 个有效的目标邮箱地址');
    }
    const emailSet = new Set(cleanEmails);

    for (const file of files || []) {
      if (!file || !file.id) continue;
      const fileOwner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
      const perms = file.permissions || [];
      const existingByEmail = new Map();
      for (const p of perms) {
        if (p.type === 'user' || p.type === 'group') {
          const em = normalizeEntry(p.emailAddress || '');
          if (em) existingByEmail.set(em, p);
        }
      }

      if (mode === 'grant') {
        for (const email of cleanEmails) {
          if (email === fileOwner) continue;
          const contactName = contactLookup?.get(email)?.name || email;
          const existing = existingByEmail.get(email);
          if (!existing) {
            operations.push({
              type: 'create',
              file,
              fileOwner,
              email,
              name: contactName,
              role: cleanRole,
              expiresAt: validExpiresAt,
              expireAction: expireAction || 'revoke'
            });
          } else if (
            existing.role !== 'owner' &&
            !permIsInherited(existing) &&
            (existing.role !== cleanRole || Boolean(validExpiresAt))
          ) {
            operations.push({
              type: 'update',
              file,
              fileOwner,
              permission: existing,
              email,
              name: contactName,
              role: cleanRole,
              expiresAt: validExpiresAt,
              expireAction: expireAction || 'revoke'
            });
          } else if (
            existing.role !== 'owner' &&
            permIsInherited(existing) &&
            permissionRoleRank(cleanRole) > permissionRoleRank(existing.role)
          ) {
            operations.push({
              type: 'create',
              file,
              fileOwner,
              email,
              name: contactName,
              role: cleanRole,
              expiresAt: validExpiresAt,
              expireAction: expireAction || 'revoke'
            });
          }
        }
      } else if (mode === 'revoke') {
        for (const p of perms) {
          if (p.role === 'owner' || permIsInherited(p)) continue;
          const em = normalizeEntry(p.emailAddress || '');
          if (em && em !== fileOwner && emailSet.has(em)) {
            operations.push({
              type: 'delete',
              file,
              fileOwner,
              permission: p,
              email: em,
              name: contactLookup?.get(em)?.name || p.displayName || em
            });
          }
        }
      }
    }
  }

  let createdCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  let failedCount = 0;
  let stopped = false;
  const failedItems = [];
  const ttlBatchToEnqueue = [];
  const logs = [];
  let cursor = 0;

  const tokenCache = new Map();
  async function getToken(owner) {
    if (tokenCache.has(owner)) return tokenCache.get(owner);
    const t = await getValidTokenForAccount(owner, true);
    tokenCache.set(owner, t);
    return t;
  }

  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < operations.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const op = operations[cursor++];
      const { file, fileOwner } = op;
      const activeExpiresAt = op.expiresAt || '';
      const activeExpireAction = op.expireAction || expireAction || 'revoke';
      const targetDisplay = op.name && op.name !== op.email ? `${op.name} (${op.email})` : op.email;
      try {
        const token = await getToken(fileOwner);
        if (op.type === 'create') {
          let created = null;
          let nativeExpirationApplied = false;
          if (activeExpiresAt) {
            const grantRes = await grantPermissionCoreApi(token, file, file.id, {
              type: 'user',
              role: op.role,
              emailAddress: op.email,
              expiresAt: activeExpiresAt
            });
            created = grantRes.createdPermission;
            nativeExpirationApplied = grantRes.nativeExpirationApplied;
          } else {
            created = await createPermission(token, file.id, {
              type: 'user',
              role: op.role,
              emailAddress: op.email
            });
          }
          const createdId = created?.id || `dir-${Date.now()}-${Math.random()}`;
          file.permissions = file.permissions || [];
          const existPerm = file.permissions.find(p => normalizeEntry(p.emailAddress || '') === op.email);
          if (existPerm && existPerm.role !== 'owner') {
            existPerm.id = created?.id || existPerm.id;
            existPerm.role = op.role;
          } else {
            file.permissions.push({
              id: createdId,
              type: 'user',
              role: op.role,
              emailAddress: op.email,
              displayName: op.name || op.email
            });
          }

          if (activeExpiresAt) {
            ttlBatchToEnqueue.push({
              fileId: file.id,
              fileName: file.name || '(无名称)',
              mimeType: file.mimeType || '',
              webViewLink: file.webViewLink || '',
              accountEmail: fileOwner,
              permissionId: created?.id || '',
              targetType: 'user',
              targetEmail: op.email,
              targetLabel: targetDisplay,
              grantedRole: op.role,
              expireAction: activeExpireAction,
              expiresAt: activeExpiresAt,
              nativeExpirationApplied
            });
          }
          createdCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            isTtl: Boolean(activeExpiresAt),
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: created?.id || '',
            targetType: 'user',
            targetEmail: op.email,
            targetLabel: targetDisplay,
            previousRole: '',
            newRole: op.role,
            restored: false,
            message: `指定邮箱批量授予「${roleLabel(op.role)}」权限${
              activeExpiresAt ? `（限时：${formatTtlRemaining(activeExpiresAt)}）` : ''
            }`
          });
        } else if (op.type === 'update') {
          const prevRole = op.permission.role;
          if (prevRole !== op.role) {
            await updatePermissionRole(token, file.id, op.permission.id, op.role);
            op.permission.role = op.role;
          }
          if (activeExpiresAt) {
            ttlBatchToEnqueue.push({
              fileId: file.id,
              fileName: file.name || '(无名称)',
              mimeType: file.mimeType || '',
              webViewLink: file.webViewLink || '',
              accountEmail: fileOwner,
              permissionId: op.permission.id,
              targetType: op.permission.type || 'user',
              targetEmail: op.email,
              targetLabel: targetDisplay,
              grantedRole: op.role,
              expireAction: activeExpireAction,
              expiresAt: activeExpiresAt,
              nativeExpirationApplied: false
            });
          }
          updatedCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'downgrade',
            isTtl: Boolean(activeExpiresAt),
            accountEmail: fileOwner,
            fileId: file.id,
            fileName: file.name || '(无名称)',
            webViewLink: file.webViewLink || '',
            permissionId: op.permission.id,
            targetType: op.permission.type || 'user',
            targetEmail: op.email,
            targetLabel: targetDisplay,
            previousRole: prevRole,
            newRole: op.role,
            restored: false,
            message: `指定邮箱批量调整角色：${roleLabel(prevRole)} -> ${roleLabel(op.role)}${
              activeExpiresAt ? `（限时：${formatTtlRemaining(activeExpiresAt)}）` : ''
            }`
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
            targetType: op.permission.type || 'user',
            targetEmail: op.email,
            targetLabel: targetDisplay,
            previousRole: op.permission.role,
            newRole: '',
            restored: false,
            message: `指定邮箱批量移除权限（原角色：${roleLabel(op.permission.role)}）`
          });
        }
      } catch (error) {
        failedCount++;
        failedItems.push({
          type: op.type,
          fileId: file.id,
          fileName: file.name || '(无名称)',
          mimeType: file.mimeType || '',
          webViewLink: file.webViewLink || '',
          fileOwner,
          permissionId: op.permission?.id || '',
          permission: op.permission
            ? {
                id: op.permission.id,
                type: op.permission.type,
                role: op.permission.role,
                emailAddress: op.permission.emailAddress || '',
                domain: op.permission.domain || ''
              }
            : null,
          email: op.email || '',
          name: op.name || '',
          role: op.role || '',
          expiresAt: activeExpiresAt,
          expireAction: activeExpireAction,
          errorMessage: error?.message || String(error)
        });
      }

      const changedCount = createdCount + updatedCount + removedCount;
      if (onProgress) {
        onProgress({
          done: changedCount + failedCount,
          total: operations.length,
          changedCount,
          createdCount,
          updatedCount,
          removedCount,
          failedCount,
          stopped,
          message: `正在处理指定邮箱权限 ${changedCount + failedCount}/${operations.length}（成功 ${changedCount}，失败 ${failedCount}）…`
        });
      }
    }
  });

  await Promise.all(workers);
  if (ttlBatchToEnqueue.length) {
    await enqueueTtlPermissions(ttlBatchToEnqueue);
  }
  if (logs.length) await appendAuditLogs(logs);

  const changedCount = createdCount + updatedCount + removedCount;
  return {
    changedCount,
    createdCount,
    updatedCount,
    removedCount,
    failedCount,
    total: operations.length,
    failedItems,
    stopped
  };
}

/**
 * 对指定文件列表按当前白名单与公开策略执行修正（支持暂停/取消与失败重试）
 */
async function enforceFilesByPolicy(
  fallbackToken,
  files,
  policy,
  fallbackOwnerEmail,
  source = 'manual',
  onProgress = null,
  control = {}
) {
  const { shouldStop = null, retryQueue = null } = control || {};
  const fileById = new Map();
  for (const f of files || []) {
    if (f && f.id) fileById.set(f.id, f);
  }

  const queue = [];
  if (Array.isArray(retryQueue)) {
    for (const item of retryQueue) {
      if (!item || !item.fileId || !item.permissionId) continue;
      const liveFile =
        fileById.get(item.fileId) ||
        item.file || {
          id: item.fileId,
          name: item.fileName || '(无名称)',
          webViewLink: item.webViewLink || '',
          ownerAccount: item.fileOwner || fallbackOwnerEmail || '',
          permissions: []
        };
      const livePerm =
        Array.isArray(liveFile.permissions)
          ? liveFile.permissions.find(p => p.id === item.permissionId) || item.permission
          : item.permission;
      if (!livePerm) continue;
      queue.push({
        file: liveFile,
        fileOwner: item.fileOwner || liveFile.ownerAccount || liveFile.owners?.[0]?.emailAddress || fallbackOwnerEmail,
        permission: livePerm,
        action: item.action,
        targetRole: item.targetRole || 'reader',
        reason: item.reason || '策略合规修正'
      });
    }
  } else {
    const excludedSet = buildExcludedFileIdSet(files || [], policy?.excludedFolders || []);
    for (const file of files || []) {
      if (isFileInExcludedFolders(file, policy?.excludedFolders || [], excludedSet)) continue;
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
  }

  let removed = 0;
  let downgraded = 0;
  let failed = 0;
  let stopped = false;
  const failedItems = [];
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
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
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
        const errMsg = error?.message || String(error);
        failedItems.push({
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: file.webViewLink || '',
          fileOwner,
          permissionId: permission.id,
          permission: {
            id: permission.id,
            type: permission.type,
            role: permission.role,
            emailAddress: permission.emailAddress || '',
            domain: permission.domain || '',
            displayName: permission.displayName || ''
          },
          action,
          targetRole,
          reason,
          errorMessage: errMsg
        });
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
          message: `处理失败 (${targetLabel})：${errMsg}`
        });
      }

      if (onProgress) {
        onProgress({
          done: removed + downgraded + failed,
          total: queue.length,
          removed,
          downgraded,
          failed,
          stopped
        });
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) {
    await appendAuditLogs(logs);
  }

  return { removed, downgraded, failed, total: queue.length, logs, stopped, failedItems };
}

function normalizeScannedFileItem(file, accountEmail = '') {
  file.ownerAccount = normalizeEntry(accountEmail || file.owners?.[0]?.emailAddress || '');
  file.scannedByAccount = normalizeEntry(accountEmail || '');
  file.webViewLink = formatDriveCanonicalLink(file);
  file.writersCanShare = file.writersCanShare !== undefined ? Boolean(file.writersCanShare) : true;
  file.copyRequiresWriterPermission = Boolean(file.copyRequiresWriterPermission);
  const roRestriction = Array.isArray(file.contentRestrictions)
    ? file.contentRestrictions.find(r => r && r.readOnly)
    : null;
  file.contentLocked =
    file.contentLocked !== undefined && !Array.isArray(file.contentRestrictions)
      ? Boolean(file.contentLocked)
      : Boolean(roRestriction);
  file.contentLockReason = roRestriction?.reason || file.contentLockReason || '';
  file.viewedByMeTime = file.viewedByMeTime || '';
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
  scanScope = 'owned',
  customFolderIds = [],
  recursive = true
) {
  let files = [];
  const seenFileIds = new Set();
  let lastPartialEmit = 0;

  const INLINE_FILE_FIELDS =
    'id,name,mimeType,webViewLink,createdTime,modifiedTime,viewedByMeTime,writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason),ownedByMe,shared,owners(emailAddress,displayName),capabilities(canEdit,canComment,canShare),permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType)),parents';

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
      // 将每层父文件夹按 15 个一组分块，并用 4 线程并发请求 Drive API，大幅提速目录递归扫描
      const chunks = [];
      for (let i = 0; i < currentBatchIds.length; i += 15) {
        chunks.push(currentBatchIds.slice(i, i + 15));
      }
      let chunkCursor = 0;
      const chunkWorkers = Array.from({ length: Math.min(4, chunks.length) }, async () => {
        while (chunkCursor < chunks.length) {
          const chunk = chunks[chunkCursor++];
          const parentClause = chunk.map(fid => `'${escapeDriveQueryLiteral(fid)}' in parents`).join(' or ');
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
                message: `${accountPrefix}多线程扫描指定文件夹（第 ${depth} 层）：已发现 ${files.length} 项（含 ${folderCount} 个文件夹）…`
              });
            }
            const now = Date.now();
            if (onPartialFiles && (now - lastPartialEmit >= 450 || !pageToken)) {
              lastPartialEmit = now;
              onPartialFiles(files);
            }
          } while (pageToken);
        }
      });
      await Promise.all(chunkWorkers);

      if (!recursive) break;
      frontierFolderIds = nextFrontier;
    }
  } else {
    // 4 线程分片并发扫描全网盘（按文件夹与修改时间切分为 4 个并行分片同时拉取）
    let baseQ = 'trashed = false';
    if (scanScope === 'owned') {
      baseQ = "'me' in owners and trashed = false";
    }

    const shards =
      scanScope === 'folders_only'
        ? [
            `${baseQ} and mimeType = 'application/vnd.google-apps.folder' and modifiedTime >= '2024-01-01T00:00:00'`,
            `${baseQ} and mimeType = 'application/vnd.google-apps.folder' and modifiedTime < '2024-01-01T00:00:00'`
          ]
        : [
            `${baseQ} and mimeType = 'application/vnd.google-apps.folder'`,
            `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2025-01-01T00:00:00'`,
            `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2023-01-01T00:00:00' and modifiedTime < '2025-01-01T00:00:00'`,
            `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime < '2023-01-01T00:00:00'`
          ];

    await Promise.all(
      shards.map(async shardQ => {
        let pageToken = '';
        do {
          const params = new URLSearchParams({
            q: shardQ,
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
              message: `${accountPrefix}⚡ 4线程并发扫描中：已发现 ${files.length} 项（含 ${folderCount} 个文件夹）…`
            });
          }
          const now = Date.now();
          if (onPartialFiles && (now - lastPartialEmit >= 450 || !pageToken)) {
            lastPartialEmit = now;
            onPartialFiles(files);
          }
        } while (pageToken);
      })
    );
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
                'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType))'
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
 * 执行完整扫描（支持多账号并发、扫描范围选择 scanScope、边扫边展示 onPartialFiles、并发锁与权限变更 Diff）
 */
async function runFullScan({
  interactive = false,
  source = 'manual',
  targetAccount = 'all',
  scanScope = 'owned',
  customFolderIds = [],
  recursive = true,
  resumeCheckpoint = false,
  onProgress = null,
  onPartialFiles = null
} = {}) {
  const lockAttempt = await acquireScanRuntimeLock(source);
  if (!lockAttempt.acquired) {
    const policy = await getPolicy();
    const prevSnapshot = await getSnapshot();
    const summary = computeSummary(
      prevSnapshot.files || [],
      policy,
      prevSnapshot.accountEmail || '',
      new Set(prevSnapshot.newFileIds || [])
    );
    return {
      skipped: true,
      skipReason: 'scan_in_progress',
      accounts: await getAuthorizedAccounts(),
      policy,
      snapshot: prevSnapshot,
      summary,
      newlyDiscoveredCount: 0,
      excludedSkippedCount: 0,
      autoEnforceResult: null
    };
  }

  const lockId = lockAttempt.lockId;
  const isAutoPatrol = source === 'schedule' || source === 'startup';
  try {
    const policy = await getPolicy();
    const prevSnapshot = await getSnapshot();
    const accounts = await getAuthorizedAccounts();
    const excludedFolders = policy.excludedFolders || [];

    const knownSet = new Set(prevSnapshot.knownFileIds || []);
    const prevNewSet = new Set(prevSnapshot.newFileIds || []);
    const isFirstScan = knownSet.size === 0;

    // 准备旧快照权限指纹（兼容尚未持久化 permFingerprints 的历史快照）
    const prevFingerprints = { ...(prevSnapshot.permFingerprints || {}) };
    if (Object.keys(prevFingerprints).length === 0 && Array.isArray(prevSnapshot.files) && prevSnapshot.files.length > 0) {
      for (const pf of prevSnapshot.files) {
        if (!pf?.id) continue;
        const fp = buildFilePermissionFingerprint(pf);
        if (fp) prevFingerprints[pf.id] = fp;
      }
    }
    const prevPermDiffs = { ...(prevSnapshot.permDiffs || {}) };

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

    // 自动巡检断点续检：若开启 resumeCheckpoint 且上次未完成，跳过已扫完的账号并保留其历史文件
    let resumedCompletedSet = new Set();
    let checkpointStartedAt = new Date().toISOString();
    if (isAutoPatrol) {
      const prevCp = await getAutoScanCheckpoint();
      if (
        resumeCheckpoint &&
        (prevCp.status === 'running' || prevCp.status === 'interrupted') &&
        Array.isArray(prevCp.completedAccountEmails) &&
        prevCp.completedAccountEmails.length > 0
      ) {
        const targetNormSet = new Set(targetAccounts.map(a => normalizeEntry(a.email)));
        const validCompleted = prevCp.completedAccountEmails
          .map(normalizeEntry)
          .filter(em => em && targetNormSet.has(em));
        if (validCompleted.length > 0 && validCompleted.length < targetAccounts.length) {
          resumedCompletedSet = new Set(validCompleted);
          if (prevCp.startedAt) checkpointStartedAt = prevCp.startedAt;
        }
      }
      await saveAutoScanCheckpoint({
        status: 'running',
        startedAt: checkpointStartedAt,
        completedAccountEmails: [...resumedCompletedSet],
        totalAccounts: targetAccounts.length,
        scanScope,
        lastError: ''
      });
    }

    const accountsToScan =
      resumedCompletedSet.size > 0
        ? targetAccounts.filter(a => !resumedCompletedSet.has(normalizeEntry(a.email)))
        : targetAccounts;

    const activelyScanningAccountSet = new Set(accountsToScan.map(a => normalizeEntry(a.email)));
    const otherAccountFiles =
      scanScope !== 'custom_folders' &&
      (targetAccount !== 'all' || resumedCompletedSet.size > 0) &&
      prevSnapshot.files?.length
        ? prevSnapshot.files.filter(f => f.ownerAccount && !activelyScanningAccountSet.has(normalizeEntry(f.ownerAccount)))
        : [];

    const perAccountFiles = new Map();
    const completedEmailsLive = new Set(resumedCompletedSet);

    // 多账号全网盘扫描时按 file.id 去重，优先保留 ownedByMe 或权限信息更完整的项
    const mergeAndDedupeRawFiles = () => {
      const byId = new Map();
      const allLists = [...perAccountFiles.values(), otherAccountFiles];
      for (const list of allLists) {
        for (const file of list) {
          if (!file?.id) continue;
          const prev = byId.get(file.id);
          if (
            !prev ||
            (!prev.ownedByMe && file.ownedByMe) ||
            (file.permissions?.length || 0) > (prev.permissions?.length || 0)
          ) {
            byId.set(file.id, file);
          }
        }
      }
      return [...byId.values()];
    };

    const filterOutExcluded = list => {
      if (!excludedFolders.length || !list.length) {
        return { kept: list, excludedCount: 0 };
      }
      const exSet = buildExcludedFileIdSet(list, excludedFolders);
      if (exSet.size === 0) {
        return { kept: list, excludedCount: 0 };
      }
      const kept = list.filter(f => !exSet.has(f.id));
      return { kept, excludedCount: list.length - kept.length };
    };

    const emitPartialCombined = () => {
      touchScanRuntimeLock(lockId);
      if (!onPartialFiles) return;
      const { kept: combined } = filterOutExcluded(mergeAndDedupeRawFiles());
      for (const file of combined) {
        file.isNew = (!isFirstScan && !knownSet.has(file.id)) || prevNewSet.has(file.id);
      }
      onPartialFiles(combined);
    };

    const wrappedProgress = onProgress
      ? info => {
          touchScanRuntimeLock(lockId);
          onProgress(info);
        }
      : info => {
          touchScanRuntimeLock(lockId);
        };

    // 多账号多线程并发扫描
    await Promise.all(
      accountsToScan.map(async acc => {
        const prefix = targetAccounts.length > 1 ? `[${acc.email}] ` : '';
        let token = await getValidTokenForAccount(acc.email, interactive, false);
        let accFiles;
        try {
          accFiles = await scanSingleAccount(
            acc.email,
            token,
            wrappedProgress,
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
              wrappedProgress,
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

        if (isAutoPatrol) {
          const normAcc = normalizeEntry(acc.email);
          if (normAcc) completedEmailsLive.add(normAcc);
          const { kept: partialMerged } = filterOutExcluded(mergeAndDedupeRawFiles());
          await saveSnapshot({
            ...prevSnapshot,
            lastScanAt: new Date().toISOString(),
            lastScanSource: source,
            accountEmail: targetAccounts[0]?.email || prevSnapshot.accountEmail || '',
            files: partialMerged
          });
          await saveAutoScanCheckpoint({
            status: 'running',
            startedAt: checkpointStartedAt,
            completedAccountEmails: [...completedEmailsLive],
            totalAccounts: targetAccounts.length,
            scanScope,
            lastError: ''
          });
        }
      })
    );

    const scannedFileIdSet = new Set();
    for (const list of perAccountFiles.values()) {
      for (const f of list || []) {
        if (f?.id) scannedFileIdSet.add(f.id);
      }
    }

    const { kept: mergedFiles, excludedCount: excludedSkippedCount } = filterOutExcluded(mergeAndDedupeRawFiles());

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
    if (isAutoPatrol && policy.autoEnforce) {
      autoEnforceResult = await enforceFilesByPolicy(null, mergedFiles, policy, primaryEmail, 'auto');
    }

    // 计算本次扫描后的权限指纹与权限变动 Diff（单账号或断点续检时保留未重扫账号原有的指纹与 Diff）
    const isPartialAccountScan =
      scanScope === 'custom_folders' || (targetAccount && targetAccount !== 'all') || resumedCompletedSet.size > 0;
    const nextFingerprints = isPartialAccountScan ? { ...prevFingerprints } : {};
    const nextPermDiffs = isPartialAccountScan ? { ...prevPermDiffs } : {};

    for (const file of mergedFiles) {
      if (!file?.id) continue;
      if (!scannedFileIdSet.has(file.id)) {
        if (prevFingerprints[file.id]) nextFingerprints[file.id] = prevFingerprints[file.id];
        if (prevPermDiffs[file.id]) nextPermDiffs[file.id] = prevPermDiffs[file.id];
        continue;
      }

      const currFp = buildFilePermissionFingerprint(file);
      if (currFp) {
        nextFingerprints[file.id] = currFp;
      } else if (prevFingerprints[file.id]) {
        nextFingerprints[file.id] = prevFingerprints[file.id];
      }

      const prevFp = prevFingerprints[file.id] || null;
      if (!isFirstScan && prevFp && currFp && prevFp.sig !== currFp.sig) {
        const diffInfo = computeFilePermissionDiff(prevFp, currFp);
        if (diffInfo) {
          nextPermDiffs[file.id] = diffInfo;
        } else {
          delete nextPermDiffs[file.id];
        }
      } else if (scannedFileIdSet.has(file.id)) {
        delete nextPermDiffs[file.id];
      }
    }

    hydrateFilesPermissionDiffs(mergedFiles, nextPermDiffs);

    const completedIso = new Date().toISOString();
    const snapshot = {
      lastScanAt: completedIso,
      lastScanSource: source,
      accountEmail: primaryEmail,
      files: mergedFiles,
      knownFileIds: updatedKnownIds,
      newFileIds: updatedNewIds,
      permFingerprints: nextFingerprints,
      permDiffs: nextPermDiffs
    };

    await saveSnapshot(snapshot);
    await updateExtensionBadge(mergedFiles, policy, primaryEmail);

    if (isAutoPatrol) {
      await saveAutoScanCheckpoint({
        status: 'completed',
        startedAt: checkpointStartedAt,
        completedAt: completedIso,
        lastSuccessAt: completedIso,
        completedAccountEmails: targetAccounts.map(a => normalizeEntry(a.email)).filter(Boolean),
        totalAccounts: targetAccounts.length,
        scanScope,
        lastError: ''
      });
    }

    const summary = computeSummary(mergedFiles, policy, primaryEmail, new Set(updatedNewIds));

    if (isAutoPatrol) {
      const patrolLabel =
        source === 'startup' && resumedCompletedSet.size > 0
          ? `启动断点续检 (${accountsToScan.length}/${targetAccounts.length} 个剩余账号)`
          : source === 'startup'
            ? `启动自动巡检 (${targetAccounts.length} 个账号)`
            : `定期自动巡检 (${targetAccounts.length} 个账号)`;
      await appendAuditLogs({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: snapshot.lastScanAt,
        source: 'scan',
        actionType: 'scan_summary',
        fileId: '',
        fileName: patrolLabel,
        webViewLink: '',
        permissionId: '',
        targetType: '',
        targetEmail: '',
        targetLabel: `共 ${summary.total} 个文件（新增 ${newlyDiscoveredIds.length} 个，变动 ${summary.changedFiles} 个${
          excludedSkippedCount > 0 ? `，已跳过排除项 ${excludedSkippedCount} 个` : ''
        }）`,
        previousRole: '',
        newRole: '',
        restored: false,
        message: autoEnforceResult
          ? `${patrolLabel}完成：自动移除 ${autoEnforceResult.removed} 项违规权限，自动降级 ${autoEnforceResult.downgraded} 项越权编辑。`
          : `${patrolLabel}完成：发现 ${summary.anomalousFiles} 个异常文件（${summary.actionablePermissions} 项待处理权限，${summary.changedFiles} 个权限变动文件）。`
      });
    }

    return {
      accounts: await getAuthorizedAccounts(),
      policy,
      snapshot,
      summary,
      newlyDiscoveredCount: newlyDiscoveredIds.length,
      excludedSkippedCount,
      resumedFromCheckpoint: resumedCompletedSet.size > 0,
      autoEnforceResult
    };
  } catch (scanErr) {
    if (isAutoPatrol) {
      try {
        await saveAutoScanCheckpoint({
          status: 'interrupted',
          lastError: scanErr?.message || String(scanErr)
        });
      } catch (_cpErr) {}
    }
    throw scanErr;
  } finally {
    await releaseScanRuntimeLock(lockId);
  }
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
 * 从逗号、分号、空格、制表符、换行或 `姓名 <a@b.com>` 文本/数组中提取去重合法邮箱数组
 */
function parseEmailListInput(rawText = '') {
  const combined = Array.isArray(rawText) ? rawText.join('\n') : String(rawText ?? '');
  const matches = combined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(matches.map(normalizeEntry).filter(Boolean))];
}

/**
 * 兼容旧版邮箱列表提取别名
 */
function parseEmailsInput(rawText = '') {
  return parseEmailListInput(rawText);
}

/**
 * 对一批文件/文件夹 ID (fileIds 或 rows) 和一批邮箱 (emails) 批量开通查看/编辑/评论或关闭权限
 * 若单行对象传入了合法 row.role ('writer'|'commenter'|'reader')，优先使用单行 row.role，否则使用工具栏统一 role
 */
async function executeBatchLinksPermissions({
  fileIds = [],
  emails = [],
  rows = null,
  role = 'reader', // 'reader' | 'writer' | 'commenter'
  mode = 'grant',  // 'grant' | 'revoke'
  existingFiles = [],
  targetAccount = 'all',
  expiresAt = '',
  expireAction = 'revoke',
  onProgress = null,
  shouldStop = null,
  retryQueue = null
}) {
  const defaultRole = normalizePermissionRole(role, 'reader') || 'reader';
  const validExpiresAt =
    expiresAt && Number.isFinite(Date.parse(expiresAt)) ? new Date(Date.parse(expiresAt)).toISOString() : '';
  const isRetry = Array.isArray(retryQueue);
  if (isRetry && retryQueue.length === 0) {
    return {
      fileCount: 0,
      emailCount: 0,
      totalTasks: 0,
      successCount: 0,
      failCount: 0,
      stopped: false,
      failedItems: []
    };
  }

  const hasRowObjects =
    !isRetry &&
    ((Array.isArray(rows) && rows.length > 0) ||
      (Array.isArray(fileIds) && fileIds.some(item => item && typeof item === 'object')));

  const rowPairs = [];
  let cleanFileIds = [];
  let cleanEmails = [];

  if (isRetry) {
    cleanFileIds = [...new Set(retryQueue.map(x => x?.fileId).filter(Boolean))];
    cleanEmails = [...new Set(retryQueue.map(x => normalizeEntry(x?.email || '')).filter(Boolean))];
  } else if (hasRowObjects) {
    const rawRowObjects =
      Array.isArray(rows) && rows.length > 0 ? rows : fileIds.filter(item => item && typeof item === 'object');
    const fallbackEmails = parseEmailListInput(emails);
    const pairMap = new Map();
    const fidSet = new Set();
    const emailSet = new Set();

    for (const r of rawRowObjects) {
      if (!r || typeof r !== 'object') continue;
      let rowFids = [];
      if (Array.isArray(r.fileIds) && r.fileIds.length) {
        rowFids = r.fileIds.map(x => String(x || '').trim()).filter(Boolean);
      } else if (typeof r.fileId === 'string' && r.fileId.trim()) {
        const parsedIds = parseDriveLinksInput(r.fileId);
        rowFids = parsedIds.length ? parsedIds : [r.fileId.trim()];
      } else if (typeof r.id === 'string' && r.id.trim()) {
        rowFids = [r.id.trim()];
      } else if (r.link || r.url) {
        rowFids = parseDriveLinksInput(r.link || r.url);
      }

      let rowEmails = [];
      if (Array.isArray(r.emails) && r.emails.length) {
        rowEmails = parseEmailListInput(r.emails);
      } else if (typeof r.emails === 'string' && r.emails.trim()) {
        rowEmails = parseEmailListInput(r.emails);
      } else if (typeof r.email === 'string' && r.email.trim()) {
        rowEmails = parseEmailListInput(r.email);
      } else {
        rowEmails = fallbackEmails;
      }

      const rowRole = normalizePermissionRole(r.role, '') || defaultRole;
      const rowExp =
        r.expiresAt && Number.isFinite(Date.parse(r.expiresAt))
          ? new Date(Date.parse(r.expiresAt)).toISOString()
          : validExpiresAt;

      for (const fid of rowFids) {
        fidSet.add(fid);
        for (const em of rowEmails) {
          emailSet.add(em);
          const pKey = `${fid}::${em}`;
          const prevPair = pairMap.get(pKey);
          if (!prevPair || permissionRoleRank(rowRole) >= permissionRoleRank(prevPair.role)) {
            pairMap.set(pKey, {
              fileId: fid,
              email: em,
              role: rowRole,
              expiresAt: rowExp
            });
          }
        }
      }
    }

    rowPairs.push(...pairMap.values());
    cleanFileIds = [...fidSet];
    cleanEmails = [...emailSet];
  } else {
    cleanFileIds = [...new Set((fileIds || []).map(x => String(x || '').trim()).filter(Boolean))];
    cleanEmails = parseEmailListInput(emails);
  }

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

  const existingMap = new Map((existingFiles || []).map(f => [f.id, f]));
  const fileMetaMap = new Map();
  let stopped = false;

  // 并发解析每个 fileId 对应的文件名与可用 token（避免逐个串行等待）
  let metaCursor = 0;
  const metaWorkers = Array.from({ length: Math.min(10, cleanFileIds.length) }, async () => {
    while (metaCursor < cleanFileIds.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const fid = cleanFileIds[metaCursor++];
      const localFile = existingMap.get(fid);
      const preferredEmail = normalizeEntry(localFile?.ownerAccount || localFile?.owners?.[0]?.emailAddress || '');
      const preferredEntry = tokenPool.find(x => x.email && x.email === preferredEmail) || tokenPool[0];

      let resolvedToken = preferredEntry.token;
      let resolvedAccount = preferredEntry.email;
      let fileName = localFile?.name || `文件 (${fid.slice(0, 8)}…)`;
      let mimeType = localFile?.mimeType || '';
      let webViewLink = localFile?.webViewLink || `https://drive.google.com/open?id=${fid}`;

      if (!localFile) {
        for (const entry of tokenPool) {
          try {
            const meta = await driveApi(
              entry.token,
              `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,owners(emailAddress)`
            );
            if (meta) {
              resolvedToken = entry.token;
              resolvedAccount = entry.email || normalizeEntry(meta.owners?.[0]?.emailAddress || '');
              fileName = meta.name || fileName;
              mimeType = meta.mimeType || mimeType;
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
        mimeType,
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
  if (isRetry) {
    for (const item of retryQueue) {
      if (!item || !item.fileId || !item.email) continue;
      tasks.push({
        type: item.type || mode || 'grant',
        fileId: item.fileId,
        email: normalizeEntry(item.email),
        role: normalizePermissionRole(item.role, defaultRole) || defaultRole,
        permissionId: item.permissionId || '',
        previousRole: item.previousRole || '',
        expiresAt: item.expiresAt || validExpiresAt,
        expireAction: item.expireAction || expireAction || 'revoke'
      });
    }
  } else if (mode === 'grant') {
    if (hasRowObjects) {
      for (const pair of rowPairs) {
        tasks.push({
          type: 'grant',
          fileId: pair.fileId,
          email: pair.email,
          role: pair.role,
          expiresAt: pair.expiresAt,
          expireAction: expireAction || 'revoke'
        });
      }
    } else {
      for (const fid of cleanFileIds) {
        for (const email of cleanEmails) {
          tasks.push({
            type: 'grant',
            fileId: fid,
            email,
            role: defaultRole,
            expiresAt: validExpiresAt,
            expireAction: expireAction || 'revoke'
          });
        }
      }
    }
  } else {
    // mode === 'revoke': 并发读取每个文件的权限列表，找出命中目标邮箱的权限项
    const allowedEmailsByFile = new Map();
    if (hasRowObjects) {
      for (const pair of rowPairs) {
        if (!allowedEmailsByFile.has(pair.fileId)) {
          allowedEmailsByFile.set(pair.fileId, new Set());
        }
        allowedEmailsByFile.get(pair.fileId).add(pair.email);
      }
    }
    const globalEmailSet = new Set(cleanEmails);
    let revCursor = 0;
    const revWorkers = Array.from({ length: Math.min(10, cleanFileIds.length) }, async () => {
      while (revCursor < cleanFileIds.length) {
        if (shouldStop?.()) {
          stopped = true;
          break;
        }
        const fid = cleanFileIds[revCursor++];
        const meta = fileMetaMap.get(fid);
        if (!meta) continue;
        const targetEmailSet = hasRowObjects ? allowedEmailsByFile.get(fid) || new Set() : globalEmailSet;
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
            if (em && targetEmailSet.has(em)) {
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
  const failedItems = [];
  const ttlBatchToEnqueue = [];
  const logs = [];

  const workers = Array.from({ length: 12 }, async () => {
    while (cursor < tasks.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const task = tasks[cursor++];
      const meta = fileMetaMap.get(task.fileId) || {
        fileId: task.fileId,
        fileName: `文件 (${String(task.fileId).slice(0, 8)}…)`,
        mimeType: '',
        webViewLink: `https://drive.google.com/open?id=${task.fileId}`,
        token: tokenPool[0].token,
        accountEmail: tokenPool[0].email,
        localFile: existingMap.get(task.fileId) || null
      };
      const taskExpiresAt = task.expiresAt || '';
      const taskExpireAction = task.expireAction || expireAction || 'revoke';
      try {
        if (task.type === 'grant') {
          let created = null;
          let nativeExpirationApplied = false;
          if (taskExpiresAt) {
            const grantRes = await grantPermissionCoreApi(
              meta.token,
              meta.localFile || { mimeType: meta.mimeType },
              task.fileId,
              {
                type: 'user',
                role: task.role,
                emailAddress: task.email,
                expiresAt: taskExpiresAt
              }
            );
            created = grantRes.createdPermission;
            nativeExpirationApplied = grantRes.nativeExpirationApplied;
          } else {
            created = await createPermission(meta.token, task.fileId, {
              type: 'user',
              role: task.role,
              emailAddress: task.email
            });
          }

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

          if (taskExpiresAt) {
            ttlBatchToEnqueue.push({
              fileId: task.fileId,
              fileName: meta.fileName,
              mimeType: meta.mimeType || meta.localFile?.mimeType || '',
              webViewLink: meta.webViewLink,
              accountEmail: meta.accountEmail,
              permissionId: created?.id || '',
              targetType: 'user',
              targetEmail: task.email,
              targetLabel: task.email,
              grantedRole: task.role,
              expireAction: taskExpireAction,
              expiresAt: taskExpiresAt,
              nativeExpirationApplied
            });
          }

          successCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            isTtl: Boolean(taskExpiresAt),
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
            message: `批量链接授权：授予「${roleLabel(task.role)}」权限${
              taskExpiresAt ? `（限时：${formatTtlRemaining(taskExpiresAt)}）` : ''
            }`
          });
        } else if (task.type === 'revoke') {
          let permId = task.permissionId;
          if (!permId) {
            const data = await driveApi(
              meta.token,
              `/files/${encodeURIComponent(task.fileId)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress)`
            );
            const matched = (data?.permissions || []).find(
              p => p.role !== 'owner' && normalizeEntry(p.emailAddress || '') === task.email
            );
            permId = matched?.id || '';
          }
          if (permId) {
            await deletePermission(meta.token, task.fileId, permId);
            if (meta.localFile && meta.localFile.permissions) {
              meta.localFile.permissions = meta.localFile.permissions.filter(p => p.id !== permId);
            }
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
            permissionId: permId,
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
        const errMsg = error?.message || String(error);
        failedItems.push({
          type: task.type,
          fileId: task.fileId,
          fileName: meta.fileName,
          email: task.email,
          role: task.role || role,
          permissionId: task.permissionId || '',
          previousRole: task.previousRole || '',
          expiresAt: taskExpiresAt,
          expireAction: taskExpireAction,
          errorMessage: errMsg
        });
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
          message: `批量链接操作失败 (${task.email})：${errMsg}`
        });
      } finally {
        done++;
        if (onProgress) {
          onProgress({
            done,
            total: tasks.length,
            successCount,
            failCount,
            stopped,
            message: `正在处理链接权限 ${done}/${tasks.length}（成功 ${successCount}，失败 ${failCount}）…`
          });
        }
      }
    }
  });

  await Promise.all(workers);
  if (ttlBatchToEnqueue.length) {
    await enqueueTtlPermissions(ttlBatchToEnqueue);
  }
  if (logs.length) await appendAuditLogs(logs);

  return {
    fileCount: cleanFileIds.length,
    emailCount: cleanEmails.length,
    totalTasks: tasks.length,
    successCount,
    failCount,
    stopped,
    failedItems
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
  onProgress = null,
  shouldStop = null,
  retryQueue = null
}) {
  const isRetry = Array.isArray(retryQueue);
  if (isRetry && retryQueue.length === 0) {
    return { total: 0, successCount: 0, failCount: 0, stopped: false, failedItems: [], results: [] };
  }

  const taskItems = isRetry
    ? retryQueue
        .map(item => {
          const fid = typeof item === 'string' ? item : item?.fileId;
          return fid ? { fileId: fid, publicMode: item?.publicMode || publicMode } : null;
        })
        .filter(Boolean)
    : [...new Set((fileIds || []).filter(Boolean))].map(fid => ({ fileId: fid, publicMode }));

  if (!taskItems.length) {
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

  const existingMap = new Map((existingFiles || []).map(f => [f.id, f]));

  let successCount = 0;
  let failCount = 0;
  let done = 0;
  let cursor = 0;
  let stopped = false;
  const failedItems = [];
  const results = [];
  const logs = [];

  const workers = Array.from({ length: Math.min(10, taskItems.length) }, async () => {
    while (cursor < taskItems.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const taskItem = taskItems[cursor++];
      const fid = taskItem.fileId;
      const itemMode = taskItem.publicMode || publicMode;
      const desiredRole =
        itemMode === 'anyone_writer' ? 'writer' : itemMode === 'anyone_commenter' ? 'commenter' : 'reader';
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

        if (itemMode === 'anyone_off') {
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
          results.push({
            fileId: fid,
            fileName,
            webViewLink,
            ok: true,
            status: '已关闭公开链接（受限）'
          });
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
          results.push({
            fileId: fid,
            fileName,
            webViewLink,
            ok: true,
            status: `任何人 · ${roleLabel(desiredRole)}`
          });
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
        const errMsg = error?.message || String(error);
        failedItems.push({
          fileId: fid,
          fileName,
          webViewLink,
          publicMode: itemMode,
          errorMessage: errMsg
        });
        results.push({
          fileId: fid,
          fileName,
          webViewLink,
          ok: false,
          status: `失败：${errMsg}`
        });
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
          message: `设置公开链接失败：${errMsg}`
        });
      } finally {
        done++;
        if (onProgress) {
          onProgress({
            done,
            total: taskItems.length,
            successCount,
            failCount,
            stopped,
            message: `正在设置链接公开权限 ${done}/${taskItems.length}（成功 ${successCount}，失败 ${failCount}）…`
          });
        }
      }
    }
  });

  await Promise.all(workers);
  if (logs.length) await appendAuditLogs(logs);
  return { total: taskItems.length, successCount, failCount, stopped, failedItems, results };
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
  const hasFullState = Array.isArray(partial.items) && Array.isArray(partial.logs);
  const current = hasFullState ? partial : await getOwnershipTransferState();
  const next = {
    ...current,
    ...partial,
    sourceEmail: normalizeEntry(partial.sourceEmail !== undefined ? partial.sourceEmail : current.sourceEmail),
    targetEmail: normalizeEntry(partial.targetEmail !== undefined ? partial.targetEmail : current.targetEmail),
    lastUpdatedAt: new Date().toISOString()
  };
  if (Array.isArray(next.logs) && next.logs.length > 400) {
    next.logs = next.logs.slice(-400);
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
 * 为转移列表计算目录树拓扑结构：
 * 1. 识别所有顶层大文件夹 (isTopLevelFolder = true)
 * 2. 为每个子文件夹与文件溯源归属的顶层大文件夹 (rootFolderId / rootFolderName / depth)
 * 3. 按【顶层文件夹 ➔ 子文件夹(按浅到深) ➔ 内部文件(按所属顶层大文件夹聚合)】排序
 */
function enrichTransferItemsWithTree(items = []) {
  const folderMap = new Map();
  for (const it of items) {
    if (it.mimeType === 'application/vnd.google-apps.folder') {
      folderMap.set(it.id, it);
    }
  }

  const rootCache = new Map();
  function resolveRootAndDepth(item) {
    if (rootCache.has(item.id)) return rootCache.get(item.id);
    const visited = new Set([item.id]);
    const ancestors = [];
    let cur = item;
    let depth = 0;
    while (cur) {
      const pList = Array.isArray(cur.parents) ? cur.parents : [];
      const parentFolder = pList.map(pid => folderMap.get(pid)).find(Boolean);
      if (!parentFolder || visited.has(parentFolder.id)) {
        break;
      }
      visited.add(parentFolder.id);
      ancestors.unshift(parentFolder);
      cur = parentFolder;
      depth++;
    }
    const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
    const isTopLevelFolder = isFolder && depth === 0;
    const rootFolderId = isFolder && depth === 0 ? item.id : cur !== item ? cur.id : '__root_loose__';
    const rootFolderName =
      isFolder && depth === 0
        ? item.name
        : cur !== item
        ? cur.name || '(顶层文件夹)'
        : '📄 根目录直属单文件';
    const itemName = item.name || '(无名称)';
    const folderPath =
      ancestors.length > 0
        ? ancestors.map(a => a.name || a.id).join(' / ')
        : isFolder
        ? '顶层目录'
        : '根目录';
    const fullPath =
      ancestors.length > 0
        ? [...ancestors.map(a => a.name || a.id), itemName].join(' / ')
        : itemName;
    const immediateParent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    const rawParentId = (Array.isArray(item.parents) && item.parents[0]) || '';
    const parentFolderId = immediateParent ? immediateParent.id : rawParentId;
    const parentFolderName = immediateParent
      ? immediateParent.name || immediateParent.id
      : rawParentId
      ? '上级目录'
      : '根目录';
    const parentFolderLink = parentFolderId
      ? `https://drive.google.com/drive/folders/${encodeURIComponent(parentFolderId)}`
      : '';
    const rootFolderLink =
      rootFolderId && rootFolderId !== '__root_loose__'
        ? `https://drive.google.com/drive/folders/${encodeURIComponent(rootFolderId)}`
        : '';
    const res = {
      isTopLevelFolder,
      depth,
      levelLabel: `第 ${depth + 1} 层`,
      folderPath,
      fullPath,
      treeDisplayName: `${'　'.repeat(depth)}${depth > 0 ? '├─ ' : ''}${itemName}`,
      parentFolderId,
      parentFolderName,
      parentFolderLink,
      rootFolderId,
      rootFolderName,
      rootFolderLink
    };
    rootCache.set(item.id, res);
    return res;
  }

  for (const it of items) {
    const info = resolveRootAndDepth(it);
    it.isTopLevelFolder = info.isTopLevelFolder;
    it.folderDepth = info.depth;
    it.levelLabel = info.levelLabel;
    it.folderPath = info.folderPath;
    it.fullPath = info.fullPath;
    it.treeDisplayName = info.treeDisplayName;
    it.parentFolderId = info.parentFolderId;
    it.parentFolderName = info.parentFolderName;
    it.parentFolderLink = info.parentFolderLink;
    it.rootFolderId = info.rootFolderId;
    it.rootFolderName = info.rootFolderName;
    it.rootFolderLink = info.rootFolderLink;
    it.webViewLink = formatDriveCanonicalLink(it);
  }

  items.sort((a, b) => {
    // 1. 顶层大文件夹最优先（先给顶层大文件夹赋权 writer，全树子目录与文件即刻自动继承）
    if (a.isTopLevelFolder !== b.isTopLevelFolder) return a.isTopLevelFolder ? -1 : 1;
    // 2. 其余文件夹按层级由浅入深排在文件前面
    const aFolder = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    const bFolder = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    if (aFolder === 0 && a.folderDepth !== b.folderDepth) return a.folderDepth - b.folderDepth;
    // 3. 按所属顶层文件夹聚合排序
    if (a.rootFolderName !== b.rootFolderName) {
      return String(a.rootFolderName || '').localeCompare(String(b.rootFolderName || ''), 'zh-CN');
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });

  return items;
}

/**
 * 将扫描到的原始 Drive 文件数组转换为所有权转移条目列表（供每页边扫边展示与最终汇总共用）
 */
function buildTransferItemsFromRawFiles(
  rawFiles = [],
  { normSource = '', normTarget = '', existingItems = [], mergeMode = false, includeHistoricalMerged = false } = {}
) {
  const prevById = new Map((existingItems || []).map(it => [it.id, it]));
  const nextItems = [];
  const seenIds = new Set();

  for (const f of rawFiles) {
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
    } else if (prev && (prev.stage === 'completed' || prev.stage === 'pending_accept')) {
      stage = prev.stage;
      statusText = prev.statusText || statusText;
      currentOwner = prev.currentOwner || currentOwner;
    }

    nextItems.push({
      id: f.id,
      name: f.name || '(无名称)',
      mimeType: f.mimeType || '',
      parents: Array.isArray(f.parents) ? f.parents : Array.isArray(prev?.parents) ? prev.parents : [],
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

  return enrichTransferItemsWithTree(nextItems);
}

/**
 * 扫描来源邮箱名下所有「我是所有者 ('me' in owners)」的文件夹与文件
 * 采用【4 线程并发分片 + 单页 1000 条极速轻量模式】，速度提升 15～30 倍，并支持边扫边展示 onPartialItems
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
      message: `正在校验来源邮箱 (${normSource}) 的本地授权令牌…`
    });
  }

  let sourceToken = await getValidTokenForAccount(normSource, true, false);

  if (onProgress) {
    onProgress({
      phase: 'token_ready',
      page: 0,
      count: 0,
      message: `✅ 来源邮箱 (${normSource}) 令牌校验通过，已启动 4 线程极速并发扫描（单页 1000 条）…`
    });
  }

  const rawFiles = [];
  const seenFileIds = new Set();
  let completedPages = 0;
  let lastEmitTime = 0;
  let tokenRefreshedOnce = false;

  const baseQ = "trashed = false and 'me' in owners and mimeType != 'application/vnd.google-apps.shortcut'";
  const shards = [
    {
      name: '线程1[📁文件夹]',
      q: `${baseQ} and mimeType = 'application/vnd.google-apps.folder'`
    },
    {
      name: '线程2[📄近期文件]',
      q: `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2025-01-01T00:00:00'`
    },
    {
      name: '线程3[📄中期文件]',
      q: `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2023-01-01T00:00:00' and modifiedTime < '2025-01-01T00:00:00'`
    },
    {
      name: '线程4[📄历史文件]',
      q: `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime < '2023-01-01T00:00:00'`
    }
  ];

  // 轻量字段列表：不请求内联 permissions(...)，使 Google Drive 允许 pageSize=1000 且单页响应时间从 3 秒降至 0.3 秒（同时拉取 parents 构建目录树）
  const fastFields = 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,ownedByMe,owners(emailAddress,displayName),parents)';
  let activeShards = shards.length;

  await Promise.all(
    shards.map(async shard => {
      let pageToken = '';
      try {
        do {
          if (shouldStop && shouldStop()) {
            break;
          }
          const apiPath = `/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
            shard.q
          )}&fields=${encodeURIComponent(fastFields)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;

          let res;
          try {
            res = await driveApi(sourceToken, apiPath);
          } catch (apiErr) {
            if (!tokenRefreshedOnce && /401|Invalid Credentials|UNAUTHENTICATED|authError/i.test(String(apiErr?.message || ''))) {
              tokenRefreshedOnce = true;
              if (onProgress) {
                onProgress({
                  phase: 'auth_refresh',
                  page: completedPages + 1,
                  count: rawFiles.length,
                  message: `🔄 检测到缓存令牌已过期，正在使用本地 refreshToken 自动换取新令牌…`
                });
              }
              sourceToken = await getValidTokenForAccount(normSource, false, true);
              res = await driveApi(sourceToken, apiPath);
            } else {
              throw apiErr;
            }
          }

          const pageFiles = Array.isArray(res?.files) ? res.files : [];
          let addedInPage = 0;
          for (const f of pageFiles) {
            if (f?.id && !seenFileIds.has(f.id)) {
              seenFileIds.add(f.id);
              rawFiles.push(f);
              addedInPage++;
            }
          }

          pageToken = res?.nextPageToken || '';
          completedPages++;

          if (onProgress) {
            onProgress({
              phase: 'scanning',
              page: completedPages,
              count: rawFiles.length,
              message: `⚡ 4线程极速扫描 (${normSource})：${shard.name} 完成第 ${completedPages} 批（累计已发现 ${rawFiles.length} 项）…`
            });
          }

          const now = Date.now();
          if (onPartialItems && (addedInPage > 0 || !pageToken) && (now - lastEmitTime >= 220 || !pageToken)) {
            lastEmitTime = now;
            const partialItems = buildTransferItemsFromRawFiles(rawFiles, {
              normSource,
              normTarget,
              existingItems,
              mergeMode,
              includeHistoricalMerged: false
            });
            await onPartialItems(partialItems, {
              page: completedPages,
              shardName: shard.name,
              pageAdded: addedInPage,
              total: partialItems.length,
              hasMore: Boolean(pageToken) || activeShards > 1
            });
            await new Promise(r => setTimeout(r, 10));
          }
        } while (pageToken);
      } finally {
        activeShards--;
      }
    })
  );

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
  if (!permId) {
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
      // ignore permission list error
    }
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
 * 【阶段 0：顶层大文件夹预热剪枝 + 自动挂载到接收方『我的云端硬盘』】
 * 在正式并发转移万级子文件前，先对最外层的「顶层文件夹」：
 * 1. 赋予接收方 writer 权限并拿到固定 permId（使内部所有多级子文件夹和子文件瞬间自动继承 writer，省去 90% 的 POST 请求！）
 * 2. 若接收方已授权 Token，立即将这些顶层文件夹挂入接收方的『我的云端硬盘 (root)』根目录，转移第1秒即可在『我的云端硬盘』看到完整目录树！
 */
async function prepareTopLevelFoldersForTransfer({
  sourceToken = '',
  targetToken = '',
  topFolders = [],
  targetEmail = '',
  onLog = null
}) {
  const normTarget = normalizeEntry(targetEmail);
  if (!sourceToken || !normTarget || !Array.isArray(topFolders) || !topFolders.length) {
    return { permId: '', grantedCount: 0, mountedCount: 0 };
  }

  let discoveredPermId = '';
  let grantedCount = 0;
  let mountedCount = 0;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(4, topFolders.length) }, async () => {
    while (cursor < topFolders.length) {
      const idx = cursor++;
      if (idx >= topFolders.length) break;
      const folder = topFolders[idx];

      // 1. 为顶层文件夹赋予接收方 writer 权限（触发 Google Drive 自动向所有子文件夹与子文件级联继承）
      try {
        const created = await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(folder.id)}/permissions?sendNotificationEmail=false&supportsAllDrives=true&fields=id,role,pendingOwner`,
          {
            method: 'POST',
            body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normTarget })
          }
        );
        if (created?.id) {
          discoveredPermId = discoveredPermId || created.id;
          folder.targetPermissionId = created.id;
        }
        grantedCount++;
      } catch (_e) {
        // ignore if already owner
      }

      // 2. 若接收方 Token 可用，开局立即将该顶层文件夹挂入接收方的『我的云端硬盘 (root)』根目录
      if (targetToken && !folder._mountedToTargetRoot) {
        try {
          const prevParents = Array.isArray(folder.parents) ? folder.parents.filter(Boolean) : [];
          const rmQuery = prevParents.length ? `&removeParents=${encodeURIComponent(prevParents.join(','))}` : '';
          try {
            await driveApi(
              targetToken,
              `/files/${encodeURIComponent(folder.id)}?addParents=root${rmQuery}&supportsAllDrives=true&fields=id,parents`,
              { method: 'PATCH' }
            );
          } catch (_eInner) {
            await driveApi(
              targetToken,
              `/files/${encodeURIComponent(folder.id)}?addParents=root&supportsAllDrives=true&fields=id,parents`,
              { method: 'PATCH' }
            );
          }
          folder._mountedToTargetRoot = true;
          mountedCount++;
        } catch (_e2) {
          // ignore if already in root or not yet movable before acceptance
        }
      }
    }
  });

  await Promise.all(workers);

  if (grantedCount > 0 && onLog) {
    await onLog(
      `🌳 [顶层目录树剪枝预热完成] 已为 ${grantedCount} 个顶层大文件夹赋权 writer（子目录与子文件已自动级联继承 permId=${
        discoveredPermId || '已就绪'
      }）${mountedCount > 0 ? `，并已将 ${mountedCount} 个顶层大文件夹自动挂入接收号『我的云端硬盘』根目录` : ''}！`
    );
  }

  return { permId: discoveredPermId, grantedCount, mountedCount };
}

/**
 * 单个文件/文件夹发起所有权转移（极速两步路径：自动赋予 writer + 设置 pendingOwner/transferOwnership + 可选自动调用接收方接受）
 */
async function transferSingleItemOwnership({
  sourceToken,
  targetToken = '',
  item,
  targetEmail,
  autoAccept = true,
  skipTargetApiAccept = false,
  knownTargetPermId = ''
}) {
  const normTarget = normalizeEntry(targetEmail || item.targetOwner);
  if (!sourceToken) throw new Error('缺少来源邮箱授权令牌');
  if (!normTarget) throw new Error('缺少接收邮箱地址');

  const isPersonalGmail = /@(gmail|googlemail)\.com$/i.test(normTarget);
  const logs = [];
  let permId = item.targetPermissionId || knownTargetPermId || '';
  let alreadyPending = item.stage === 'pending_accept' && Boolean(item.targetPermissionId);

  if (!alreadyPending) {
    // 非 @gmail.com（如 Google Workspace 企业同域账号）优先尝试 1 步直接转移所有权
    if (!isPersonalGmail) {
      try {
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
          return {
            stage: 'completed',
            currentOwner: normTarget,
            targetPermissionId: permId,
            statusText: '✅ 已直接完成所有权转移',
            error: '',
            logs: [`✅ 来源号已将《${item.name}》直接转移所有权给 ${normTarget}`]
          };
        }
        if (directCreate?.pendingOwner) {
          alreadyPending = true;
        }
      } catch (_directErr) {
        // 自动进入两步法
      }
    }

    // 超高速继承捷径（1次请求完结）：因为父文件夹优先授权了 writer，子文件已自动继承接收方的固定 permId，
    // 若已知 permId，直接尝试 1 步 PATCH pendingOwner=true（成功则省去 50% 的 POST 写配额与耗时！）
    if (!alreadyPending && permId) {
      try {
        await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?supportsAllDrives=true&fields=id,role,pendingOwner`,
          {
            method: 'PATCH',
            body: JSON.stringify({ role: 'writer', pendingOwner: true })
          }
        );
        alreadyPending = true;
        logs.push(`⚡ 已对《${item.name}》一步设为待接收 (复用继承权限 permId)`);
      } catch (_fastPatchErr) {
        // 若该文件不在已共享的父目录内（尚未继承 writer），清空 permId 走下方标准两步法
        permId = '';
      }
    }

    // 极速两步法 Step 1：直接通过幂等 POST 授予/升级接收方为 writer 并一步拿到 permId
    if (!alreadyPending && !permId) {
      try {
        const createdWriter = await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions?sendNotificationEmail=false&supportsAllDrives=true&fields=id,role,pendingOwner`,
          {
            method: 'POST',
            body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normTarget })
          }
        );
        permId = createdWriter?.id || '';
        if (createdWriter?.role === 'owner') {
          return {
            stage: 'completed',
            currentOwner: normTarget,
            targetPermissionId: permId,
            statusText: '✅ 已归属接收邮箱',
            error: '',
            logs: [`✅ 《${item.name}》所有者已是 ${normTarget}`]
          };
        }
        if (createdWriter?.pendingOwner) {
          alreadyPending = true;
        }
      } catch (postErr) {
        const errMsg = String(postErr?.message || '');
        if (/cannotModifyOwnerPermission|already.*owner/i.test(errMsg)) {
          return {
            stage: 'completed',
            currentOwner: normTarget,
            targetPermissionId: permId,
            statusText: '✅ 已归属接收邮箱',
            error: '',
            logs: [`✅ 《${item.name}》所有者已是 ${normTarget}`]
          };
        }
        // 回退读取一次权限列表
        const permRes = await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,pendingOwner)`
        );
        const targetPerm = (permRes?.permissions || []).find(p => normalizeEntry(p.emailAddress || '') === normTarget);
        if (targetPerm?.role === 'owner') {
          return {
            stage: 'completed',
            currentOwner: normTarget,
            targetPermissionId: targetPerm.id || '',
            statusText: '✅ 已归属接收邮箱',
            error: '',
            logs: [`✅ 《${item.name}》所有者已是 ${normTarget}`]
          };
        }
        if (targetPerm?.id) {
          permId = targetPerm.id;
          alreadyPending = Boolean(targetPerm.pendingOwner);
        } else {
          throw postErr;
        }
      }
    }

    // 极速两步法 Step 2：设置 pendingOwner: true 发起所有权转移邀请
    if (!alreadyPending && permId) {
      try {
        await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?supportsAllDrives=true&fields=id,role,pendingOwner`,
          {
            method: 'PATCH',
            body: JSON.stringify({ role: 'writer', pendingOwner: true })
          }
        );
        alreadyPending = true;
        logs.push(`📨 已对《${item.name}》发起转移邀请 (pendingOwner=true)`);
      } catch (_err1) {
        await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(item.id)}/permissions/${encodeURIComponent(permId)}?transferOwnership=true&moveToNewOwnersRoot=false&supportsAllDrives=true&fields=id,role,pendingOwner`,
          {
            method: 'PATCH',
            body: JSON.stringify({ role: 'writer', pendingOwner: true })
          }
        );
        alreadyPending = true;
        logs.push(`📨 已对《${item.name}》发起转移邀请 (pendingOwner=true)`);
      }
    }
  }

  // 3. 如果开启了接收方自动接受且接收方 Token 可用（且未触发个人号 API 接受熔断跳过），尝试用接收方 Token 接管所有权
  const updatedItem = { ...item, targetPermissionId: permId, stage: 'pending_accept' };
  if (autoAccept && targetToken && !skipTargetApiAccept) {
    const acceptRes = await acceptSingleItemOwnership({
      targetToken,
      item: updatedItem,
      targetEmail: normTarget
    });
    logs.push(acceptRes.logMsg);
    return {
      stage: acceptRes.stage,
      acceptedByApi: Boolean(acceptRes.accepted),
      currentOwner: acceptRes.currentOwner || item.sourceOwner,
      targetPermissionId: acceptRes.targetPermissionId || permId,
      statusText: acceptRes.statusText,
      error: '',
      logs
    };
  }

  return {
    stage: 'pending_accept',
    acceptedByApi: false,
    currentOwner: item.sourceOwner,
    targetPermissionId: permId,
    statusText: '📨 已发转移邀请 (待接收邮箱确认)',
    error: '',
    logs
  };
}

/**
 * 批量核对/对比来源邮箱与接收邮箱的实际归属状态（极速批量拉取对比，0.5秒核验数千文件）
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

  const total = items.length;
  let newlyCompleted = 0;
  let stillPending = 0;
  let stillSource = 0;

  // 若已授权接收方 Token，优先用 4 线程 pageSize=1000 一次性拉取接收方名下所有 'me' in owners 的文件 ID 集合（数千文件仅需 0.5 秒）
  if (targetToken) {
    if (onProgress) {
      onProgress({
        done: 0,
        total,
        message: `⚡ 正在用 4 线程极速扫描接收邮箱 (${normTarget}) 已拥有的全部文件与文件夹…`
      });
    }
    const targetOwnedIds = new Set();
    const baseQ = "trashed = false and 'me' in owners";
    const shards = [
      `${baseQ} and mimeType = 'application/vnd.google-apps.folder'`,
      `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2025-01-01T00:00:00'`,
      `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2023-01-01T00:00:00' and modifiedTime < '2025-01-01T00:00:00'`,
      `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime < '2023-01-01T00:00:00'`
    ];
    await Promise.all(
      shards.map(async sq => {
        let pt = '';
        do {
          const res = await driveApi(
            targetToken,
            `/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
              sq
            )}&fields=nextPageToken,files(id)${pt ? `&pageToken=${encodeURIComponent(pt)}` : ''}`
          );
          for (const f of res?.files || []) {
            if (f?.id) targetOwnedIds.add(f.id);
          }
          pt = res?.nextPageToken || '';
        } while (pt);
      })
    );

    const nowIso = new Date().toISOString();
    for (const it of items) {
      if (targetOwnedIds.has(it.id)) {
        it.stage = 'completed';
        it.currentOwner = normTarget || it.targetOwner;
        it.statusText = '✅ 已归属接收邮箱 (对比确认)';
        it.error = '';
        it.updatedAt = nowIso;
        newlyCompleted++;
      } else if (it.stage === 'pending_accept') {
        stillPending++;
      } else {
        stillSource++;
      }
    }
    if (onProgress) {
      onProgress({
        done: total,
        total,
        message: `✅ 极速归属对比完成：已归接收方 ${newlyCompleted} 项 · 待确认 ${stillPending} 项 · 仍归来源 ${stillSource} 项`
      });
    }
    return { total, newlyCompleted, stillPending, stillSource };
  }

  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(10, Math.max(1, total)) }, async () => {
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

        if ((normTarget && ownerEm === normTarget) || targetPerm?.role === 'owner') {
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
      if (onProgress && (done % 10 === 0 || done === total)) {
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

/**
 * 将已转移给接收邮箱（或来自来源邮箱）的顶层文件夹与顶层文件一键归入接收邮箱的「我的云端硬盘 (My Drive)」根目录，
 * 自动修复跨账号转移导致的「点开文件夹一闪而过变空 / 游离未归档 (is:unorganized)」问题，
 * 并在上层父文件夹转移完成后自动将曾暂挂根目录的子文件夹/子文件恢复回原父文件夹，100% 保持原始目录树结构！
 */
async function mountTransferredItemsToMyDriveRoot({
  targetToken = '',
  sourceToken = '',
  transferItems = [],
  concurrency = 8,
  onProgress = null
}) {
  if (!targetToken) {
    throw new Error('请先在右侧授权或选择已授权的「接收邮箱」，才能将其归入接收号的『我的云端硬盘』');
  }

  if (onProgress) {
    onProgress({ message: '正在读取接收邮箱『我的云端硬盘 (root)』根目录 ID…' });
  }
  const targetRootMeta = await driveApi(targetToken, '/files/root?fields=id');
  const targetRootId = targetRootMeta?.id || 'root';

  let sourceRootId = '';
  if (sourceToken) {
    try {
      const srcRootMeta = await driveApi(sourceToken, '/files/root?fields=id');
      sourceRootId = srcRootMeta?.id || '';
    } catch (_e) {}
  }

  // 4 线程极速扫描接收邮箱当前已拥有的全部文件与文件夹及其 parents 父目录关系
  const ownedFiles = [];
  const seenIds = new Set();
  const baseQ = "trashed = false and 'me' in owners";
  const shards = [
    `${baseQ} and mimeType = 'application/vnd.google-apps.folder'`,
    `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2025-01-01T00:00:00'`,
    `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2023-01-01T00:00:00' and modifiedTime < '2025-01-01T00:00:00'`,
    `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime < '2023-01-01T00:00:00'`
  ];

  await Promise.all(
    shards.map(async sq => {
      let pt = '';
      do {
        const res = await driveApi(
          targetToken,
          `/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
            sq
          )}&fields=nextPageToken,files(id,name,mimeType,parents)${pt ? `&pageToken=${encodeURIComponent(pt)}` : ''}`
        );
        for (const f of res?.files || []) {
          if (f?.id && !seenIds.has(f.id)) {
            seenIds.add(f.id);
            ownedFiles.push(f);
          }
        }
        pt = res?.nextPageToken || '';
        if (onProgress) {
          onProgress({ message: `正在分析接收邮箱目录树结构（已读取 ${ownedFiles.length} 项）…` });
        }
      } while (pt);
    })
  );

  // 仅将「接收方当前已实际拥有 ('me' in owners)」的文件夹计入有效父文件夹集合！
  // （关键修复：若某子文件夹如《Suki 整理完毕》已归属接收方，但其上级文件夹仍归属旧账号，不能把未转移的上级算作已挂载父目录，否则该子文件夹会悬空变成 is:unorganized 并导致点开一闪而过！）
  const ownedFolderIds = new Set();
  for (const f of ownedFiles) {
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      ownedFolderIds.add(f.id);
    }
  }

  // 构建每个条目的「原始父文件夹 ID 映射表 (origParentMap)」，用于：
  // 1) 当子文件夹/子文件从原父目录脱落时，自动塞回原父文件夹；
  // 2) 当上级文件夹稍后也完成转移归属接收方时，将此前暂挂在 root 的子文件夹自动归位回上级文件夹内部！
  const origParentMap = new Map();
  const transferItemById = new Map();
  const isRootId = pid => !pid || pid === 'root' || pid === targetRootId || (sourceRootId && pid === sourceRootId);

  for (const it of transferItems || []) {
    if (!it?.id) continue;
    transferItemById.set(it.id, it);
    if (it.origParentId && !isRootId(it.origParentId)) {
      origParentMap.set(it.id, it.origParentId);
    } else if (Array.isArray(it.parents)) {
      const p = it.parents.find(pid => !isRootId(pid));
      if (p) {
        it.origParentId = p;
        origParentMap.set(it.id, p);
      }
    }
  }

  try {
    const snap = await getSnapshot();
    for (const sf of snap?.files || []) {
      if (sf?.id && !origParentMap.has(sf.id) && Array.isArray(sf.parents)) {
        const p = sf.parents.find(pid => !isRootId(pid));
        if (p) origParentMap.set(sf.id, p);
      }
    }
  } catch (_eSnap) {}

  // 对当前 ownedFiles 中仍保留着非 root 父目录引用的条目（例如上级文件夹尚在旧账号名下），先记下其原始父文件夹 ID
  for (const f of ownedFiles) {
    const parents = Array.isArray(f.parents) ? f.parents : [];
    const nonRootParent = parents.find(pid => !isRootId(pid));
    if (nonRootParent && !origParentMap.has(f.id)) {
      origParentMap.set(f.id, nonRootParent);
    }
    const tfItem = transferItemById.get(f.id);
    if (tfItem && nonRootParent && !tfItem.origParentId) {
      tfItem.origParentId = nonRootParent;
    }
  }

  // 单父目录模型安全移动辅助函数：自动携带 removeParents 替换旧父目录，彻底杜绝 Google Drive 403 Increasing the number of parents is not allowed
  async function moveDriveItemToParent(item, destParentId) {
    const effectiveDest = destParentId === 'root' ? targetRootId : destParentId;
    const curParents = Array.isArray(item.parents) ? item.parents.filter(Boolean) : [];
    const removeList = curParents.filter(pid => pid !== destParentId && pid !== effectiveDest);

    if (removeList.length > 0) {
      try {
        await driveApi(
          targetToken,
          `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
            destParentId
          )}&removeParents=${encodeURIComponent(removeList.join(','))}&supportsAllDrives=true&fields=id,parents`,
          { method: 'PATCH' }
        );
        item.parents = [effectiveDest];
        return { moved: true };
      } catch (_errWithRemove) {
        // fallback below
      }
    }

    try {
      await driveApi(
        targetToken,
        `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(destParentId)}&supportsAllDrives=true&fields=id,parents`,
        { method: 'PATCH' }
      );
      item.parents = [effectiveDest];
      return { moved: true };
    } catch (_errDirect) {
      // 查询实时 parents 后再精准替换或刷新元数据索引
      const liveMeta = await driveApi(
        targetToken,
        `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id,parents`
      );
      const liveParents = Array.isArray(liveMeta?.parents) ? liveMeta.parents.filter(Boolean) : [];
      if (liveParents.includes(effectiveDest) || liveParents.includes(destParentId)) {
        await driveApi(targetToken, `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id`, {
          method: 'PATCH',
          body: JSON.stringify({ name: item.name })
        });
        item.parents = liveParents;
        return { moved: false, refreshed: true };
      }
      const liveRemove = liveParents.filter(pid => pid !== destParentId && pid !== effectiveDest);
      const rmParam = liveRemove.length ? `&removeParents=${encodeURIComponent(liveRemove.join(','))}` : '';
      await driveApi(
        targetToken,
        `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(destParentId)}${rmParam}&supportsAllDrives=true&fields=id,parents`,
        { method: 'PATCH' }
      );
      item.parents = [effectiveDest];
      return { moved: true };
    }
  }

  // 队列 1：子目录脱钩归位（原父文件夹 origPid 现已归属接收方 ownedFolderIds，但当前条目不在 origPid 内）
  const restoreChildTasks = [];
  const handledIds = new Set();

  for (const f of ownedFiles) {
    const origPid = origParentMap.get(f.id);
    if (origPid && origPid !== f.id && ownedFolderIds.has(origPid)) {
      const parents = Array.isArray(f.parents) ? f.parents : [];
      if (!parents.includes(origPid)) {
        restoreChildTasks.push({ item: f, destParentId: origPid, kind: 'restore_child' });
        handledIds.add(f.id);
      }
    }
  }

  // 队列 2：顶层或悬空文件夹/文件挂入『我的云端硬盘 (root)』根目录
  // 条件：尚未在 targetRootId 下，且当前没有任何已归属接收方的父文件夹 (ownedFolderIds) 承载它
  const mountRootTasks = [];
  for (const f of ownedFiles) {
    if (handledIds.has(f.id)) continue;
    const parents = Array.isArray(f.parents) ? f.parents : [];
    if (parents.includes(targetRootId)) continue;
    const isInsideOwnedSubfolder = parents.some(pid => ownedFolderIds.has(pid));
    if (!isInsideOwnedSubfolder) {
      mountRootTasks.push({ item: f, destParentId: 'root', kind: 'mount_root' });
      handledIds.add(f.id);
    }
  }

  // 排序：文件夹优先于普通文件执行，确保父容器先就位
  const sortFoldersFirst = (a, b) => {
    const af = a.item.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    const bf = b.item.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    return af - bf;
  };
  restoreChildTasks.sort(sortFoldersFirst);
  mountRootTasks.sort(sortFoldersFirst);

  // 队列 3：对已在目录树中但可能因跨账号转移导致网页端视图索引卡死（点开一闪而过）的已拥有文件夹，执行一次轻量元数据刷新激活索引
  const refreshFolderTasks = [];
  for (const f of ownedFiles) {
    if (f.mimeType === 'application/vnd.google-apps.folder' && !handledIds.has(f.id)) {
      refreshFolderTasks.push({ item: f, kind: 'refresh_folder' });
    }
  }

  const allTasks = [...mountRootTasks, ...restoreChildTasks, ...refreshFolderTasks];
  const totalTasks = allTasks.length;

  let mountedCount = 0;
  let mountedFolders = 0;
  let mountedFiles = 0;
  let repairedChildCount = 0;
  let refreshedFolderCount = 0;
  let failedCount = 0;
  let cursor = 0;

  if (totalTasks > 0) {
    const workerCount = Math.min(Math.max(1, concurrency), totalTasks);
    const workers = Array.from({ length: workerCount }, async (_, workerIdx) => {
      if (workerIdx > 0) {
        await new Promise(r => setTimeout(r, workerIdx * 50));
      }
      while (cursor < totalTasks) {
        const idx = cursor++;
        if (idx >= totalTasks) break;
        const task = allTasks[idx];
        const { item, destParentId, kind } = task;

        try {
          if (kind === 'mount_root') {
            await moveDriveItemToParent(item, 'root');
            mountedCount++;
            if (item.mimeType === 'application/vnd.google-apps.folder') mountedFolders++;
            else mountedFiles++;
          } else if (kind === 'restore_child') {
            await moveDriveItemToParent(item, destParentId);
            repairedChildCount++;
          } else if (kind === 'refresh_folder') {
            const pId = Array.isArray(item.parents) && item.parents[0] ? item.parents[0] : '';
            if (pId && pId !== targetRootId && pId !== 'root') {
              await driveApi(
                targetToken,
                `/files/${encodeURIComponent(item.id)}?addParents=root&removeParents=${encodeURIComponent(pId)}&supportsAllDrives=true&fields=id`,
                { method: 'PATCH', body: JSON.stringify({ name: item.name }) }
              );
              await driveApi(
                targetToken,
                `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(pId)}&removeParents=root&supportsAllDrives=true&fields=id`,
                { method: 'PATCH', body: JSON.stringify({ name: item.name }) }
              );
            } else {
              await driveApi(targetToken, `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id`, {
                method: 'PATCH',
                body: JSON.stringify({ name: item.name })
              });
            }
            refreshedFolderCount++;
          }
        } catch (_err) {
          failedCount++;
        }

        const done = mountedCount + repairedChildCount + refreshedFolderCount + failedCount;
        if (onProgress && (done % 5 === 0 || done === totalTasks)) {
          onProgress({
            done,
            total: totalTasks,
            message: `📂 正在归位并刷新目录索引 (${done}/${totalTasks})：挂入根目录 ${mountedFolders} 个文件夹/${mountedFiles} 个文件 · 归位子项 ${repairedChildCount} 个 · 激活文件夹索引 ${refreshedFolderCount} 个…`
          });
        }
      }
    });
    await Promise.all(workers);
  }

  return {
    totalOwned: ownedFiles.length,
    totalTopLevel: mountRootTasks.length,
    mountedCount,
    mountedFolders,
    mountedFiles,
    repairedChildCount,
    refreshedFolderCount,
    failedCount
  };
}

/**
 * 定向扫描 1 个或多个指定的 Google Drive 源文件夹（递归遍历其内部所有子文件夹与文件），
 * 即使该文件夹在网页端点开一闪而过变空，API 仍能通过 '<folderId>' in parents 100% 扫出内部所有文件！
 * 若同时授权了来源邮箱与接收邮箱，自动双端合并扫描，不论文件当前归属新号还是旧号都能全部扫出。
 */
async function scanSpecificFoldersForTransfer({
  sourceEmail = '',
  targetEmail = '',
  folderIds = [],
  recursive = true,
  existingItems = [],
  mergeMode = false,
  onProgress = null,
  onPartialItems = null,
  shouldStop = null
}) {
  const cleanFolderIds = [...new Set((folderIds || []).map(x => String(x || '').trim()).filter(Boolean))];
  if (!cleanFolderIds.length) {
    throw new Error('请先输入或粘贴至少 1 个要扫描的「源文件夹」链接或文件夹 ID');
  }

  const normSource = normalizeEntry(sourceEmail);
  const normTarget = normalizeEntry(targetEmail);

  let sourceToken = '';
  let targetToken = '';
  if (normSource) {
    try {
      sourceToken = await getValidTokenForAccount(normSource, false, false);
    } catch (_e) {}
  }
  if (normTarget) {
    try {
      targetToken = await getValidTokenForAccount(normTarget, false, false);
    } catch (_e) {}
  }
  if (!sourceToken && normSource) {
    sourceToken = await getValidTokenForAccount(normSource, true, false);
  }
  if (!sourceToken && !targetToken && normTarget) {
    targetToken = await getValidTokenForAccount(normTarget, true, false);
  }

  const activeTokens = [...new Set([sourceToken, targetToken].filter(Boolean))];
  if (!activeTokens.length) {
    throw new Error('请先在上方选择并授权「来源邮箱」或「接收邮箱」后再扫描指定文件夹');
  }

  const fastFields =
    'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,ownedByMe,owners(emailAddress,displayName),parents)';
  const singleFields =
    'id,name,mimeType,webViewLink,modifiedTime,ownedByMe,owners(emailAddress,displayName),parents';

  const rawFiles = [];
  const seenFileIds = new Set();
  const rootFolderIdSet = new Set(cleanFolderIds);

  // 1. 先拉取指定的源文件夹自身元数据
  for (const fid of cleanFolderIds) {
    if (shouldStop && shouldStop()) break;
    for (const tk of activeTokens) {
      try {
        const meta = await driveApi(
          tk,
          `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=${encodeURIComponent(singleFields)}`
        );
        if (meta?.id && !seenFileIds.has(meta.id)) {
          meta._isScannedSourceRoot = true;
          seenFileIds.add(meta.id);
          rawFiles.push(meta);
        }
        break;
      } catch (_e) {
        // try next token
      }
    }
  }

  // 2. BFS 逐层扫描文件夹内部的全部子文件夹与文件（支持双账号令牌互补扫描，不漏任何跨账号子项）
  let currentLevelFolderIds = [...cleanFolderIds];
  const visitedFolders = new Set(cleanFolderIds);
  let depth = 0;
  let batchSeq = 0;

  while (currentLevelFolderIds.length > 0) {
    if (shouldStop && shouldStop()) break;
    depth++;
    const nextLevelFolderIds = [];
    const chunkSize = 15;

    for (let i = 0; i < currentLevelFolderIds.length; i += chunkSize) {
      if (shouldStop && shouldStop()) break;
      const chunk = currentLevelFolderIds.slice(i, i + chunkSize);
      const parentClause = chunk.map(id => `'${escapeDriveQueryLiteral(id)}' in parents`).join(' or ');
      const q = `trashed = false and mimeType != 'application/vnd.google-apps.shortcut' and (${parentClause})`;

      let addedInBatch = 0;
      await Promise.all(
        activeTokens.map(async tk => {
          let pageToken = '';
          do {
            if (shouldStop && shouldStop()) break;
            try {
              const res = await driveApi(
                tk,
                `/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
                  q
                )}&fields=${encodeURIComponent(fastFields)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
              );
              for (const f of res?.files || []) {
                if (!f?.id) continue;
                if (!seenFileIds.has(f.id)) {
                  seenFileIds.add(f.id);
                  rawFiles.push(f);
                  addedInBatch++;
                }
                if (
                  recursive &&
                  f.mimeType === 'application/vnd.google-apps.folder' &&
                  !visitedFolders.has(f.id)
                ) {
                  visitedFolders.add(f.id);
                  nextLevelFolderIds.push(f.id);
                }
              }
              pageToken = res?.nextPageToken || '';
            } catch (_errPage) {
              pageToken = '';
            }
          } while (pageToken);
        })
      );

      batchSeq++;
      if (onProgress) {
        onProgress({
          phase: 'scanning',
          page: batchSeq,
          count: rawFiles.length,
          message: `📁 正在扫描指定文件夹第 ${depth} 层目录（已发现 ${rawFiles.length} 项）…`
        });
      }

      if (onPartialItems && addedInBatch > 0) {
        const partialItems = buildTransferItemsFromRawFiles(rawFiles, {
          normSource: normSource || normTarget,
          normTarget,
          existingItems,
          mergeMode,
          includeHistoricalMerged: false
        });
        for (const it of partialItems) {
          if (rootFolderIdSet.has(it.id)) it.isScannedSourceRoot = true;
        }
        await onPartialItems(partialItems, {
          page: batchSeq,
          shardName: `📁第${depth}层`,
          pageAdded: addedInBatch,
          total: partialItems.length,
          hasMore: nextLevelFolderIds.length > 0 || i + chunkSize < currentLevelFolderIds.length
        });
      }
    }

    currentLevelFolderIds = nextLevelFolderIds;
  }

  const finalItems = buildTransferItemsFromRawFiles(rawFiles, {
    normSource: normSource || normTarget,
    normTarget,
    existingItems,
    mergeMode,
    includeHistoricalMerged: mergeMode
  });
  for (const it of finalItems) {
    if (rootFolderIdSet.has(it.id)) it.isScannedSourceRoot = true;
  }
  return finalItems;
}

/**
 * 将扫描出的源文件夹内部文件/子文件夹批量转移（移动）到指定的「目标文件夹 (destFolderId)」
 * 支持 3 种结构模式：
 * - 'keep_tree': 保持原内部子文件夹层级移入目标文件夹（若某旧子文件夹因跨号受限无法直接移动，自动在目标文件夹新建同名子文件夹承接）
 * - 'rebuild_folders': 在目标文件夹下按原层级镜像新建全新的同名子文件夹，并将所有文件移入新子文件夹（100% 根治旧文件夹点开闪退变空！）
 * - 'flatten_files': 忽略子目录结构，将所有文件直接提取平铺移入目标文件夹
 */
async function moveTransferItemsToTargetFolder({
  sourceToken = '',
  targetToken = '',
  sourceEmail = '',
  targetEmail = '',
  items = [],
  sourceFolderIds = [],
  destFolderId = '',
  structureMode = 'keep_tree',
  concurrency = 8,
  shouldStop = null,
  onProgress = null,
  onLog = null
}) {
  const cleanDestId = String(destFolderId || '').trim();
  if (!cleanDestId) {
    throw new Error('请先在右侧输入或粘贴「目标文件夹」链接或文件夹 ID');
  }
  if (!Array.isArray(items) || !items.length) {
    throw new Error('当前列表中没有可移动的文件，请先扫描指定源文件夹或全盘文件');
  }

  const tokens = [...new Set([targetToken, sourceToken].filter(Boolean))];
  if (!tokens.length) {
    throw new Error('请先授权接收邮箱或来源邮箱后再执行转移到目标文件夹');
  }
  const primaryToken = targetToken || sourceToken;

  // 1. 校验目标文件夹是否存在，并自动打通来源号与接收号对目标文件夹的协作写入权限
  let destFolderName = cleanDestId === 'root' ? '我的云端硬盘 (root)' : cleanDestId;
  if (cleanDestId !== 'root') {
    let destMeta = null;
    for (const tk of tokens) {
      try {
        destMeta = await driveApi(
          tk,
          `/files/${encodeURIComponent(cleanDestId)}?supportsAllDrives=true&fields=id,name,mimeType,owners(emailAddress)`
        );
        if (destMeta?.id) break;
      } catch (_e) {}
    }
    if (!destMeta?.id) {
      throw new Error(`无法访问目标文件夹 (${cleanDestId})，请确认目标文件夹链接/ID 正确且当前授权账号有权限访问`);
    }
    if (destMeta.mimeType && destMeta.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`您输入的目标 ID (${destMeta.name || cleanDestId}) 不是一个文件夹，请粘贴正确的目标文件夹链接`);
    }
    destFolderName = destMeta.name || cleanDestId;

    // 若来源号和接收号都已授权，确保双方都对目标文件夹拥有 writer 权限，以便双方名下的文件都能直接移入目标文件夹
    const destOwner = normalizeEntry(destMeta.owners?.[0]?.emailAddress || '');
    const normSource = normalizeEntry(sourceEmail);
    const normTarget = normalizeEntry(targetEmail);
    if (targetToken && normSource && destOwner === normTarget && normSource !== normTarget) {
      try {
        await driveApi(
          targetToken,
          `/files/${encodeURIComponent(cleanDestId)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
          {
            method: 'POST',
            body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normSource })
          }
        );
      } catch (_e) {}
    } else if (sourceToken && normTarget && destOwner === normSource && normSource !== normTarget) {
      try {
        await driveApi(
          sourceToken,
          `/files/${encodeURIComponent(cleanDestId)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
          {
            method: 'POST',
            body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normTarget })
          }
        );
      } catch (_e) {}
    }
  }

  // 2. 识别「源根容器文件夹集合 (sourceRootSet)」：
  // 如果用户指定了源文件夹 S，我们是把 S 里面的子文件夹和文件移到目标文件夹 destFolderId，而不是把 S 移进自己
  const sourceRootSet = new Set((sourceFolderIds || []).filter(Boolean));
  for (const it of items) {
    if (it.isScannedSourceRoot) sourceRootSet.add(it.id);
  }
  if (sourceRootSet.has(cleanDestId)) {
    throw new Error('「源文件夹」与「目标文件夹」不能是同一个文件夹！请粘贴另一个目标文件夹链接');
  }

  // 判断源根文件夹内部是否有子项；如果有子项，则排除源根外壳本身，只移动其内部子文件夹与文件
  const hasChildrenOfSourceRoots =
    sourceRootSet.size > 0 && items.some(it => !sourceRootSet.has(it.id));

  // 单条目跨令牌安全移动辅助函数（自动携带 removeParents 替换原父目录）
  async function moveSingleItem(item, newParentId) {
    const normItemOwner = normalizeEntry(item.currentOwner || '');
    const normTarget = normalizeEntry(targetEmail);
    const orderedTokens =
      normItemOwner && normTarget && normItemOwner === normTarget && targetToken
        ? [...new Set([targetToken, sourceToken].filter(Boolean))]
        : [...new Set([sourceToken, targetToken].filter(Boolean))];

    let lastErr = null;
    for (const tk of orderedTokens) {
      try {
        const curParents = Array.isArray(item.parents) ? item.parents.filter(Boolean) : [];
        const rmList = curParents.filter(pid => pid !== newParentId);
        if (rmList.length > 0) {
          try {
            await driveApi(
              tk,
              `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
                newParentId
              )}&removeParents=${encodeURIComponent(rmList.join(','))}&supportsAllDrives=true&fields=id,parents`,
              { method: 'PATCH' }
            );
            item.parents = [newParentId];
            return { moved: true };
          } catch (_e1) {
            // fallback to live parents check
          }
        }

        const liveMeta = await driveApi(
          tk,
          `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id,parents`
        );
        const liveParents = Array.isArray(liveMeta?.parents) ? liveMeta.parents.filter(Boolean) : [];
        if (liveParents.includes(newParentId)) {
          // 关键修复：若文件原本就在该文件夹内但网页端一闪而过变空，单纯 PATCH {name} 不会触发 Google 重建父子边索引！
          // 必须执行真正的「两步移出再移回 (removeParents ➔ addParents)」才能强制 Google Drive 重建目录视图索引！
          if (newParentId !== 'root') {
            try {
              await driveApi(
                tk,
                `/files/${encodeURIComponent(item.id)}?addParents=root&removeParents=${encodeURIComponent(
                  newParentId
                )}&supportsAllDrives=true&fields=id,parents`,
                { method: 'PATCH', body: JSON.stringify({ trashed: false }) }
              );
              await driveApi(
                tk,
                `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
                  newParentId
                )}&removeParents=root&supportsAllDrives=true&fields=id,parents`,
                { method: 'PATCH', body: JSON.stringify({ trashed: false }) }
              );
            } catch (_bounceErr) {
              await driveApi(tk, `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id`, {
                method: 'PATCH',
                body: JSON.stringify({ trashed: false, name: item.name })
              });
            }
          }
          item.parents = [newParentId];
          return { moved: true, alreadyInDest: true };
        }
        const liveRm = liveParents.filter(pid => pid !== newParentId);
        const rmQuery = liveRm.length ? `&removeParents=${encodeURIComponent(liveRm.join(','))}` : '';
        await driveApi(
          tk,
          `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
            newParentId
          )}${rmQuery}&supportsAllDrives=true&fields=id,parents`,
          { method: 'PATCH', body: JSON.stringify({ trashed: false }) }
        );
        item.parents = [newParentId];
        return { moved: true };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('移动文件失败');
  }

  let movedFolders = 0;
  let createdFolders = 0;
  let movedFiles = 0;
  let failedCount = 0;

  // 建立「原父文件夹 ID ➔ 目标父文件夹 ID」重定向映射
  const folderRedirect = new Map();
  for (const rid of sourceRootSet) {
    folderRedirect.set(rid, cleanDestId);
  }

  const candidateItems = items.filter(it => {
    if (!it?.id || it.id === cleanDestId) return false;
    if (hasChildrenOfSourceRoots && sourceRootSet.has(it.id)) return false;
    return true;
  });

  const folderItems = candidateItems
    .filter(it => it.mimeType === 'application/vnd.google-apps.folder')
    .sort((a, b) => (a.folderDepth || 0) - (b.folderDepth || 0));
  const fileItems = candidateItems.filter(it => it.mimeType !== 'application/vnd.google-apps.folder');

  // 阶段 A：处理子文件夹结构
  // 关键升级：无论是 keep_tree 还是 rebuild_folders，只要存在子文件夹，统一在目标文件夹下创建干净的同名子文件夹并把内部文件移入新子文件夹！
  // 这样每个文件都会经历一次真实的 addParents=新子夹&removeParents=旧子夹，100% 杜绝旧文件夹视图索引损坏导致点开一闪而过的问题！
  if ((structureMode === 'keep_tree' || structureMode === 'rebuild_folders') && folderItems.length > 0) {
    if (onLog) {
      await onLog(
        `✨ 正在目标文件夹《${destFolderName}》下按原目录树创建 ${folderItems.length} 个干净同名子文件夹（彻底根治旧文件夹闪退看不见）…`
      );
    }
    for (let i = 0; i < folderItems.length; i++) {
      if (shouldStop && shouldStop()) break;
      const sf = folderItems[i];
      const origPid = (sf.parents || [])[0] || '';
      const targetParentId = folderRedirect.get(origPid) || cleanDestId;
      try {
        const created = await driveApi(
          primaryToken,
          `/files?supportsAllDrives=true&fields=id,name,parents`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: sf.name || '子文件夹',
              mimeType: 'application/vnd.google-apps.folder',
              parents: [targetParentId]
            })
          }
        );
        if (created?.id) {
          folderRedirect.set(sf.id, created.id);
          createdFolders++;
        }
      } catch (err) {
        failedCount++;
        if (onLog) await onLog(`❌ 创建子文件夹《${sf.name}》失败: ${err.message}`);
      }
      if (onProgress) {
        onProgress({
          done: i + 1,
          total: folderItems.length + fileItems.length,
          message: `✨ 正在目标文件夹构建子目录层级 (${i + 1}/${folderItems.length}): 《${sf.name}》…`
        });
      }
    }
  }

  // 阶段 B：多线程并发将文件移入对应的目标文件夹（或对应的目标子文件夹）
  let fileCursor = 0;
  const totalFiles = fileItems.length;
  if (totalFiles > 0) {
    const workerCount = Math.min(Math.max(1, concurrency), totalFiles);
    const workers = Array.from({ length: workerCount }, async (_, workerIdx) => {
      if (workerIdx > 0) {
        await new Promise(r => setTimeout(r, workerIdx * 55));
      }
      while (fileCursor < totalFiles) {
        if (shouldStop && shouldStop()) break;
        const idx = fileCursor++;
        if (idx >= totalFiles) break;
        const file = fileItems[idx];
        const origPid = (file.parents || [])[0] || '';

        let destPid = cleanDestId;
        if (structureMode === 'flatten_files') {
          destPid = cleanDestId;
        } else if (folderRedirect.has(origPid)) {
          destPid = folderRedirect.get(origPid);
        } else if (origPid && !sourceRootSet.has(origPid)) {
          destPid = origPid;
        }

        try {
          await moveSingleItem(file, destPid);
          movedFiles++;
          file.statusText = `📂 已移入目标文件夹《${destFolderName}》`;
          file.updatedAt = new Date().toISOString();
        } catch (err) {
          failedCount++;
          file.error = err.message;
          if (onLog) {
            await onLog(`❌ 移动文件《${file.name}》失败: ${err.message}`);
          }
        }

        const doneFiles = movedFiles + failedCount;
        if (onProgress && (doneFiles % 4 === 0 || doneFiles === totalFiles)) {
          onProgress({
            done: folderItems.length + doneFiles,
            total: folderItems.length + totalFiles,
            message: `📂 正在将文件移入《${destFolderName}》(${doneFiles}/${totalFiles})：已成功移入 ${movedFiles} 个文件…`
          });
        }
      }
    });
    await Promise.all(workers);
  }

  return {
    destFolderId: cleanDestId,
    destFolderName,
    movedFolders,
    createdFolders,
    movedFiles,
    failedCount,
    totalProcessed: movedFolders + createdFolders + movedFiles + failedCount
  };
}

/**
 * 扫描并一键恢复「回收站 (Trash, trashed=true)」、「疑似被 Google 误判归入『垃圾内容 (Spam)』隐身文件」以及「文件夹内点开一闪而过消失 (Index Desync)」的文件！
 * 工作原理：
 * 1. 双端扫描接收邮箱与来源邮箱的回收站 (q="trashed = true")，自动设置 trashed: false 恢复；
 * 2. 双端扫描正常文件与文件夹（不限 'me' in owners，覆盖父文件夹归新号、子文件仍归旧号的跨号断层文件）；
 * 3. 对游离脱钩文件执行 addParents 挂回原父目录；对已在文件夹内但点开一闪而过消失的文件，执行真正的「两步移出再移回 (removeParents ➔ addParents)」重建 Google 目录索引！
 */
async function scanAndRestoreSpamAndTrashItems({
  targetToken = '',
  sourceToken = '',
  targetEmail = '',
  sourceEmail = '',
  transferItems = [],
  fallbackDestFolderId = '',
  searchKeyword = '',
  onlyRootFolderId = '',
  concurrency = 8,
  shouldStop = null,
  onProgress = null,
  onLog = null
}) {
  const activeTokens = [...new Set([targetToken, sourceToken].filter(Boolean))];
  if (!activeTokens.length) {
    throw new Error('请先在上方选择并授权「接收邮箱」或「来源邮箱」后再执行扫描恢复');
  }

  let targetRootId = 'root';
  let sourceRootId = '';
  if (targetToken) {
    try {
      const rm = await driveApi(targetToken, '/files/root?fields=id');
      targetRootId = rm?.id || 'root';
    } catch (_e) {}
  }
  if (sourceToken) {
    try {
      const srm = await driveApi(sourceToken, '/files/root?fields=id');
      sourceRootId = srm?.id || '';
    } catch (_e) {}
  }

  const isRootId = pid => !pid || pid === 'root' || pid === targetRootId || (sourceRootId && pid === sourceRootId);
  const cleanKw = String(searchKeyword || '').trim().toLowerCase();

  // 1. 记录已知的原始父目录关系 (origParentMap) 与文件夹名称映射
  const origParentMap = new Map();
  const knownItemMap = new Map();
  const folderNameMap = new Map();

  for (const it of transferItems || []) {
    if (!it?.id) continue;
    knownItemMap.set(it.id, it);
    if (it.mimeType === 'application/vnd.google-apps.folder' && it.name) {
      folderNameMap.set(it.id, it.name);
    }
    if (it.origParentId && !isRootId(it.origParentId)) {
      origParentMap.set(it.id, it.origParentId);
    } else if (Array.isArray(it.parents)) {
      const p = it.parents.find(pid => !isRootId(pid));
      if (p) origParentMap.set(it.id, p);
    }
  }
  try {
    const snap = await getSnapshot();
    for (const sf of snap?.files || []) {
      if (!sf?.id) continue;
      if (!knownItemMap.has(sf.id)) knownItemMap.set(sf.id, sf);
      if (sf.mimeType === 'application/vnd.google-apps.folder' && sf.name) {
        folderNameMap.set(sf.id, sf.name);
      }
      if (!origParentMap.has(sf.id) && Array.isArray(sf.parents)) {
        const p = sf.parents.find(pid => !isRootId(pid));
        if (p) origParentMap.set(sf.id, p);
      }
    }
  } catch (_eSnap) {}

  // 2. 若用户在搜索框输入了文件名关键词（如 Candidates），优先在双端执行实时精准搜寻（含回收站与全盘共享）并打印其真实位置
  const keywordMatchedItems = [];
  if (cleanKw) {
    const safeKw = cleanKw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const kwFields = 'files(id,name,mimeType,webViewLink,trashed,owners(emailAddress,displayName),parents)';
    await Promise.all(
      activeTokens.map(async tk => {
        try {
          const res = await driveApi(
            tk,
            `/files?pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
              `name contains '${safeKw}' and mimeType != 'application/vnd.google-apps.shortcut'`
            )}&fields=${encodeURIComponent(kwFields)}`
          );
          for (const f of res?.files || []) {
            if (
              f?.id &&
              !keywordMatchedItems.some(x => x.id === f.id) &&
              ((f.name || '').toLowerCase().includes(cleanKw) || f.id.toLowerCase().includes(cleanKw))
            ) {
              keywordMatchedItems.push(f);
            }
          }
        } catch (_e) {}
      })
    );
    if (keywordMatchedItems.length > 0 && onLog) {
      for (const kf of keywordMatchedItems.slice(0, 15)) {
        const pid = (kf.parents || [])[0] || origParentMap.get(kf.id) || '';
        const pName = folderNameMap.get(pid) || (isRootId(pid) ? '我的云端硬盘(root)' : pid || '无父目录(游离状态)');
        const ownerEm = kf.owners?.[0]?.emailAddress || '未知所有者';
        await onLog(
          `🎯 定位到文件《${kf.name}》➔ 当前所有者: ${ownerEm} | 所在父目录: 《${pName}》 | 回收站: ${
            kf.trashed ? '是(trashed)' : '否'
          } | 链接: https://drive.google.com/open?id=${kf.id}`
        );
      }
    }
  }

  // 3. 扫描双端「回收站 (trashed = true)」中的全部文件与文件夹
  if (onProgress) {
    onProgress({ message: '🗑️ 正在扫描新旧账号『回收站 (trashed=true)』中的文件…' });
  }
  const trashedItems = [];
  const seenTrashedIds = new Set();
  const trashFields = 'nextPageToken,files(id,name,mimeType,webViewLink,trashed,owners(emailAddress,displayName),parents)';

  await Promise.all(
    activeTokens.map(async tk => {
      let pt = '';
      do {
        if (shouldStop && shouldStop()) break;
        try {
          const res = await driveApi(
            tk,
            `/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
              "trashed = true and mimeType != 'application/vnd.google-apps.shortcut'"
            )}&fields=${encodeURIComponent(trashFields)}${pt ? `&pageToken=${encodeURIComponent(pt)}` : ''}`
          );
          for (const f of res?.files || []) {
            if (f?.id && !seenTrashedIds.has(f.id)) {
              seenTrashedIds.add(f.id);
              trashedItems.push(f);
            }
          }
          pt = res?.nextPageToken || '';
        } catch (_e) {
          pt = '';
        }
      } while (pt);
    })
  );

  // 4. 双端扫描正常可见 (trashed = false) 的文件夹与文件（覆盖接收号与来源号，解决「文件夹归新号、内部文件仍归旧号」导致点开一闪而过的问题）
  if (onProgress) {
    onProgress({ message: `🔍 已发现回收站文件 ${trashedItems.length} 项，正在双端扫描排查『一闪而过消失 / 垃圾内容隐身』文件…` });
  }
  const visibleIds = new Set();
  const activeFolderIds = new Set();
  const targetOwnedFolderIds = new Set();
  const visibleFilesById = new Map();

  for (const tk of activeTokens) {
    const isTargetTk = tk === targetToken;
    const baseQ = "trashed = false and 'me' in owners";
    const shards = [
      `${baseQ} and mimeType = 'application/vnd.google-apps.folder'`,
      `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2025-01-01T00:00:00'`,
      `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime >= '2023-01-01T00:00:00' and modifiedTime < '2025-01-01T00:00:00'`,
      `${baseQ} and mimeType != 'application/vnd.google-apps.folder' and modifiedTime < '2023-01-01T00:00:00'`
    ];
    await Promise.all(
      shards.map(async sq => {
        let pt = '';
        do {
          if (shouldStop && shouldStop()) break;
          try {
            const res = await driveApi(
              tk,
              `/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(
                sq
              )}&fields=nextPageToken,files(id,name,mimeType,owners(emailAddress),parents)${
                pt ? `&pageToken=${encodeURIComponent(pt)}` : ''
              }`
            );
            for (const f of res?.files || []) {
              if (!f?.id) continue;
              if (isTargetTk) visibleIds.add(f.id);
              if (!visibleFilesById.has(f.id) || isTargetTk) {
                visibleFilesById.set(f.id, f);
              }
              if (f.mimeType === 'application/vnd.google-apps.folder') {
                activeFolderIds.add(f.id);
                if (f.name) folderNameMap.set(f.id, f.name);
                if (isTargetTk) targetOwnedFolderIds.add(f.id);
              }
              const nonRootP = (f.parents || []).find(pid => !isRootId(pid));
              if (nonRootP && !origParentMap.has(f.id)) {
                origParentMap.set(f.id, nonRootP);
              }
            }
            pt = res?.nextPageToken || '';
          } catch (_e) {
            pt = '';
          }
        } while (pt);
      })
    );
  }

  // 5. 构建三级修复队列：
  // 队列 A (trash): 回收站中的文件
  // 队列 B (spam_or_orphan): 在正常列表中消失（被塞进 Spam）或失去父目录悬空的文件
  // 队列 C (flash_in_folder): 位于文件夹内部，但因跨账号所有权变更/父子不同步导致在网页端「点开一闪就没了」的文件（执行两步移出再移回重绑索引！）
  const spamOrHiddenCandidates = [];
  const flashInFolderCandidates = [];
  const queuedIds = new Set(seenTrashedIds);

  // 先把用户搜索关键词命中的文件放入最高优先级
  for (const kf of keywordMatchedItems) {
    if (queuedIds.has(kf.id)) continue;
    queuedIds.add(kf.id);
    if (kf.trashed) {
      trashedItems.unshift(kf);
    } else {
      flashInFolderCandidates.unshift(kf);
    }
  }

  const matchesFilter = item => {
    if (onlyRootFolderId && onlyRootFolderId !== 'all') {
      const rf = item.rootFolderId || '__root_loose__';
      if (rf !== onlyRootFolderId && item.id !== onlyRootFolderId && !(item.parents || []).includes(onlyRootFolderId)) {
        return false;
      }
    }
    if (cleanKw) {
      const hay = `${item.name || ''} ${item.id || ''}`.toLowerCase();
      if (!hay.includes(cleanKw)) return false;
    }
    return true;
  };

  for (const [id, knownIt] of knownItemMap.entries()) {
    if (queuedIds.has(id) || !matchesFilter(knownIt)) continue;
    const vFile = visibleFilesById.get(id);
    if (!vFile) {
      if (!targetToken || knownIt.stage === 'completed' || knownIt.stage === 'pending_accept') {
        spamOrHiddenCandidates.push(knownIt);
        queuedIds.add(id);
      }
    } else {
      const merged = { ...knownIt, ...vFile };
      const parents = Array.isArray(vFile.parents) ? vFile.parents : [];
      const inRoot = parents.includes(targetRootId);
      const inTargetFolder = parents.some(pid => targetOwnedFolderIds.has(pid));
      const inAnyActiveFolder = parents.some(pid => activeFolderIds.has(pid));

      if (!inRoot && !inAnyActiveFolder) {
        spamOrHiddenCandidates.push(merged);
        queuedIds.add(id);
      } else if (vFile.mimeType !== 'application/vnd.google-apps.folder' && (inTargetFolder || inAnyActiveFolder)) {
        // 位于文件夹内的子文件：通过两步移出再移回重绑父子索引，解决点开文件夹一闪而过消失！
        flashInFolderCandidates.push(merged);
        queuedIds.add(id);
      }
    }
  }

  for (const [id, vFile] of visibleFilesById.entries()) {
    if (queuedIds.has(id) || !matchesFilter(vFile)) continue;
    const parents = Array.isArray(vFile.parents) ? vFile.parents : [];
    const inRoot = parents.includes(targetRootId);
    const inAnyActiveFolder = parents.some(pid => activeFolderIds.has(pid));
    if (!inRoot && !inAnyActiveFolder) {
      spamOrHiddenCandidates.push(vFile);
      queuedIds.add(id);
    } else if (vFile.mimeType !== 'application/vnd.google-apps.folder' && inAnyActiveFolder) {
      flashInFolderCandidates.push(vFile);
      queuedIds.add(id);
    }
  }

  const sortFoldersFirst = (a, b) => {
    const af = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    const bf = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    return af - bf;
  };
  trashedItems.sort(sortFoldersFirst);
  spamOrHiddenCandidates.sort(sortFoldersFirst);

  // 优先修复「父文件夹已归属接收号 (targetOwnedFolderIds)」内部的一闪而过文件！
  flashInFolderCandidates.sort((a, b) => {
    const aInTarget = (a.parents || []).some(pid => targetOwnedFolderIds.has(pid)) ? 0 : 1;
    const bInTarget = (b.parents || []).some(pid => targetOwnedFolderIds.has(pid)) ? 0 : 1;
    return aInTarget - bInTarget;
  });

  const allRestoreTasks = [
    ...trashedItems.map(item => ({ item, sourceType: 'trash' })),
    ...spamOrHiddenCandidates.map(item => ({ item, sourceType: 'spam_or_orphan' })),
    ...flashInFolderCandidates.map(item => ({ item, sourceType: 'flash_in_folder' }))
  ];

  const totalTasks = allRestoreTasks.length;
  let restoredFromTrash = 0;
  let rescuedFromSpamOrOrphan = 0;
  let fixedFlashInFolder = 0;
  let failedCount = 0;
  let cursor = 0;

  const cleanFallbackDest = String(fallbackDestFolderId || '').trim();
  const normTargetEmail = normalizeEntry(targetEmail);
  const normSourceEmail = normalizeEntry(sourceEmail);
  const ensuredFolderBridge = new Set();

  if (totalTasks > 0) {
    if (onLog) {
      await onLog(
        `🛡️ 扫描发现待修复项共 ${totalTasks} 个（🗑️ 回收站 ${trashedItems.length} 项 · 👻 隐身/脱钩 ${spamOrHiddenCandidates.length} 项 · ⚡ 文件夹内一闪而过待重绑索引 ${flashInFolderCandidates.length} 项），启动 ${concurrency} 线程并发修复…`
      );
    }

    const workerCount = Math.min(Math.max(1, concurrency), totalTasks);
    const workers = Array.from({ length: workerCount }, async (_, workerIdx) => {
      if (workerIdx > 0) {
        await new Promise(r => setTimeout(r, workerIdx * 55));
      }
      while (cursor < totalTasks) {
        if (shouldStop && shouldStop()) break;
        const idx = cursor++;
        if (idx >= totalTasks) break;
        const { item, sourceType } = allRestoreTasks[idx];

        const curParents = Array.isArray(item.parents) ? item.parents.filter(Boolean) : [];
        const origPid = origParentMap.get(item.id) || curParents.find(pid => !isRootId(pid)) || '';
        const destParentId = cleanFallbackDest
          ? cleanFallbackDest
          : origPid && activeFolderIds.has(origPid)
          ? origPid
          : 'root';
        const effectiveDest = destParentId === 'root' ? targetRootId : destParentId;

        // 若父文件夹归接收号、子文件归来源号（或反之），自动为双方打通该父文件夹与子文件的 writer 权限，消除跨账号权限断层导致的闪退隐藏
        if (sourceToken && targetToken && normTargetEmail && normSourceEmail && normTargetEmail !== normSourceEmail) {
          if (effectiveDest !== 'root' && effectiveDest !== targetRootId && !ensuredFolderBridge.has(effectiveDest)) {
            ensuredFolderBridge.add(effectiveDest);
            try {
              await driveApi(
                targetToken,
                `/files/${encodeURIComponent(effectiveDest)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
                {
                  method: 'POST',
                  body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normSourceEmail })
                }
              );
            } catch (_eBridge1) {}
            try {
              await driveApi(
                sourceToken,
                `/files/${encodeURIComponent(effectiveDest)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
                {
                  method: 'POST',
                  body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: normTargetEmail })
                }
              );
            } catch (_eBridge2) {}
          }
        }

        let ok = false;
        for (const tk of activeTokens) {
          try {
            const alreadyInDest =
              curParents.includes(destParentId) || curParents.includes(effectiveDest);

            if (alreadyInDest && effectiveDest !== targetRootId && destParentId !== 'root') {
              // 核心两步移出再移回重绑（与网页端手动「整理->移出再移回原文件夹」完全等价，强制 Google 重建目录视图索引，彻底解决点开一闪就没了！）
              await driveApi(
                tk,
                `/files/${encodeURIComponent(item.id)}?addParents=root&removeParents=${encodeURIComponent(
                  effectiveDest
                )}&supportsAllDrives=true&fields=id,parents`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ trashed: false })
                }
              );
              await driveApi(
                tk,
                `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
                  effectiveDest
                )}&removeParents=root&supportsAllDrives=true&fields=id,parents`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ trashed: false })
                }
              );
            } else {
              const rmList = curParents.filter(pid => pid !== destParentId && pid !== effectiveDest);
              const rmQuery = rmList.length ? `&removeParents=${encodeURIComponent(rmList.join(','))}` : '';
              try {
                await driveApi(
                  tk,
                  `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
                    destParentId
                  )}${rmQuery}&supportsAllDrives=true&fields=id,trashed,parents`,
                  {
                    method: 'PATCH',
                    body: JSON.stringify({ trashed: false })
                  }
                );
              } catch (_eInner) {
                // 查询实时 parents 后执行两步重绑或替换
                const liveMeta = await driveApi(
                  tk,
                  `/files/${encodeURIComponent(item.id)}?supportsAllDrives=true&fields=id,parents`
                );
                const liveP = Array.isArray(liveMeta?.parents) ? liveMeta.parents.filter(Boolean) : [];
                if (liveP.includes(effectiveDest) && effectiveDest !== targetRootId) {
                  await driveApi(
                    tk,
                    `/files/${encodeURIComponent(item.id)}?addParents=root&removeParents=${encodeURIComponent(
                      effectiveDest
                    )}&supportsAllDrives=true&fields=id,parents`,
                    { method: 'PATCH', body: JSON.stringify({ trashed: false }) }
                  );
                  await driveApi(
                    tk,
                    `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
                      effectiveDest
                    )}&removeParents=root&supportsAllDrives=true&fields=id,parents`,
                    { method: 'PATCH', body: JSON.stringify({ trashed: false }) }
                  );
                } else {
                  const liveRm = liveP.filter(pid => pid !== destParentId && pid !== effectiveDest);
                  const liveRmQ = liveRm.length ? `&removeParents=${encodeURIComponent(liveRm.join(','))}` : '';
                  await driveApi(
                    tk,
                    `/files/${encodeURIComponent(item.id)}?addParents=${encodeURIComponent(
                      destParentId
                    )}${liveRmQ}&supportsAllDrives=true&fields=id,trashed,parents`,
                    { method: 'PATCH', body: JSON.stringify({ trashed: false }) }
                  );
                }
              }
            }

            ok = true;
            if (item.mimeType === 'application/vnd.google-apps.folder') {
              activeFolderIds.add(item.id);
            }
            break;
          } catch (_errTk) {
            // try next token
          }
        }

        if (ok) {
          const pName = folderNameMap.get(effectiveDest) || (effectiveDest === targetRootId ? '我的云端硬盘' : effectiveDest);
          if (sourceType === 'trash') restoredFromTrash++;
          else if (sourceType === 'spam_or_orphan') rescuedFromSpamOrOrphan++;
          else fixedFlashInFolder++;

          const tfItem = knownItemMap.get(item.id);
          if (tfItem) {
            tfItem.statusText = `✅ 已重绑显示于《${pName}》`;
            tfItem.updatedAt = new Date().toISOString();
          }
          if (onLog && (restoredFromTrash + rescuedFromSpamOrOrphan + fixedFlashInFolder <= 25 || cleanKw)) {
            await onLog(
              `✅ 已修复《${item.name}》➔ 现已稳固显示于文件夹《${pName}》(https://drive.google.com/open?id=${item.id})`
            );
          }
        } else {
          failedCount++;
        }

        const done = restoredFromTrash + rescuedFromSpamOrOrphan + fixedFlashInFolder + failedCount;
        if (onProgress && (done % 4 === 0 || done === totalTasks)) {
          onProgress({
            done,
            total: totalTasks,
            message: `🛡️ 正在修复 (${done}/${totalTasks})：回收站恢复 ${restoredFromTrash} · 隐身找回 ${rescuedFromSpamOrOrphan} · 一闪而过重绑 ${fixedFlashInFolder}…`
          });
        }
      }
    });
    await Promise.all(workers);
  }

  return {
    trashedFound: trashedItems.length,
    spamOrHiddenFound: spamOrHiddenCandidates.length,
    flashInFolderFound: flashInFolderCandidates.length,
    restoredFromTrash,
    rescuedFromSpamOrOrphan,
    fixedFlashInFolder,
    failedCount,
    totalFound: totalTasks
  };
}

// ============================================================================
// 阶段二：外部域名聚合审计与离职人员一键全盘清退引擎
// ============================================================================

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'qq.com',
  'foxmail.com',
  'vip.qq.com',
  '163.com',
  '126.com',
  'yeah.net',
  'vip.163.com',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'aliyun.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'yahoo.co.jp',
  'yahoo.com.hk',
  'yahoo.com.tw',
  'ymail.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'zoho.com',
  'gmx.com',
  'mail.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'yandex.ru',
  'yandex.com'
]);

/**
 * 安全提取邮箱的小写域名（如 'alice@Company.com' -> 'company.com'）
 */
function extractEmailDomain(email = '') {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw) return '';
  const angleMatch = raw.match(/<([^<>]+)>/);
  const target = (angleMatch ? angleMatch[1] : raw).trim();
  const atIdx = target.lastIndexOf('@');
  if (atIdx === -1) return '';
  if (atIdx === 0 && target.length > 1) {
    const bareDom = target.slice(1).trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(bareDom) ? bareDom : '';
  }
  const localPart = target.slice(0, atIdx).trim();
  const domainPart = target.slice(atIdx + 1).trim();
  if (!localPart || !domainPart) return '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainPart)) return '';
  return domainPart;
}

/**
 * 外部域名聚合审计摘要：
 * 自动从已授权账号识别内部企业域名（排除公共邮箱域），聚合全部非所有者协作者并按风险与暴露文件数排序
 */
function buildDomainAuditSummary(
  files = [],
  directory = DEFAULT_DIRECTORY,
  policy = DEFAULT_POLICY,
  authorizedAccounts = []
) {
  const internalDomains = new Set();

  for (const acc of authorizedAccounts || []) {
    const accEmail = typeof acc === 'string' ? acc : acc?.email || '';
    const dom = extractEmailDomain(accEmail);
    if (dom && !PUBLIC_EMAIL_DOMAINS.has(dom)) {
      internalDomains.add(dom);
    }
  }

  // 若调用方未显式传入 authorizedAccounts，从当前已扫描自有文件的 ownerAccount 兜底推断企业自有域名
  if (internalDomains.size === 0 && Array.isArray(files)) {
    const ownerDomainCounts = new Map();
    for (const file of files) {
      if (!file) continue;
      const ownerCandidate = file.ownerAccount || (file.ownedByMe ? file.owners?.[0]?.emailAddress : '') || '';
      const dom = extractEmailDomain(ownerCandidate);
      if (dom && !PUBLIC_EMAIL_DOMAINS.has(dom)) {
        ownerDomainCounts.set(dom, (ownerDomainCounts.get(dom) || 0) + 1);
      }
    }
    for (const [dom] of ownerDomainCounts.entries()) {
      internalDomains.add(dom);
    }
  }

  const contactLookup = buildContactLookup(directory || DEFAULT_DIRECTORY);
  const activePolicy = policy || DEFAULT_POLICY;
  const domainBuckets = new Map();

  for (const file of files || []) {
    if (!file || !file.id) continue;
    const owner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    const seenUserInFile = new Set();

    for (const p of file.permissions || []) {
      if (!p || p.role === 'owner' || (p.type !== 'user' && p.type !== 'group')) continue;
      const email = normalizeEntry(p.emailAddress || '');
      if (!email || email === owner) continue;
      const domain = extractEmailDomain(email);
      if (!domain) continue;

      let bucket = domainBuckets.get(domain);
      if (!bucket) {
        const category = PUBLIC_EMAIL_DOMAINS.has(domain)
          ? 'personal'
          : internalDomains.has(domain)
            ? 'internal'
            : 'external';
        bucket = {
          domain,
          category,
          usersMap: new Map(),
          fileIds: new Set(),
          writerFileIds: new Set(),
          readerFileIds: new Set()
        };
        domainBuckets.set(domain, bucket);
      }

      bucket.fileIds.add(file.id);
      if (p.role === 'reader') {
        bucket.readerFileIds.add(file.id);
      } else {
        bucket.writerFileIds.add(file.id);
      }

      let userEntry = bucket.usersMap.get(email);
      if (!userEntry) {
        const contact = contactLookup.get(email);
        const inW = matchesAllowlist(email, activePolicy.writers || []);
        const inR = matchesAllowlist(email, activePolicy.readers || []);
        userEntry = {
          email,
          name: contact?.name || p.displayName || '',
          groups: contact?.groups ? [...contact.groups] : [],
          inDirectory: Boolean(contact),
          fileCount: 0,
          writerCount: 0,
          readerCount: 0,
          overprivilegedCount: 0,
          inWriters: inW,
          inReaders: inR,
          isStranger: !inW && !inR
        };
        bucket.usersMap.set(email, userEntry);
      }

      const userFileKey = `${email}::${file.id}`;
      if (!seenUserInFile.has(userFileKey)) {
        seenUserInFile.add(userFileKey);
        userEntry.fileCount++;
      }

      if (p.role === 'reader') {
        userEntry.readerCount++;
      } else {
        userEntry.writerCount++;
      }

      const ev = evaluatePermission(p, activePolicy, owner);
      if (ev.status === 'violation_downgrade') {
        userEntry.overprivilegedCount++;
      }
    }
  }

  const categoryWeight = {
    external: 3,
    personal: 2,
    internal: 1
  };

  const result = [];
  for (const bucket of domainBuckets.values()) {
    const users = [...bucket.usersMap.values()].sort((a, b) => {
      if (Number(b.isStranger) !== Number(a.isStranger)) return Number(b.isStranger) - Number(a.isStranger);
      if (b.writerCount !== a.writerCount) return b.writerCount - a.writerCount;
      if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
      return a.email.localeCompare(b.email);
    });

    const fileCount = bucket.fileIds.size;
    const writerFileCount = bucket.writerFileIds.size;
    const readerFileCount = Math.max(0, fileCount - writerFileCount);
    const strangerCount = users.filter(u => u.isStranger).length;
    const overprivilegedCount = users.reduce((sum, u) => sum + u.overprivilegedCount, 0);

    result.push({
      domain: bucket.domain,
      category: bucket.category,
      userCount: users.length,
      users,
      fileCount,
      writerFileCount,
      readerFileCount,
      strangerCount,
      overprivilegedCount
    });
  }

  result.sort((a, b) => {
    const cwDiff = (categoryWeight[b.category] || 0) - (categoryWeight[a.category] || 0);
    if (cwDiff !== 0) return cwDiff;
    const aRisk = a.strangerCount > 0 || a.overprivilegedCount > 0 || a.writerFileCount > 0 ? 1 : 0;
    const bRisk = b.strangerCount > 0 || b.overprivilegedCount > 0 || b.writerFileCount > 0 ? 1 : 0;
    if (bRisk !== aRisk) return bRisk - aRisk;
    if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
    if (b.writerFileCount !== a.writerFileCount) return b.writerFileCount - a.writerFileCount;
    if (b.strangerCount !== a.strangerCount) return b.strangerCount - a.strangerCount;
    if (b.userCount !== a.userCount) return b.userCount - a.userCount;
    return a.domain.localeCompare(b.domain);
  });

  return result;
}

/**
 * 将离职清退回执格式化为带 UTF-8 BOM 的 CSV 文本，便于直接导出审计存档
 */
function formatOffboardReceiptCsv(offboardResult = {}) {
  const rows = Array.isArray(offboardResult?.receiptRows) ? offboardResult.receiptRows : [];
  const escapeCsvCell = val => {
    const str = String(val ?? '');
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const header = ['处置时间', '所属账号', '目标邮箱', '文件名', '文件ID', '访问链接', '原角色', '处置结果'];
  const lines = [header.map(escapeCsvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.timestamp || '',
        r.accountEmail || '',
        r.targetEmail || offboardResult.targetEmail || '',
        r.fileName || '',
        r.fileId || '',
        r.webViewLink || '',
        r.previousRoleLabel || roleLabel(r.previousRole || ''),
        r.resultText || ''
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return '\uFEFF' + lines.join('\r\n');
}

/**
 * 指定单个或多个邮箱一键全盘移除权限：
 * 支持 targetEmail 传入逗号/换行分隔的多个邮箱或 targetEmails: string[]，
 * 结合本地扫描快照 + 实时 Drive API 补漏搜索，并发撤除全部目标邮箱在所有可管理文件/目录上的非所有者权限，
 * 跳过其作为 owner 的文件并合并生成可导出 CSV 的完整清退回执与可回滚审计日志。
 */
async function offboardPersonAcrossDrive({
  targetEmail = '',
  targetEmails = null,
  files = [],
  targetAccount = 'all',
  liveSearch = true,
  shouldStop = null,
  retryQueue = null,
  onProgress = null
} = {}) {
  const isRetry = Array.isArray(retryQueue);
  const rawEmailCandidates = [];
  if (Array.isArray(targetEmails)) {
    rawEmailCandidates.push(...parseEmailListInput(targetEmails));
  } else if (typeof targetEmails === 'string' && targetEmails.trim()) {
    rawEmailCandidates.push(...parseEmailListInput(targetEmails));
  }
  if (typeof targetEmail === 'string' && targetEmail.trim()) {
    rawEmailCandidates.push(...parseEmailListInput(targetEmail));
  } else if (Array.isArray(targetEmail)) {
    rawEmailCandidates.push(...parseEmailListInput(targetEmail));
  }
  if (isRetry) {
    for (const rItem of retryQueue) {
      const rEm = normalizeEntry(rItem?.targetEmail || '');
      if (rEm && rEm.includes('@')) rawEmailCandidates.push(rEm);
    }
  }

  const cleanEmails = [...new Set(rawEmailCandidates.filter(e => e && e.includes('@')))];
  if (!cleanEmails.length) {
    throw new Error('请输入有效的待清退人员邮箱地址');
  }
  const cleanEmailSet = new Set(cleanEmails);
  const summaryTargetEmail = cleanEmails.join(', ');
  const displayTargetSummary =
    cleanEmails.length === 1 ? cleanEmails[0] : `${cleanEmails[0]} 等 ${cleanEmails.length} 个邮箱`;

  const normalizedTargetAccount =
    targetAccount && targetAccount !== 'all' ? normalizeEntry(targetAccount) : 'all';

  // 准备已授权账号 Token 池
  const accounts = await getAuthorizedAccounts();
  const tokenPool = [];
  const tokenByEmail = new Map();

  if (accounts.length > 0) {
    const scopedAccounts =
      normalizedTargetAccount !== 'all'
        ? accounts.filter(a => normalizeEntry(a.email) === normalizedTargetAccount)
        : accounts;
    const candidateAccounts = scopedAccounts.length > 0 ? scopedAccounts : accounts;

    for (const acc of candidateAccounts) {
      const em = normalizeEntry(acc.email);
      try {
        const tk = await getValidTokenForAccount(em, false);
        if (tk) {
          const entry = { email: em, token: tk };
          tokenPool.push(entry);
          tokenByEmail.set(em, tk);
        }
      } catch (_e) {
        // 忽略单个过期账号，按需在执行时兜底获取
      }
    }
  }

  if (tokenPool.length === 0) {
    try {
      const fallbackTk = await getValidTokenForAccount(
        normalizedTargetAccount !== 'all' ? normalizedTargetAccount : '',
        false
      );
      if (fallbackTk) {
        const em = normalizedTargetAccount !== 'all' ? normalizedTargetAccount : '';
        tokenPool.push({ email: em, token: fallbackTk });
        if (em) tokenByEmail.set(em, fallbackTk);
      }
    } catch (_e) {
      // 允许在纯传入缓存 token 环境中按 getValidTokenForAccount 执行阶段获取
    }
  }

  async function resolveTokenForAccount(accEmail) {
    const norm = normalizeEntry(accEmail || '');
    if (norm && tokenByEmail.has(norm)) return tokenByEmail.get(norm);
    try {
      const tk = await getValidTokenForAccount(norm, true);
      if (norm && tk) tokenByEmail.set(norm, tk);
      return tk;
    } catch (err) {
      if (tokenPool[0]?.token) return tokenPool[0].token;
      throw err;
    }
  }

  const localFileById = new Map();
  for (const f of files || []) {
    if (f && f.id) localFileById.set(f.id, f);
  }

  const ownedFilesSkippedMap = new Map();
  const taskMap = new Map();
  let stopped = false;

  function registerFileCandidate(fileObj, fallbackAccEmail = '') {
    if (!fileObj || !fileObj.id) return;
    const accEmail = normalizeEntry(
      fileObj.ownerAccount || fileObj.scannedByAccount || fallbackAccEmail || fileObj.owners?.[0]?.emailAddress || ''
    );
    const ownerEmailSet = new Set();
    if (fileObj.ownerAccount) ownerEmailSet.add(normalizeEntry(fileObj.ownerAccount));
    if (Array.isArray(fileObj.owners)) {
      for (const o of fileObj.owners) {
        const oem = normalizeEntry(o?.emailAddress || '');
        if (oem) ownerEmailSet.add(oem);
      }
    }
    const canonicalLink = formatDriveCanonicalLink(fileObj);

    for (const ownerEm of ownerEmailSet) {
      if (cleanEmailSet.has(ownerEm)) {
        ownedFilesSkippedMap.set(`${fileObj.id}::${ownerEm}`, {
          fileId: fileObj.id,
          fileName: fileObj.name || '(无名称)',
          mimeType: fileObj.mimeType || '',
          webViewLink: canonicalLink,
          accountEmail: accEmail,
          targetEmail: ownerEm
        });
      }
    }

    for (const p of fileObj.permissions || []) {
      if (!p) continue;
      const pEmail = normalizeEntry(p.emailAddress || '');
      if (!pEmail || !cleanEmailSet.has(pEmail)) continue;

      if (p.role === 'owner' || ownerEmailSet.has(pEmail)) {
        ownedFilesSkippedMap.set(`${fileObj.id}::${pEmail}`, {
          fileId: fileObj.id,
          fileName: fileObj.name || '(无名称)',
          mimeType: fileObj.mimeType || '',
          webViewLink: canonicalLink,
          accountEmail: accEmail,
          targetEmail: pEmail
        });
        continue;
      }

      if (!p.id) continue;
      const key = `${fileObj.id}::${p.id}`;
      if (!taskMap.has(key)) {
        taskMap.set(key, {
          fileId: fileObj.id,
          fileName: fileObj.name || '(无名称)',
          mimeType: fileObj.mimeType || '',
          webViewLink: canonicalLink,
          accountEmail: accEmail,
          permissionId: p.id,
          targetType: p.type || 'user',
          targetEmail: pEmail,
          previousRole: p.role || 'reader',
          inheritedOnly: Boolean(permIsInherited(p) && !permHasDirectGrant(p)),
          parents: Array.isArray(fileObj.parents) ? [...fileObj.parents] : []
        });
      }
    }
  }

  if (isRetry) {
    for (const item of retryQueue) {
      if (!item || !item.fileId || !item.permissionId) continue;
      const itemEmail = normalizeEntry(item.targetEmail || cleanEmails[0] || '');
      if (!itemEmail) continue;
      const key = `${item.fileId}::${item.permissionId}`;
      taskMap.set(key, {
        fileId: item.fileId,
        fileName: item.fileName || '(无名称)',
        mimeType: item.mimeType || '',
        webViewLink: item.webViewLink || `https://drive.google.com/open?id=${item.fileId}`,
        accountEmail: normalizeEntry(item.accountEmail || ''),
        permissionId: item.permissionId,
        targetType: item.targetType || 'user',
        targetEmail: itemEmail,
        previousRole: item.previousRole || 'reader',
        inheritedOnly: Boolean(item.inheritedOnly),
        parents: Array.isArray(item.parents) ? [...item.parents] : []
      });
    }
  } else {
    // 1. 先从本地已扫描文件快照一次遍历收集全部目标邮箱权限
    for (const file of files || []) {
      if (!file || !file.id) continue;
      if (normalizedTargetAccount !== 'all') {
        const fAcc = normalizeEntry(file.ownerAccount || file.scannedByAccount || '');
        if (fAcc && fAcc !== normalizedTargetAccount) continue;
      }
      registerFileCandidate(file);
    }

    // 2. 实时调用 Drive API 搜索补漏未在当前快照中的文件（支持多邮箱合并查询）
    if (liveSearch !== false && tokenPool.length > 0 && !shouldStop?.()) {
      const LIVE_FIELDS =
        'nextPageToken,files(id,name,mimeType,webViewLink,ownedByMe,owners(emailAddress,displayName),parents,permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType)))';

      const emailChunks = [];
      for (let i = 0; i < cleanEmails.length; i += 8) {
        emailChunks.push(cleanEmails.slice(i, i + 8));
      }

      for (const accEntry of tokenPool) {
        if (shouldStop?.()) {
          stopped = true;
          break;
        }
        if (normalizedTargetAccount !== 'all' && accEntry.email && accEntry.email !== normalizedTargetAccount) {
          continue;
        }

        const fetchedPermFileIds = new Set();
        for (const batchEmails of emailChunks) {
          if (shouldStop?.()) {
            stopped = true;
            break;
          }
          const orClause = batchEmails
            .map(em => {
              const safeEmail = escapeDriveQueryLiteral(em);
              return `'${safeEmail}' in writers or '${safeEmail}' in readers`;
            })
            .join(' or ');
          const q = `(${orClause}) and trashed = false`;

          try {
            let pageToken = '';
            do {
              if (shouldStop?.()) {
                stopped = true;
                break;
              }
              const params = new URLSearchParams({
                q,
                pageSize: '200',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
                fields: LIVE_FIELDS
              });
              if (pageToken) params.set('pageToken', pageToken);
              const data = await driveApi(accEntry.token, `/files?${params}`);
              const foundFiles = Array.isArray(data?.files) ? data.files : [];

              for (const item of foundFiles) {
                if (!item || !item.id) continue;
                // 若共享云端硬盘文件未内联返回 permissions，补充拉取一次权限列表
                if (
                  (!Array.isArray(item.permissions) || item.permissions.length === 0) &&
                  !fetchedPermFileIds.has(item.id)
                ) {
                  fetchedPermFileIds.add(item.id);
                  try {
                    const pData = await driveApi(
                      accEntry.token,
                      `/files/${encodeURIComponent(item.id)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType))`
                    );
                    item.permissions = pData?.permissions || [];
                  } catch (_pe) {
                    item.permissions = [];
                  }
                }
                registerFileCandidate(item, accEntry.email);
              }

              pageToken = data?.nextPageToken || '';
              if (onProgress) {
                onProgress({
                  phase: 'search',
                  done: 0,
                  total: taskMap.size,
                  message: `正在全盘检索 ${displayTargetSummary} 关联文件（已发现 ${taskMap.size} 项待撤权）…`
                });
              }
            } while (pageToken);
          } catch (_searchErr) {
            // 单个账号实时搜索异常不阻断本地已收集项的清退
          }
        }
      }
    }
  }

  // 文件夹优先于普通文件执行撤权，便于父目录撤权自动级联覆盖子文件继承权限
  const tasks = [...taskMap.values()].sort((a, b) => {
    const aFolder = a.mimeType === 'application/vnd.google-apps.folder' ? 1 : 0;
    const bFolder = b.mimeType === 'application/vnd.google-apps.folder' ? 1 : 0;
    if (bFolder !== aFolder) return bFolder - aFolder;
    return (a.fileName || '').localeCompare(b.fileName || '');
  });

  const ownedFilesSkipped = [...ownedFilesSkippedMap.values()];
  const successfullyRevokedFolderEmailKeys = new Set();
  const receiptRows = [];
  const failedItems = [];
  const logs = [];
  let revokedCount = 0;
  let failedCount = 0;
  let cursor = 0;

  function cleanLocalMemoryPermission(fileId, permissionId, taskEmail) {
    const lf = localFileById.get(fileId);
    if (lf && Array.isArray(lf.permissions)) {
      lf.permissions = lf.permissions.filter(
        p => p.id !== permissionId && normalizeEntry(p.emailAddress || '') !== taskEmail
      );
    }
  }

  // 先执行顶层文件夹撤权，随后并发撤除其余文件，使父子级联判断确定可靠
  async function processSingleTask(task) {
    const nowIso = new Date().toISOString();
    const itemEmail = task.targetEmail;
    const isCascadedFromParent =
      task.inheritedOnly &&
      Array.isArray(task.parents) &&
      task.parents.some(pid => successfullyRevokedFolderEmailKeys.has(`${pid}::${itemEmail}`));

    if (isCascadedFromParent) {
      cleanLocalMemoryPermission(task.fileId, task.permissionId, itemEmail);
      revokedCount++;
      receiptRows.push({
        timestamp: nowIso,
        accountEmail: task.accountEmail,
        targetEmail: itemEmail,
        fileName: task.fileName,
        fileId: task.fileId,
        webViewLink: task.webViewLink,
        previousRole: task.previousRole,
        previousRoleLabel: roleLabel(task.previousRole),
        status: 'revoked_cascade',
        resultText: '已随上级文件夹撤权自动解除继承'
      });
      return;
    }

    try {
      const token = await resolveTokenForAccount(task.accountEmail);
      await deletePermission(token, task.fileId, task.permissionId);
      cleanLocalMemoryPermission(task.fileId, task.permissionId, itemEmail);
      if (task.mimeType === 'application/vnd.google-apps.folder') {
        successfullyRevokedFolderEmailKeys.add(`${task.fileId}::${itemEmail}`);
      }
      revokedCount++;
      logs.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: nowIso,
        source: 'manual',
        actionType: 'revoke',
        accountEmail: task.accountEmail,
        fileId: task.fileId,
        fileName: task.fileName,
        webViewLink: task.webViewLink,
        permissionId: task.permissionId,
        targetType: task.targetType,
        targetEmail: itemEmail,
        targetLabel: itemEmail,
        previousRole: task.previousRole,
        newRole: '',
        restored: false,
        message: `离职清退：已撤除 ${itemEmail} 的${roleLabel(task.previousRole)}权限`
      });
      receiptRows.push({
        timestamp: nowIso,
        accountEmail: task.accountEmail,
        targetEmail: itemEmail,
        fileName: task.fileName,
        fileId: task.fileId,
        webViewLink: task.webViewLink,
        previousRole: task.previousRole,
        previousRoleLabel: roleLabel(task.previousRole),
        status: 'revoked',
        resultText: '已撤除权限'
      });
    } catch (error) {
      const errMsg = error?.message || String(error);
      // 若权限已因父级文件夹撤权级联消失 (404 / Permission not found)，视为已完成撤除
      if (/not found|404/i.test(errMsg)) {
        cleanLocalMemoryPermission(task.fileId, task.permissionId, itemEmail);
        revokedCount++;
        receiptRows.push({
          timestamp: nowIso,
          accountEmail: task.accountEmail,
          targetEmail: itemEmail,
          fileName: task.fileName,
          fileId: task.fileId,
          webViewLink: task.webViewLink,
          previousRole: task.previousRole,
          previousRoleLabel: roleLabel(task.previousRole),
          status: 'revoked_cascade',
          resultText: '权限已不存在或随上级目录一并解除'
        });
        return;
      }

      failedCount++;
      failedItems.push({
        ...task,
        errorMessage: errMsg
      });
      logs.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: nowIso,
        source: 'manual',
        actionType: 'error',
        accountEmail: task.accountEmail,
        fileId: task.fileId,
        fileName: task.fileName,
        webViewLink: task.webViewLink,
        permissionId: task.permissionId,
        targetType: task.targetType,
        targetEmail: itemEmail,
        targetLabel: itemEmail,
        previousRole: task.previousRole,
        newRole: '',
        restored: false,
        message: `离职清退失败 (${itemEmail})：${errMsg}`
      });
      receiptRows.push({
        timestamp: nowIso,
        accountEmail: task.accountEmail,
        targetEmail: itemEmail,
        fileName: task.fileName,
        fileId: task.fileId,
        webViewLink: task.webViewLink,
        previousRole: task.previousRole,
        previousRoleLabel: roleLabel(task.previousRole),
        status: 'failed',
        resultText: `撤除失败：${errMsg}`
      });
    }
  }

  const folderTasks = tasks.filter(t => t.mimeType === 'application/vnd.google-apps.folder');
  const nonFolderTasks = tasks.filter(t => t.mimeType !== 'application/vnd.google-apps.folder');

  async function runTaskSlice(slice) {
    let sliceCursor = 0;
    const workerNum = Math.min(4, Math.max(1, slice.length));
    const workers = Array.from({ length: slice.length ? workerNum : 0 }, async () => {
      while (sliceCursor < slice.length) {
        if (shouldStop?.()) {
          stopped = true;
          break;
        }
        const task = slice[sliceCursor++];
        cursor++;
        await processSingleTask(task);
        if (onProgress) {
          onProgress({
            phase: 'revoke',
            done: revokedCount + failedCount,
            total: tasks.length,
            revokedCount,
            failedCount,
            stopped,
            message: `正在清退 ${displayTargetSummary} (${revokedCount + failedCount}/${tasks.length})：成功 ${revokedCount}，失败 ${failedCount}…`
          });
        }
      }
    });
    await Promise.all(workers);
  }

  if (!stopped && folderTasks.length > 0) {
    await runTaskSlice(folderTasks);
  }
  if (!stopped && nonFolderTasks.length > 0) {
    await runTaskSlice(nonFolderTasks);
  }

  for (const owned of ownedFilesSkipped) {
    receiptRows.push({
      timestamp: new Date().toISOString(),
      accountEmail: owned.accountEmail || '',
      targetEmail: owned.targetEmail || summaryTargetEmail,
      fileName: owned.fileName,
      fileId: owned.fileId,
      webViewLink: owned.webViewLink,
      previousRole: 'owner',
      previousRoleLabel: roleLabel('owner'),
      status: 'skipped_owner',
      resultText: '跳过：该人员为文件所有者，请使用所有权转移功能交接'
    });
  }

  if (logs.length) {
    await appendAuditLogs(logs);
  }

  return {
    targetEmail: summaryTargetEmail,
    targetEmails: cleanEmails,
    revokedCount,
    failedCount,
    ownedSkippedCount: ownedFilesSkipped.length,
    ownedFilesSkipped,
    stopped,
    total: tasks.length,
    failedItems,
    receiptRows
  };
}

async function offboardEmailsAcrossDrive(options = {}) {
  return offboardPersonAcrossDrive(options);
}

// ============================================================================
// 阶段三：限时授权自动回收 (TTL)、扫描权限变更 Diff 与伴随侧边栏支撑引擎
// ============================================================================

const SCAN_LOCK_STALE_MS = 120 * 1000;
let _memoryScanRuntimeLock = null;

async function notifyRuntimeSafe(payload) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      await chrome.runtime.sendMessage(payload);
    }
  } catch (_e) {
    // 忽略无接收端异常
  }
}

async function readScanRuntimeLock() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
      const data = await chrome.storage.session.get('scanRuntimeLock');
      return data?.scanRuntimeLock || null;
    }
  } catch (_e) {
    // 回退内存锁
  }
  return _memoryScanRuntimeLock;
}

async function writeScanRuntimeLock(lockObj) {
  _memoryScanRuntimeLock = lockObj || null;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
      if (lockObj) {
        await chrome.storage.session.set({ scanRuntimeLock: lockObj });
      } else if (chrome.storage.session.remove) {
        await chrome.storage.session.remove('scanRuntimeLock');
      } else {
        await chrome.storage.session.set({ scanRuntimeLock: null });
      }
    }
  } catch (_e) {
    // 忽略 session 存储异常
  }
}

async function acquireScanRuntimeLock(source = 'manual') {
  const now = Date.now();
  const existing = await readScanRuntimeLock();
  const isAlive = existing && Number.isFinite(existing.heartbeatAt) && now - existing.heartbeatAt < SCAN_LOCK_STALE_MS;

  if (isAlive && (source === 'schedule' || source === 'startup')) {
    return { acquired: false, holder: existing };
  }

  const lockId = `scan-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const nextLock = {
    lockId,
    source,
    startedAt: now,
    heartbeatAt: now
  };
  await writeScanRuntimeLock(nextLock);
  return { acquired: true, lockId };
}

function touchScanRuntimeLock(lockId) {
  if (!lockId) return;
  const now = Date.now();
  if (_memoryScanRuntimeLock && _memoryScanRuntimeLock.lockId === lockId) {
    _memoryScanRuntimeLock.heartbeatAt = now;
  }
  (async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.get && chrome.storage?.session?.set) {
        const cur = await chrome.storage.session.get('scanRuntimeLock');
        if (cur?.scanRuntimeLock?.lockId === lockId) {
          await chrome.storage.session.set({
            scanRuntimeLock: { ...cur.scanRuntimeLock, heartbeatAt: now }
          });
        }
      }
    } catch (_e) {}
  })();
}

async function releaseScanRuntimeLock(lockId) {
  if (!lockId) return;
  const cur = await readScanRuntimeLock();
  if (!cur || cur.lockId === lockId) {
    await writeScanRuntimeLock(null);
  }
}

/* ==================== A. 临时限时授权 (TTL) 与到期自动回收引擎 ==================== */

/**
 * 解析限时预设或自定义时间为标准 ISO 到期时间字符串
 */
function resolveTtlExpiresAt(ttlPreset = 'none', customDateTime = '') {
  const preset = String(ttlPreset || 'none').trim().toLowerCase();
  if (!preset || preset === 'none' || preset === 'permanent') {
    return null;
  }

  const now = Date.now();
  const durationMap = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  };

  if (durationMap[preset]) {
    return new Date(now + durationMap[preset]).toISOString();
  }

  if (preset === 'custom') {
    const rawCustom = String(customDateTime || '').trim();
    if (!rawCustom) {
      throw new Error('请选择有效的自定义权限到期时间');
    }
    const parsedMs = Date.parse(rawCustom);
    if (!Number.isFinite(parsedMs)) {
      throw new Error('自定义权限到期时间格式无效，请重新选择');
    }
    if (parsedMs <= now + 30 * 1000) {
      throw new Error('自定义权限到期时间必须晚于当前时间至少 30 秒');
    }
    return new Date(parsedMs).toISOString();
  }

  const fallbackMs = Date.parse(ttlPreset);
  if (Number.isFinite(fallbackMs) && fallbackMs > now + 30 * 1000) {
    return new Date(fallbackMs).toISOString();
  }

  throw new Error(`不支持的权限有效期选项：${ttlPreset}`);
}

/**
 * 格式化剩余时间文案（零破折号，清晰易读）
 */
function formatTtlRemaining(expiresAt, nowMs = Date.now()) {
  const expMs = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(expMs)) return '';
  const diffMs = expMs - nowMs;
  if (diffMs <= 0) {
    return '已到期（待回收）';
  }

  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
  if (totalMinutes < 60) {
    return `剩余 ${totalMinutes} 分钟`;
  }

  const totalHours = Math.floor(diffMs / 3600000);
  if (totalHours < 24) {
    const roundedHours = Math.max(1, Math.round(diffMs / 3600000));
    return `剩余 ${roundedHours} 小时`;
  }

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `剩余 ${days} 天 ${remHours} 小时` : `剩余 ${days} 天`;
}

/**
 * 读取待回收限时权限队列（按到期时间升序排列）
 */
async function getTtlQueue() {
  const data = await chrome.storage.local.get('ttlPermissionsQueue');
  const list = Array.isArray(data.ttlPermissionsQueue) ? data.ttlPermissionsQueue : [];
  return [...list].sort((a, b) => (Date.parse(a?.expiresAt || '') || 0) - (Date.parse(b?.expiresAt || '') || 0));
}

function isSameTtlTarget(existingItem, incomingItem) {
  if (!existingItem || !incomingItem) return false;
  if (existingItem.fileId !== incomingItem.fileId) return false;

  const existEmail = normalizeEntry(existingItem.targetEmail || '');
  const nextEmail = normalizeEntry(incomingItem.targetEmail || '');
  if (existEmail && nextEmail) {
    return existEmail === nextEmail;
  }

  if (existingItem.permissionId && incomingItem.permissionId) {
    return existingItem.permissionId === incomingItem.permissionId;
  }

  const existKey = `${existingItem.targetType || 'user'}:${String(existingItem.domain || '').toLowerCase()}`;
  const nextKey = `${incomingItem.targetType || 'user'}:${String(incomingItem.domain || '').toLowerCase()}`;
  return !existEmail && !nextEmail && existKey === nextKey;
}

/**
 * 将单条或多条限时授权写入持久化队列（同文件同目标幂等覆盖）并唤醒后台定时器同步
 */
async function enqueueTtlPermissions(entries) {
  const rawList = Array.isArray(entries) ? entries : entries ? [entries] : [];
  const normalizedIncoming = [];

  for (const raw of rawList) {
    if (!raw || !raw.fileId || !raw.expiresAt) continue;
    const expMs = Date.parse(String(raw.expiresAt));
    if (!Number.isFinite(expMs)) continue;

    const cleanEmail = normalizeEntry(raw.targetEmail || raw.emailAddress || '');
    const targetType = raw.targetType || raw.type || (cleanEmail ? 'user' : 'anyone');
    const cleanDomain = String(raw.domain || '').trim().toLowerCase();
    const fallbackLabel =
      cleanEmail ||
      (targetType === 'anyone'
        ? '公开链接 (任何人)'
        : targetType === 'domain'
          ? `域内共享 (${cleanDomain || '未知域'})`
          : '协作者');

    normalizedIncoming.push({
      id: raw.id || `ttl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileId: String(raw.fileId),
      fileName: raw.fileName || '(无名称)',
      mimeType: raw.mimeType || '',
      webViewLink: raw.webViewLink || `https://drive.google.com/open?id=${raw.fileId}`,
      accountEmail: normalizeEntry(raw.accountEmail || ''),
      permissionId: raw.permissionId || '',
      targetType,
      targetEmail: cleanEmail,
      domain: cleanDomain,
      targetLabel: raw.targetLabel || fallbackLabel,
      grantedRole: raw.grantedRole || raw.role || 'reader',
      expireAction: raw.expireAction === 'downgrade_reader' ? 'downgrade_reader' : 'revoke',
      expiresAt: new Date(expMs).toISOString(),
      createdAt: raw.createdAt || new Date().toISOString(),
      nativeExpirationApplied: Boolean(raw.nativeExpirationApplied),
      status: 'pending',
      retryCount: 0,
      lastError: ''
    });
  }

  if (!normalizedIncoming.length) return [];

  const currentQueue = await getTtlQueue();
  const kept = currentQueue.filter(oldItem => !normalizedIncoming.some(inc => isSameTtlTarget(oldItem, inc)));
  const merged = [...kept, ...normalizedIncoming].sort(
    (a, b) => (Date.parse(a.expiresAt) || 0) - (Date.parse(b.expiresAt) || 0)
  );

  await safeStorageSet({ ttlPermissionsQueue: merged });
  await notifyRuntimeSafe({ type: 'SYNC_TTL_ALARM' });
  await notifyRuntimeSafe({ type: 'TTL_UPDATED' });
  return normalizedIncoming;
}

/**
 * 取消限时回收（将权限转为长期有效，不删除云端权限）
 */
async function cancelTtlEntry(ttlId) {
  if (!ttlId) return { removed: false, entry: null };
  const currentQueue = await getTtlQueue();
  const target = currentQueue.find(item => item.id === ttlId) || null;
  if (!target) {
    return { removed: false, entry: null };
  }

  const nextQueue = currentQueue.filter(item => item.id !== ttlId);
  await safeStorageSet({ ttlPermissionsQueue: nextQueue });

  await appendAuditLogs({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source: 'manual',
    actionType: 'ttl_cancel',
    isTtl: true,
    accountEmail: target.accountEmail || '',
    fileId: target.fileId,
    fileName: target.fileName || '(无名称)',
    webViewLink: target.webViewLink || '',
    permissionId: target.permissionId || '',
    targetType: target.targetType || 'user',
    targetEmail: target.targetEmail || '',
    domain: target.domain || '',
    targetLabel: target.targetLabel || target.targetEmail || '',
    previousRole: target.grantedRole || 'reader',
    newRole: target.grantedRole || 'reader',
    restored: true,
    message: `限时授权已转为长期有效：保留 ${target.targetLabel || target.targetEmail} 的「${roleLabel(target.grantedRole)}」权限`
  });

  await notifyRuntimeSafe({ type: 'SYNC_TTL_ALARM' });
  await notifyRuntimeSafe({ type: 'TTL_UPDATED' });
  return { removed: true, entry: target };
}

async function resolveTtlOperationToken(accountEmail = '', interactive = false) {
  const norm = normalizeEntry(accountEmail);
  try {
    return await getValidTokenForAccount(norm, interactive);
  } catch (primaryErr) {
    const accounts = await getAuthorizedAccounts();
    for (const acc of accounts) {
      if (norm && normalizeEntry(acc.email) === norm) continue;
      try {
        const tk = await getValidTokenForAccount(acc.email, false);
        if (tk) return tk;
      } catch (_e) {}
    }
    throw primaryErr;
  }
}

async function syncSnapshotAfterTtlMutations(mutations = []) {
  if (!Array.isArray(mutations) || !mutations.length) return;
  try {
    const data = await chrome.storage.local.get('scanSnapshot');
    const snap = data.scanSnapshot;
    if (!snap || !Array.isArray(snap.files) || !snap.files.length) return;

    const byFileId = new Map();
    for (const m of mutations) {
      if (!m?.fileId) continue;
      if (!byFileId.has(m.fileId)) byFileId.set(m.fileId, []);
      byFileId.get(m.fileId).push(m);
    }

    let touched = false;
    for (const file of snap.files) {
      const fileMuts = byFileId.get(file.id);
      if (!fileMuts || !Array.isArray(file.permissions)) continue;
      for (const m of fileMuts) {
        const normTargetEmail = normalizeEntry(m.targetEmail || '');
        if (m.actionDone === 'downgraded') {
          for (const p of file.permissions) {
            if (
              (m.permissionId && p.id === m.permissionId) ||
              (normTargetEmail && normalizeEntry(p.emailAddress || '') === normTargetEmail)
            ) {
              p.role = 'reader';
              touched = true;
            }
          }
        } else {
          const beforeLen = file.permissions.length;
          file.permissions = file.permissions.filter(p => {
            if (p.role === 'owner') return true;
            if (m.permissionId && p.id === m.permissionId) return false;
            if (normTargetEmail && normalizeEntry(p.emailAddress || '') === normTargetEmail) return false;
            if (!normTargetEmail && !m.permissionId && p.type === m.targetType) return false;
            return true;
          });
          if (file.permissions.length !== beforeLen) touched = true;
        }
      }
      if (snap.permFingerprints && typeof snap.permFingerprints === 'object') {
        const fp = buildFilePermissionFingerprint(file);
        if (fp) snap.permFingerprints[file.id] = fp;
      }
    }

    if (touched) {
      await saveSnapshot(snap);
    }
  } catch (_e) {
    // 快照同步异常不影响主回收流程
  }
}

async function executeSingleTtlReapItem(entry, { interactive = false } = {}) {
  const token = await resolveTtlOperationToken(entry.accountEmail || '', interactive);
  let permId = entry.permissionId || '';

  if (!permId) {
    const permData = await driveApi(
      token,
      `/files/${encodeURIComponent(entry.fileId)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,domain)`
    );
    const perms = Array.isArray(permData?.permissions) ? permData.permissions : [];
    const normEmail = normalizeEntry(entry.targetEmail || '');
    const matched = perms.find(p => {
      if (!p || p.role === 'owner') return false;
      if (normEmail) return normalizeEntry(p.emailAddress || '') === normEmail;
      if (entry.targetType === 'domain') {
        return p.type === 'domain' && String(p.domain || '').toLowerCase() === String(entry.domain || '').toLowerCase();
      }
      return p.type === entry.targetType;
    });
    permId = matched?.id || '';
  }

  if (!permId) {
    return { actionDone: 'revoked', permissionId: '', alreadyGone: true };
  }

  if (entry.expireAction === 'downgrade_reader') {
    try {
      await updatePermissionRole(token, entry.fileId, permId, 'reader');
      return { actionDone: 'downgraded', permissionId: permId, alreadyGone: false };
    } catch (err) {
      if (/not found|404/i.test(String(err?.message || err))) {
        return { actionDone: 'revoked', permissionId: permId, alreadyGone: true };
      }
      throw err;
    }
  }

  try {
    await deletePermission(token, entry.fileId, permId);
    return { actionDone: 'revoked', permissionId: permId, alreadyGone: false };
  } catch (err) {
    if (/not found|404/i.test(String(err?.message || err))) {
      return { actionDone: 'revoked', permissionId: permId, alreadyGone: true };
    }
    throw err;
  }
}

/**
 * 立即提前收回单条限时授权
 */
async function revokeTtlEntryNow(ttlId, { interactive = true } = {}) {
  const currentQueue = await getTtlQueue();
  const target = currentQueue.find(item => item.id === ttlId);
  if (!target) {
    throw new Error('未找到对应的限时授权记录，可能已被回收');
  }

  const reapRes = await executeSingleTtlReapItem(target, { interactive });
  const nextQueue = currentQueue.filter(item => item.id !== ttlId);
  await safeStorageSet({ ttlPermissionsQueue: nextQueue });

  await syncSnapshotAfterTtlMutations([
    {
      fileId: target.fileId,
      permissionId: reapRes.permissionId || target.permissionId,
      targetEmail: target.targetEmail,
      targetType: target.targetType,
      actionDone: reapRes.actionDone
    }
  ]);

  const isDowngrade = reapRes.actionDone === 'downgraded';
  await appendAuditLogs({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source: 'manual',
    actionType: isDowngrade ? 'downgrade' : 'revoke',
    isTtl: true,
    accountEmail: target.accountEmail || '',
    fileId: target.fileId,
    fileName: target.fileName || '(无名称)',
    webViewLink: target.webViewLink || '',
    permissionId: reapRes.permissionId || target.permissionId || '',
    targetType: target.targetType || 'user',
    targetEmail: target.targetEmail || '',
    domain: target.domain || '',
    targetLabel: target.targetLabel || target.targetEmail || '',
    previousRole: target.grantedRole || 'reader',
    newRole: isDowngrade ? 'reader' : '',
    restored: false,
    message: isDowngrade
      ? `限时授权提前降级：已将 ${target.targetLabel || target.targetEmail} 降为仅查看`
      : `限时授权提前收回：已移除 ${target.targetLabel || target.targetEmail} 的「${roleLabel(target.grantedRole)}」权限`
  });

  await notifyRuntimeSafe({ type: 'SYNC_TTL_ALARM' });
  await notifyRuntimeSafe({ type: 'TTL_UPDATED' });
  return {
    revoked: reapRes.actionDone === 'revoked',
    downgraded: isDowngrade,
    entry: target
  };
}

/**
 * 批量巡检并自动回收所有已到期的限时授权（4 线程并发）
 */
async function processExpiredTtlPermissions({ now = Date.now() } = {}) {
  const currentQueue = await getTtlQueue();
  const dueItems = [];
  const untouchedItems = [];

  for (const item of currentQueue) {
    const expMs = Date.parse(item?.expiresAt || '');
    if (item?.status === 'pending' && Number.isFinite(expMs) && expMs <= now) {
      dueItems.push(item);
    } else {
      untouchedItems.push(item);
    }
  }

  if (!dueItems.length) {
    const remainingPendingCount = untouchedItems.filter(x => x?.status === 'pending').length;
    return {
      processedCount: 0,
      revokedCount: 0,
      downgradedCount: 0,
      failedCount: 0,
      remainingPendingCount,
      reapedItems: []
    };
  }

  let revokedCount = 0;
  let downgradedCount = 0;
  let failedCount = 0;
  const reapedItems = [];
  const retryOrFailedItems = [];
  const snapshotMutations = [];
  const logs = [];
  let cursor = 0;

  const workerCount = Math.min(4, dueItems.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < dueItems.length) {
      const entry = dueItems[cursor++];
      try {
        const reapRes = await executeSingleTtlReapItem(entry, { interactive: false });
        const isDowngrade = reapRes.actionDone === 'downgraded';
        if (isDowngrade) {
          downgradedCount++;
        } else {
          revokedCount++;
        }
        reapedItems.push({ ...entry, actionDone: reapRes.actionDone });
        snapshotMutations.push({
          fileId: entry.fileId,
          permissionId: reapRes.permissionId || entry.permissionId,
          targetEmail: entry.targetEmail,
          targetType: entry.targetType,
          actionDone: reapRes.actionDone
        });
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'auto',
          actionType: isDowngrade ? 'downgrade' : 'revoke',
          isTtl: true,
          accountEmail: entry.accountEmail || '',
          fileId: entry.fileId,
          fileName: entry.fileName || '(无名称)',
          webViewLink: entry.webViewLink || '',
          permissionId: reapRes.permissionId || entry.permissionId || '',
          targetType: entry.targetType || 'user',
          targetEmail: entry.targetEmail || '',
          domain: entry.domain || '',
          targetLabel: entry.targetLabel || entry.targetEmail || '',
          previousRole: entry.grantedRole || 'reader',
          newRole: isDowngrade ? 'reader' : '',
          restored: false,
          message: isDowngrade
            ? `限时授权到期自动收回：已将 ${entry.targetLabel || entry.targetEmail} 从${roleLabel(entry.grantedRole)}降为仅查看`
            : `限时授权到期自动收回：已移除 ${entry.targetLabel || entry.targetEmail} 的「${roleLabel(entry.grantedRole)}」权限`
        });
      } catch (error) {
        failedCount++;
        const errMsg = error?.message || String(error);
        const nextRetry = (Number(entry.retryCount) || 0) + 1;
        const nextStatus = nextRetry >= 5 ? 'failed' : 'pending';
        retryOrFailedItems.push({
          ...entry,
          retryCount: nextRetry,
          status: nextStatus,
          lastError: errMsg
        });
        if (nextStatus === 'failed') {
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'auto',
            actionType: 'error',
            isTtl: true,
            accountEmail: entry.accountEmail || '',
            fileId: entry.fileId,
            fileName: entry.fileName || '(无名称)',
            webViewLink: entry.webViewLink || '',
            permissionId: entry.permissionId || '',
            targetType: entry.targetType || 'user',
            targetEmail: entry.targetEmail || '',
            targetLabel: entry.targetLabel || entry.targetEmail || '',
            previousRole: entry.grantedRole || 'reader',
            newRole: '',
            restored: false,
            message: `限时授权到期回收连续失败 (${entry.targetLabel || entry.targetEmail})：${errMsg}`
          });
        }
      }
    }
  });

  await Promise.all(workers);

  const updatedQueue = [...untouchedItems, ...retryOrFailedItems].sort(
    (a, b) => (Date.parse(a?.expiresAt || '') || 0) - (Date.parse(b?.expiresAt || '') || 0)
  );
  await safeStorageSet({ ttlPermissionsQueue: updatedQueue });

  if (snapshotMutations.length) {
    await syncSnapshotAfterTtlMutations(snapshotMutations);
  }
  if (logs.length) {
    await appendAuditLogs(logs);
  }

  const remainingPendingCount = updatedQueue.filter(x => x?.status === 'pending').length;
  return {
    processedCount: dueItems.length,
    revokedCount,
    downgradedCount,
    failedCount,
    remainingPendingCount,
    reapedItems
  };
}

/**
 * 底层限时权限创建辅助（优先尝试 Drive API 原生 expirationTime，400/403 不支持时无感回退）
 */
async function grantPermissionCoreApi(
  token,
  file,
  fileId,
  { type = 'user', role = 'reader', emailAddress = '', domain = '', expiresAt = '' } = {}
) {
  const targetFileId = fileId || file?.id || '';
  if (!targetFileId) {
    throw new Error('缺少目标文件 ID');
  }

  const expMs = expiresAt ? Date.parse(String(expiresAt)) : NaN;
  const now = Date.now();
  const maxNativeSpanMs = 364 * 24 * 60 * 60 * 1000;
  const isFolder = file?.mimeType === 'application/vnd.google-apps.folder';
  const canTryNative =
    Number.isFinite(expMs) &&
    expMs > now &&
    expMs - now <= maxNativeSpanMs &&
    (type === 'user' || type === 'group') &&
    !isFolder;

  if (canTryNative) {
    const params = new URLSearchParams({
      supportsAllDrives: 'true',
      sendNotificationEmail: 'false'
    });
    const body = {
      type,
      role,
      expirationTime: new Date(expMs).toISOString()
    };
    if (emailAddress) body.emailAddress = emailAddress;
    if (domain) body.domain = domain;

    try {
      const createdPermission = await driveApi(
        token,
        `/files/${encodeURIComponent(targetFileId)}/permissions?${params}`,
        {
          method: 'POST',
          body: JSON.stringify(body)
        }
      );
      return { createdPermission, nativeExpirationApplied: true };
    } catch (err) {
      const msg = String(err?.message || err || '');
      // Drive API 对个人版账号、文件夹或特定共享云端硬盘不支持 expirationTime 时返回 400/403，自动回退普通创建
      if (!/400|403|expiration|cannotSetExpiration|not supported|invalid/i.test(msg)) {
        throw err;
      }
    }
  }

  const createdPermission = await createPermission(token, targetFileId, {
    type,
    role,
    emailAddress: emailAddress || undefined,
    domain: domain || undefined
  });
  return { createdPermission, nativeExpirationApplied: false };
}

/**
 * 授予单条权限并按需绑定 TTL 到期自动回收队列
 */
async function grantPermissionWithTtl({
  token = '',
  accountEmail = '',
  file = null,
  fileId = '',
  type = 'user',
  role = 'reader',
  emailAddress = '',
  domain = '',
  expiresAt = '',
  expireAction = 'revoke'
} = {}) {
  const resolvedFileId = fileId || file?.id || '';
  if (!resolvedFileId) {
    throw new Error('缺少目标文件 ID');
  }

  const resolvedAccount = normalizeEntry(
    accountEmail || file?.ownerAccount || file?.owners?.[0]?.emailAddress || ''
  );
  const activeToken = token || (await getValidTokenForAccount(resolvedAccount, true));

  const validExpiresAt =
    expiresAt && Number.isFinite(Date.parse(String(expiresAt)))
      ? new Date(Date.parse(String(expiresAt))).toISOString()
      : '';

  const { createdPermission, nativeExpirationApplied } = await grantPermissionCoreApi(
    activeToken,
    file,
    resolvedFileId,
    {
      type,
      role,
      emailAddress: normalizeEntry(emailAddress),
      domain,
      expiresAt: validExpiresAt
    }
  );

  let ttlEntry = null;
  if (validExpiresAt) {
    const enqueued = await enqueueTtlPermissions({
      fileId: resolvedFileId,
      fileName: file?.name || '(无名称)',
      mimeType: file?.mimeType || '',
      webViewLink: file ? formatDriveCanonicalLink(file) : `https://drive.google.com/open?id=${resolvedFileId}`,
      accountEmail: resolvedAccount,
      permissionId: createdPermission?.id || '',
      targetType: type,
      targetEmail: normalizeEntry(emailAddress),
      domain,
      targetLabel:
        normalizeEntry(emailAddress) ||
        (type === 'anyone' ? '公开链接 (任何人)' : domain ? `域内共享 (${domain})` : '协作者'),
      grantedRole: role,
      expireAction,
      expiresAt: validExpiresAt,
      nativeExpirationApplied
    });
    ttlEntry = enqueued[0] || null;
  }

  return {
    createdPermission,
    nativeExpirationApplied,
    ttlEntry
  };
}

/* ==================== B. 两次扫描「权限变更 Diff」引擎 ==================== */

/**
 * 生成单文件共享权限的确定性指纹（排除所有者，用于跨扫描对比）
 */
function buildFilePermissionFingerprint(file) {
  if (!file || file.permissionsLoading || file.permissionError) return null;
  if (!Array.isArray(file.permissions)) return null;

  const fileOwner = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
  let anyoneRole = '';
  const domainMap = new Map();
  const userMap = new Map();

  for (const p of file.permissions) {
    if (!p) continue;
    if (p.type === 'anyone') {
      if (!anyoneRole || permissionRoleRank(p.role) > permissionRoleRank(anyoneRole)) {
        anyoneRole = p.role || 'reader';
      }
    } else if (p.type === 'domain') {
      const d = String(p.domain || '').trim().toLowerCase();
      if (!d) continue;
      const prev = domainMap.get(d);
      if (!prev || permissionRoleRank(p.role) > permissionRoleRank(prev)) {
        domainMap.set(d, p.role || 'reader');
      }
    } else if (p.type === 'user' || p.type === 'group') {
      if (p.role === 'owner') continue;
      const em = normalizeEntry(p.emailAddress || '');
      if (!em || em === fileOwner) continue;
      const prev = userMap.get(em);
      if (!prev || permissionRoleRank(p.role) > permissionRoleRank(prev)) {
        userMap.set(em, p.role || 'reader');
      }
    }
  }

  const domains = [...domainMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, r]) => `${d}:${r}`);
  const users = [...userMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([u, r]) => `${u}:${r}`);

  const sig = `anyone=${anyoneRole}|domains=${domains.join(',')}|users=${users.join(',')}`;
  return {
    anyoneRole,
    domains,
    users,
    sig
  };
}

function parseRolePairEntries(entries = []) {
  const map = new Map();
  for (const item of entries || []) {
    const idx = String(item).lastIndexOf(':');
    if (idx <= 0) continue;
    const key = String(item).slice(0, idx);
    const role = String(item).slice(idx + 1);
    map.set(key, role);
  }
  return map;
}

/**
 * 对比前后两次权限指纹，生成结构化变更明细与零破折号摘要
 */
function computeFilePermissionDiff(prevFp, currFp) {
  if (!prevFp || !currFp || prevFp.sig === currFp.sig) return null;

  const changes = [];
  let riskIncreased = false;

  const prevAnyone = prevFp.anyoneRole || '';
  const currAnyone = currFp.anyoneRole || '';
  if (!prevAnyone && currAnyone) {
    riskIncreased = true;
    changes.push({
      type: 'anyone_added',
      target: '公开链接 (任何人)',
      previousRole: '',
      newRole: currAnyone,
      riskIncreased: true,
      text: `新增公开链接（${roleLabel(currAnyone)}）`
    });
  } else if (prevAnyone && !currAnyone) {
    changes.push({
      type: 'anyone_removed',
      target: '公开链接 (任何人)',
      previousRole: prevAnyone,
      newRole: '',
      riskIncreased: false,
      text: `关闭公开链接（原：${roleLabel(prevAnyone)}）`
    });
  } else if (prevAnyone && currAnyone && prevAnyone !== currAnyone) {
    const up = permissionRoleRank(currAnyone) > permissionRoleRank(prevAnyone);
    if (up) riskIncreased = true;
    changes.push({
      type: up ? 'anyone_upgraded' : 'anyone_downgraded',
      target: '公开链接 (任何人)',
      previousRole: prevAnyone,
      newRole: currAnyone,
      riskIncreased: up,
      text: `公开链接角色变更：${roleLabel(prevAnyone)} -> ${roleLabel(currAnyone)}`
    });
  }

  const prevDomains = parseRolePairEntries(prevFp.domains);
  const currDomains = parseRolePairEntries(currFp.domains);
  const allDomKeys = new Set([...prevDomains.keys(), ...currDomains.keys()]);
  for (const dom of [...allDomKeys].sort()) {
    const pRole = prevDomains.get(dom) || '';
    const cRole = currDomains.get(dom) || '';
    if (!pRole && cRole) {
      riskIncreased = true;
      changes.push({
        type: 'domain_added',
        target: dom,
        previousRole: '',
        newRole: cRole,
        riskIncreased: true,
        text: `新增域内共享 ${dom}（${roleLabel(cRole)}）`
      });
    } else if (pRole && !cRole) {
      changes.push({
        type: 'domain_removed',
        target: dom,
        previousRole: pRole,
        newRole: '',
        riskIncreased: false,
        text: `移除域内共享 ${dom}（原：${roleLabel(pRole)}）`
      });
    } else if (pRole !== cRole) {
      const up = permissionRoleRank(cRole) > permissionRoleRank(pRole);
      if (up) riskIncreased = true;
      changes.push({
        type: up ? 'domain_upgraded' : 'domain_downgraded',
        target: dom,
        previousRole: pRole,
        newRole: cRole,
        riskIncreased: up,
        text: `域内共享 ${dom} 角色变更：${roleLabel(pRole)} -> ${roleLabel(cRole)}`
      });
    }
  }

  const prevUsers = parseRolePairEntries(prevFp.users);
  const currUsers = parseRolePairEntries(currFp.users);
  const allUserKeys = new Set([...prevUsers.keys(), ...currUsers.keys()]);
  for (const email of [...allUserKeys].sort()) {
    const pRole = prevUsers.get(email) || '';
    const cRole = currUsers.get(email) || '';
    if (!pRole && cRole) {
      riskIncreased = true;
      changes.push({
        type: 'user_added',
        target: email,
        previousRole: '',
        newRole: cRole,
        riskIncreased: true,
        text: `新增协作者 ${email}（${roleLabel(cRole)}）`
      });
    } else if (pRole && !cRole) {
      changes.push({
        type: 'user_removed',
        target: email,
        previousRole: pRole,
        newRole: '',
        riskIncreased: false,
        text: `移除协作者 ${email}（原：${roleLabel(pRole)}）`
      });
    } else if (pRole !== cRole) {
      const up = permissionRoleRank(cRole) > permissionRoleRank(pRole);
      if (up) riskIncreased = true;
      changes.push({
        type: up ? 'user_upgraded' : 'user_downgraded',
        target: email,
        previousRole: pRole,
        newRole: cRole,
        riskIncreased: up,
        text: `${email} 角色变更：${roleLabel(pRole)} -> ${roleLabel(cRole)}`
      });
    }
  }

  if (!changes.length) return null;

  const summaryText =
    changes.length <= 2
      ? changes.map(c => c.text).join(' · ')
      : `${changes[0].text} · ${changes[1].text} 等 ${changes.length} 项变动`;

  return {
    changed: true,
    riskIncreased,
    changes,
    summaryText,
    detectedAt: new Date().toISOString()
  };
}

function setFilePermissionDiff(file, diffInfo) {
  if (!file || typeof file !== 'object') return;
  const cleanDiff = diffInfo && diffInfo.changed ? diffInfo : null;
  file.hasPermDiff = Boolean(cleanDiff);
  try {
    Object.defineProperty(file, '_permDiff', {
      value: cleanDiff,
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (_e) {
    // 忽略只读对象异常
  }
}

function getFilePermissionDiff(file, permDiffsMap = null) {
  if (!file || typeof file !== 'object') return null;
  if (permDiffsMap instanceof Map && file.id) {
    return permDiffsMap.get(file.id) || null;
  }
  if (permDiffsMap && typeof permDiffsMap === 'object' && file.id && permDiffsMap[file.id]) {
    return permDiffsMap[file.id];
  }
  return file._permDiff || null;
}

function hydrateFilesPermissionDiffs(files = [], permDiffs = {}) {
  if (!Array.isArray(files)) return files;
  const isMap = permDiffs instanceof Map;
  const diffObj = !isMap && permDiffs && typeof permDiffs === 'object' ? permDiffs : {};
  for (const file of files) {
    if (!file || !file.id) continue;
    const diffInfo = isMap ? permDiffs.get(file.id) || null : diffObj[file.id] || null;
    setFilePermissionDiff(file, diffInfo);
  }
  return files;
}

/**
 * 清除所有扫描权限变动标记，并以当前文件列表状态刷新基线指纹
 */
async function clearScanDiffFlags() {
  const snap = await getSnapshot();
  const refreshedFingerprints = { ...(snap.permFingerprints || {}) };
  for (const file of snap.files || []) {
    if (!file?.id) continue;
    setFilePermissionDiff(file, null);
    const fp = buildFilePermissionFingerprint(file);
    if (fp) {
      refreshedFingerprints[file.id] = fp;
    }
  }
  snap.permDiffs = {};
  snap.permFingerprints = refreshedFingerprints;
  await saveSnapshot(snap);
  return snap;
}

/* ==================== C. Google Drive 网页伴随侧边栏解析与单文件深度核查 ==================== */

/**
 * 解析 Google Drive / Google Docs 网页 URL 或裸文件 ID
 * 返回 { fileId, kind, isDriveDomain, rawUrl }
 */
function parseDriveUrlOrId(input = '') {
  const rawUrl = String(input || '').trim();
  if (!rawUrl) {
    return { fileId: '', kind: 'none', isDriveDomain: false, rawUrl: '' };
  }

  // 直接传入裸 ID
  if (/^[a-zA-Z0-9_-]{15,80}$/.test(rawUrl) && !rawUrl.includes('@')) {
    return { fileId: rawUrl, kind: 'id', isDriveDomain: false, rawUrl };
  }

  let isDriveDomain = false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    isDriveDomain = host === 'drive.google.com' || host === 'docs.google.com';

    const pathname = parsed.pathname || '';
    const folderMatch = pathname.match(/\/folders\/([a-zA-Z0-9_-]{15,})/);
    if (folderMatch) {
      return { fileId: folderMatch[1], kind: 'folder', isDriveDomain, rawUrl };
    }

    const docTypeMatch = pathname.match(
      /\/(document|spreadsheets|presentation|forms|drawings|file)\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{15,})/
    );
    if (docTypeMatch) {
      const kindMap = {
        document: 'document',
        spreadsheets: 'spreadsheet',
        presentation: 'presentation',
        forms: 'form',
        drawings: 'drawing',
        file: 'file'
      };
      return {
        fileId: docTypeMatch[2],
        kind: kindMap[docTypeMatch[1]] || 'file',
        isDriveDomain,
        rawUrl
      };
    }

    const genericDMatch = pathname.match(/\/d\/([a-zA-Z0-9_-]{15,})/);
    if (genericDMatch) {
      return { fileId: genericDMatch[1], kind: 'file', isDriveDomain, rawUrl };
    }

    const queryId = parsed.searchParams.get('id') || '';
    if (/^[a-zA-Z0-9_-]{15,80}$/.test(queryId)) {
      return { fileId: queryId, kind: 'file', isDriveDomain, rawUrl };
    }

    if (isDriveDomain) {
      return { fileId: '', kind: 'drive_home', isDriveDomain: true, rawUrl };
    }
  } catch (_urlErr) {
    // 非标准完整 URL 时尝试正则提取片段
    const fallbackIds = parseDriveLinksInput(rawUrl);
    if (fallbackIds.length > 0) {
      return {
        fileId: fallbackIds[0],
        kind: rawUrl.includes('/folders/') ? 'folder' : 'file',
        isDriveDomain: /drive\.google\.com|docs\.google\.com/i.test(rawUrl),
        rawUrl
      };
    }
  }

  return { fileId: '', kind: 'none', isDriveDomain, rawUrl };
}

/**
 * 单文件/文件夹实时深度核查（供伴随侧边栏与定点刷新使用）：
 * 自动匹配具备访问/管理权限的已授权账号，拉取完整权限与父目录对比逃逸状态，并同步更新本地快照同 ID 项
 */
async function inspectSingleDriveItem(fileId, { preferredAccount = '' } = {}) {
  const parsed = parseDriveUrlOrId(fileId);
  const cleanId = parsed.fileId || String(fileId || '').trim();
  if (!cleanId) {
    throw new Error('请输入有效的 Google Drive 文件链接或文件 ID');
  }

  const accounts = await getAuthorizedAccounts();
  const normPreferred = normalizeEntry(preferredAccount);
  const orderedAccounts =
    normPreferred && accounts.length > 0
      ? [
          ...accounts.filter(a => normalizeEntry(a.email) === normPreferred),
          ...accounts.filter(a => normalizeEntry(a.email) !== normPreferred)
        ]
      : accounts;

  const tokenCandidates = [];
  for (const acc of orderedAccounts) {
    try {
      const tk = await getValidTokenForAccount(acc.email, false);
      if (tk) {
        tokenCandidates.push({ email: normalizeEntry(acc.email), token: tk });
      }
    } catch (_e) {
      // 跳过单个失效凭证
    }
  }

  if (!tokenCandidates.length) {
    const fallbackTk = await getValidTokenForAccount(normPreferred || '', false);
    let resolvedFallbackEmail = normPreferred || '';
    try {
      const about = await fetchAboutUser(fallbackTk);
      if (about?.email) resolvedFallbackEmail = about.email;
    } catch (_aboutErr) {}
    tokenCandidates.push({ email: normalizeEntry(resolvedFallbackEmail), token: fallbackTk });
  }

  const SINGLE_FIELDS =
    'id,name,mimeType,webViewLink,createdTime,modifiedTime,viewedByMeTime,writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason),ownedByMe,shared,owners(emailAddress,displayName),capabilities(canEdit,canComment,canShare),permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType)),parents';

  let bestFile = null;
  let bestAccount = '';
  let bestToken = '';
  let lastError = null;

  for (const cand of tokenCandidates) {
    try {
      const meta = await driveApi(
        cand.token,
        `/files/${encodeURIComponent(cleanId)}?supportsAllDrives=true&fields=${encodeURIComponent(SINGLE_FIELDS)}`
      );
      if (!meta || !meta.id) continue;

      if ((!Array.isArray(meta.permissions) || meta.permissions.length === 0) && meta.capabilities?.canShare) {
        try {
          const pData = await driveApi(
            cand.token,
            `/files/${encodeURIComponent(cleanId)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType))`
          );
          meta.permissions = pData?.permissions || [];
        } catch (_pe) {
          meta.permissions = meta.permissions || [];
        }
      }

      if (!bestFile) {
        bestFile = meta;
        bestAccount = cand.email || normalizeEntry(meta.owners?.[0]?.emailAddress || '');
        bestToken = cand.token;
      }

      if (meta.ownedByMe || (Array.isArray(meta.permissions) && meta.permissions.length > 0 && meta.capabilities?.canShare)) {
        bestFile = meta;
        bestAccount = cand.email || normalizeEntry(meta.owners?.[0]?.emailAddress || '');
        bestToken = cand.token;
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!bestFile) {
    throw new Error(
      lastError?.message || '当前已授权账号均无法访问此文件，请确认文件 ID 是否正确或切换对应 Google 账号授权'
    );
  }

  bestFile.permissions = Array.isArray(bestFile.permissions) ? bestFile.permissions : [];
  normalizeScannedFileItem(bestFile, bestAccount);
  bestFile.permissionsLoading = false;

  const [policy, directory, ttlQueue] = await Promise.all([getPolicy(), getDirectory(), getTtlQueue()]);
  const cleanExcluded = sanitizeExcludedFoldersList(policy?.excludedFolders || []);
  const excludedById = new Map();
  for (const ef of cleanExcluded) {
    excludedById.set(ef.id, ef);
  }
  let matchedExcludedFolder = excludedById.get(bestFile.id) || null;

  // 若存在上级父文件夹，拉取直接父目录权限以便精准执行子项逃逸比对，并沿 parents 轻量回溯最多 6 层识别顶层排除目录
  const compareList = [bestFile];
  const ancestorChainMeta = [];
  const ancestorIds = [];
  const visitedAncestors = new Set([bestFile.id]);
  const parentId =
    Array.isArray(bestFile.parents) && bestFile.parents[0] ? String(bestFile.parents[0]).trim() : '';
  let nextParentId = '';

  if (parentId) {
    visitedAncestors.add(parentId);
    ancestorIds.push(parentId);
    const directMatched = excludedById.get(parentId);
    if (!matchedExcludedFolder && directMatched && directMatched.includeSubitems !== false) {
      matchedExcludedFolder = directMatched;
    }

    if (bestToken) {
      try {
        const parentMeta = await driveApi(
          bestToken,
          `/files/${encodeURIComponent(parentId)}?supportsAllDrives=true&fields=${encodeURIComponent(SINGLE_FIELDS)}`
        );
        if (parentMeta && parentMeta.id) {
          if (
            (!Array.isArray(parentMeta.permissions) || parentMeta.permissions.length === 0) &&
            parentMeta.capabilities?.canShare
          ) {
            try {
              const ppData = await driveApi(
                bestToken,
                `/files/${encodeURIComponent(parentId)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(role,inherited,inheritedFrom,permissionType))`
              );
              parentMeta.permissions = ppData?.permissions || [];
            } catch (_ppe) {}
          }
          parentMeta.permissions = Array.isArray(parentMeta.permissions) ? parentMeta.permissions : [];
          normalizeScannedFileItem(parentMeta, bestAccount);
          parentMeta.permissionsLoading = false;
          compareList.unshift(parentMeta);
          nextParentId =
            Array.isArray(parentMeta.parents) && parentMeta.parents[0]
              ? String(parentMeta.parents[0]).trim()
              : '';
        }
      } catch (_parentErr) {
        // 无父目录读取权限时自动退化为基于 permissionDetails 的逃逸判定
      }
    }
  }

  let hop = 1;
  while (
    !matchedExcludedFolder &&
    nextParentId &&
    bestToken &&
    hop < 6 &&
    !visitedAncestors.has(nextParentId)
  ) {
    const currentAncId = nextParentId;
    visitedAncestors.add(currentAncId);
    ancestorIds.push(currentAncId);

    const ancRule = excludedById.get(currentAncId);
    if (ancRule && ancRule.includeSubitems !== false) {
      matchedExcludedFolder = ancRule;
      break;
    }

    try {
      const ancMeta = await driveApi(
        bestToken,
        `/files/${encodeURIComponent(currentAncId)}?supportsAllDrives=true&fields=id,name,parents`
      );
      hop++;
      if (ancMeta && ancMeta.id) {
        ancestorChainMeta.push({
          id: ancMeta.id,
          name: ancMeta.name || '',
          mimeType: 'application/vnd.google-apps.folder',
          parents: Array.isArray(ancMeta.parents) ? ancMeta.parents : []
        });
        nextParentId =
          Array.isArray(ancMeta.parents) && ancMeta.parents[0]
            ? String(ancMeta.parents[0]).trim()
            : '';
        if (hop >= 6 && nextParentId && !visitedAncestors.has(nextParentId)) {
          const topRule = excludedById.get(nextParentId);
          if (topRule && topRule.includeSubitems !== false) {
            ancestorIds.push(nextParentId);
            matchedExcludedFolder = topRule;
          }
        }
      } else {
        break;
      }
    } catch (_ancErr) {
      break;
    }
  }

  Object.defineProperty(bestFile, '_ancestorIds', {
    value: ancestorIds,
    configurable: true,
    writable: true,
    enumerable: false
  });

  const breakageMap = analyzeInheritanceBreakage(compareList);
  const breakage = breakageMap.get(bestFile.id) || null;

  const excludedSet = buildExcludedFileIdSet(
    [...ancestorChainMeta, ...compareList],
    policy.excludedFolders || []
  );
  const isExcluded =
    Boolean(matchedExcludedFolder) ||
    isFileInExcludedFolders(bestFile, policy.excludedFolders || [], excludedSet);
  let evaluation = evaluateFile(bestFile, policy, bestAccount, excludedSet);
  if (isExcluded && !evaluation.isExcluded) {
    evaluation = {
      ...evaluation,
      removeCount: 0,
      downgradeCount: 0,
      inheritedIssueCount: 0,
      hasActionableViolation: false,
      isExcluded: true
    };
  }
  const wideRisk = assessWidePermissionRisk(bestFile, policy, bestAccount, isExcluded);
  const ttlEntries = ttlQueue.filter(item => item.fileId === bestFile.id && item.status === 'pending');

  // 若本地扫描快照中已包含该文件，顺带同步刷新其最新权限与指纹
  try {
    const rawSnapData = await chrome.storage.local.get('scanSnapshot');
    const snap = rawSnapData.scanSnapshot;
    if (snap && Array.isArray(snap.files)) {
      const idx = snap.files.findIndex(f => f?.id === bestFile.id);
      if (idx !== -1) {
        bestFile.isNew = Boolean(snap.files[idx].isNew);
        snap.files[idx] = bestFile;
        snap.permFingerprints = snap.permFingerprints || {};
        const fp = buildFilePermissionFingerprint(bestFile);
        if (fp) snap.permFingerprints[bestFile.id] = fp;
        await saveSnapshot(snap);
      }
    }
  } catch (_snapErr) {}

  return {
    file: bestFile,
    matchedAccount: bestAccount,
    policy,
    directory,
    evaluation,
    breakage,
    ttlEntries,
    isExcluded,
    matchedExcludedFolder,
    ancestorIds,
    wideRisk
  };
}


// ============================================================================
// v1.0.0：防扩散/锁定加固、IMPORTRANGE 跨表放行、岗位权限包、合作方档案、沉睡编辑权与目录树分叉引擎
// ============================================================================

/* ==================== 1. 文件防扩散 / 防复制 / 内容锁定加固引擎 ==================== */

function resolveContentLockDirective(contentLock) {
  if (contentLock === true || contentLock === 'lock') return true;
  if (contentLock === false || contentLock === 'unlock') return false;
  return undefined;
}

/**
 * 批量或单文件执行安全加固（禁止编辑者拉人 / 禁止查看者下载打印复制 / 文件防篡改锁定）
 */
async function applyFileSecurityHardening({
  files = [],
  writersCanShare = undefined,
  copyRequiresWriterPermission = undefined,
  contentLock = undefined,
  lockReason = '由 Drive 权限管理中心锁定保护',
  onProgress = null,
  shouldStop = null
} = {}) {
  const validFiles = (Array.isArray(files) ? files : [files]).filter(f => f && f.id);
  const lockBool = resolveContentLockDirective(contentLock);

  let changedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let stopped = false;
  let cursor = 0;
  const failedItems = [];
  const mutatedById = new Map();
  const logs = [];

  const tokenCache = new Map();
  async function resolveToken(ownerEmail) {
    const norm = normalizeEntry(ownerEmail || '');
    if (tokenCache.has(norm)) return tokenCache.get(norm);
    const tk = await getValidTokenForAccount(norm, true);
    tokenCache.set(norm, tk);
    return tk;
  }

  const workerCount = Math.min(4, Math.max(1, validFiles.length));
  const workers = Array.from({ length: validFiles.length ? workerCount : 0 }, async () => {
    while (cursor < validFiles.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const file = validFiles[cursor++];
      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
      const ownerEmail = normalizeEntry(
        file.ownerAccount || file.scannedByAccount || file.owners?.[0]?.emailAddress || ''
      );

      const curWritersCanShare = file.writersCanShare !== false;
      const curCopyReq = Boolean(file.copyRequiresWriterPermission);
      const curLocked = Boolean(file.contentLocked || file.contentRestrictions?.some(r => r?.readOnly));

      const patchBody = {};
      const changeLabels = [];

      if (writersCanShare !== undefined) {
        const nextW = Boolean(writersCanShare);
        if (curWritersCanShare !== nextW) {
          patchBody.writersCanShare = nextW;
          changeLabels.push(nextW ? '允许编辑者拉人共享' : '禁止编辑者拉人共享');
        }
      }

      if (!isFolder && copyRequiresWriterPermission !== undefined) {
        const nextC = Boolean(copyRequiresWriterPermission);
        if (curCopyReq !== nextC) {
          patchBody.copyRequiresWriterPermission = nextC;
          changeLabels.push(nextC ? '禁止查看/评论者下载打印复制' : '允许查看/评论者下载打印复制');
        }
      }

      if (!isFolder && lockBool !== undefined) {
        if (curLocked !== lockBool) {
          const cleanReason = String(lockReason || '由 Drive 权限管理中心锁定保护').trim();
          patchBody.contentRestrictions = [
            lockBool ? { readOnly: true, reason: cleanReason } : { readOnly: false }
          ];
          changeLabels.push(lockBool ? '开启文件防篡改锁定' : '解除文件防篡改锁定');
        }
      }

      if (Object.keys(patchBody).length === 0) {
        skippedCount++;
        if (onProgress) {
          const done = changedCount + skippedCount + failedCount;
          onProgress({
            done,
            total: validFiles.length,
            changedCount,
            skippedCount,
            failedCount,
            stopped,
            message: `正在执行安全加固 ${done}/${validFiles.length}（已加固 ${changedCount}，无需变更 ${skippedCount}）…`
          });
        }
        continue;
      }

      try {
        const token = await resolveToken(ownerEmail);
        const updatedMeta = await driveApi(
          token,
          `/files/${encodeURIComponent(file.id)}?supportsAllDrives=true&fields=id,writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason)`,
          {
            method: 'PATCH',
            body: JSON.stringify(patchBody)
          }
        );

        if ('writersCanShare' in patchBody) {
          file.writersCanShare =
            updatedMeta?.writersCanShare !== undefined
              ? Boolean(updatedMeta.writersCanShare)
              : patchBody.writersCanShare;
        }
        if ('copyRequiresWriterPermission' in patchBody) {
          file.copyRequiresWriterPermission =
            updatedMeta?.copyRequiresWriterPermission !== undefined
              ? Boolean(updatedMeta.copyRequiresWriterPermission)
              : patchBody.copyRequiresWriterPermission;
        }
        if ('contentRestrictions' in patchBody) {
          const nextRestrictions = Array.isArray(updatedMeta?.contentRestrictions)
            ? updatedMeta.contentRestrictions
            : patchBody.contentRestrictions[0]?.readOnly
              ? patchBody.contentRestrictions
              : [];
          file.contentRestrictions = nextRestrictions;
          const roItem = nextRestrictions.find(r => r && r.readOnly);
          file.contentLocked = Boolean(roItem);
          file.contentLockReason = roItem?.reason || '';
        }

        mutatedById.set(file.id, {
          writersCanShare: file.writersCanShare !== false,
          copyRequiresWriterPermission: Boolean(file.copyRequiresWriterPermission),
          contentLocked: Boolean(file.contentLocked),
          contentLockReason: file.contentLockReason || ''
        });

        changedCount++;
        logs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          source: 'manual',
          actionType: 'harden',
          accountEmail: ownerEmail,
          fileId: file.id,
          fileName: file.name || '(无名称)',
          webViewLink: formatDriveCanonicalLink(file),
          permissionId: '',
          targetType: 'file_security',
          targetEmail: '',
          targetLabel: changeLabels.join(' · '),
          previousRole: '',
          newRole: '',
          restored: false,
          message: `文件安全加固：${changeLabels.join(' · ')}`
        });
      } catch (error) {
        failedCount++;
        const errMsg = error?.message || String(error);
        failedItems.push({
          fileId: file.id,
          fileName: file.name || '(无名称)',
          accountEmail: ownerEmail,
          errorMessage: errMsg
        });
      }

      if (onProgress) {
        const done = changedCount + skippedCount + failedCount;
        onProgress({
          done,
          total: validFiles.length,
          changedCount,
          skippedCount,
          failedCount,
          stopped,
          message: `正在执行安全加固 ${done}/${validFiles.length}（已加固 ${changedCount}，失败 ${failedCount}）…`
        });
      }
    }
  });

  await Promise.all(workers);

  if (mutatedById.size > 0) {
    try {
      const rawSnap = await chrome.storage.local.get('scanSnapshot');
      const snap = rawSnap?.scanSnapshot;
      if (snap && Array.isArray(snap.files)) {
        let touched = false;
        for (const sf of snap.files) {
          if (sf && mutatedById.has(sf.id)) {
            Object.assign(sf, mutatedById.get(sf.id));
            touched = true;
          }
        }
        if (touched) {
          await saveSnapshot(snap);
        }
      }
    } catch (_snapErr) {}
  }

  if (logs.length > 0) {
    await appendAuditLogs(logs);
  }

  return {
    changedCount,
    failedCount,
    skippedCount,
    failedItems,
    stopped
  };
}

/* ==================== 2. 锁定表格 =IMPORTRANGE 跨表关联解析与放行引擎 ==================== */

function decodeXmlEntities(str = '') {
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function resolveSpreadsheetIdFromRef(rawRef = '') {
  const trimmed = String(rawRef || '').trim();
  if (!trimmed) return '';
  const dMatch = trimmed.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,})/);
  if (dMatch) return dMatch[1];
  const genericD = trimmed.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (genericD) return genericD[1];
  const idParam = trimmed.match(/[?&](?:id|key)=([a-zA-Z0-9_-]{10,})/);
  if (idParam) return idParam[1];
  if (/^[a-zA-Z0-9_-]{8,90}$/.test(trimmed) && !trimmed.includes('!')) {
    return trimmed;
  }
  return '';
}

/**
 * 正则提取公式内所有 IMPORTRANGE("...", ...) 的源表 URL/ID
 * 兼容同一公式多处调用、转义双引号 ""、XML 实体、完整链接与纯 ID
 */
function extractImportRangeFormulaRefs(formulaText = '') {
  const decoded = decodeXmlEntities(String(formulaText || ''));
  if (!/importrange/i.test(decoded)) return [];

  const refs = [];
  const seen = new Set();
  const pattern = /IMPORTRANGE(?:_OFF)?\s*\(\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)')/gi;
  let match;
  while ((match = pattern.exec(decoded)) !== null) {
    const rawQuoted = match[1] !== undefined ? match[1].replace(/""/g, '"') : (match[2] || '').replace(/''/g, "'");
    const rawSourceRef = rawQuoted.trim();
    if (!rawSourceRef) continue;
    const sourceSpreadsheetId = resolveSpreadsheetIdFromRef(rawSourceRef);
    const dedupeKey = `${sourceSpreadsheetId}::${rawSourceRef}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({
      rawSourceRef,
      sourceSpreadsheetId,
      id: sourceSpreadsheetId
    });
  }
  return refs;
}

/**
 * 纯 JS RFC-1951 Deflate-Raw 解压兜底（当无 DecompressionStream 且无 Node zlib 时使用）
 */
function pureJsInflateRaw(src) {
  let bitPos = 0;
  const srcLen = src.length;
  const out = [];

  function readBits(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = bitPos >>> 3;
      if (byteIdx >= srcLen) throw new Error('Deflate 数据流意外结束');
      val |= ((src[byteIdx] >>> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return val;
  }

  function buildHuffmanTable(lengths) {
    let maxBits = 0;
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > maxBits) maxBits = lengths[i];
    }
    if (maxBits === 0) return { counts: new Int32Array(1), symbols: new Int32Array(0), maxBits: 0 };
    const counts = new Int32Array(maxBits + 1);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0) counts[lengths[i]]++;
    }
    const offsets = new Int32Array(maxBits + 1);
    let total = 0;
    for (let b = 1; b <= maxBits; b++) {
      offsets[b] = total;
      total += counts[b];
    }
    const symbols = new Int32Array(total);
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len > 0) symbols[offsets[len]++] = sym;
    }
    return { counts, symbols, maxBits };
  }

  function decodeSymbol(table) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= table.maxBits; len++) {
      code |= readBits(1);
      const count = table.counts[len];
      if (code - count < first) {
        return table.symbols[index + (code - first)];
      }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('无效的 Huffman 编码');
  }

  const fixedLitLengths = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) fixedLitLengths[i] = 8;
  for (let i = 144; i <= 255; i++) fixedLitLengths[i] = 9;
  for (let i = 256; i <= 279; i++) fixedLitLengths[i] = 7;
  for (let i = 280; i <= 287; i++) fixedLitLengths[i] = 8;
  const fixedDistLengths = new Uint8Array(32);
  fixedDistLengths.fill(5);

  const lenBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
  ];
  const lenExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
  ];
  const distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
  ];
  const distExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
  ];
  const clOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  let isFinal = 0;
  while (!isFinal) {
    isFinal = readBits(1);
    const blockType = readBits(2);
    if (blockType === 0) {
      bitPos = (bitPos + 7) & ~7;
      const bytePos = bitPos >>> 3;
      const blockLen = src[bytePos] | (src[bytePos + 1] << 8);
      const start = bytePos + 4;
      for (let i = 0; i < blockLen; i++) {
        out.push(src[start + i]);
      }
      bitPos = (start + blockLen) << 3;
    } else if (blockType === 1 || blockType === 2) {
      let litTable;
      let distTable;
      if (blockType === 1) {
        litTable = buildHuffmanTable(fixedLitLengths);
        distTable = buildHuffmanTable(fixedDistLengths);
      } else {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const clLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          clLengths[clOrder[i]] = readBits(3);
        }
        const clTable = buildHuffmanTable(clLengths);
        const combined = new Uint8Array(hlit + hdist);
        let idx = 0;
        while (idx < hlit + hdist) {
          const sym = decodeSymbol(clTable);
          if (sym < 16) {
            combined[idx++] = sym;
          } else if (sym === 16) {
            const repeat = readBits(2) + 3;
            const prev = idx > 0 ? combined[idx - 1] : 0;
            for (let r = 0; r < repeat; r++) combined[idx++] = prev;
          } else if (sym === 17) {
            const repeat = readBits(3) + 3;
            for (let r = 0; r < repeat; r++) combined[idx++] = 0;
          } else {
            const repeat = readBits(7) + 11;
            for (let r = 0; r < repeat; r++) combined[idx++] = 0;
          }
        }
        litTable = buildHuffmanTable(combined.subarray(0, hlit));
        distTable = buildHuffmanTable(combined.subarray(hlit));
      }

      while (true) {
        const sym = decodeSymbol(litTable);
        if (sym < 256) {
          out.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          const length = lenBase[lenIdx] + readBits(lenExtra[lenIdx]);
          const distSym = decodeSymbol(distTable);
          const distance = distBase[distSym] + readBits(distExtra[distSym]);
          const copyStart = out.length - distance;
          for (let i = 0; i < length; i++) {
            out.push(out[copyStart + i]);
          }
        }
      }
    } else {
      throw new Error('不支持的 Deflate 块类型');
    }
  }

  return new Uint8Array(out);
}

async function decompressZipEntryText(compressedBytes, method) {
  if (method === 0) {
    return new TextDecoder('utf-8').decode(compressedBytes);
  }
  if (method !== 8) {
    throw new Error(`不支持的 ZIP 压缩算法 (${method})`);
  }

  if (typeof DecompressionStream === 'function' && typeof Response === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    await writer.write(compressedBytes);
    await writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder('utf-8').decode(ab);
  }

  if (typeof zlib !== 'undefined' && typeof zlib.inflateRawSync === 'function') {
    const buf = zlib.inflateRawSync(compressedBytes);
    return new TextDecoder('utf-8').decode(buf);
  }

  if (typeof require === 'function') {
    try {
      const nodeZlib = require('zlib');
      if (nodeZlib && typeof nodeZlib.inflateRawSync === 'function') {
        const buf = nodeZlib.inflateRawSync(compressedBytes);
        return new TextDecoder('utf-8').decode(buf);
      }
    } catch (_reqErr) {}
  }

  const rawOut = pureJsInflateRaw(compressedBytes);
  return new TextDecoder('utf-8').decode(rawOut);
}

function readZipCentralDirectory(bytes) {
  if (!bytes || bytes.length < 22) {
    throw new Error('无效的 XLSX 文件数据（长度不足）');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdPos = -1;
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) {
    throw new Error('无法识别 XLSX ZIP 目录结构');
  }

  const totalEntries = view.getUint16(eocdPos + 10, true);
  const cdOffset = view.getUint32(eocdPos + 16, true);
  const entries = new Map();
  let pos = cdOffset;
  const decoder = new TextDecoder('utf-8');

  for (let idx = 0; idx < totalEntries && pos + 46 <= bytes.length; idx++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const rawName = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    const normName = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
    pos += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 <= bytes.length && view.getUint32(localOffset, true) === 0x04034b50) {
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      entries.set(normName, {
        name: normName,
        method,
        compressedBytes: bytes.subarray(dataStart, dataStart + compressedSize)
      });
    }
  }
  return entries;
}

function getXmlAttr(attrText = '', attrName = '') {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = String(attrText || '').match(re);
  if (!m) return '';
  return decodeXmlEntities(m[1] !== undefined ? m[1] : m[2] || '');
}

/**
 * 纯 JS 解析 .xlsx 二进制包，提取所有工作表中含 =IMPORTRANGE 的公式单元格及 #REF! 错误状态
 */
async function parseXlsxImportRangeFormulas(arrayBuffer) {
  let bytes;
  if (arrayBuffer instanceof Uint8Array) {
    bytes = arrayBuffer;
  } else if (arrayBuffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(arrayBuffer);
  } else if (arrayBuffer && arrayBuffer.buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset || 0, arrayBuffer.byteLength);
  } else {
    throw new Error('无效的 XLSX 二进制缓冲区');
  }

  const entries = readZipCentralDirectory(bytes);

  const relsMap = new Map();
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    const relsXml = await decompressZipEntryText(relsEntry.compressedBytes, relsEntry.method);
    const relRe = /<Relationship\b([^>]*?)\/?>/gi;
    let rm;
    while ((rm = relRe.exec(relsXml)) !== null) {
      const attrs = rm[1] || '';
      const rId = getXmlAttr(attrs, 'Id');
      let target = getXmlAttr(attrs, 'Target');
      if (rId && target) {
        target = target.replace(/\\/g, '/');
        if (target.startsWith('/')) {
          target = target.replace(/^\/+/, '');
        } else if (!target.startsWith('xl/')) {
          target = `xl/${target.replace(/^\.\//, '')}`;
        }
        relsMap.set(rId, target);
      }
    }
  }

  const sheetDefs = [];
  const wbEntry = entries.get('xl/workbook.xml');
  if (wbEntry) {
    const wbXml = await decompressZipEntryText(wbEntry.compressedBytes, wbEntry.method);
    const sheetRe = /<sheet\b([^>]*?)\/?>/gi;
    let sm;
    let idx = 0;
    while ((sm = sheetRe.exec(wbXml)) !== null) {
      const attrs = sm[1] || '';
      const sheetName = getXmlAttr(attrs, 'name') || `Sheet${idx + 1}`;
      const explicitGid = getXmlAttr(attrs, 'gid');
      const sheetId = getXmlAttr(attrs, 'sheetId');
      const relId = getXmlAttr(attrs, 'r:id') || getXmlAttr(attrs, 'id');
      const entryPath = (relId && relsMap.get(relId)) || `xl/worksheets/sheet${idx + 1}.xml`;
      const sheetGid = explicitGid !== '' ? explicitGid : sheetId !== '' ? sheetId : String(idx);
      sheetDefs.push({ sheetName, sheetGid, entryPath });
      idx++;
    }
  }

  if (sheetDefs.length === 0) {
    let fallbackIdx = 0;
    for (const key of entries.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(key)) {
        sheetDefs.push({
          sheetName: `Sheet${fallbackIdx + 1}`,
          sheetGid: String(fallbackIdx),
          entryPath: key
        });
        fallbackIdx++;
      }
    }
  }

  const results = [];

  for (const sDef of sheetDefs) {
    const wsEntry = entries.get(sDef.entryPath);
    if (!wsEntry) continue;
    const wsXml = await decompressZipEntryText(wsEntry.compressedBytes, wsEntry.method);
    const sharedFormulas = new Map();
    const cellRe = /<c\b([^>]*?)>([\s\S]*?)<\/c>/gi;
    let cm;

    while ((cm = cellRe.exec(wsXml)) !== null) {
      const cAttrs = cm[1] || '';
      const cInner = cm[2] || '';
      const cellRef = getXmlAttr(cAttrs, 'r') || 'A1';
      const cellType = getXmlAttr(cAttrs, 't');

      let rawFormula = '';
      const fFullMatch = cInner.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
      if (fFullMatch) {
        const fAttrs = fFullMatch[1] || '';
        rawFormula = decodeXmlEntities(fFullMatch[2] || '').trim();
        const fType = getXmlAttr(fAttrs, 't');
        const fSi = getXmlAttr(fAttrs, 'si');
        if (fType === 'shared' && fSi !== '' && rawFormula) {
          sharedFormulas.set(fSi, rawFormula);
        }
      } else {
        const fSelfClose = cInner.match(/<f\b([^>]*)\/>/i);
        if (fSelfClose) {
          const fSi = getXmlAttr(fSelfClose[1] || '', 'si');
          if (fSi !== '' && sharedFormulas.has(fSi)) {
            rawFormula = sharedFormulas.get(fSi);
          }
        }
      }

      if (!rawFormula || !/importrange/i.test(rawFormula)) continue;

      const vMatch = cInner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i);
      const isTextMatch = !vMatch ? cInner.match(/<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/i) : null;
      const cachedValue = decodeXmlEntities((vMatch ? vMatch[1] : isTextMatch ? isTextMatch[1] : '') || '').trim();
      const isRefError = cellType === 'e' || /#REF!/i.test(cachedValue);

      const extractedRefs = extractImportRangeFormulaRefs(rawFormula);
      const normalizedFormula = rawFormula.startsWith('=') ? rawFormula : `=${rawFormula}`;

      for (const ref of extractedRefs) {
        results.push({
          sheetName: sDef.sheetName,
          sheetGid: String(sDef.sheetGid ?? '0'),
          cellRef,
          formula: normalizedFormula,
          rawSourceRef: ref.rawSourceRef,
          sourceSpreadsheetId: ref.sourceSpreadsheetId,
          isRefError
        });
      }
    }
  }

  return results;
}

async function buildAuthorizedTokenPool(preferredAccount = '') {
  const accounts = await getAuthorizedAccounts();
  const normPref = preferredAccount && preferredAccount !== 'all' ? normalizeEntry(preferredAccount) : '';
  const ordered =
    normPref && accounts.length > 0
      ? [
          ...accounts.filter(a => normalizeEntry(a.email) === normPref),
          ...accounts.filter(a => normalizeEntry(a.email) !== normPref)
        ]
      : accounts;

  const pool = [];
  for (const acc of ordered) {
    try {
      const tk = await getValidTokenForAccount(acc.email, false);
      if (tk) {
        pool.push({ email: normalizeEntry(acc.email), token: tk });
      }
    } catch (_e) {}
  }

  if (!pool.length) {
    try {
      const fallbackTk = await getValidTokenForAccount(normPref || '', true);
      let em = normPref || '';
      if (!em && fallbackTk) {
        try {
          const about = await fetchAboutUser(fallbackTk);
          em = normalizeEntry(about?.email || '');
        } catch (_ae) {}
      }
      if (fallbackTk) {
        pool.push({ email: em, token: fallbackTk });
      }
    } catch (_fe) {}
  }
  return pool;
}

/**
 * 扫描并诊断目标汇总表中的全部 =IMPORTRANGE 跨表上游源表权限状态与 #REF! 阻塞原因
 */
async function inspectImportRangeDependencies(targetSheetIdOrUrl, { accountEmail = '' } = {}) {
  const parsedTarget = parseDriveUrlOrId(targetSheetIdOrUrl);
  const targetId = parsedTarget.fileId || extractDriveFileId(targetSheetIdOrUrl);
  if (!targetId) {
    throw new Error('请输入有效的目标 Google 表格链接或文件 ID');
  }

  const tokenPool = await buildAuthorizedTokenPool(accountEmail);
  if (!tokenPool.length) {
    throw new Error('尚未找到可用的已授权账号令牌，请先完成 Google OAuth 客户端或服务账号授权');
  }

  const META_FIELDS =
    'id,name,mimeType,webViewLink,ownedByMe,shared,owners(emailAddress,displayName),capabilities(canEdit,canComment,canShare),permissions(id,type,role,emailAddress,domain,displayName),writersCanShare,copyRequiresWriterPermission,contentRestrictions(readOnly,reason)';

  let targetMeta = null;
  let targetToken = '';
  let matchedAccount = '';
  let lastErr = null;

  for (const entry of tokenPool) {
    try {
      const meta = await driveApi(
        entry.token,
        `/files/${encodeURIComponent(targetId)}?supportsAllDrives=true&fields=${encodeURIComponent(META_FIELDS)}`
      );
      if (meta && meta.id) {
        targetMeta = meta;
        targetToken = entry.token;
        matchedAccount = entry.email || normalizeEntry(meta.owners?.[0]?.emailAddress || '');
        if (meta.ownedByMe || meta.capabilities?.canShare) {
          break;
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (!targetMeta || !targetToken) {
    throw new Error(lastErr?.message || '当前已授权账号无法读取目标汇总表，请确认表格链接及账号权限');
  }

  const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const exportResp = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(targetId)}/export?mimeType=${encodeURIComponent(xlsxMime)}`,
    {
      headers: { Authorization: `Bearer ${targetToken}` }
    }
  );
  if (!exportResp.ok) {
    let errDetail = '';
    try {
      const body = await exportResp.json();
      errDetail = body?.error?.message || '';
    } catch (_je) {}
    throw new Error(errDetail || `导出目标表格公式结构失败 (${exportResp.status})`);
  }

  const xlsxBuffer = await exportResp.arrayBuffer();
  const formulaHits = await parseXlsxImportRangeFormulas(xlsxBuffer);

  const targetOwnerEmail = normalizeEntry(targetMeta.owners?.[0]?.emailAddress || matchedAccount || '');
  const target = {
    id: targetMeta.id,
    name: targetMeta.name || '(未命名表格)',
    mimeType: targetMeta.mimeType || '',
    webViewLink: formatDriveCanonicalLink(targetMeta),
    ownerEmail: targetOwnerEmail,
    owners: targetMeta.owners || [],
    contentLocked: Boolean(targetMeta.contentRestrictions?.some(r => r?.readOnly)),
    matchedAccount
  };

  const groupedBySource = new Map();
  for (const hit of formulaHits) {
    const srcKey = hit.sourceSpreadsheetId || hit.rawSourceRef;
    if (!srcKey) continue;
    const jumpUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
      targetId
    )}/edit#gid=${encodeURIComponent(hit.sheetGid || '0')}&range=${encodeURIComponent(hit.cellRef || 'A1')}`;

    if (!groupedBySource.has(srcKey)) {
      groupedBySource.set(srcKey, {
        sourceSpreadsheetId: hit.sourceSpreadsheetId || '',
        rawSourceRef: hit.rawSourceRef,
        cells: []
      });
    }
    groupedBySource.get(srcKey).cells.push({
      sheetName: hit.sheetName,
      sheetGid: hit.sheetGid,
      cellRef: hit.cellRef,
      formula: hit.formula,
      rawSourceRef: hit.rawSourceRef,
      isRefError: Boolean(hit.isRefError),
      jumpUrl
    });
  }

  const sourceGroups = [...groupedBySource.values()];
  const dependencies = new Array(sourceGroups.length);
  let depCursor = 0;

  const workers = Array.from({ length: Math.min(4, Math.max(1, sourceGroups.length)) }, async () => {
    while (depCursor < sourceGroups.length) {
      const idx = depCursor++;
      const grp = sourceGroups[idx];
      const srcId = grp.sourceSpreadsheetId;
      const hasRefError = grp.cells.some(c => c.isRefError);
      const refErrorCellCount = grp.cells.filter(c => c.isRefError).length;
      const firstJumpUrl = (grp.cells.find(c => c.isRefError) || grp.cells[0])?.jumpUrl || '';

      if (!srcId) {
        dependencies[idx] = {
          sourceSpreadsheetId: '',
          rawSourceRef: grp.rawSourceRef,
          sourceName: `无法识别的源表引用 (${grp.rawSourceRef})`,
          sourceWebViewLink: '',
          sourceOwnerEmail: '',
          manageAccountEmail: '',
          sourceLocked: true,
          contentLocked: false,
          writersCanShare: true,
          copyRequiresWriterPermission: false,
          hasPublicAccess: false,
          targetOwnerEmail,
          targetOwnerHasAccess: false,
          canFixSourcePerm: false,
          hasRefError,
          refErrorCellCount,
          firstJumpUrl,
          cells: grp.cells,
          status: 'source_inaccessible'
        };
        continue;
      }

      let srcMeta = null;
      let bestSrcAccount = '';

      for (const entry of tokenPool) {
        try {
          const meta = await driveApi(
            entry.token,
            `/files/${encodeURIComponent(srcId)}?supportsAllDrives=true&fields=${encodeURIComponent(META_FIELDS)}`
          );
          if (!meta || !meta.id) continue;
          if ((!Array.isArray(meta.permissions) || meta.permissions.length === 0) && meta.capabilities?.canShare) {
            try {
              const pRes = await driveApi(
                entry.token,
                `/files/${encodeURIComponent(srcId)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,domain,displayName)`
              );
              meta.permissions = pRes?.permissions || [];
            } catch (_pe) {}
          }
          if (!srcMeta) {
            srcMeta = meta;
            bestSrcAccount = entry.email;
          }
          if (meta.ownedByMe || meta.capabilities?.canShare) {
            srcMeta = meta;
            bestSrcAccount = entry.email;
            break;
          }
        } catch (_srcErr) {}
      }

      if (!srcMeta) {
        dependencies[idx] = {
          sourceSpreadsheetId: srcId,
          rawSourceRef: grp.rawSourceRef,
          sourceName: `未授权访问的源表 (${srcId.slice(0, 8)}…)`,
          sourceWebViewLink: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(srcId)}/edit`,
          sourceOwnerEmail: '',
          manageAccountEmail: '',
          sourceLocked: true,
          contentLocked: false,
          writersCanShare: true,
          copyRequiresWriterPermission: false,
          hasPublicAccess: false,
          targetOwnerEmail,
          targetOwnerHasAccess: false,
          canFixSourcePerm: false,
          hasRefError,
          refErrorCellCount,
          firstJumpUrl,
          cells: grp.cells,
          status: 'source_inaccessible'
        };
        continue;
      }

      const perms = Array.isArray(srcMeta.permissions) ? srcMeta.permissions : [];
      const hasPublicAccess = perms.some(p => p && p.type === 'anyone');
      const contentLocked = Boolean(srcMeta.contentRestrictions?.some(r => r?.readOnly));
      const sourceLocked = Boolean(!hasPublicAccess || contentLocked);
      const srcOwnerEmail = normalizeEntry(srcMeta.owners?.[0]?.emailAddress || '');
      const ownerInPerms =
        Boolean(targetOwnerEmail) &&
        (targetOwnerEmail === srcOwnerEmail ||
          perms.some(p => p && p.emailAddress && normalizeEntry(p.emailAddress) === targetOwnerEmail));
      const targetOwnerHasAccess = Boolean(hasPublicAccess || ownerInPerms);
      const canFixSourcePerm = Boolean(srcMeta.ownedByMe || srcMeta.capabilities?.canShare);

      let status = 'accessible_or_public';
      if (!targetOwnerHasAccess) {
        status = 'missing_source_perm';
      } else if (hasRefError) {
        status = 'needs_allow_click';
      }

      dependencies[idx] = {
        sourceSpreadsheetId: srcId,
        rawSourceRef: grp.rawSourceRef,
        sourceName: srcMeta.name || `源表格 (${srcId.slice(0, 8)}…)`,
        sourceWebViewLink: formatDriveCanonicalLink(srcMeta),
        sourceOwnerEmail: srcOwnerEmail,
        manageAccountEmail: bestSrcAccount,
        sourceLocked,
        contentLocked,
        writersCanShare: srcMeta.writersCanShare !== false,
        copyRequiresWriterPermission: Boolean(srcMeta.copyRequiresWriterPermission),
        hasPublicAccess,
        targetOwnerEmail,
        targetOwnerHasAccess,
        canFixSourcePerm,
        hasRefError,
        refErrorCellCount,
        firstJumpUrl,
        cells: grp.cells,
        status
      };
    }
  });

  if (sourceGroups.length > 0) {
    await Promise.all(workers);
  }

  const refErrorCount = formulaHits.filter(h => h.isRefError).length;
  return {
    target,
    dependencies,
    totalFormulas: formulaHits.length,
    refErrorCount
  };
}

/**
 * 为汇总表所有者批量补齐被引用上游源表的 reader 只读访问权限
 */
async function grantImportRangeSourceAccess({ targetOwnerEmail, sourceIds = [], onProgress = null } = {}) {
  const cleanOwner = normalizeEntry(targetOwnerEmail || '');
  if (!cleanOwner || !cleanOwner.includes('@')) {
    throw new Error('缺少有效的目标汇总表所有者邮箱，无法补齐源表只读权限');
  }

  const cleanSourceIds = [
    ...new Set(
      (Array.isArray(sourceIds) ? sourceIds : [sourceIds])
        .map(x => parseDriveUrlOrId(x).fileId || String(x || '').trim())
        .filter(Boolean)
    )
  ];

  if (!cleanSourceIds.length) {
    return { grantedCount: 0, skippedCount: 0, failedCount: 0, failedItems: [] };
  }

  const tokenPool = await buildAuthorizedTokenPool('');
  if (!tokenPool.length) {
    throw new Error('尚未找到可用的已授权账号令牌');
  }

  let grantedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let cursor = 0;
  const failedItems = [];
  const logs = [];
  const grantedByFileId = new Map();

  const workers = Array.from({ length: Math.min(4, cleanSourceIds.length) }, async () => {
    while (cursor < cleanSourceIds.length) {
      const srcId = cleanSourceIds[cursor++];
      try {
        let manageToken = '';
        let manageAccount = '';
        let srcMeta = null;

        for (const entry of tokenPool) {
          try {
            const meta = await driveApi(
              entry.token,
              `/files/${encodeURIComponent(srcId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,ownedByMe,owners(emailAddress),capabilities(canShare),permissions(id,type,role,emailAddress)`
            );
            if (!meta || !meta.id) continue;
            if ((!Array.isArray(meta.permissions) || meta.permissions.length === 0) && meta.capabilities?.canShare) {
              try {
                const pRes = await driveApi(
                  entry.token,
                  `/files/${encodeURIComponent(srcId)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress)`
                );
                meta.permissions = pRes?.permissions || [];
              } catch (_pe) {}
            }
            if (!srcMeta) {
              srcMeta = meta;
              manageToken = entry.token;
              manageAccount = entry.email;
            }
            if (meta.ownedByMe || meta.capabilities?.canShare) {
              srcMeta = meta;
              manageToken = entry.token;
              manageAccount = entry.email;
              break;
            }
          } catch (_e) {}
        }

        if (!srcMeta || !manageToken) {
          throw new Error('当前已授权账号无权读取或管理该源表');
        }

        const srcOwner = normalizeEntry(srcMeta.owners?.[0]?.emailAddress || '');
        const existingPerms = Array.isArray(srcMeta.permissions) ? srcMeta.permissions : [];
        const alreadyHasAccess =
          cleanOwner === srcOwner ||
          existingPerms.some(p => p && p.emailAddress && normalizeEntry(p.emailAddress) === cleanOwner);

        if (alreadyHasAccess) {
          skippedCount++;
        } else {
          const created = await createPermission(manageToken, srcId, {
            type: 'user',
            role: 'reader',
            emailAddress: cleanOwner
          });
          grantedCount++;
          grantedByFileId.set(srcId, {
            id: created?.id || `ir-${Date.now()}-${Math.random()}`,
            type: 'user',
            role: 'reader',
            emailAddress: cleanOwner
          });
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'grant',
            accountEmail: manageAccount || srcOwner,
            fileId: srcId,
            fileName: srcMeta.name || `源表格 (${srcId.slice(0, 8)}…)`,
            webViewLink: formatDriveCanonicalLink(srcMeta),
            permissionId: created?.id || '',
            targetType: 'user',
            targetEmail: cleanOwner,
            targetLabel: cleanOwner,
            previousRole: '',
            newRole: 'reader',
            restored: false,
            message: `IMPORTRANGE 跨表放行：为汇总表所有者 ${cleanOwner} 补齐源表「仅查看」权限`
          });
        }
      } catch (error) {
        failedCount++;
        failedItems.push({
          sourceSpreadsheetId: srcId,
          targetOwnerEmail: cleanOwner,
          errorMessage: error?.message || String(error)
        });
      }

      if (onProgress) {
        const done = grantedCount + skippedCount + failedCount;
        onProgress({
          done,
          total: cleanSourceIds.length,
          grantedCount,
          skippedCount,
          failedCount,
          message: `正在放行上游源表权限 ${done}/${cleanSourceIds.length}（已授权 ${grantedCount}，已具备 ${skippedCount}，失败 ${failedCount}）…`
        });
      }
    }
  });

  await Promise.all(workers);

  if (grantedByFileId.size > 0) {
    try {
      const rawSnap = await chrome.storage.local.get('scanSnapshot');
      const snap = rawSnap?.scanSnapshot;
      if (snap && Array.isArray(snap.files)) {
        let touched = false;
        for (const sf of snap.files) {
          if (sf && grantedByFileId.has(sf.id)) {
            sf.permissions = Array.isArray(sf.permissions) ? sf.permissions : [];
            const newPerm = grantedByFileId.get(sf.id);
            if (!sf.permissions.some(p => normalizeEntry(p.emailAddress || '') === cleanOwner)) {
              sf.permissions.push(newPerm);
              touched = true;
            }
          }
        }
        if (touched) {
          await saveSnapshot(snap);
        }
      }
    } catch (_se) {}
  }

  if (logs.length > 0) {
    await appendAuditLogs(logs);
  }

  return {
    grantedCount,
    skippedCount,
    failedCount,
    failedItems
  };
}

/* ==================== 3. 岗位权限包（Role Bundles：入职赋权与转岗差集切换） ==================== */

function parseRoleBundleAssetsInput(rawText = '', existingFiles = [], defaultRole = 'reader') {
  const cleanDefault = normalizePermissionRole(defaultRole, 'reader') || 'reader';
  const fileMap = new Map();
  for (const f of existingFiles || []) {
    if (f && f.id) fileMap.set(f.id, f);
  }

  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const itemMap = new Map();
  for (const line of lines) {
    const parts = line
      .split(/[\t,，;；|]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!parts.length) continue;

    let fid = '';
    let role = cleanDefault;
    let customName = '';

    for (const part of parts) {
      const roleHit = normalizePermissionRole(part, '');
      if (roleHit) {
        role = roleHit;
        continue;
      }
      if (!fid) {
        const parsed = parseDriveUrlOrId(part);
        if (parsed.fileId) {
          fid = parsed.fileId;
          continue;
        }
        const extracted = parseDriveLinksInput(part);
        if (extracted.length > 0) {
          fid = extracted[0];
          continue;
        }
      } else if (!customName) {
        customName = part;
      }
    }

    if (!fid) continue;
    const local = fileMap.get(fid);
    itemMap.set(fid, {
      fileId: fid,
      fileName: local?.name || customName || `云盘资产 (${fid.slice(0, 8)}…)`,
      mimeType: local?.mimeType || '',
      webViewLink: local ? formatDriveCanonicalLink(local) : `https://drive.google.com/open?id=${encodeURIComponent(fid)}`,
      role
    });
  }

  return [...itemMap.values()];
}

async function getRoleBundles() {
  const data = await chrome.storage.local.get('roleBundles');
  return Array.isArray(data.roleBundles) ? data.roleBundles : [];
}

async function saveRoleBundles(bundles = []) {
  const list = Array.isArray(bundles) ? bundles : [];
  const cleaned = [];
  const seenIds = new Set();
  const nowIso = new Date().toISOString();

  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const name = String(b.name || '').trim();
    if (!name) continue;
    const id = String(b.id || `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`).trim();
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const itemById = new Map();
    for (const rawIt of b.items || []) {
      if (!rawIt) continue;
      const fid =
        parseDriveUrlOrId(rawIt.fileId || rawIt.link || '').fileId || String(rawIt.fileId || '').trim();
      if (!fid) continue;
      const role = normalizePermissionRole(rawIt.role, 'reader') || 'reader';
      itemById.set(fid, {
        fileId: fid,
        fileName: String(rawIt.fileName || rawIt.name || `云盘资产 (${fid.slice(0, 8)}…)`).trim(),
        mimeType: String(rawIt.mimeType || ''),
        webViewLink: String(rawIt.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(fid)}`),
        role
      });
    }

    cleaned.push({
      id,
      name,
      description: String(b.description || '').trim(),
      items: [...itemById.values()],
      updatedAt: String(b.updatedAt || nowIso)
    });
  }

  await safeStorageSet({ roleBundles: cleaned });
  return cleaned;
}

async function runRoleBundleOperations({
  operations = [],
  actionSummaryPrefix = '岗位权限包',
  expiresAt = '',
  expireAction = 'revoke',
  onProgress = null,
  shouldStop = null
} = {}) {
  const validExpiresAt =
    expiresAt && Number.isFinite(Date.parse(expiresAt)) ? new Date(Date.parse(expiresAt)).toISOString() : '';
  const tokenPool = await buildAuthorizedTokenPool('');
  if (!tokenPool.length && operations.length > 0) {
    throw new Error('尚未找到可用的已授权账号令牌');
  }

  let snap = null;
  const snapFileMap = new Map();
  try {
    const rawSnap = await chrome.storage.local.get('scanSnapshot');
    snap = rawSnap?.scanSnapshot || null;
    if (snap && Array.isArray(snap.files)) {
      for (const sf of snap.files) {
        if (sf && sf.id) snapFileMap.set(sf.id, sf);
      }
    }
  } catch (_e) {}

  const uniqueFileIds = [...new Set(operations.map(op => op.fileId).filter(Boolean))];
  const fileContextMap = new Map();
  let metaCursor = 0;

  const metaWorkers = Array.from({ length: Math.min(6, Math.max(1, uniqueFileIds.length)) }, async () => {
    while (metaCursor < uniqueFileIds.length) {
      if (shouldStop?.()) break;
      const fid = uniqueFileIds[metaCursor++];
      const snapFile = snapFileMap.get(fid) || null;
      let resolvedToken = tokenPool[0]?.token || '';
      let resolvedAccount = tokenPool[0]?.email || '';
      let fileName = snapFile?.name || `云盘资产 (${fid.slice(0, 8)}…)`;
      let mimeType = snapFile?.mimeType || '';
      let webViewLink = snapFile ? formatDriveCanonicalLink(snapFile) : `https://drive.google.com/open?id=${encodeURIComponent(fid)}`;
      let livePermissions = Array.isArray(snapFile?.permissions) ? [...snapFile.permissions] : null;

      const prefOwner = normalizeEntry(snapFile?.ownerAccount || snapFile?.owners?.[0]?.emailAddress || '');
      const orderedPool = prefOwner
        ? [
            ...tokenPool.filter(x => x.email === prefOwner),
            ...tokenPool.filter(x => x.email !== prefOwner)
          ]
        : tokenPool;

      for (const entry of orderedPool) {
        try {
          const meta = await driveApi(
            entry.token,
            `/files/${encodeURIComponent(fid)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,ownedByMe,owners(emailAddress),capabilities(canShare),permissions(id,type,role,emailAddress,permissionDetails(role,inherited))`
          );
          if (!meta || !meta.id) continue;
          if ((!Array.isArray(meta.permissions) || meta.permissions.length === 0) && meta.capabilities?.canShare) {
            try {
              const pData = await driveApi(
                entry.token,
                `/files/${encodeURIComponent(fid)}/permissions?supportsAllDrives=true&pageSize=100&fields=permissions(id,type,role,emailAddress,permissionDetails(role,inherited))`
              );
              meta.permissions = pData?.permissions || [];
            } catch (_pe) {}
          }
          resolvedToken = entry.token;
          resolvedAccount = entry.email || normalizeEntry(meta.owners?.[0]?.emailAddress || '');
          fileName = meta.name || fileName;
          mimeType = meta.mimeType || mimeType;
          webViewLink = formatDriveCanonicalLink(meta);
          livePermissions = Array.isArray(meta.permissions) ? meta.permissions : livePermissions || [];
          if (meta.ownedByMe || meta.capabilities?.canShare) break;
        } catch (_me) {}
      }

      fileContextMap.set(fid, {
        fileId: fid,
        fileName,
        mimeType,
        webViewLink,
        token: resolvedToken,
        accountEmail: resolvedAccount,
        permissions: livePermissions || [],
        snapFile
      });
    }
  });

  if (uniqueFileIds.length > 0) {
    await Promise.all(metaWorkers);
  }

  let grantedCount = 0;
  let updatedCount = 0;
  let revokedCount = 0;
  let unchangedCount = 0;
  let failedCount = 0;
  let stopped = false;
  let opCursor = 0;
  const failedItems = [];
  const ttlBatch = [];
  const logs = [];
  let snapTouched = false;

  const workers = Array.from({ length: Math.min(4, Math.max(1, operations.length)) }, async () => {
    while (opCursor < operations.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const op = operations[opCursor++];
      const ctx = fileContextMap.get(op.fileId);
      if (!ctx || !ctx.token) {
        failedCount++;
        failedItems.push({ ...op, errorMessage: '未找到可管理此文件的账号令牌' });
        continue;
      }

      const email = normalizeEntry(op.email);
      const existing = (ctx.permissions || []).find(p => normalizeEntry(p?.emailAddress || '') === email);

      try {
        if (op.opType === 'grant_or_adjust') {
          const desiredRole = normalizePermissionRole(op.role, 'reader') || 'reader';
          if (existing && existing.role === 'owner') {
            unchangedCount++;
          } else if (existing && !permIsInherited(existing)) {
            if (existing.role === desiredRole && !validExpiresAt) {
              unchangedCount++;
            } else {
              const prevRole = existing.role;
              if (prevRole !== desiredRole) {
                await updatePermissionRole(ctx.token, ctx.fileId, existing.id, desiredRole);
                existing.role = desiredRole;
                if (ctx.snapFile && Array.isArray(ctx.snapFile.permissions)) {
                  const sp = ctx.snapFile.permissions.find(p => p.id === existing.id || normalizeEntry(p.emailAddress || '') === email);
                  if (sp) {
                    sp.role = desiredRole;
                    snapTouched = true;
                  }
                }
              }
              if (validExpiresAt) {
                ttlBatch.push({
                  fileId: ctx.fileId,
                  fileName: ctx.fileName,
                  mimeType: ctx.mimeType,
                  webViewLink: ctx.webViewLink,
                  accountEmail: ctx.accountEmail,
                  permissionId: existing.id,
                  targetType: 'user',
                  targetEmail: email,
                  targetLabel: email,
                  grantedRole: desiredRole,
                  expireAction: expireAction || 'revoke',
                  expiresAt: validExpiresAt,
                  nativeExpirationApplied: false
                });
              }
              updatedCount++;
              logs.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                source: 'manual',
                actionType: 'downgrade',
                isTtl: Boolean(validExpiresAt),
                accountEmail: ctx.accountEmail,
                fileId: ctx.fileId,
                fileName: ctx.fileName,
                webViewLink: ctx.webViewLink,
                permissionId: existing.id,
                targetType: 'user',
                targetEmail: email,
                targetLabel: email,
                previousRole: prevRole,
                newRole: desiredRole,
                restored: false,
                message: `${actionSummaryPrefix}：调整角色 ${roleLabel(prevRole)} -> ${roleLabel(desiredRole)}${
                  validExpiresAt ? `（限时：${formatTtlRemaining(validExpiresAt)}）` : ''
                }`
              });
            }
          } else {
            let created = null;
            let nativeExpirationApplied = false;
            if (validExpiresAt) {
              const grantRes = await grantPermissionCoreApi(
                ctx.token,
                { mimeType: ctx.mimeType },
                ctx.fileId,
                {
                  type: 'user',
                  role: desiredRole,
                  emailAddress: email,
                  expiresAt: validExpiresAt
                }
              );
              created = grantRes.createdPermission;
              nativeExpirationApplied = grantRes.nativeExpirationApplied;
            } else {
              created = await createPermission(ctx.token, ctx.fileId, {
                type: 'user',
                role: desiredRole,
                emailAddress: email
              });
            }
            const newPermObj = {
              id: created?.id || `bdl-${Date.now()}-${Math.random()}`,
              type: 'user',
              role: desiredRole,
              emailAddress: email
            };
            ctx.permissions.push(newPermObj);
            if (ctx.snapFile) {
              ctx.snapFile.permissions = Array.isArray(ctx.snapFile.permissions) ? ctx.snapFile.permissions : [];
              ctx.snapFile.permissions.push(newPermObj);
              snapTouched = true;
            }
            if (validExpiresAt) {
              ttlBatch.push({
                fileId: ctx.fileId,
                fileName: ctx.fileName,
                mimeType: ctx.mimeType,
                webViewLink: ctx.webViewLink,
                accountEmail: ctx.accountEmail,
                permissionId: created?.id || '',
                targetType: 'user',
                targetEmail: email,
                targetLabel: email,
                grantedRole: desiredRole,
                expireAction: expireAction || 'revoke',
                expiresAt: validExpiresAt,
                nativeExpirationApplied
              });
            }
            grantedCount++;
            logs.push({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: new Date().toISOString(),
              source: 'manual',
              actionType: 'grant',
              isTtl: Boolean(validExpiresAt),
              accountEmail: ctx.accountEmail,
              fileId: ctx.fileId,
              fileName: ctx.fileName,
              webViewLink: ctx.webViewLink,
              permissionId: created?.id || '',
              targetType: 'user',
              targetEmail: email,
              targetLabel: email,
              previousRole: '',
              newRole: desiredRole,
              restored: false,
              message: `${actionSummaryPrefix}：授予「${roleLabel(desiredRole)}」权限${
                validExpiresAt ? `（限时：${formatTtlRemaining(validExpiresAt)}）` : ''
              }`
            });
          }
        } else if (op.opType === 'revoke') {
          if (!existing || existing.role === 'owner' || permIsInherited(existing)) {
            unchangedCount++;
          } else {
            await deletePermission(ctx.token, ctx.fileId, existing.id);
            ctx.permissions = ctx.permissions.filter(p => p.id !== existing.id);
            if (ctx.snapFile && Array.isArray(ctx.snapFile.permissions)) {
              ctx.snapFile.permissions = ctx.snapFile.permissions.filter(p => p.id !== existing.id);
              snapTouched = true;
            }
            revokedCount++;
            logs.push({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: new Date().toISOString(),
              source: 'manual',
              actionType: 'revoke',
              accountEmail: ctx.accountEmail,
              fileId: ctx.fileId,
              fileName: ctx.fileName,
              webViewLink: ctx.webViewLink,
              permissionId: existing.id,
              targetType: 'user',
              targetEmail: email,
              targetLabel: email,
              previousRole: existing.role,
              newRole: '',
              restored: false,
              message: `${actionSummaryPrefix}：收回原岗「${roleLabel(existing.role)}」权限`
            });
          }
        }
      } catch (error) {
        failedCount++;
        failedItems.push({
          ...op,
          fileName: ctx.fileName,
          errorMessage: error?.message || String(error)
        });
      }

      if (onProgress) {
        const done = grantedCount + updatedCount + revokedCount + unchangedCount + failedCount;
        onProgress({
          done,
          total: operations.length,
          grantedCount,
          updatedCount,
          revokedCount,
          unchangedCount,
          failedCount,
          stopped,
          message: `${actionSummaryPrefix}执行中 ${done}/${operations.length}…`
        });
      }
    }
  });

  if (operations.length > 0) {
    await Promise.all(workers);
  }

  if (ttlBatch.length > 0) {
    await enqueueTtlPermissions(ttlBatch);
  }
  if (snapTouched && snap) {
    try {
      await saveSnapshot(snap);
    } catch (_se) {}
  }
  if (logs.length > 0) {
    await appendAuditLogs(logs);
  }

  const changedCount = grantedCount + updatedCount + revokedCount;
  return {
    grantedCount,
    updatedCount,
    revokedCount,
    unchangedCount,
    changedCount,
    failedCount,
    total: operations.length,
    failedItems,
    stopped
  };
}

/**
 * 岗位权限包：新员工入职一键赋权
 */
async function executeRoleBundleOnboarding({
  bundle,
  emails = [],
  expiresAt = '',
  expireAction = 'revoke',
  onProgress = null,
  shouldStop = null
} = {}) {
  const cleanEmails = parseEmailListInput(emails);
  if (!bundle || !Array.isArray(bundle.items) || bundle.items.length === 0) {
    throw new Error('所选岗位权限包内暂无云盘资产');
  }
  if (!cleanEmails.length) {
    throw new Error('请输入至少 1 个入职人员邮箱');
  }

  const operations = [];
  for (const item of bundle.items) {
    if (!item?.fileId) continue;
    for (const em of cleanEmails) {
      operations.push({
        opType: 'grant_or_adjust',
        fileId: item.fileId,
        email: em,
        role: normalizePermissionRole(item.role, 'reader') || 'reader'
      });
    }
  }

  return runRoleBundleOperations({
    operations,
    actionSummaryPrefix: `岗位包【${bundle.name || '未命名'}】入职赋权`,
    expiresAt,
    expireAction,
    onProgress,
    shouldStop
  });
}

/**
 * 岗位权限包：一键转岗权限差集切换（收回旧岗独有资产 · 升降级重叠资产 · 开通新岗新增资产）
 */
async function executeRoleBundleTransfer({
  fromBundle,
  toBundle,
  emails = [],
  expiresAt = '',
  expireAction = 'revoke',
  onProgress = null,
  shouldStop = null
} = {}) {
  const cleanEmails = parseEmailListInput(emails);
  if (!fromBundle || !toBundle) {
    throw new Error('请同时选择原岗位包与新岗位包');
  }
  if (fromBundle.id && toBundle.id && fromBundle.id === toBundle.id) {
    throw new Error('原岗位包与新岗位包不能相同');
  }
  if (!cleanEmails.length) {
    throw new Error('请输入至少 1 个转岗人员邮箱');
  }

  const fromMap = new Map();
  for (const it of fromBundle.items || []) {
    if (it?.fileId) fromMap.set(it.fileId, normalizePermissionRole(it.role, 'reader') || 'reader');
  }
  const toMap = new Map();
  for (const it of toBundle.items || []) {
    if (it?.fileId) toMap.set(it.fileId, normalizePermissionRole(it.role, 'reader') || 'reader');
  }

  const operations = [];
  // 1. 旧岗独有资产 -> 收回权限
  for (const oldFid of fromMap.keys()) {
    if (!toMap.has(oldFid)) {
      for (const em of cleanEmails) {
        operations.push({
          opType: 'revoke',
          fileId: oldFid,
          email: em,
          role: ''
        });
      }
    }
  }
  // 2. 重叠资产与新岗新增资产 -> 按新岗角色开通或升降级
  for (const [newFid, newRole] of toMap.entries()) {
    for (const em of cleanEmails) {
      operations.push({
        opType: 'grant_or_adjust',
        fileId: newFid,
        email: em,
        role: newRole
      });
    }
  }

  return runRoleBundleOperations({
    operations,
    actionSummaryPrefix: `转岗切换【${fromBundle.name || '原岗'} -> ${toBundle.name || '新岗'}】`,
    expiresAt,
    expireAction,
    onProgress,
    shouldStop
  });
}

/* ==================== 4. 外部合作方生命周期档案（Partner Profiles） ==================== */

async function getPartnerProfiles() {
  const data = await chrome.storage.local.get('partnerProfiles');
  return Array.isArray(data.partnerProfiles) ? data.partnerProfiles : [];
}

async function savePartnerProfiles(profiles = []) {
  const list = Array.isArray(profiles) ? profiles : [];
  const cleaned = [];
  const seenIds = new Set();
  const nowIso = new Date().toISOString();

  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '').trim();
    if (!name) continue;
    const id = String(p.id || `partner_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`).trim();
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const rawDomainTokens = Array.isArray(p.domains)
      ? p.domains.join('\n')
      : String(p.domains || '');
    const rawEmailTokens = Array.isArray(p.emails)
      ? p.emails.join('\n')
      : String(p.emails || '');

    const domainsSet = new Set();
    const emailsSet = new Set(parseEmailListInput(rawEmailTokens));

    for (const token of rawDomainTokens.split(/[\r\n\s,，;；]+/).map(s => s.trim()).filter(Boolean)) {
      if (token.includes('@') && !token.startsWith('@')) {
        const parsedEm = parseEmailListInput(token);
        for (const em of parsedEm) emailsSet.add(em);
      } else {
        const cleanDom = token.toLowerCase().replace(/^@+/, '').trim();
        if (cleanDom && cleanDom.includes('.')) {
          domainsSet.add(cleanDom);
        }
      }
    }

    let cleanExpiresAt = '';
    if (p.expiresAt) {
      const rawExp = String(p.expiresAt).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawExp)) {
        cleanExpiresAt = `${rawExp}T23:59:59.999Z`;
      } else if (Number.isFinite(Date.parse(rawExp))) {
        cleanExpiresAt = new Date(Date.parse(rawExp)).toISOString();
      }
    }

    cleaned.push({
      id,
      name,
      domains: [...domainsSet],
      emails: [...emailsSet],
      expiresAt: cleanExpiresAt,
      note: String(p.note || '').trim(),
      updatedAt: String(p.updatedAt || nowIso)
    });
  }

  await safeStorageSet({ partnerProfiles: cleaned });
  return cleaned;
}

/**
 * 匹配外部合作方档案关联的云盘文件、命中邮箱及合同到期状态
 */
function matchFilesForPartner(files = [], partner = {}, nowMs = Date.now()) {
  const domainSet = new Set(
    (partner?.domains || [])
      .map(d => String(d || '').trim().toLowerCase().replace(/^@+/, ''))
      .filter(Boolean)
  );
  const emailSet = new Set((partner?.emails || []).map(normalizeEntry).filter(Boolean));

  const matchedFiles = [];
  const matchedEmailSet = new Set();

  for (const file of files || []) {
    if (!file || !file.id) continue;
    const ownerEmail = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');
    let fileHit = false;

    for (const perm of file.permissions || []) {
      if (!perm || perm.role === 'owner') continue;
      if (perm.emailAddress) {
        const em = normalizeEntry(perm.emailAddress);
        if (em && em !== ownerEmail) {
          const dom = extractEmailDomain(em);
          if (emailSet.has(em) || (dom && domainSet.has(dom))) {
            fileHit = true;
            matchedEmailSet.add(em);
          }
        }
      } else if (perm.type === 'domain' && perm.domain) {
        const pDom = String(perm.domain).trim().toLowerCase();
        if (domainSet.has(pDom)) {
          fileHit = true;
        }
      }
    }

    if (fileHit) {
      matchedFiles.push(file);
    }
  }

  let daysRemaining = null;
  let isExpired = false;
  let isExpiringSoon = false;

  if (partner?.expiresAt && Number.isFinite(Date.parse(partner.expiresAt))) {
    const diffMs = Date.parse(partner.expiresAt) - nowMs;
    daysRemaining = Math.ceil(diffMs / 86400000);
    isExpired = diffMs <= 0;
    isExpiringSoon = !isExpired && daysRemaining <= 7;
  }

  return {
    files: matchedFiles,
    matchedEmails: [...matchedEmailSet],
    daysRemaining,
    isExpired,
    isExpiringSoon
  };
}

/* ==================== 5. 沉睡编辑权雷达（Dormant Permissions） ==================== */

/**
 * 扫描超过指定天数未发生修改/访问却仍持有编辑权的非所有者直接权限项
 */
function findDormantEditorEntries(files = [], { inactiveDays = 90, nowMs = Date.now() } = {}) {
  const thresholdDays = Math.max(1, Number(inactiveDays) || 90);
  const cutoffMs = nowMs - thresholdDays * 86400000;
  const entries = [];

  for (const file of files || []) {
    if (!file || !file.id) continue;
    const modMs = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
    const viewMs = file.viewedByMeTime ? Date.parse(file.viewedByMeTime) : NaN;
    const createdMs = file.createdTime ? Date.parse(file.createdTime) : NaN;
    const lastActiveMs = Number.isFinite(modMs)
      ? modMs
      : Number.isFinite(viewMs)
        ? viewMs
        : createdMs;

    if (!Number.isFinite(lastActiveMs) || lastActiveMs > cutoffMs) continue;

    const dormantDays = Math.max(thresholdDays, Math.floor((nowMs - lastActiveMs) / 86400000));
    const ownerEmail = normalizeEntry(file.ownerAccount || file.owners?.[0]?.emailAddress || '');

    for (const perm of file.permissions || []) {
      if (!perm || !perm.id || perm.role === 'owner') continue;
      if (permIsInherited(perm)) continue;
      if (!['writer', 'organizer', 'fileOrganizer'].includes(perm.role)) continue;
      const pEmail = normalizeEntry(perm.emailAddress || '');
      if (pEmail && pEmail === ownerEmail) continue;

      entries.push({
        id: `${file.id}::${perm.id}`,
        fileId: file.id,
        fileName: file.name || '(无名称)',
        mimeType: file.mimeType || '',
        webViewLink: formatDriveCanonicalLink(file),
        accountEmail: ownerEmail,
        permissionId: perm.id,
        targetType: perm.type || 'user',
        targetEmail: pEmail,
        domain: perm.domain || '',
        targetLabel: permissionLabel(perm),
        currentRole: perm.role,
        modifiedTime: file.modifiedTime || '',
        viewedByMeTime: file.viewedByMeTime || '',
        dormantDays
      });
    }
  }

  entries.sort((a, b) => b.dormantDays - a.dormantDays);
  return entries;
}

/**
 * 对沉睡编辑权条目批量降级为只读/评论或直接收回权限
 */
async function downgradeOrRevokeDormantEntries({
  entries = [],
  mode = 'downgrade_reader',
  files = null,
  onProgress = null,
  shouldStop = null
} = {}) {
  const validEntries = (Array.isArray(entries) ? entries : []).filter(e => e && e.fileId && e.permissionId);
  const isRevoke = mode === 'revoke' || mode === 'remove' || mode === 'delete';
  const targetRole = mode === 'downgrade_commenter' || mode === 'commenter' ? 'commenter' : 'reader';

  const localMap = new Map();
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f && f.id) localMap.set(f.id, f);
    }
  }

  let snap = null;
  const snapMap = new Map();
  try {
    const rawSnap = await chrome.storage.local.get('scanSnapshot');
    snap = rawSnap?.scanSnapshot || null;
    if (snap && Array.isArray(snap.files)) {
      for (const sf of snap.files) {
        if (sf && sf.id) snapMap.set(sf.id, sf);
      }
    }
  } catch (_e) {}

  const tokenCache = new Map();
  async function getToken(accEmail) {
    const norm = normalizeEntry(accEmail || '');
    if (tokenCache.has(norm)) return tokenCache.get(norm);
    const tk = await getValidTokenForAccount(norm, true);
    tokenCache.set(norm, tk);
    return tk;
  }

  let downgradedCount = 0;
  let revokedCount = 0;
  let failedCount = 0;
  let stopped = false;
  let cursor = 0;
  let snapTouched = false;
  const failedItems = [];
  const logs = [];

  const workers = Array.from({ length: Math.min(4, Math.max(1, validEntries.length)) }, async () => {
    while (cursor < validEntries.length) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      const entry = validEntries[cursor++];
      try {
        const token = await getToken(entry.accountEmail);
        if (isRevoke) {
          await deletePermission(token, entry.fileId, entry.permissionId);
          for (const targetFile of [localMap.get(entry.fileId), snapMap.get(entry.fileId)]) {
            if (targetFile && Array.isArray(targetFile.permissions)) {
              targetFile.permissions = targetFile.permissions.filter(p => p.id !== entry.permissionId);
              if (targetFile === snapMap.get(entry.fileId)) snapTouched = true;
            }
          }
          revokedCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'revoke',
            accountEmail: entry.accountEmail || '',
            fileId: entry.fileId,
            fileName: entry.fileName || '(无名称)',
            webViewLink: entry.webViewLink || '',
            permissionId: entry.permissionId,
            targetType: entry.targetType || 'user',
            targetEmail: entry.targetEmail || '',
            domain: entry.domain || '',
            targetLabel: entry.targetLabel || entry.targetEmail || '',
            previousRole: entry.currentRole || 'writer',
            newRole: '',
            restored: false,
            message: `沉睡编辑权瘦身（闲置 ${entry.dormantDays || 90} 天）：已移除权限`
          });
        } else {
          await updatePermissionRole(token, entry.fileId, entry.permissionId, targetRole);
          for (const targetFile of [localMap.get(entry.fileId), snapMap.get(entry.fileId)]) {
            if (targetFile && Array.isArray(targetFile.permissions)) {
              const hit = targetFile.permissions.find(p => p.id === entry.permissionId);
              if (hit) {
                hit.role = targetRole;
                if (targetFile === snapMap.get(entry.fileId)) snapTouched = true;
              }
            }
          }
          downgradedCount++;
          logs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            source: 'manual',
            actionType: 'downgrade',
            accountEmail: entry.accountEmail || '',
            fileId: entry.fileId,
            fileName: entry.fileName || '(无名称)',
            webViewLink: entry.webViewLink || '',
            permissionId: entry.permissionId,
            targetType: entry.targetType || 'user',
            targetEmail: entry.targetEmail || '',
            domain: entry.domain || '',
            targetLabel: entry.targetLabel || entry.targetEmail || '',
            previousRole: entry.currentRole || 'writer',
            newRole: targetRole,
            restored: false,
            message: `沉睡编辑权瘦身（闲置 ${entry.dormantDays || 90} 天）：${roleLabel(
              entry.currentRole || 'writer'
            )} -> ${roleLabel(targetRole)}`
          });
        }
      } catch (error) {
        failedCount++;
        failedItems.push({
          ...entry,
          errorMessage: error?.message || String(error)
        });
      }

      if (onProgress) {
        const done = downgradedCount + revokedCount + failedCount;
        onProgress({
          done,
          total: validEntries.length,
          changedCount: downgradedCount + revokedCount,
          downgradedCount,
          revokedCount,
          failedCount,
          stopped,
          message: `正在处理沉睡编辑权 ${done}/${validEntries.length}…`
        });
      }
    }
  });

  if (validEntries.length > 0) {
    await Promise.all(workers);
  }

  if (snapTouched && snap) {
    try {
      await saveSnapshot(snap);
    } catch (_se) {}
  }

  if (logs.length > 0) {
    await appendAuditLogs(logs);
  }

  return {
    changedCount: downgradedCount + revokedCount,
    downgradedCount,
    revokedCount,
    failedCount,
    total: validEntries.length,
    failedItems,
    stopped
  };
}

/* ==================== 6. 目录树权限分叉构建器（Folder Tree Topology） ==================== */

/**
 * 基于 parents 构建云盘资产目录树，精准识别子项相对父目录的权限分叉 (diverged)
 * 并统计每个父目录下与父目录权限完全一致的子项数 uniformChildCount
 */
function buildFolderPermissionTree(files = [], policy = DEFAULT_POLICY, accountEmail = '') {
  const validFiles = (Array.isArray(files) ? files : []).filter(f => f && f.id);
  const excludedSet =
    policy?.excludedFolders?.length > 0
      ? buildExcludedFileIdSet(validFiles, policy.excludedFolders)
      : null;
  const nodeMap = new Map();
  const breakageMap = analyzeInheritanceBreakage(validFiles);

  for (const file of validFiles) {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const ownerEmail = file.ownerAccount || file.owners?.[0]?.emailAddress || accountEmail || '';
    const evaluation = evaluateFile(file, policy, ownerEmail, excludedSet);
    const fingerprint = buildFilePermissionFingerprint(file);
    const rawParentId = Array.isArray(file.parents) && file.parents[0] ? String(file.parents[0]) : '';

    nodeMap.set(file.id, {
      id: file.id,
      file,
      name: file.name || '(无名称)',
      mimeType: file.mimeType || '',
      isFolder,
      rawParentId,
      parentId: '',
      depth: 0,
      path: file.name || '(无名称)',
      fingerprint,
      evaluation,
      breakage: breakageMap.get(file.id) || null,
      diverged: false,
      divergenceReason: '',
      hasDescendantDivergence: false,
      securityFlags: {
        writersCanShare: file.writersCanShare !== false,
        copyRequiresWriterPermission: Boolean(file.copyRequiresWriterPermission),
        contentLocked: Boolean(file.contentLocked || file.contentRestrictions?.some(r => r?.readOnly)),
        unhardened: Boolean(
          (file.shared || evaluation.hasNonOwner) &&
            (file.writersCanShare !== false || (!isFolder && !file.copyRequiresWriterPermission))
        )
      },
      children: [],
      divergedChildren: [],
      uniformChildren: [],
      uniformChildCount: 0,
      divergedChildCount: 0,
      totalChildCount: 0
    });
  }

  // 建立防环父子挂载关系
  const roots = [];
  for (const node of nodeMap.values()) {
    let pId = node.rawParentId;
    if (pId && pId !== node.id && nodeMap.has(pId)) {
      // 检测潜在环路
      const visited = new Set([node.id]);
      let cur = pId;
      let hasCycle = false;
      while (cur && nodeMap.has(cur)) {
        if (visited.has(cur)) {
          hasCycle = true;
          break;
        }
        visited.add(cur);
        cur = nodeMap.get(cur).rawParentId;
      }
      if (!hasCycle) {
        node.parentId = pId;
        nodeMap.get(pId).children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  let divergedCount = 0;
  let uniformCount = 0;

  // 自顶向下计算深度、路径与相对父目录的权限分叉状态
  function traverseTopDown(node, parentNode, depth, ancestorPath) {
    node.depth = depth;
    node.path = ancestorPath ? `${ancestorPath} / ${node.name}` : node.name;

    if (parentNode) {
      const parentSig = parentNode.fingerprint?.sig ?? '';
      const childSig = node.fingerprint?.sig ?? '';
      if (node.breakage?.broken) {
        node.diverged = true;
        node.divergenceReason = node.breakage.summaryText || '子项存在超出父目录的单独权限';
      } else if (parentNode.fingerprint && node.fingerprint && parentSig !== childSig) {
        node.diverged = true;
        const diff = computeFilePermissionDiff(parentNode.fingerprint, node.fingerprint);
        node.divergenceReason = diff?.summaryText || '子项共享权限与父文件夹不一致';
      } else {
        node.diverged = false;
        node.divergenceReason = '';
      }
    } else if (node.breakage?.broken) {
      node.diverged = true;
      node.divergenceReason = node.breakage.summaryText || '存在超出继承链的单独权限';
    }

    if (node.diverged) {
      divergedCount++;
    } else if (parentNode) {
      uniformCount++;
    }

    for (const child of node.children) {
      traverseTopDown(child, node, depth + 1, node.path);
    }
  }

  for (const root of roots) {
    traverseTopDown(root, null, 0, '');
  }

  const hasNodeViolation = n =>
    Boolean(n?.evaluation?.hasActionableViolation || n?.evaluation?.status === 'violation');

  const sortTreeNodes = (a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    const aImportant = a.diverged || a.hasDescendantDivergence || hasNodeViolation(a) ? 1 : 0;
    const bImportant = b.diverged || b.hasDescendantDivergence || hasNodeViolation(b) ? 1 : 0;
    if (aImportant !== bImportant) return bImportant - aImportant;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  };

  // 自底向上汇总子目录分叉状态与一致子项统计
  function summarizeBottomUp(node) {
    let anyDescendantDiverged = false;
    for (const child of node.children) {
      const childHasIssue = summarizeBottomUp(child);
      if (childHasIssue) anyDescendantDiverged = true;
    }

    node.children.sort(sortTreeNodes);
    node.divergedChildren = node.children.filter(
      ch => ch.diverged || ch.hasDescendantDivergence || hasNodeViolation(ch)
    );
    node.uniformChildren = node.children.filter(
      ch => !ch.diverged && !ch.hasDescendantDivergence && !hasNodeViolation(ch)
    );
    node.uniformChildCount = node.children.filter(ch => !ch.diverged).length;
    node.divergedChildCount = node.children.filter(ch => ch.diverged).length;
    node.totalChildCount = node.children.length;
    node.hasDescendantDivergence = anyDescendantDiverged;

    return Boolean(node.diverged || anyDescendantDiverged || hasNodeViolation(node));
  }

  for (const root of roots) {
    summarizeBottomUp(root);
  }
  roots.sort(sortTreeNodes);

  const flatNodes = [];
  function collectFlat(node) {
    flatNodes.push(node);
    for (const child of node.children) {
      collectFlat(child);
    }
  }
  for (const root of roots) {
    collectFlat(root);
  }

  Object.defineProperties(roots, {
    roots: { value: roots, enumerable: false },
    nodes: { value: roots, enumerable: false },
    flatNodes: { value: flatNodes, enumerable: false },
    nodeMap: { value: nodeMap, enumerable: false },
    totalCount: { value: validFiles.length, enumerable: false },
    divergedCount: { value: divergedCount, enumerable: false },
    uniformCount: { value: uniformCount, enumerable: false }
  });

  return roots;
}


// ============================================================================
// v1.1.0：IMPORTRANGE 多账号极速批授权 (A->B)、公式防卡顿开关与分组批量增删/资产绑定引擎
// ============================================================================

const IMPORTRANGE_BATCH_SUCCESS_MARK = '✅ 已授权(A->B)';

function extractSpreadsheetIdStrictOrUrl(rawVal = '') {
  if (rawVal === null || rawVal === undefined) return '';
  const str = String(rawVal).trim();
  if (!str || str.toLowerCase() === 'nan') return '';
  const dMatch = str.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,})/);
  if (dMatch) return dMatch[1];
  const genericD = str.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (genericD) return genericD[1];
  const idParam = str.match(/[?&](?:id|key)=([a-zA-Z0-9_-]{10,})/);
  if (idParam) return idParam[1];
  if (/^[a-zA-Z0-9_-]{15,90}$/.test(str) && !str.includes('@') && !str.includes('!')) {
    return str;
  }
  return '';
}

/**
 * 一键暂停或恢复目标汇总表内的全部 IMPORTRANGE 公式重算（防批量授权期间卡顿）
 * - pause = true : IMPORTRANGE( -> IMPORTRANGE_OFF(
 * - pause = false: IMPORTRANGE_OFF( -> IMPORTRANGE(
 */
async function toggleTargetSheetImportRangeFormulas(targetId, { pause = true, accountEmail = '' } = {}) {
  const cleanTargetId =
    extractSpreadsheetIdStrictOrUrl(targetId) ||
    parseDriveUrlOrId(targetId).fileId ||
    extractDriveFileId(targetId);

  if (!cleanTargetId) {
    return {
      ok: false,
      targetId: '',
      formulasChanged: 0,
      status: 0,
      error: '无效的目标 Google 表格链接或文件 ID'
    };
  }

  const tokenPool = await buildAuthorizedTokenPool(accountEmail);
  if (!tokenPool.length) {
    return {
      ok: false,
      targetId: cleanTargetId,
      formulasChanged: 0,
      status: 0,
      error: '尚未找到可用的已授权账号令牌'
    };
  }

  const findStr = pause ? 'IMPORTRANGE(' : 'IMPORTRANGE_OFF(';
  const replStr = pause ? 'IMPORTRANGE_OFF(' : 'IMPORTRANGE(';
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cleanTargetId)}:batchUpdate`;
  const bodyJson = JSON.stringify({
    requests: [
      {
        findReplace: {
          find: findStr,
          replacement: replStr,
          matchCase: false,
          includeFormulas: true,
          allSheets: true
        }
      }
    ]
  });

  let lastStatus = 0;
  let lastError = '未能修改目标表公式状态';

  for (const entry of tokenPool) {
    let activeToken = entry.token;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${activeToken}`,
            'Content-Type': 'application/json'
          },
          body: bodyJson
        });
        lastStatus = resp.status;

        if (resp.status === 200) {
          let parsed = {};
          try {
            parsed = await resp.json();
          } catch (_je) {}
          const formulasChanged = Number(parsed?.replies?.[0]?.findReplace?.formulasChanged || 0);
          return {
            ok: true,
            targetId: cleanTargetId,
            formulasChanged,
            status: 200,
            error: ''
          };
        }

        if (resp.status === 401 && attempt === 0 && entry.email) {
          try {
            const refreshed = await getValidTokenForAccount(entry.email, false, true);
            if (refreshed) {
              activeToken = refreshed;
              entry.token = refreshed;
              continue;
            }
          } catch (_re) {}
        }

        let errText = '';
        try {
          errText = await resp.text();
        } catch (_te) {}

        if (
          resp.status === 403 &&
          /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|scope/i.test(errText)
        ) {
          lastError =
            '当前账号令牌尚未包含 Google Sheets 公式编辑权限（不影响跨表授权；如需使用暂停/恢复公式功能，请在账号设置中重新授权一次该账号）';
        } else {
          try {
            const errObj = JSON.parse(errText);
            lastError = errObj?.error?.message || `Sheets API 返回状态码 ${resp.status}`;
          } catch (_pe) {
            lastError = `Sheets API 返回状态码 ${resp.status}`;
          }
        }
        break;
      } catch (err) {
        lastError = err?.message || String(err);
        break;
      }
    }
  }

  return {
    ok: false,
    targetId: cleanTargetId,
    formulasChanged: 0,
    status: lastStatus,
    error: lastError
  };
}

/**
 * 解析 .xlsx / .csv / .tsv / .txt 中的 IMPORTRANGE 授权任务对（A列来源表 -> B列目标表 -> C列状态）
 * 支持 B 列为空时自动继承首行有效目标表 ID（多对一 & 多对多自适应）
 */
async function parseImportRangePairsFromFile(arrayBufferOrText, fileName = '') {
  let rawRows = [];

  const isBinaryBuffer =
    arrayBufferOrText instanceof ArrayBuffer ||
    arrayBufferOrText instanceof Uint8Array ||
    (arrayBufferOrText && arrayBufferOrText.buffer instanceof ArrayBuffer);

  let treatAsXlsx = false;
  let bytes = null;
  if (isBinaryBuffer) {
    if (arrayBufferOrText instanceof Uint8Array) {
      bytes = arrayBufferOrText;
    } else if (arrayBufferOrText instanceof ArrayBuffer) {
      bytes = new Uint8Array(arrayBufferOrText);
    } else {
      bytes = new Uint8Array(
        arrayBufferOrText.buffer,
        arrayBufferOrText.byteOffset || 0,
        arrayBufferOrText.byteLength
      );
    }
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      treatAsXlsx = true;
    } else if (/\.xlsx$/i.test(String(fileName || ''))) {
      treatAsXlsx = true;
    }
  }

  if (treatAsXlsx && bytes) {
    const entries = readZipCentralDirectory(bytes);
    const sharedStrings = [];
    const sstEntry = entries.get('xl/sharedStrings.xml');
    if (sstEntry) {
      const sstXml = await decompressZipEntryText(sstEntry.compressedBytes, sstEntry.method);
      const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
      let sim;
      while ((sim = siRe.exec(sstXml)) !== null) {
        const siInner = sim[1] || '';
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi;
        let tm;
        let parts = '';
        while ((tm = tRe.exec(siInner)) !== null) {
          parts += decodeXmlEntities(tm[1] || '');
        }
        sharedStrings.push(parts);
      }
    }

    let firstSheetPath = 'xl/worksheets/sheet1.xml';
    const relsMap = new Map();
    const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
    if (relsEntry) {
      const relsXml = await decompressZipEntryText(relsEntry.compressedBytes, relsEntry.method);
      const relRe = /<Relationship\b([^>]*?)\/?>/gi;
      let rm;
      while ((rm = relRe.exec(relsXml)) !== null) {
        const attrs = rm[1] || '';
        const rId = getXmlAttr(attrs, 'Id');
        let target = getXmlAttr(attrs, 'Target');
        if (rId && target) {
          target = target.replace(/\\/g, '/');
          if (target.startsWith('/')) {
            target = target.replace(/^\/+/, '');
          } else if (!target.startsWith('xl/')) {
            target = `xl/${target.replace(/^\.\//, '')}`;
          }
          relsMap.set(rId, target);
        }
      }
    }

    const wbEntry = entries.get('xl/workbook.xml');
    if (wbEntry) {
      const wbXml = await decompressZipEntryText(wbEntry.compressedBytes, wbEntry.method);
      const sheetMatch = wbXml.match(/<sheet\b([^>]*?)\/?>/i);
      if (sheetMatch) {
        const relId = getXmlAttr(sheetMatch[1] || '', 'r:id') || getXmlAttr(sheetMatch[1] || '', 'id');
        if (relId && relsMap.has(relId)) {
          firstSheetPath = relsMap.get(relId);
        }
      }
    }
    if (!entries.has(firstSheetPath)) {
      for (const k of entries.keys()) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(k)) {
          firstSheetPath = k;
          break;
        }
      }
    }

    const wsEntry = entries.get(firstSheetPath);
    if (wsEntry) {
      const wsXml = await decompressZipEntryText(wsEntry.compressedBytes, wsEntry.method);
      const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
      let rowMatch;
      while ((rowMatch = rowRe.exec(wsXml)) !== null) {
        const rowInner = rowMatch[1] || '';
        const cols = ['', '', ''];
        let seqCol = 0;
        const cRe = /<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/gi;
        let cm;
        while ((cm = cRe.exec(rowInner)) !== null) {
          const cAttrs = cm[1] || '';
          const cInner = cm[2] || '';
          const rAttr = getXmlAttr(cAttrs, 'r');
          let colIdx = seqCol;
          if (rAttr) {
            const lettersMatch = rAttr.match(/^[A-Za-z]+/);
            if (lettersMatch) {
              const letters = lettersMatch[0].toUpperCase();
              let n = 0;
              for (let i = 0; i < letters.length; i++) {
                n = n * 26 + (letters.charCodeAt(i) - 64);
              }
              colIdx = n - 1;
            }
          }
          seqCol = colIdx + 1;
          if (colIdx < 0 || colIdx > 2) continue;

          const cType = getXmlAttr(cAttrs, 't');
          let valText = '';
          if (cType === 's') {
            const vm = cInner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i);
            const sIdx = vm ? parseInt(String(vm[1] || '').trim(), 10) : NaN;
            if (Number.isInteger(sIdx) && sIdx >= 0 && sIdx < sharedStrings.length) {
              valText = sharedStrings[sIdx];
            }
          } else if (cType === 'inlineStr') {
            const isMatch = cInner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i);
            const scopeXml = isMatch ? isMatch[1] : cInner;
            const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi;
            let tm;
            while ((tm = tRe.exec(scopeXml)) !== null) {
              valText += decodeXmlEntities(tm[1] || '');
            }
          } else {
            const vm = cInner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i);
            if (vm) {
              valText = decodeXmlEntities(vm[1] || '');
            }
          }
          cols[colIdx] = String(valText || '').trim();
        }
        if (cols[0] || cols[1] || cols[2]) {
          rawRows.push(cols);
        }
      }
    }
  } else {
    const rawText = isBinaryBuffer
      ? new TextDecoder('utf-8').decode(bytes)
      : String(arrayBufferOrText || '');
    const cleanText = rawText.replace(/^\uFEFF/, '');
    const lines = cleanText.split(/\r?\n/);
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      const cells = splitTabularRowCells(line);
      if (cells[0] || cells[1] || cells[2]) {
        rawRows.push([cells[0] || '', cells[1] || '', cells[2] || '']);
      }
    }
  }

  const parsedPairs = [];
  let defaultTargetId = '';
  let defaultTargetInput = '';

  for (let i = 0; i < rawRows.length; i++) {
    const [colA, colB, colC] = rawRows[i];
    const dId = extractSpreadsheetIdStrictOrUrl(colA);
    const tId = extractSpreadsheetIdStrictOrUrl(colB);

    // 若首行 A/B 均非有效表格链接/ID，则视为表头自动跳过
    if (i === 0 && !dId && !tId) {
      continue;
    }

    if (tId && !defaultTargetId) {
      defaultTargetId = tId;
      defaultTargetInput = colB.trim();
    }

    const resolvedTargetId = tId || defaultTargetId;
    const resolvedTargetInput = colB.trim() || (resolvedTargetId ? defaultTargetInput : '');

    if (!colA.trim() && !colB.trim()) continue;

    parsedPairs.push({
      donorInput: colA.trim(),
      targetInput: resolvedTargetInput,
      donorId: dId,
      targetId: resolvedTargetId,
      status: String(colC || '').trim()
    });
  }

  return parsedPairs;
}

/**
 * IMPORTRANGE A列(来源表) -> B列(目标表) 多账号轮询极速批量授权引擎
 * 支持多对一（B列留空继承首行）、多对多、自动暂停/恢复公式、限流冷却、401自动续期及 302/403 自动补齐源表只读权限重试
 */
async function executeBatchImportRangeAuth({
  pairs = [],
  autoPauseFormulas = true,
  concurrency = 6,
  ensureDonorReader = true,
  onProgress = null,
  onRowUpdate = null,
  shouldStop = null
} = {}) {
  const inputList = Array.isArray(pairs) ? pairs : [];
  let defaultTargetId = '';
  for (const raw of inputList) {
    if (!raw) continue;
    const rawTarget = Array.isArray(raw) ? raw[1] : raw.targetId || raw.targetInput || raw.target || '';
    const tid = extractSpreadsheetIdStrictOrUrl(rawTarget) || resolveSpreadsheetIdFromRef(rawTarget);
    if (tid) {
      defaultTargetId = tid;
      break;
    }
  }

  const tasks = [];
  const uniqueTargets = new Set();

  for (let idx = 0; idx < inputList.length; idx++) {
    const raw = inputList[idx];
    if (!raw) continue;
    const isArr = Array.isArray(raw);
    const rowIndex = !isArr && Number.isInteger(raw.rowIndex)
      ? raw.rowIndex
      : !isArr && Number.isInteger(raw.rowIdx)
        ? raw.rowIdx
        : idx;
    const donorInput = String(isArr ? raw[0] || '' : raw.donorInput || raw.donorId || raw.sourceId || '').trim();
    const targetInput = String(isArr ? raw[1] || '' : raw.targetInput || raw.targetId || '').trim();
    const curStatus = String(isArr ? raw[2] || '' : raw.status || '').trim();

    const donorId =
      (!isArr && raw.donorId ? extractSpreadsheetIdStrictOrUrl(raw.donorId) || String(raw.donorId).trim() : '') ||
      extractSpreadsheetIdStrictOrUrl(donorInput) ||
      resolveSpreadsheetIdFromRef(donorInput);
    const explicitTargetId =
      (!isArr && raw.targetId ? extractSpreadsheetIdStrictOrUrl(raw.targetId) || String(raw.targetId).trim() : '') ||
      extractSpreadsheetIdStrictOrUrl(targetInput) ||
      resolveSpreadsheetIdFromRef(targetInput);
    const targetId = explicitTargetId || defaultTargetId;

    if (!donorId || !targetId) continue;
    if (curStatus === IMPORTRANGE_BATCH_SUCCESS_MARK) continue;

    tasks.push({
      rowIndex,
      donorId,
      targetId,
      donorInput: donorInput || donorId,
      targetInput: targetInput || targetId
    });
    uniqueTargets.add(targetId);
  }

  if (tasks.length === 0) {
    return {
      total: 0,
      successCount: 0,
      failedCount: 0,
      stopped: false,
      failedPairs: [],
      pausedTargetsCount: 0
    };
  }

  const basePool = await buildAuthorizedTokenPool('');
  if (!basePool.length) {
    throw new Error('尚未找到可用的已授权账号令牌，请先导入 Google OAuth 客户端或服务账号完成授权');
  }

  const poolWorkers = basePool.map((item, i) => ({
    id: i,
    email: item.email || `account_${i + 1}`,
    token: item.token,
    cooldownUntil: 0
  }));
  let rrCursor = 0;

  async function acquireWorker() {
    while (!shouldStop?.()) {
      const now = Date.now();
      for (let i = 0; i < poolWorkers.length; i++) {
        const w = poolWorkers[rrCursor % poolWorkers.length];
        rrCursor++;
        if (now >= w.cooldownUntil && w.token) {
          return w;
        }
      }
      const soonest = Math.min(...poolWorkers.map(w => w.cooldownUntil));
      const waitMs = Math.min(1000, Math.max(100, soonest - now));
      await new Promise(r => setTimeout(r, waitMs));
    }
    return poolWorkers[0];
  }

  function markRateLimited(worker, attempt = 1) {
    if (!worker) return;
    worker.cooldownUntil = Math.max(worker.cooldownUntil, Date.now() + Math.round(3500 * attempt));
  }

  async function refreshWorker(worker) {
    if (!worker || !worker.email || worker.email.startsWith('account_')) return false;
    try {
      const fresh = await getValidTokenForAccount(worker.email, false, true);
      if (fresh) {
        worker.token = fresh;
        return true;
      }
    } catch (_e) {}
    return false;
  }

  const targetOwnerCache = new Map();
  async function resolveTargetSheetOwnerEmail(targetId) {
    if (targetOwnerCache.has(targetId)) return targetOwnerCache.get(targetId);
    for (const w of poolWorkers) {
      if (!w.token) continue;
      try {
        const meta = await driveApi(
          w.token,
          `/files/${encodeURIComponent(targetId)}?supportsAllDrives=true&fields=id,owners(emailAddress)`
        );
        const ownerEm = normalizeEntry(meta?.owners?.[0]?.emailAddress || '');
        if (ownerEm) {
          targetOwnerCache.set(targetId, ownerEm);
          return ownerEm;
        }
      } catch (_e) {}
    }
    targetOwnerCache.set(targetId, '');
    return '';
  }

  const ensuredDonorPairSet = new Set();
  async function tryEnsureDonorReaderAccess(donorId, targetId, currentWorkerEmail) {
    const candidateEmails = new Set();
    const targetOwner = await resolveTargetSheetOwnerEmail(targetId);
    if (targetOwner && targetOwner.includes('@')) candidateEmails.add(targetOwner);
    if (currentWorkerEmail && currentWorkerEmail.includes('@')) {
      candidateEmails.add(normalizeEntry(currentWorkerEmail));
    }
    let anyGrantedOrPresent = false;
    for (const em of candidateEmails) {
      const pairKey = `${donorId}::${em}`;
      if (ensuredDonorPairSet.has(pairKey)) {
        anyGrantedOrPresent = true;
        continue;
      }
      ensuredDonorPairSet.add(pairKey);
      try {
        const res = await grantImportRangeSourceAccess({
          targetOwnerEmail: em,
          sourceIds: [donorId]
        });
        if ((res?.grantedCount || 0) > 0 || (res?.skippedCount || 0) > 0) {
          anyGrantedOrPresent = true;
        }
      } catch (_ge) {}
    }
    return anyGrantedOrPresent;
  }

  const pausedTargets = [];
  if (autoPauseFormulas && uniqueTargets.size >= 1 && uniqueTargets.size <= 5) {
    for (const tid of uniqueTargets) {
      if (shouldStop?.()) break;
      if (onProgress) {
        onProgress({
          done: 0,
          total: tasks.length,
          successCount: 0,
          failedCount: 0,
          stopped: false,
          message: `正在暂停目标汇总表 (${tid.slice(0, 8)}…) 公式重算以加速批量授权…`
        });
      }
      const pRes = await toggleTargetSheetImportRangeFormulas(tid, { pause: true });
      if (pRes.ok) {
        pausedTargets.push(tid);
      }
    }
  }

  let successCount = 0;
  let failedCount = 0;
  let completed = 0;
  let stopped = false;
  let taskCursor = 0;
  const failedPairs = [];
  const workerLimit = Math.max(1, Math.min(16, Number(concurrency) || 6, tasks.length));

  async function authorizeSinglePairTask(task) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
      task.targetId
    )}/externaldata/addimportrangepermissions?donorDocId=${encodeURIComponent(task.donorId)}`;

    const maxAttempts = Math.max(3, poolWorkers.length + 1);
    let triedEnsureDonor = false;
    let lastErrText = '❌ 授权失败';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (shouldStop?.()) {
        stopped = true;
        return { ok: false, aborted: true, statusText: '已暂停' };
      }
      const worker = await acquireWorker();
      if (shouldStop?.()) {
        stopped = true;
        return { ok: false, aborted: true, statusText: '已暂停' };
      }

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${worker.token}`
          },
          redirect: 'manual'
        });

        const code = resp.status;
        const isOpaqueRedirect = resp.type === 'opaqueredirect' || (code >= 300 && code < 400);
        let bodySnippet = '';
        if (!isOpaqueRedirect) {
          try {
            bodySnippet = (await resp.text()).slice(0, 180);
          } catch (_be) {}
        }

        if ((code === 200 || code === 204) && !/<html/i.test(bodySnippet)) {
          return { ok: true, aborted: false, statusText: IMPORTRANGE_BATCH_SUCCESS_MARK };
        }

        if (code === 429 || (code === 403 && /rate|quota|limit/i.test(bodySnippet))) {
          markRateLimited(worker, attempt);
          lastErrText = `❌ 触发限流 (${code})`;
          continue;
        }

        if (code === 401) {
          await refreshWorker(worker);
          lastErrText = '❌ 令牌已过期 (401)';
          continue;
        }

        if (isOpaqueRedirect || code === 302 || code === 403 || code === 404) {
          const dispCode = isOpaqueRedirect && !code ? 302 : code;
          lastErrText = `❌ 失败(状态码:${dispCode}, 请确认对源表与目标表有权限)`;

          if (ensureDonorReader && !triedEnsureDonor && (isOpaqueRedirect || dispCode === 302 || dispCode === 403)) {
            triedEnsureDonor = true;
            const fixed = await tryEnsureDonorReaderAccess(task.donorId, task.targetId, worker.email);
            if (fixed) {
              // 补齐源表只读权限后立即重试一次当前授权对
              const retryResp = await fetch(url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${worker.token}`
                },
                redirect: 'manual'
              });
              const rCode = retryResp.status;
              let rBody = '';
              if (retryResp.type !== 'opaqueredirect') {
                try {
                  rBody = (await retryResp.text()).slice(0, 180);
                } catch (_rbe) {}
              }
              if ((rCode === 200 || rCode === 204) && !/<html/i.test(rBody)) {
                return { ok: true, aborted: false, statusText: IMPORTRANGE_BATCH_SUCCESS_MARK };
              }
            }
          }

          if (poolWorkers.length > 1 && attempt < maxAttempts) {
            continue;
          }
          return { ok: false, aborted: false, statusText: lastErrText };
        }

        lastErrText = `❌ 失败(状态码:${code || '未知'})`;
      } catch (err) {
        const msg = String(err?.message || err || '').slice(0, 48);
        lastErrText = `❌ 网络或请求异常: ${msg}`;
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }

    return { ok: false, aborted: false, statusText: lastErrText };
  }

  try {
    const workers = Array.from({ length: workerLimit }, async () => {
      while (taskCursor < tasks.length) {
        if (shouldStop?.()) {
          stopped = true;
          break;
        }
        const task = tasks[taskCursor++];
        const outcome = await authorizeSinglePairTask(task);
        if (outcome.aborted) {
          stopped = true;
          break;
        }

        completed++;
        if (outcome.ok) {
          successCount++;
        } else {
          failedCount++;
          failedPairs.push({
            rowIndex: task.rowIndex,
            donorId: task.donorId,
            targetId: task.targetId,
            donorInput: task.donorInput,
            targetInput: task.targetInput,
            status: outcome.statusText,
            errorMessage: outcome.statusText
          });
        }

        if (onRowUpdate) {
          onRowUpdate(task.rowIndex, {
            ok: outcome.ok,
            statusText: outcome.statusText,
            donorId: task.donorId,
            targetId: task.targetId
          });
        }

        if (onProgress) {
          onProgress({
            done: completed,
            total: tasks.length,
            successCount,
            failedCount,
            stopped,
            message: `正在极速授权 IMPORTRANGE (${completed}/${tasks.length})：成功 ${successCount} · 失败 ${failedCount}…`
          });
        }
      }
    });

    await Promise.all(workers);
  } finally {
    // 无论正常结束还是中途暂停/中断，无条件恢复所有被自动暂停的目标汇总表公式
    for (const tid of pausedTargets) {
      try {
        await toggleTargetSheetImportRangeFormulas(tid, { pause: false });
      } catch (_resumeErr) {}
    }
  }

  if (successCount > 0 || failedCount > 0) {
    try {
      await appendAuditLogs({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        source: 'manual',
        actionType: 'grant',
        accountEmail: poolWorkers[0]?.email || '',
        fileId: [...uniqueTargets][0] || '',
        fileName: `IMPORTRANGE 跨表批量授权 (${uniqueTargets.size} 张目标表)`,
        webViewLink: '',
        permissionId: '',
        targetType: 'importrange_batch',
        targetEmail: '',
        targetLabel: `共 ${completed} 对（成功 ${successCount} · 失败 ${failedCount}）`,
        previousRole: '',
        newRole: 'reader',
        restored: false,
        message: `IMPORTRANGE 极速批量授权完成：成功 ${successCount} 项，失败 ${failedCount} 项${
          stopped ? '（已手动中止）' : ''
        }`
      });
    } catch (_logErr) {}
  }

  return {
    total: tasks.length,
    successCount,
    failedCount,
    stopped,
    failedPairs,
    pausedTargetsCount: pausedTargets.length
  };
}

/* ==================== 分组批量增删邮箱与资产绑定分组引擎 ==================== */

/**
 * 批量解析多个邮箱并加入指定分组（保留成员原有其他分组，更新该组个人角色并同步白名单）
 */
async function batchAddEmailsToGroup(groupName, rawEmailsText, role = '') {
  const cleanGroup = String(groupName || '').trim();
  if (!cleanGroup) {
    throw new Error('请先选择或输入目标分组名称');
  }
  const emails = parseEmailListInput(rawEmailsText);
  if (!emails.length) {
    throw new Error('请至少输入 1 个有效的邮箱地址');
  }

  const dir = await getDirectory();
  let targetGrp = (dir.groups || []).find(g => g.name === cleanGroup);
  const explicitRole = role ? normalizePermissionRole(role, '') : '';

  if (!targetGrp) {
    const defRole = explicitRole || 'reader';
    targetGrp = {
      name: cleanGroup,
      defaultRole: defRole,
      policyTier: defRole === 'writer' ? 'writer' : 'reader',
      assets: []
    };
    dir.groups = [...(dir.groups || []), targetGrp];
  }

  const assignedRole = explicitRole || normalizePermissionRole(targetGrp.defaultRole, 'reader') || 'reader';
  const contactByEmail = new Map();
  for (const c of dir.contacts || []) {
    const em = normalizeEntry(c?.email || '');
    if (em) contactByEmail.set(em, c);
  }

  let addedCount = 0;
  let updatedCount = 0;

  for (const em of emails) {
    const existing = contactByEmail.get(em);
    if (existing) {
      const prevGroups = Array.isArray(existing.groups) ? existing.groups : [];
      const alreadyIn = prevGroups.includes(cleanGroup);
      existing.groups = [...new Set([...prevGroups, cleanGroup])];
      existing.groupRoles = {
        ...(existing.groupRoles || {}),
        [cleanGroup]: assignedRole
      };
      if (!existing.role || permissionRoleRank(assignedRole) > permissionRoleRank(existing.role) || existing.groups.length === 1) {
        existing.role = assignedRole;
      }
      if (alreadyIn) {
        updatedCount++;
      } else {
        addedCount++;
      }
    } else {
      const newContact = {
        email: em,
        name: '',
        groups: [cleanGroup],
        role: assignedRole,
        groupRoles: { [cleanGroup]: assignedRole },
        hasExplicitRole: true
      };
      dir.contacts.push(newContact);
      contactByEmail.set(em, newContact);
      addedCount++;
    }
  }

  const savedDir = await saveDirectory(dir);
  return {
    directory: savedDir,
    addedCount,
    updatedCount,
    emails
  };
}

/**
 * 跨全部分组批量彻底移除指定邮箱（同时从 directory.contacts 与 policy.writers / policy.readers 中清除）
 */
async function batchRemoveEmailsFromAllGroups(rawEmailsText) {
  const emails = parseEmailListInput(rawEmailsText);
  if (!emails.length) {
    throw new Error('请至少输入 1 个需要删除的邮箱地址');
  }
  const removeSet = new Set(emails);

  const dir = await getDirectory();
  let removedCount = 0;
  const affectedGroupSet = new Set();
  const keptContacts = [];

  for (const c of dir.contacts || []) {
    const em = normalizeEntry(c?.email || '');
    if (removeSet.has(em)) {
      removedCount++;
      for (const g of c.groups || []) {
        if (g) affectedGroupSet.add(g);
      }
    } else {
      keptContacts.push(c);
    }
  }

  const savedDir = await saveDirectory({
    ...dir,
    contacts: keptContacts
  });

  const currentPolicy = await getPolicy();
  const nextWriters = (currentPolicy.writers || []).filter(item => !removeSet.has(normalizeEntry(item)));
  const nextReaders = (currentPolicy.readers || []).filter(item => !removeSet.has(normalizeEntry(item)));
  if (
    nextWriters.length !== (currentPolicy.writers || []).length ||
    nextReaders.length !== (currentPolicy.readers || []).length
  ) {
    await savePolicy({
      writers: nextWriters,
      readers: nextReaders
    });
  }

  return {
    directory: savedDir,
    removedCount,
    affectedGroups: [...affectedGroupSet],
    emails
  };
}

/**
 * 将选中的文件/文件夹资产绑定保存到指定分组的 group.assets 中
 */
async function bindAssetsToGroup(
  groupName,
  files = [],
  { createIfMissing = true, defaultRole = 'reader' } = {}
) {
  const cleanGroup = String(groupName || '').trim();
  if (!cleanGroup) {
    throw new Error('请先选择或输入目标分组名称');
  }

  const dir = await getDirectory();
  let grp = (dir.groups || []).find(g => g.name === cleanGroup);
  if (!grp) {
    if (!createIfMissing) {
      throw new Error(`未找到分组「${cleanGroup}」`);
    }
    const normRole = normalizePermissionRole(defaultRole, 'reader') || 'reader';
    grp = {
      name: cleanGroup,
      defaultRole: normRole,
      policyTier: normRole === 'writer' ? 'writer' : 'reader',
      assets: []
    };
    dir.groups = [...(dir.groups || []), grp];
  }

  const mergedAssets = Array.isArray(grp.assets) ? [...grp.assets] : [];
  const seenIds = new Set(mergedAssets.map(a => a.fileId));
  let addedCount = 0;

  for (const item of Array.isArray(files) ? files : [files]) {
    if (!item) continue;
    const fid = String(item.fileId || item.id || '').trim();
    if (!fid || seenIds.has(fid)) continue;
    seenIds.add(fid);
    addedCount++;
    mergedAssets.push({
      fileId: fid,
      fileName: String(item.fileName || item.name || '(无名称)').trim(),
      mimeType: String(item.mimeType || ''),
      webViewLink: String(
        item.webViewLink || formatDriveCanonicalLink({ id: fid, mimeType: item.mimeType || '' })
      )
    });
  }

  grp.assets = mergedAssets;
  const savedDir = await saveDirectory(dir);
  const savedGroup = (savedDir.groups || []).find(g => g.name === cleanGroup) || grp;

  return {
    directory: savedDir,
    group: savedGroup,
    addedCount,
    totalAssets: Array.isArray(savedGroup.assets) ? savedGroup.assets.length : 0
  };
}


// ============================================================================
// v1.2.0：排除扫描文件夹、宽权限风险评估、12小时断点续检检查点与第三方关联应用 OAuth 守卫引擎
// ============================================================================

/* ==================== 1. 排除扫描目录与宽权限风险评估引擎 ==================== */

/**
 * 根据 excludedFolders 配置与文件列表 parents 链，递归推导全部处于排除范围内的文件夹及子项 ID 集合
 */
function buildExcludedFileIdSet(files = [], excludedFolders = []) {
  const cleanExcluded = sanitizeExcludedFoldersList(excludedFolders);
  if (!cleanExcluded.length) return new Set();

  const excludedSet = new Set();
  const recursiveRootIds = [];

  for (const ef of cleanExcluded) {
    excludedSet.add(ef.id);
    if (ef.includeSubitems !== false) {
      recursiveRootIds.push(ef.id);
    }
  }

  if (recursiveRootIds.length > 0 && Array.isArray(files) && files.length > 0) {
    const childrenByParent = new Map();
    for (const f of files) {
      if (!f || !f.id || !Array.isArray(f.parents)) continue;
      for (const pid of f.parents) {
        const cleanPid = String(pid || '').trim();
        if (!cleanPid) continue;
        if (!childrenByParent.has(cleanPid)) {
          childrenByParent.set(cleanPid, []);
        }
        childrenByParent.get(cleanPid).push(f.id);
      }
    }

    const queue = [...recursiveRootIds];
    const visited = new Set(recursiveRootIds);
    let qCursor = 0;

    while (qCursor < queue.length) {
      const curId = queue[qCursor++];
      const childIds = childrenByParent.get(curId);
      if (!childIds) continue;
      for (const cid of childIds) {
        excludedSet.add(cid);
        if (!visited.has(cid)) {
          visited.add(cid);
          queue.push(cid);
        }
      }
    }
  }

  return excludedSet;
}

/**
 * 判断单个文件或文件夹是否属于已排除扫描/保护目录范围
 */
function isFileInExcludedFolders(file, excludedFolders = [], excludedIdSet = null) {
  if (!file) return false;
  const fid = typeof file === 'string' ? file.trim() : String(file.id || '').trim();
  if (!fid) return false;

  if (excludedIdSet instanceof Set && excludedIdSet.has(fid)) {
    return true;
  }

  const cleanExcluded = sanitizeExcludedFoldersList(excludedFolders);
  if (!cleanExcluded.length) return false;

  const directSet = new Set();
  const recursiveSet = new Set();
  for (const ef of cleanExcluded) {
    directSet.add(ef.id);
    if (ef.includeSubitems !== false) {
      recursiveSet.add(ef.id);
    }
  }

  if (directSet.has(fid)) return true;

  if (typeof file === 'object') {
    const candidateAncestors = [];
    if (Array.isArray(file.parents)) candidateAncestors.push(...file.parents);
    if (Array.isArray(file._ancestorIds)) candidateAncestors.push(...file._ancestorIds);
    if (Array.isArray(file.ancestorIds)) candidateAncestors.push(...file.ancestorIds);

    for (const pid of candidateAncestors) {
      const cleanPid = String(pid || '').trim();
      if (!cleanPid) continue;
      if (recursiveSet.has(cleanPid)) return true;
      if (excludedIdSet instanceof Set && excludedIdSet.has(cleanPid)) {
        const matchedRule = cleanExcluded.find(ef => ef.id === cleanPid);
        if (!matchedRule || matchedRule.includeSubitems !== false) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * 添加一个或多个排除扫描的公开/对外文件夹并持久化至 policy.excludedFolders
 */
async function addExcludedFolders(entries = []) {
  const incomingList = Array.isArray(entries) ? entries : entries ? [entries] : [];
  const cleanIncoming = sanitizeExcludedFoldersList(incomingList);
  const currentPolicy = await getPolicy();
  if (!cleanIncoming.length) return currentPolicy;

  const byId = new Map();
  for (const existing of currentPolicy.excludedFolders || []) {
    byId.set(existing.id, existing);
  }
  for (const inc of cleanIncoming) {
    const prev = byId.get(inc.id);
    byId.set(inc.id, {
      ...prev,
      ...inc,
      name:
        inc.name && !inc.name.startsWith('排除目录 (')
          ? inc.name
          : prev?.name || inc.name,
      note: inc.note !== '' ? inc.note : prev?.note || '',
      addedAt: prev?.addedAt || inc.addedAt
    });
  }

  const nextPolicy = await savePolicy({
    excludedFolders: [...byId.values()]
  });

  // 同步从当前缓存快照中移除已被列入排除范围的文件，避免旧列表继续告警
  try {
    const rawSnap = await chrome.storage.local.get('scanSnapshot');
    const snap = rawSnap?.scanSnapshot;
    if (snap && Array.isArray(snap.files) && snap.files.length > 0) {
      const exSet = buildExcludedFileIdSet(snap.files, nextPolicy.excludedFolders);
      if (exSet.size > 0) {
        const filtered = snap.files.filter(f => !exSet.has(f?.id));
        if (filtered.length !== snap.files.length) {
          snap.files = filtered;
          await saveSnapshot(snap);
        }
      }
    }
  } catch (_snapErr) {}

  return nextPolicy;
}

/**
 * 从 policy.excludedFolders 中移出指定排除文件夹 ID
 */
async function removeExcludedFolder(folderId) {
  const parsed = parseDriveUrlOrId(folderId);
  const cleanId = parsed.fileId || extractDriveFileId(folderId) || String(folderId || '').trim();
  const currentPolicy = await getPolicy();
  if (!cleanId) return currentPolicy;

  const nextExcluded = (currentPolicy.excludedFolders || []).filter(item => item.id !== cleanId);
  return savePolicy({
    excludedFolders: nextExcluded
  });
}

/**
 * 宽权限风险评估辅助（供伴随侧边栏首屏高辨识度预警卡与巡检提醒调用）
 */
function assessWidePermissionRisk(file, policy = DEFAULT_POLICY, accountEmail = '', forceExcluded = null) {
  const isExcluded =
    forceExcluded !== null
      ? Boolean(forceExcluded)
      : isFileInExcludedFolders(file, policy?.excludedFolders || []);

  const perms = Array.isArray(file?.permissions) ? file.permissions : [];
  const ownerEmail = normalizeEntry(
    file?.ownerAccount || file?.owners?.[0]?.emailAddress || accountEmail || ''
  );
  const ownerDomain = extractEmailDomain(ownerEmail);
  const personalDomains = new Set([
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'qq.com',
    '163.com',
    '126.com',
    'icloud.com',
    'yahoo.com'
  ]);

  let hasPublicWriter = false;
  let hasPublicReader = false;
  let hasDomainLink = false;
  let hasNonOwnerCollaborator = false;
  const externalEmailSet = new Set();

  for (const p of perms) {
    if (!p || p.role === 'owner') continue;
    if (p.type === 'anyone') {
      hasNonOwnerCollaborator = true;
      if (['writer', 'organizer', 'fileOrganizer'].includes(p.role)) {
        hasPublicWriter = true;
      } else {
        hasPublicReader = true;
      }
      continue;
    }
    if (p.type === 'domain') {
      hasNonOwnerCollaborator = true;
      hasDomainLink = true;
      continue;
    }
    const em = normalizeEntry(p.emailAddress || '');
    if (em && em !== ownerEmail) {
      hasNonOwnerCollaborator = true;
      const dom = extractEmailDomain(em);
      if (!ownerDomain || personalDomains.has(ownerDomain) || dom !== ownerDomain) {
        externalEmailSet.add(em);
      }
    }
  }

  const externalCount = externalEmailSet.size;
  const allowsWritersShare = Boolean(
    (file?.shared || hasNonOwnerCollaborator) && file?.writersCanShare !== false
  );

  if (isExcluded) {
    return {
      isWide: false,
      isExcluded: true,
      severity: 'none',
      reasons: ['已列入排除扫描目录，豁免宽权限预警与自动关链'],
      hasPublicWriter,
      hasPublicReader,
      hasDomainLink,
      externalCount,
      allowsWritersShare,
      removeCount: 0,
      downgradeCount: 0
    };
  }

  const evalRes = evaluateFile(file || {}, policy || DEFAULT_POLICY, ownerEmail);
  const reasons = [];

  if (hasPublicWriter) {
    reasons.push('已开启任何人可编辑的公开链接');
  } else if (hasPublicReader) {
    reasons.push('已开启任何人可查看的公开链接');
  }

  if (hasDomainLink) {
    reasons.push('已开启全域名范围共享链接');
  }

  if (evalRes.removeCount > 0) {
    reasons.push(`含 ${evalRes.removeCount} 项非白名单违规权限`);
  }

  if (evalRes.downgradeCount > 0) {
    reasons.push(`含 ${evalRes.downgradeCount} 项越权编辑权限`);
  }

  if (externalCount >= 3) {
    reasons.push(`外部协作者较多 (${externalCount} 人)`);
  }

  if (allowsWritersShare) {
    reasons.push('允许编辑者继续拉人共享');
  }

  let severity = 'none';
  if (
    hasPublicWriter ||
    (hasPublicReader && (policy?.publicLinkRule || 'forbid') === 'forbid') ||
    evalRes.removeCount > 0
  ) {
    severity = 'high';
  } else if (hasPublicReader || hasDomainLink || evalRes.downgradeCount > 0 || externalCount >= 3) {
    severity = 'medium';
  } else if (allowsWritersShare) {
    severity = 'low';
  }

  return {
    isWide: severity !== 'none' && reasons.length > 0,
    isExcluded: false,
    severity,
    reasons,
    hasPublicWriter,
    hasPublicReader,
    hasDomainLink,
    externalCount,
    allowsWritersShare,
    removeCount: evalRes.removeCount,
    downgradeCount: evalRes.downgradeCount
  };
}

/* ==================== 2. 12 小时定期巡检与启动断点续检检查点存储 ==================== */

const DEFAULT_AUTO_SCAN_CHECKPOINT = {
  status: 'idle', // 'idle' | 'running' | 'completed' | 'interrupted'
  startedAt: '',
  completedAt: '',
  lastSuccessAt: '',
  completedAccountEmails: [],
  totalAccounts: 0,
  scanScope: 'owned',
  lastError: ''
};

async function getAutoScanCheckpoint() {
  const data = await chrome.storage.local.get('autoScanCheckpoint');
  const saved =
    data?.autoScanCheckpoint && typeof data.autoScanCheckpoint === 'object'
      ? data.autoScanCheckpoint
      : {};
  return {
    ...DEFAULT_AUTO_SCAN_CHECKPOINT,
    ...saved,
    completedAccountEmails: Array.isArray(saved.completedAccountEmails)
      ? normalizeEmailList(saved.completedAccountEmails)
      : []
  };
}

async function saveAutoScanCheckpoint(partialCp = {}) {
  const current = await getAutoScanCheckpoint();
  const safePartial = partialCp && typeof partialCp === 'object' ? partialCp : {};
  const next = {
    ...current,
    ...safePartial,
    completedAccountEmails:
      safePartial.completedAccountEmails !== undefined
        ? normalizeEmailList(safePartial.completedAccountEmails)
        : current.completedAccountEmails
  };
  await safeStorageSet({ autoScanCheckpoint: next });
  return next;
}

/* ==================== 3. 第三方关联应用 OAuth 授权页安全守卫 ==================== */

async function getThirdPartyAppAlerts() {
  const data = await chrome.storage.local.get('thirdPartyAppAlerts');
  return Array.isArray(data?.thirdPartyAppAlerts) ? data.thirdPartyAppAlerts : [];
}

async function clearThirdPartyAppAlerts() {
  await safeStorageSet({ thirdPartyAppAlerts: [] });
  return [];
}

async function getThirdPartyAppAlertById(alertId = '') {
  const cleanId = String(alertId || '').trim();
  const list = await getThirdPartyAppAlerts();
  if (!cleanId) return list[0] || null;
  return list.find(item => item && item.id === cleanId) || null;
}

async function recordThirdPartyAppAlert(alert = {}) {
  const existing = await getThirdPartyAppAlerts();
  const nowMs = Date.now();
  const nowIso = alert.timestamp || new Date(nowMs).toISOString();
  const clientId = String(alert.clientId || '').trim();
  const host = String(alert.host || alert.redirectDomain || '').trim();
  const redirectDomain = String(alert.redirectDomain || host || '').trim();
  const appHint = String(alert.appName || alert.appHint || '').trim();
  const originalUrl = String(alert.originalUrl || alert.url || '').trim();
  const action = alert.action === 'blocked' ? 'blocked' : 'alerted';

  // 60 秒内同一外部应用的重复页内跳转去重，避免同一次授权流弹出多条重复通知；同时同步刷新最新原始链接与拦截状态
  const duplicateIdx = existing.findIndex(item => {
    const itemMs = item?.timestamp ? Date.parse(item.timestamp) : 0;
    if (!itemMs || nowMs - itemMs > 60000) return false;
    if (clientId && item.clientId === clientId) return true;
    const itemHost = item.host || item.redirectDomain || '';
    if (!clientId && appHint && (item.appName === appHint || item.appHint === appHint) && itemHost === host) {
      return true;
    }
    return false;
  });

  if (duplicateIdx !== -1) {
    const prev = existing[duplicateIdx];
    let touched = false;
    if (originalUrl && originalUrl !== prev.originalUrl) {
      prev.originalUrl = originalUrl;
      prev.url = originalUrl;
      touched = true;
    }
    if (action === 'blocked' && prev.action !== 'blocked') {
      prev.action = 'blocked';
      prev.shouldBlock = true;
      touched = true;
    }
    if (Number.isInteger(alert.tabId) && prev.tabId !== alert.tabId) {
      prev.tabId = alert.tabId;
      touched = true;
    }
    if (touched) {
      await safeStorageSet({ thirdPartyAppAlerts: existing });
    }
    return { recorded: false, entry: prev, alerts: existing };
  }

  const matchedKeywords = Array.isArray(alert.matchedKeywords)
    ? alert.matchedKeywords
    : alert.matchedKeyword
    ? [String(alert.matchedKeyword)]
    : [];
  const requestedScopes = Array.isArray(alert.requestedScopes)
    ? alert.requestedScopes.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  const resolvedAppName =
    appHint ||
    host ||
    redirectDomain ||
    (clientId ? clientId.slice(0, 24) : '外部第三方应用');
  const resolvedReason = String(alert.reason || '检测到第三方 OAuth 授权请求');

  const entry = {
    id: alert.id || `oauth-alert-${nowMs}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: nowIso,
    detectedAt: nowIso,
    action,
    shouldBlock: alert.shouldBlock !== undefined ? Boolean(alert.shouldBlock) : action === 'blocked',
    originalUrl,
    url: String(alert.url || originalUrl || ''),
    tabTitle: String(alert.tabTitle || ''),
    clientId,
    host,
    redirectUri: String(alert.redirectUri || ''),
    redirectDomain,
    appHint: resolvedAppName,
    appName: resolvedAppName,
    matchedKeyword: String(alert.matchedKeyword || matchedKeywords[0] || ''),
    matchedKeywords,
    requestedScopes,
    scopes: String(alert.scopes || requestedScopes.join(' ')),
    hasDriveScope: Boolean(alert.hasDriveScope),
    hasSheetsScope: Boolean(alert.hasSheetsScope),
    reason: resolvedReason,
    title: `${resolvedAppName} · ${resolvedReason}`,
    message: `${resolvedAppName} · ${resolvedReason}`,
    tabId: Number.isInteger(alert.tabId) ? alert.tabId : null
  };

  const merged = [entry, ...existing].slice(0, 100);
  await safeStorageSet({ thirdPartyAppAlerts: merged });
  return { recorded: true, entry, alerts: merged };
}

const KNOWN_OAUTH_APP_DISPLAY_NAMES = {
  chatgpt: 'ChatGPT',
  openai: 'OpenAI',
  grok: 'Grok',
  xai: 'xAI',
  muse: 'Muse',
  claude: 'Claude',
  cursor: 'Cursor',
  notion: 'Notion',
  zapier: 'Zapier',
  make: 'Make'
};

const GOOGLE_FIRST_PARTY_WEB_DOMAINS = new Set([
  'google.com',
  'www.google.com',
  'accounts.google.com',
  'myaccount.google.com',
  'drive.google.com',
  'docs.google.com',
  'sheets.google.com',
  'slides.google.com',
  'forms.google.com',
  'mail.google.com',
  'calendar.google.com',
  'meet.google.com',
  'keep.google.com',
  'photos.google.com',
  'admin.google.com',
  'console.cloud.google.com',
  'colab.research.google.com'
]);

/**
 * 检测浏览器访问的 Google OAuth 授权页 URL 是否命中禁止关联应用关键词或受禁的 Google 网盘 / Google 表格权限
 * 兼容旧签名 matchThirdPartyOAuthUrl(urlStr, blockedKeywordsArray, ownClientIds)
 * 与新对象传参 matchThirdPartyOAuthUrl(urlStr, { blockedKeywords, trustedKeywords, blockDriveScope, blockSheetsScope, ownClientIds })
 */
function matchThirdPartyOAuthUrl(
  urlStr = '',
  optionsOrKeywords = {},
  ownClientIds = []
) {
  const raw = String(urlStr || '').trim();
  if (!raw || !raw.includes('accounts.google.com')) {
    return { matched: false, shouldBlock: false };
  }

  let outerUrl;
  try {
    outerUrl = new URL(raw);
  } catch (_e) {
    return { matched: false, shouldBlock: false };
  }

  if (outerUrl.hostname.toLowerCase() !== 'accounts.google.com') {
    return { matched: false, shouldBlock: false };
  }

  // 解析选项与向下兼容旧数组传参
  let resolvedBlockedKeywords;
  let resolvedTrustedKeywords = [];
  let blockDriveScope = true;
  let blockSheetsScope = true;
  let resolvedOwnClientIds = Array.isArray(ownClientIds) ? ownClientIds : [];

  if (Array.isArray(optionsOrKeywords) || typeof optionsOrKeywords === 'string') {
    resolvedBlockedKeywords = sanitizeBlockedKeywordsList(optionsOrKeywords);
  } else if (optionsOrKeywords && typeof optionsOrKeywords === 'object') {
    resolvedBlockedKeywords =
      optionsOrKeywords.blockedKeywords !== undefined
        ? sanitizeBlockedKeywordsList(optionsOrKeywords.blockedKeywords)
        : optionsOrKeywords.blockedAppKeywords !== undefined
        ? sanitizeBlockedKeywordsList(optionsOrKeywords.blockedAppKeywords)
        : [...DEFAULT_BLOCKED_APP_KEYWORDS];
    resolvedTrustedKeywords = sanitizeTrustedKeywordsList(
      optionsOrKeywords.trustedKeywords ?? optionsOrKeywords.trustedOAuthKeywords ?? []
    );
    if (optionsOrKeywords.blockDriveScope !== undefined) {
      blockDriveScope = Boolean(optionsOrKeywords.blockDriveScope);
    } else if (optionsOrKeywords.blockThirdPartyDriveScope !== undefined) {
      blockDriveScope = Boolean(optionsOrKeywords.blockThirdPartyDriveScope);
    }
    if (optionsOrKeywords.blockSheetsScope !== undefined) {
      blockSheetsScope = Boolean(optionsOrKeywords.blockSheetsScope);
    } else if (optionsOrKeywords.blockThirdPartySheetsScope !== undefined) {
      blockSheetsScope = Boolean(optionsOrKeywords.blockThirdPartySheetsScope);
    }
    if (Array.isArray(optionsOrKeywords.ownClientIds)) {
      resolvedOwnClientIds = optionsOrKeywords.ownClientIds;
    }
  } else {
    resolvedBlockedKeywords = [...DEFAULT_BLOCKED_APP_KEYWORDS];
  }

  // 若外层为 AccountChooser / ServiceLogin / 二次验证多跳包装页，循环解包内部 continue / followup 授权地址
  let targetUrl = outerUrl;
  let continueHost = '';
  for (let hop = 0; hop < 4; hop++) {
    let continueParam =
      targetUrl.searchParams.get('continue') || targetUrl.searchParams.get('followup') || '';
    if (!continueParam) break;
    if (/^https?%3a/i.test(continueParam)) {
      try {
        continueParam = decodeURIComponent(continueParam);
      } catch (_ce) {}
    }
    try {
      const inner = new URL(continueParam);
      const innerHost = inner.hostname.toLowerCase();
      if (innerHost === 'accounts.google.com') {
        targetUrl = inner;
      } else {
        continueHost = innerHost;
        break;
      }
    } catch (_ie) {
      break;
    }
  }

  // 多层解码完整 URL，确保 Google 多步登录/二次验证包装下的嵌套参数（client_id / scope / redirect_uri / state）均可精准识别
  let decodedStr = raw;
  for (let pass = 0; pass < 3; pass++) {
    try {
      const safeEncoded = decodedStr.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
      const nextDecoded = decodeURIComponent(safeEncoded);
      if (nextDecoded === decodedStr) break;
      decodedStr = nextDecoded;
    } catch (_de) {
      break;
    }
  }
  const decodedFull = `${raw} ${decodedStr}`.toLowerCase();

  const pathLower = targetUrl.pathname.toLowerCase();
  const isOAuthPath =
    pathLower.includes('/o/oauth2') ||
    pathLower.includes('/signin/oauth') ||
    pathLower.includes('/oauthchooseaccount') ||
    decodedFull.includes('/o/oauth2') ||
    decodedFull.includes('/signin/oauth');

  let clientId = (
    targetUrl.searchParams.get('client_id') ||
    outerUrl.searchParams.get('client_id') ||
    ''
  ).trim();
  if (!clientId) {
    const cidMatch = decodedStr.match(/[?&]client_id=([^&#\s]+)/i);
    if (cidMatch) clientId = cidMatch[1].trim();
  }

  let redirectUri = (
    targetUrl.searchParams.get('redirect_uri') ||
    outerUrl.searchParams.get('redirect_uri') ||
    ''
  ).trim();
  if (!redirectUri) {
    const rMatch = decodedStr.match(/[?&]redirect_uri=([^&#\s]+)/i);
    if (rMatch) {
      try {
        redirectUri = decodeURIComponent(rMatch[1].trim());
      } catch (_re0) {
        redirectUri = rMatch[1].trim();
      }
    }
  }

  let rawScope = (
    targetUrl.searchParams.get('scope') ||
    outerUrl.searchParams.get('scope') ||
    ''
  ).trim();
  if (!rawScope) {
    const sMatch = decodedStr.match(/[?&]scope=([^&#]+)/i);
    if (sMatch) rawScope = sMatch[1].trim();
  }

  const stateParam = (
    targetUrl.searchParams.get('state') ||
    outerUrl.searchParams.get('state') ||
    ''
  ).trim();

  if (!isOAuthPath && !clientId && !redirectUri) {
    return { matched: false, shouldBlock: false };
  }

  // 1) 放行本插件自身的客户端 ID 与本地回环 PKCE 授权流（兼容多跳嵌套编码场景）
  const ownSet = new Set(
    resolvedOwnClientIds.map(x => String(x || '').trim()).filter(Boolean)
  );
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const mfClientId = chrome.runtime.getManifest()?.oauth2?.client_id || '';
      if (mfClientId && !mfClientId.includes('替换')) {
        ownSet.add(mfClientId.trim());
      }
    }
  } catch (_me) {}

  if (clientId && ownSet.has(clientId)) {
    return { matched: false, shouldBlock: false, reason: 'own_client' };
  }
  for (const ownId of ownSet) {
    const lowOwnId = String(ownId || '').trim().toLowerCase();
    if (lowOwnId && decodedFull.includes(lowOwnId)) {
      return { matched: false, shouldBlock: false, reason: 'own_client' };
    }
  }

  let redirectDomain = '';
  if (redirectUri) {
    try {
      const rParsed = new URL(redirectUri);
      redirectDomain = rParsed.hostname.toLowerCase();
      if (
        (redirectDomain === 'localhost' || redirectDomain === '127.0.0.1') &&
        stateParam.startsWith('st_')
      ) {
        return { matched: false, shouldBlock: false, reason: 'own_loopback_pkce' };
      }
    } catch (_re) {}
  }
  if (
    (decodedFull.includes('http://localhost') || decodedFull.includes('http://127.0.0.1')) &&
    /[?&]state=st_[a-z0-9_-]+/i.test(decodedStr)
  ) {
    return { matched: false, shouldBlock: false, reason: 'own_loopback_pkce' };
  }

  // 2) 放行用户配置的信任白名单应用关键词或域名
  const haystack = `${decodedFull} ${redirectUri.toLowerCase()} ${redirectDomain} ${clientId.toLowerCase()}`;
  if (resolvedTrustedKeywords.length > 0) {
    const trustedHit = resolvedTrustedKeywords.find(tk => tk && haystack.includes(tk));
    if (trustedHit) {
      return {
        matched: false,
        shouldBlock: false,
        reason: 'trusted_keyword',
        trustedKeyword: trustedHit
      };
    }
  }

  // 3) 精准解析请求的 OAuth Scopes（区分 Google 网盘 Drive 与 Google 表格 Sheets）
  const scopeSet = new Set();
  if (rawScope) {
    for (const token of rawScope.split(/[\s+,]+/)) {
      const cleanToken = token.trim();
      if (cleanToken) scopeSet.add(cleanToken);
    }
  }
  const googleAuthMatches = decodedStr.match(/https?:\/\/www\.googleapis\.com\/auth\/[a-zA-Z0-9_.-]+/g) || [];
  for (const gm of googleAuthMatches) {
    scopeSet.add(gm);
  }
  const requestedScopes = [...scopeSet];
  const scopeInspectionText = `${requestedScopes.join(' ')} ${rawScope} ${decodedFull}`;

  const hasDriveScope = /auth\/drive(?:\.[a-z0-9_.-]+)?(?![a-z0-9_])/i.test(scopeInspectionText);
  const hasSheetsScope = /auth\/spreadsheets(?:\.[a-z0-9_.-]+)?(?![a-z0-9_])/i.test(scopeInspectionText);

  const matchedKeywords = resolvedBlockedKeywords.filter(kw => kw && haystack.includes(kw));
  const matchedKeyword = matchedKeywords[0] || '';
  const hitBlockedApp = matchedKeywords.length > 0;

  // Google 官方第一方 Web 服务会话登录/重登（未命中用户黑名单应用词时）直接放行，避免误拦自有服务
  const firstPartyHost = redirectDomain || continueHost;
  if (!hitBlockedApp && firstPartyHost && GOOGLE_FIRST_PARTY_WEB_DOMAINS.has(firstPartyHost)) {
    return {
      matched: false,
      shouldBlock: false,
      reason: 'google_first_party',
      host: firstPartyHost
    };
  }

  const hitBlockedDrive = Boolean(blockDriveScope && hasDriveScope);
  const hitBlockedSheets = Boolean(blockSheetsScope && hasSheetsScope);

  if (!hitBlockedApp && !hitBlockedDrive && !hitBlockedSheets) {
    return {
      matched: false,
      shouldBlock: false,
      matchedKeyword: '',
      matchedKeywords: [],
      hasDriveScope,
      hasSheetsScope,
      requestedScopes,
      appName: '',
      host: redirectDomain,
      reason: '',
      clientId
    };
  }

  const serviceHint = (
    targetUrl.searchParams.get('service') ||
    targetUrl.searchParams.get('app_name') ||
    outerUrl.searchParams.get('service') ||
    ''
  ).trim();

  const appName = matchedKeyword
    ? KNOWN_OAUTH_APP_DISPLAY_NAMES[matchedKeyword] || matchedKeyword.toUpperCase()
    : redirectDomain || serviceHint || (clientId ? clientId.slice(0, 24) : '外部第三方应用');

  const reasons = [];
  if (hitBlockedApp) {
    reasons.push(`命中禁止关联应用 (${matchedKeywords.join(', ')})`);
  }
  if (hitBlockedDrive && hitBlockedSheets) {
    reasons.push('申请受禁的 Google 网盘与 Google 表格权限');
  } else if (hitBlockedDrive) {
    reasons.push('申请受禁的 Google 网盘 (Drive) 权限');
  } else if (hitBlockedSheets) {
    reasons.push('申请受禁的 Google 表格 (Sheets) 权限');
  }

  return {
    matched: true,
    shouldBlock: true,
    matchedKeyword,
    matchedKeywords,
    hasDriveScope,
    hasSheetsScope,
    requestedScopes,
    scopes: requestedScopes.join(' ') || rawScope,
    appName,
    appHint: appName,
    host: redirectDomain,
    redirectUri,
    redirectDomain,
    reason: reasons.join(' · '),
    clientId
  };
}
