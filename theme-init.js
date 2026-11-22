// 同步首屏主题防闪烁初始化（遵循 Chrome MV3 CSP script-src 'self'）
try {
  const savedScheme = localStorage.getItem('color-scheme');
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta && (savedScheme === 'light' || savedScheme === 'dark')) {
    meta.content = savedScheme;
  }
} catch (_e) {
  // 存储受限时自动回退至系统默认配色方案
}
