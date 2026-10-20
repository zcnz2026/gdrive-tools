importScripts('core.js');

// 内置轻量 PNG 图标 Data URI，用于系统桌面通知
const NOTIFICATION_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAABNSURBVHgB7c4xAQAgCAAw7N/a2cHHB4K6c3Z27gwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcLcB6f4Bff8tZ1MAAAAASUVORK5CYII=';

async function openOrFocusDashboard() {
  const targetUrl = chrome.runtime.getURL('popup.html');
  const tabs = await chrome.tabs.query({ url: targetUrl });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: targetUrl });
}

chrome.action.onClicked.addListener(() => {
  openOrFocusDashboard();
});

async function syncScheduleAlarm() {
  const policy = await getPolicy();
  await chrome.alarms.clear(ALARM_NAME);
  if (policy.scheduleEnabled) {
    const periodInMinutes = Math.max(15, Number(policy.scheduleMinutes) || 60);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: periodInMinutes,
      periodInMinutes
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  syncScheduleAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  syncScheduleAlarm();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.policy) {
    syncScheduleAlarm();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SYNC_ALARM') {
    syncScheduleAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    const result = await runFullScan({ interactive: false, source: 'schedule' });
    const { summary, newlyDiscoveredCount, autoEnforceResult, policy } = result;

    // 通知前台已打开的管理页刷新
    chrome.runtime.sendMessage({ type: 'SCAN_UPDATED' }).catch(() => {});

    if (policy.autoEnforce && autoEnforceResult && (autoEnforceResult.removed > 0 || autoEnforceResult.downgraded > 0)) {
      chrome.notifications.create(`scan-${Date.now()}`, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON,
        title: 'Drive 权限自动守护已执行',
        message: `定时巡检已自动移除 ${autoEnforceResult.removed} 项非白名单权限，降级 ${autoEnforceResult.downgraded} 项越权编辑。`
      });
    } else if (summary.anomalousFiles > 0 || newlyDiscoveredCount > 0) {
      chrome.notifications.create(`scan-${Date.now()}`, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON,
        title: 'Drive 权限定时巡检提醒',
        message: `发现 ${summary.anomalousFiles} 个权限异常文件（${summary.actionablePermissions} 项待处理）${newlyDiscoveredCount ? `，新增文件 ${newlyDiscoveredCount} 个` : ''}。点击查看详情。`
      });
    }
  } catch (error) {
    await appendAuditLogs({
      id: `${Date.now()}-err`,
      timestamp: new Date().toISOString(),
      source: 'scan',
      actionType: 'error',
      fileId: '',
      fileName: '后台定时巡检',
      webViewLink: '',
      permissionId: '',
      targetType: '',
      targetEmail: '',
      targetLabel: '系统任务',
      previousRole: '',
      newRole: '',
      restored: false,
      message: `定时扫描未完成：${error.message}`
    });
  }
});

chrome.notifications.onClicked.addListener(() => {
  openOrFocusDashboard();
});
