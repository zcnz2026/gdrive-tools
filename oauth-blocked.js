const GOOGLE_CONNECTIONS_PAGE = 'https://myaccount.google.com/connections';

let currentAlertId = '';
let currentAlertRecord = null;

function $(id) {
  return document.getElementById(id);
}

function showStatusMessage(text = '') {
  const box = $('blocked-status-msg');
  if (!box) return;
  if (!text) {
    box.textContent = '';
    box.classList.add('hidden');
    return;
  }
  box.textContent = text;
  box.classList.remove('hidden');
}

function isSafeGoogleAccountsUrl(urlStr = '') {
  try {
    const parsed = new URL(String(urlStr || '').trim());
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'accounts.google.com';
  } catch (_e) {
    return false;
  }
}

function renderBlockedAlertDetails(alert) {
  const appNameEl = $('blocked-app-name');
  const scopesSummaryEl = $('blocked-scopes-summary');
  const reasonsListEl = $('blocked-reasons-list');
  const hostRowEl = $('blocked-host-row');
  const hostTextEl = $('blocked-host-text');
  const clientRowEl = $('blocked-client-row');
  const clientTextEl = $('blocked-client-text');
  const tempAllowBtn = $('blocked-temp-allow-btn');

  if (!alert) {
    if (appNameEl) appNameEl.textContent = '外部第三方应用';
    if (scopesSummaryEl) scopesSummaryEl.textContent = 'Google 账号关联或云盘/表格访问权限';
    if (reasonsListEl) {
      reasonsListEl.textContent = '';
      const li = document.createElement('li');
      li.textContent = '该授权页面命中第三方 OAuth 主动拦截规则，已被安全阻断。';
      reasonsListEl.appendChild(li);
    }
    if (tempAllowBtn) {
      tempAllowBtn.disabled = true;
      tempAllowBtn.title = '未找到可跳转的原始授权链接';
    }
    return;
  }

  const displayApp =
    alert.appName || alert.appHint || alert.matchedKeyword || alert.host || '外部第三方应用';
  if (appNameEl) {
    appNameEl.textContent = displayApp;
  }

  const blockedScopeLabels = [];
  if (alert.hasDriveScope) blockedScopeLabels.push('Google 网盘 (Drive)');
  if (alert.hasSheetsScope) blockedScopeLabels.push('Google 表格 (Sheets)');
  if (scopesSummaryEl) {
    if (blockedScopeLabels.length > 0) {
      scopesSummaryEl.textContent = blockedScopeLabels.join('、');
    } else if (Array.isArray(alert.requestedScopes) && alert.requestedScopes.length > 0) {
      scopesSummaryEl.textContent = alert.requestedScopes.join(', ');
    } else if (alert.scopes) {
      scopesSummaryEl.textContent = alert.scopes;
    } else {
      scopesSummaryEl.textContent = '第三方账号关联授权（未额外声明网盘/表格细分权限）';
    }
  }

  if (reasonsListEl) {
    reasonsListEl.textContent = '';
    const items = [];
    const kwList =
      Array.isArray(alert.matchedKeywords) && alert.matchedKeywords.length > 0
        ? alert.matchedKeywords
        : alert.matchedKeyword
        ? [alert.matchedKeyword]
        : [];
    if (kwList.length > 0) {
      items.push(`命中禁止关联应用名单：${kwList.join(', ')}`);
    }
    if (alert.hasDriveScope) {
      items.push('申请受禁权限：禁止外部第三方应用获取 Google 网盘（Drive）访问或管理权限');
    }
    if (alert.hasSheetsScope) {
      items.push('申请受禁权限：禁止外部第三方应用获取 Google 表格（Sheets）读写权限');
    }
    if (items.length === 0) {
      items.push(alert.reason || '命中第三方 OAuth 安全拦截策略');
    }

    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      reasonsListEl.appendChild(li);
    }
  }

  const hostVal = String(alert.host || alert.redirectDomain || '').trim();
  if (hostRowEl && hostTextEl) {
    if (hostVal) {
      hostTextEl.textContent = hostVal;
      hostRowEl.classList.remove('hidden');
    } else {
      hostRowEl.classList.add('hidden');
    }
  }

  const clientVal = String(alert.clientId || '').trim();
  if (clientRowEl && clientTextEl) {
    if (clientVal) {
      clientTextEl.textContent = clientVal;
      clientRowEl.classList.remove('hidden');
    } else {
      clientRowEl.classList.add('hidden');
    }
  }

  const returnUrl = String(alert.originalUrl || alert.url || '').trim();
  if (tempAllowBtn) {
    const canReturn = isSafeGoogleAccountsUrl(returnUrl);
    tempAllowBtn.disabled = !canReturn;
    tempAllowBtn.title = canReturn
      ? '将当前应用加入 5 分钟会话临时白名单并跳回原 Google 授权页'
      : '无有效的原始 Google 授权链接';
  }
}

async function loadBlockedAlertRecord() {
  const params = new URLSearchParams(window.location.search);
  currentAlertId = String(params.get('alertId') || '').trim();

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GET_OAUTH_BLOCKED_ALERT',
      alertId: currentAlertId
    });
    if (resp?.ok && resp.alert) {
      currentAlertRecord = resp.alert;
      renderBlockedAlertDetails(currentAlertRecord);
      return;
    }
  } catch (_msgErr) {}

  try {
    const raw = await chrome.storage.local.get('thirdPartyAppAlerts');
    const list = Array.isArray(raw?.thirdPartyAppAlerts) ? raw.thirdPartyAppAlerts : [];
    currentAlertRecord = currentAlertId
      ? list.find(item => item?.id === currentAlertId) || null
      : list[0] || null;
  } catch (_storageErr) {}

  renderBlockedAlertDetails(currentAlertRecord);
}

async function handleCloseBlockedPage() {
  try {
    if (chrome.tabs?.getCurrent && chrome.tabs?.remove) {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) {
        await chrome.tabs.remove(tab.id);
        return;
      }
    }
  } catch (_e) {}

  window.close();
  window.location.replace(chrome.runtime.getURL('popup.html'));
}

async function handleOpenGoogleConnections() {
  try {
    if (chrome.tabs?.create) {
      await chrome.tabs.create({ url: GOOGLE_CONNECTIONS_PAGE, active: true });
      return;
    }
  } catch (_e) {}
  window.open(GOOGLE_CONNECTIONS_PAGE, '_blank', 'noopener,noreferrer');
}

async function handleTempAllowFiveMinutes() {
  const btn = $('blocked-temp-allow-btn');
  const targetUrl = String(currentAlertRecord?.originalUrl || currentAlertRecord?.url || '').trim();
  if (!isSafeGoogleAccountsUrl(targetUrl)) {
    showStatusMessage('无法识别有效的 Google 原始授权地址，请回到原站点重新发起或检查白名单配置。');
    return;
  }

  if (btn) btn.disabled = true;
  showStatusMessage('正在为您写入 5 分钟临时放行凭证并跳回原授权页…');

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'TEMP_ALLOW_OAUTH_URL',
      alertId: currentAlertRecord?.id || currentAlertId,
      originalUrl: targetUrl,
      durationMinutes: 5
    });
    if (!resp?.ok || !isSafeGoogleAccountsUrl(resp.redirectUrl)) {
      throw new Error(resp?.error || '临时放行失败');
    }
    window.location.replace(resp.redirectUrl);
  } catch (error) {
    if (btn) btn.disabled = false;
    showStatusMessage(`临时放行未成功：${error?.message || String(error)}`);
  }
}

function initBlockedPage() {
  $('blocked-close-btn')?.addEventListener('click', handleCloseBlockedPage);
  $('blocked-connections-btn')?.addEventListener('click', handleOpenGoogleConnections);
  $('blocked-temp-allow-btn')?.addEventListener('click', handleTempAllowFiveMinutes);
  loadBlockedAlertRecord();
}

document.addEventListener('DOMContentLoaded', initBlockedPage);
