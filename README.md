# Google Drive 权限管理与安全加固中心 Chrome 扩展 (v1.2.1)

纯前端 Chrome Manifest V3 扩展项目，无需额外构建工具即可加载运行。采用**现代左导航全宽工作台**与**首屏高优先级网页伴随侧边栏（Side Panel）**双视图协同架构。

## v1.2.1 核心能力

1. **第三方应用 OAuth 主动拦截禁止与网盘/表格权限封禁**
   - **主动阻断拦截 (`oauthGuardMode: 'block'`)**：实时监测浏览器访问的 Google OAuth 授权页（支持多层 `continue`/`followup` 嵌套解包与多重 URL 解码），当命中禁止关联应用黑名单（默认覆盖 `ChatGPT / OpenAI / Grok / xAI / Muse / Claude / Cursor / Notion / Zapier / Make`）或外部应用申请受禁的 **Google 网盘 (`drive`) / Google 表格 (`spreadsheets`)** 权限时，立即重定向拦截至内置安全保护页 (`oauth-blocked.html`)。
   - **零误伤智能白名单与 5 分钟临时放行**：自动放行本扩展自身导入的 OAuth 客户端与本地 `localhost` PKCE 流程，支持配置信任应用白名单 (`trustedOAuthKeywords`)，并在拦截页提供「我确认信任，本次临时放行 5 分钟」会话级安全豁免及一键直达 Google 已关联第三方应用页。

2. **网页伴随侧边栏首屏优先级与一键关闭公开权限**
   - 打开任意 Google 文档/表格/文件夹时，伴随栏顶部操作区内置醒目的 **「🔴 一键关闭公开权限」** 按钮，存在公开或域内共享链接时一点即关；第 1 屏同步置顶展示 **宽权限风险预警横幅 (`assessWidePermissionRisk`)** 与前置 **「谁有权限」实时协作者清单**。

3. **排除扫描目录保护与全工作台吸顶止血**
   - **独立「排除目录」管理 (`excludedFolders`)**：支持搜索勾选已扫描文件夹或粘贴文件夹链接加入排除名单（递归豁免全部深层子目录与子文件，伴随栏支持最多 6 层祖先目录链自动回溯识别），扫描、自动修正与一键关闭公开链接均自动跳过对外公开资料目录。
   - **按风险等级排序**：资产卡片、筛选器与快捷操作统一按危险等级从高到低配 Emoji 排列，吸顶工具栏内置 **「🔴 一键关闭公开链接」**、**「🔒 一键禁编辑拉人」** 与 **「🛡️ 一键禁只读下载复制」**。

4. **默认 12 小时定期自动巡检 + 浏览器启动防重与断点续检**
   - 默认开启每 **12 小时（720 分钟）** 后台自动巡检自有云盘资产；重启浏览器未满 12 小时智能跳过不重复打扰，若上次多账号巡检中途未完成则自动断点续检剩余账号。

5. **IMPORTRANGE 多账号极速批授权、分组资产绑定与全盘清退**
   - 支持 `A列来源表 -> B列目标表` 多账号轮询极速批量放行 `IMPORTRANGE`、授权前自动暂停汇总表公式防卡顿、Google 表格 `A列邮箱 · B列权限` 导入、跨全部分组批量增删邮箱、岗位权限包及多邮箱全盘移除权限并导出 CSV 回执。

## 目录结构

- `manifest.json`：Manifest V3 扩展配置、Drive + Sheets OAuth 权限声明与 Side Panel 配置（`v1.2.1`）。
- `core.js`：底层治理引擎（第三方 OAuth 主动拦截匹配与 Scope 解析、排除目录递归推导、宽权限风险评估、断点续检检查点、IMPORTRANGE 极速批授权、分组管理与安全加固）。
- `background.js`：MV3 Service Worker（第三方 OAuth 实时阻断拦截与 5 分钟临时放行、12 小时智能巡检与启动断点续检、TTL 到期回收与伴随栏联动）。
- `oauth-blocked.html` / `oauth-blocked.js`：MV3 CSP 合规的第三方 Google OAuth 主动安全拦截提示页。
- `theme-init.js`：首屏零闪烁深浅双色主题初始化脚本。
- `popup.html` / `popup.css` / `popup.js`：六维导航全宽治理工作台。
- `sidepanel.html` / `sidepanel.js`：Google Drive / Docs 首屏高优先级网页伴随侧边栏。
- `icons/`：扩展多尺寸图标（16 / 32 / 48 / 128 px）。
- `vendor/`：内置 Jspreadsheet CE 与 jSuites 表格组件。

## 安装方式

1. 前往本仓库 **Releases** 页面下载最新打包好的 `gdrive-tools-v*.zip` 并解压到本地目录。
2. 打开 Chrome 浏览器访问 `chrome://extensions`，开启右上角 **「开发者模式」**。
3. 点击左上角 **「加载已解压的扩展程序」**，选择解压后的文件夹即可使用。

> **安全提示**：白名单与分组备份仅导出规则配置（不含账号令牌）；切勿将 Google Cloud OAuth 客户端密钥或 Service Account 私钥文件上传至公开代码仓库。
