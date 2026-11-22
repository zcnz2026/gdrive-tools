importScripts('core.js');

// 扩展内置高清 PNG 图标，用于系统桌面通知
const NOTIFICATION_ICON = 'icons/icon128.png';
const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections';

function isGoogleDriveOrDocsUrl(url = '') {
  return /^https:\/\/(drive|docs)\.google\.com\//i.test(String(url || ''));
}

async function safeBroadcastRuntimeMessage(payload) {
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (_e) {
    // 前台页面未打开时静默忽略
  }
}

async function openOrFocusDashboard(focusFileId = '') {
  const cleanFileId = String(focusFileId || '').trim();
  if (cleanFileId) {
    try {
      if (chrome.storage?.session?.set) {
        await chrome.storage.session.set({ pendingFocusFileId: cleanFileId });
      }
    } catch (_e) {
      // 忽略 session 存储异常
    }
  }

  const targetUrl = chrome.runtime.getURL('popup.html');
  const tabs = await chrome.tabs.query({ url: targetUrl });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (cleanFileId) {
      await safeBroadcastRuntimeMessage({ type: 'FOCUS_FILE_IN_DASHBOARD', fileId: cleanFileId });
    }
    return;
  }

  await chrome.tabs.create({ url: targetUrl });
}

chrome.action.onClicked.addListener(async tab => {
  // 必须在任何 await 之前同步判定并在用户手势栈内直接调用 chrome.sidePanel.open
  if (isGoogleDriveOrDocsUrl(tab?.url) && tab?.windowId && chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch (_err) {
      // 若当前浏览器环境打开侧边栏失败，平滑回退打开全屏工作台
    }
  }
  await openOrFocusDashboard();
});

/**
 * 按当前策略与上次成功巡检时间智能对齐定期巡检闹钟（默认每 12 小时 / 720 分钟）
 */
async function syncAlarmWithPolicy() {
  const [policy, checkpoint] = await Promise.all([getPolicy(), getAutoScanCheckpoint()]);
  await chrome.alarms.clear(ALARM_NAME);
  if (!policy.scheduleEnabled) {
    return { scheduled: false, periodInMinutes: 0, delayInMinutes: 0, nextRunAt: '' };
  }

  const periodInMinutes = Math.max(15, Number(policy.scheduleMinutes) || 720);
  let delayInMinutes = periodInMinutes;

  if (checkpoint.lastSuccessAt && Number.isFinite(Date.parse(checkpoint.lastSuccessAt))) {
    const elapsedMs = Date.now() - Date.parse(checkpoint.lastSuccessAt);
    const periodMs = periodInMinutes * 60000;
    if (elapsedMs >= 0 && elapsedMs < periodMs) {
      delayInMinutes = Math.max(1, Math.ceil((periodMs - elapsedMs) / 60000));
    } else {
      delayInMinutes = 1;
    }
  }

  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes,
    periodInMinutes
  });

  return {
    scheduled: true,
    periodInMinutes,
    delayInMinutes,
    nextRunAt: new Date(Date.now() + delayInMinutes * 60000).toISOString()
  };
}

const syncScheduleAlarm = syncAlarmWithPolicy;

async function syncTtlAlarm() {
  const queue = await getTtlQueue();
  const pendingItems = queue.filter(
    item => item?.status === 'pending' && Number.isFinite(Date.parse(item?.expiresAt || ''))
  );

  if (!pendingItems.length) {
    await chrome.alarms.clear(TTL_ALARM_NAME);
    return { scheduled: false, pendingCount: 0, nextDueAt: '' };
  }

  const earliestMs = Math.min(...pendingItems.map(item => Date.parse(item.expiresAt)));
  const when = Math.max(Date.now() + 5000, earliestMs);
  await chrome.alarms.create(TTL_ALARM_NAME, {
    when,
    periodInMinutes: 5
  });

  return {
    scheduled: true,
    pendingCount: pendingItems.length,
    nextDueAt: new Date(earliestMs).toISOString()
  };
}

async function runTtlReaperAndNotify() {
  const result = await processExpiredTtlPermissions();
  await syncTtlAlarm();

  if (result.processedCount > 0) {
    await safeBroadcastRuntimeMessage({ type: 'TTL_UPDATED', result });
    if (result.revokedCount > 0 || result.downgradedCount > 0) {
      await safeBroadcastRuntimeMessage({ type: 'SCAN_UPDATED' });
      try {
        await chrome.notifications.create(`ttl-${Date.now()}`, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON,
          title: 'Drive 限时授权到期已自动收回',
          message: `已自动回收 ${result.revokedCount} 项到期权限${
            result.downgradedCount ? `，降级 ${result.downgradedCount} 项为只读` : ''
          }。`
        });
      } catch (_notifyErr) {}
    }
  }

  return result;
}

async function executeAutoPatrolScan(source = 'schedule', resumeCheckpoint = false) {
  try {
    const result = await runFullScan({
      interactive: false,
      source,
      scanScope: 'owned',
      resumeCheckpoint
    });
    if (result?.skipped) {
      return { executed: false, reason: result.skipReason || 'scan_in_progress' };
    }

    const { summary, newlyDiscoveredCount, autoEnforceResult, policy } = result;
    await safeBroadcastRuntimeMessage({ type: 'SCAN_UPDATED' });

    if (
      policy.autoEnforce &&
      autoEnforceResult &&
      (autoEnforceResult.removed > 0 || autoEnforceResult.downgraded > 0)
    ) {
      await chrome.notifications.create(`scan-${Date.now()}`, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON,
        title: 'Drive 权限自动守护已执行',
        message: `自动巡检已移除 ${autoEnforceResult.removed} 项非白名单权限，降级 ${autoEnforceResult.downgraded} 项越权编辑。`
      });
    } else if (
      summary.publicFiles > 0 ||
      summary.anomalousFiles > 0 ||
      newlyDiscoveredCount > 0 ||
      summary.changedFiles > 0
    ) {
      const extraNotes = [];
      if (summary.publicFiles > 0) extraNotes.push(`公开/域内链接 ${summary.publicFiles} 个`);
      if (newlyDiscoveredCount > 0) extraNotes.push(`新增文件 ${newlyDiscoveredCount} 个`);
      if (summary.changedFiles > 0) extraNotes.push(`权限变动 ${summary.changedFiles} 个`);
      await chrome.notifications.create(`scan-${Date.now()}`, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON,
        title: 'Drive 宽权限与异常自动巡检提醒',
        message: `发现 ${summary.anomalousFiles} 个权限异常文件（${summary.actionablePermissions} 项待处理）${
          extraNotes.length ? `，${extraNotes.join('，')}` : ''
        }。点击查看详情。`
      });
    }

    return { executed: true, resumed: Boolean(result.resumedFromCheckpoint), summary };
  } catch (error) {
    await appendAuditLogs({
      id: `${Date.now()}-err`,
      timestamp: new Date().toISOString(),
      source: 'scan',
      actionType: 'error',
      fileId: '',
      fileName: source === 'startup' ? '启动自动巡检' : '后台定时巡检',
      webViewLink: '',
      permissionId: '',
      targetType: '',
      targetEmail: '',
      targetLabel: '系统任务',
      previousRole: '',
      newRole: '',
      restored: false,
      message: `自动巡检未完成：${error?.message || String(error)}`
    });
    return { executed: false, reason: 'error', error: error?.message || String(error) };
  }
}

/**
 * 智能自动巡检调度入口（启动防重 · 未完成账号断点续检 · 12小时周期判定）
 */
async function checkAndRunAutoPatrol(triggerReason = 'startup') {
  const [accounts, policy, checkpoint] = await Promise.all([
    getAuthorizedAccounts(),
    getPolicy(),
    getAutoScanCheckpoint()
  ]);

  if (!accounts.length || !policy.scheduleEnabled) {
    await syncAlarmWithPolicy();
    return { executed: false, reason: 'disabled_or_no_accounts' };
  }

  if (triggerReason === 'startup' && policy.scanOnBrowserStartup === false) {
    const alarmState = await syncAlarmWithPolicy();
    return { executed: false, reason: 'startup_scan_disabled', nextRunAt: alarmState.nextRunAt };
  }

  const nowMs = Date.now();
  const startedMs = checkpoint.startedAt ? Date.parse(checkpoint.startedAt) : 0;

  // 若最近 2 分钟内已有活跃自动扫描，避免重复并发触发
  if (checkpoint.status === 'running' && startedMs > 0 && nowMs - startedMs <= 2 * 60 * 1000) {
    return { executed: false, reason: 'already_running' };
  }

  // 若上次巡检中途被关闭中断（status === 'interrupted'，或 running 超过 2 分钟已失活），立即断点续检剩余账号
  const isUnfinished =
    checkpoint.status === 'interrupted' ||
    (checkpoint.status === 'running' && (!startedMs || nowMs - startedMs > 2 * 60 * 1000));

  if (isUnfinished) {
    const scanSource = triggerReason === 'alarm' ? 'schedule' : 'startup';
    const res = await executeAutoPatrolScan(scanSource, true);
    const alarmState = await syncAlarmWithPolicy();
    return { ...res, nextRunAt: alarmState.nextRunAt };
  }

  // 若距上次完整巡检不足设定周期（默认 720 分钟 = 12 小时），跳过本次扫描并对齐剩余闹钟时间
  const intervalMs = Math.max(15, Number(policy.scheduleMinutes) || 720) * 60000;
  const lastSuccessMs = checkpoint.lastSuccessAt ? Date.parse(checkpoint.lastSuccessAt) : 0;
  if (lastSuccessMs > 0 && nowMs - lastSuccessMs < intervalMs) {
    const alarmState = await syncAlarmWithPolicy();
    return { executed: false, reason: 'within_interval', nextRunAt: alarmState.nextRunAt };
  }

  // 从未巡检过或已满设定周期：立即启动新一轮定期巡检
  const scanSource = triggerReason === 'alarm' ? 'schedule' : 'startup';
  const res = await executeAutoPatrolScan(scanSource, false);
  const alarmState = await syncAlarmWithPolicy();
  return { ...res, nextRunAt: alarmState.nextRunAt };
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await Promise.all([syncAlarmWithPolicy(), syncTtlAlarm()]);
    await checkAndRunAutoPatrol('startup');
  } catch (_err) {}
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await Promise.all([syncAlarmWithPolicy(), syncTtlAlarm()]);
    await runTtlReaperAndNotify();
    await checkAndRunAutoPatrol('startup');
  } catch (_err) {}
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;
  try {
    if (changes.policy) {
      await syncAlarmWithPolicy();
    }
    if (changes.ttlPermissionsQueue) {
      await syncTtlAlarm();
    }
  } catch (_err) {}
});

const TEMP_ALLOW_OAUTH_TTL_MS = 5 * 60 * 1000;
let memTempAllowedOAuth = [];

function isSafeGoogleOAuthReturnUrl(urlStr = '') {
  try {
    const parsed = new URL(String(urlStr || '').trim());
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'accounts.google.com';
  } catch (_e) {
    return false;
  }
}

async function getTempAllowedOAuthEntries() {
  const nowMs = Date.now();
  let list = memTempAllowedOAuth;
  try {
    if (chrome.storage?.session?.get) {
      const data = await chrome.storage.session.get('tempAllowedOAuth');
      if (Array.isArray(data?.tempAllowedOAuth)) {
        list = data.tempAllowedOAuth;
      }
    }
  } catch (_e) {}

  const valid = (Array.isArray(list) ? list : []).filter(
    item => item && Number(item.expiresAt) > nowMs
  );
  memTempAllowedOAuth = valid;
  if (valid.length !== (Array.isArray(list) ? list.length : 0)) {
    try {
      if (chrome.storage?.session?.set) {
        await chrome.storage.session.set({ tempAllowedOAuth: valid });
      }
    } catch (_se) {}
  }
  return valid;
}

async function addTempAllowedOAuthEntry({
  alert = null,
  originalUrl = '',
  durationMinutes = 5,
  tabId = null
} = {}) {
  const existing = await getTempAllowedOAuthEntries();
  const targetUrl = String(originalUrl || alert?.originalUrl || alert?.url || '').trim();
  const hitInfo = targetUrl ? matchThirdPartyOAuthUrl(targetUrl, {}) : {};

  const clientId = String(alert?.clientId || hitInfo?.clientId || '').trim();
  const host = String(alert?.host || alert?.redirectDomain || hitInfo?.host || '').trim().toLowerCase();
  const matchedKeyword = String(alert?.matchedKeyword || hitInfo?.matchedKeyword || '').trim().toLowerCase();
  const resolvedTabId = Number.isInteger(tabId)
    ? tabId
    : Number.isInteger(alert?.tabId)
    ? alert.tabId
    : null;
  const ttlMs = Math.max(1, Math.min(30, Number(durationMinutes) || 5)) * 60 * 1000;
  const expiresAt = Date.now() + (ttlMs || TEMP_ALLOW_OAUTH_TTL_MS);

  const entry = {
    id: `temp-allow-${Date.now()}`,
    tabId: resolvedTabId,
    clientId,
    host,
    matchedKeyword,
    originalUrl: targetUrl,
    expiresAt
  };

  const next = [
    entry,
    ...existing.filter(
      it =>
        !(
          (Number.isInteger(resolvedTabId) && it.tabId === resolvedTabId) ||
          (clientId && it.clientId === clientId) ||
          (!clientId && host && it.host === host) ||
          (!clientId && !host && targetUrl && it.originalUrl === targetUrl)
        )
    )
  ].slice(0, 30);

  memTempAllowedOAuth = next;
  try {
    if (chrome.storage?.session?.set) {
      await chrome.storage.session.set({ tempAllowedOAuth: next });
    }
  } catch (_e) {}

  return entry;
}

async function isTempAllowed(urlStr = '', hit = null, tabId = null) {
  const activeList = await getTempAllowedOAuthEntries();
  if (!activeList.length) return false;

  const raw = String(urlStr || '').trim();
  const safeGoogleUrl = isSafeGoogleOAuthReturnUrl(raw);
  let decodedLower = raw.toLowerCase();
  try {
    decodedLower = `${raw} ${decodeURIComponent(raw.replace(/%(?![0-9a-fA-F]{2})/g, '%25'))}`.toLowerCase();
  } catch (_e) {}

  const hitClientId = String(hit?.clientId || '').trim();
  const hitHost = String(hit?.host || hit?.redirectDomain || '').trim().toLowerCase();
  const hitKeyword = String(hit?.matchedKeyword || '').trim().toLowerCase();

  return activeList.some(rule => {
    if (
      safeGoogleUrl &&
      Number.isInteger(tabId) &&
      Number.isInteger(rule.tabId) &&
      rule.tabId === tabId
    ) {
      return true;
    }
    if (rule.clientId) {
      if (hitClientId && rule.clientId === hitClientId) return true;
      if (decodedLower.includes(rule.clientId.toLowerCase())) return true;
    }
    if (rule.host) {
      if (hitHost && rule.host === hitHost) return true;
      if (decodedLower.includes(rule.host)) return true;
    }
    if (rule.matchedKeyword) {
      if (hitKeyword && rule.matchedKeyword === hitKeyword) return true;
      if (decodedLower.includes(rule.matchedKeyword)) return true;
    }
    if (rule.originalUrl && raw === rule.originalUrl) {
      return true;
    }
    return false;
  });
}

// 实时监测并主动拦截禁止关联第三方应用（如 ChatGPT / Grok / Muse）或索取 Google 网盘 / 表格权限的授权页
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const candidateUrl =
    changeInfo.url || (changeInfo.status === 'loading' ? tab?.pendingUrl || tab?.url || '' : '');
  if (!candidateUrl || !candidateUrl.includes('accounts.google.com')) {
    return;
  }

  try {
    const [policy, oauthClients] = await Promise.all([getPolicy(), getOAuthClients()]);
    if (policy.thirdPartyOAuthGuardEnabled === false) {
      return;
    }
    const ownClientIds = (oauthClients || []).map(c => c?.client_id).filter(Boolean);
    const hit = matchThirdPartyOAuthUrl(candidateUrl, {
      blockedKeywords: policy.blockedAppKeywords,
      trustedKeywords: policy.trustedOAuthKeywords,
      blockDriveScope: policy.blockThirdPartyDriveScope,
      blockSheetsScope: policy.blockThirdPartySheetsScope,
      ownClientIds
    });
    if (!hit.matched) {
      return;
    }

    if (await isTempAllowed(candidateUrl, hit, tabId)) {
      return;
    }

    const isBlockMode = policy.oauthGuardMode !== 'alert' && hit.shouldBlock !== false;
    const saved = await recordThirdPartyAppAlert({
      ...hit,
      action: isBlockMode ? 'blocked' : 'alerted',
      originalUrl: candidateUrl,
      url: candidateUrl,
      tabTitle: String(tab?.title || ''),
      tabId
    });

    if (isBlockMode) {
      const blockedPageUrl = chrome.runtime.getURL(
        `oauth-blocked.html?alertId=${encodeURIComponent(saved.entry.id)}`
      );
      try {
        await chrome.tabs.update(tabId, { url: blockedPageUrl });
      } catch (_tabUpdateErr) {}
    }

    await safeBroadcastRuntimeMessage({ type: 'OAUTH_GUARD_ALERT', alert: saved.entry });

    if (saved.recorded) {
      try {
        await chrome.notifications.create(`oauth-guard-${Date.now()}`, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON,
          priority: 2,
          title: isBlockMode
            ? '已主动拦截第三方 Google 授权请求'
            : '警惕第三方应用请求 Google 账号与云盘授权',
          message: isBlockMode
            ? `已拦截禁止关联「${hit.appName || hit.appHint}」（${hit.reason}）。如确系本人需要，可在拦截页临时放行 5 分钟；点击可核查历史关联应用。`
            : `检测到外部授权请求（${hit.appName || hit.appHint} · ${hit.reason}）。请谨慎核实，点击前往 Google 关联应用页核查撤销。`
        });
      } catch (_notifyErr) {}
    }
  } catch (_guardErr) {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 严格校验消息来源必须为本扩展自身，防止跨扩展或不可信上下文伪造指令
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }

  const msgType = message?.type || '';
  if (
    msgType !== 'SYNC_ALARM' &&
    msgType !== 'SYNC_SCHEDULE' &&
    msgType !== 'SYNC_TTL_ALARM' &&
    msgType !== 'RUN_TTL_REAPER_NOW' &&
    msgType !== 'OPEN_DASHBOARD' &&
    msgType !== 'GET_AUTO_PATROL_STATUS' &&
    msgType !== 'GET_OAUTH_BLOCKED_ALERT' &&
    msgType !== 'TEMP_ALLOW_OAUTH_URL'
  ) {
    return false;
  }

  (async () => {
    try {
      if (msgType === 'SYNC_ALARM' || msgType === 'SYNC_SCHEDULE') {
        const alarmState = await syncAlarmWithPolicy();
        sendResponse({ ok: true, ...alarmState });
      } else if (msgType === 'SYNC_TTL_ALARM') {
        const alarmState = await syncTtlAlarm();
        sendResponse({ ok: true, ...alarmState });
      } else if (msgType === 'RUN_TTL_REAPER_NOW') {
        const result = await runTtlReaperAndNotify();
        sendResponse({ ok: true, result });
      } else if (msgType === 'OPEN_DASHBOARD') {
        await openOrFocusDashboard(message?.fileId || '');
        sendResponse({ ok: true });
      } else if (msgType === 'GET_AUTO_PATROL_STATUS') {
        const [policy, checkpoint, alarm] = await Promise.all([
          getPolicy(),
          getAutoScanCheckpoint(),
          chrome.alarms.get(ALARM_NAME)
        ]);
        const nextIso = alarm?.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : '';
        sendResponse({
          ok: true,
          policy,
          checkpoint,
          nextRunAt: nextIso,
          nextAlarmTime: nextIso
        });
      } else if (msgType === 'GET_OAUTH_BLOCKED_ALERT') {
        const [alert, policy] = await Promise.all([
          getThirdPartyAppAlertById(message?.alertId || ''),
          getPolicy()
        ]);
        sendResponse({
          ok: true,
          alert,
          policy
        });
      } else if (msgType === 'TEMP_ALLOW_OAUTH_URL') {
        const alert = message?.alertId
          ? await getThirdPartyAppAlertById(message.alertId)
          : null;
        const candidateOriginalUrl = String(
          message?.originalUrl || alert?.originalUrl || alert?.url || ''
        ).trim();
        if (!isSafeGoogleOAuthReturnUrl(candidateOriginalUrl)) {
          throw new Error('原始授权链接无效或不属于 Google 官方授权域，无法放行');
        }
        const entry = await addTempAllowedOAuthEntry({
          alert,
          originalUrl: candidateOriginalUrl,
          durationMinutes: message?.durationMinutes || 5,
          tabId: sender?.tab?.id ?? alert?.tabId ?? null
        });
        sendResponse({
          ok: true,
          redirectUrl: candidateOriginalUrl,
          expiresAt: entry.expiresAt,
          entry
        });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === TTL_ALARM_NAME) {
    try {
      await runTtlReaperAndNotify();
    } catch (error) {
      await appendAuditLogs({
        id: `${Date.now()}-ttl-err`,
        timestamp: new Date().toISOString(),
        source: 'auto',
        actionType: 'error',
        isTtl: true,
        fileId: '',
        fileName: '限时授权到期巡检',
        webViewLink: '',
        permissionId: '',
        targetType: '',
        targetEmail: '',
        targetLabel: '系统任务',
        previousRole: '',
        newRole: '',
        restored: false,
        message: `限时授权自动回收异常：${error?.message || String(error)}`
      });
    }
    return;
  }

  if (alarm.name !== ALARM_NAME) return;

  try {
    await runTtlReaperAndNotify();
  } catch (_ttlErr) {}

  try {
    await checkAndRunAutoPatrol('alarm');
  } catch (_patrolErr) {}
});

chrome.notifications.onClicked.addListener(async notificationId => {
  if (String(notificationId || '').startsWith('oauth-guard-')) {
    try {
      await chrome.tabs.create({ url: GOOGLE_CONNECTIONS_URL, active: true });
      return;
    } catch (_tabErr) {}
  }
  await openOrFocusDashboard();
});
