# Google Drive 权限管理与安全加固中心 Chrome 扩展 (v1.2.3)

纯前端 Chrome Manifest V3 扩展项目，无需额外构建工具即可加载运行。采用**现代左导航全宽工作台**与**首屏高优先级网页伴随侧边栏（Side Panel）**双视图协同架构。

## v1.2.3 核心能力

1. **大文件夹深层所有权转移真实核验与隐身游离文件一键找回**
   - **杜绝「假已发送」与共享限流掉队 (`transferSingleItemOwnership` / `acceptSingleItemOwnership`)**：严格按目录层级自顶向下顺序转移，对每个深层子文件夹与子文件独立校验 API 返回的 `role === 'owner' || pendingOwner === true`；当继承自上级目录的共享权限 ID 无法挂载 `pendingOwner` 时自动创建文件级直属权限重试，并内置 `sharingRateLimitExceeded` 最高 12 次指数退避。
   - **隐身游离文件一键找回与自动归位 (`rescueInvisibleOrphanFiles` / `mountTransferredItemsToMyDriveRoot`)**：基于 BFS 目录树可达性分析，在转移完成后或点击顶栏「📂 找回隐藏文件」时，自动将原父目录已接管的脱钩子项还原回原目录、将断层目录直接挂载至『我的云端硬盘』根目录（完整保留内部子目录树），并将无归属孤儿单文件统一归集至根目录 **「📁 找回的隐藏游离文件」**。

2. **OAuth JSON 授权文件与已授权账号多入口彻底移除**
   - **凭证与关联账号联动彻底清理 (`removeOAuthClientAndAccounts` / `removeAuthorizedAccount` / `clearAllAuthCredentials`)**：为桌面端、Web 端与服务账号 JSON 凭证统一生成唯一 `uid` 并自动修复历史旧记录；支持在设置页整行卡片、左侧导航栏当前账号框及全盘转移页来源/接收账号框一键移除单个错误授权文件、单个授权账号或清空全部本地授权凭证，所有视图与伴随侧边栏实时同步刷新。

3. **全量配置一键导出与导入 + Google 群组与通讯录姓名备注检索**
   - **全模块一键备份 (`exportAllExtensionConfig` / `importAllExtensionConfig`)**：支持一键导出与恢复全部本地业务规则（白名单、排除目录、12 小时巡检与 OAuth 拦截名单、邮箱分组、通讯录姓名备注、岗位权限包、合作方档案与筛选预设），严格剥离所有密钥与账号令牌。
   - **全链路 Google 群组邮箱与姓名备注搜索**：原生支持 `@googlegroups.com` 与企业自建域名群组邮箱双向智能回退及姓名/备注快速定位。

4. **第三方应用 OAuth 主动拦截禁止 + 伴随侧边栏一键关闭公开权限**
   - **主动阻断拦截 (`oauthGuardMode: 'block'`)**：实时拦截命中黑名单或申请受禁网盘/表格权限的外部 OAuth 授权请求至内置安全保护页 (`oauth-blocked.html`)；伴随侧边栏支持一键关闭公开权限、排除目录 6 层祖先链自动识别及 12 小时断点续检。

## 目录结构

- `manifest.json`：Manifest V3 扩展配置、Drive + Sheets OAuth 权限声明与 Side Panel 配置（`v1.2.3`）。
- `core.js`：底层治理引擎（深层所有权转移真实核验与隐身游离文件找回、OAuth 凭证与账号联动移除、全量配置导入导出、Google 群组授权、第三方 OAuth 拦截与 IMPORTRANGE 批授权）。
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

> **安全提示**：全量配置备份仅导出业务规则与分组名录（绝不含账号令牌或密钥）；切勿将 Google Cloud OAuth 客户端密钥或 Service Account 私钥文件上传至公开代码仓库。
