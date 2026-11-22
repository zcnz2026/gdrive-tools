# Google Drive 权限管理与安全加固中心 Chrome 扩展 (v1.2.2)

纯前端 Chrome Manifest V3 扩展项目，无需额外构建工具即可加载运行。采用**现代左导航全宽工作台**与**首屏高优先级网页伴随侧边栏（Side Panel）**双视图协同架构。

## v1.2.2 核心能力

1. **全量配置一键导出与导入（换机/团队同步 · 零密钥零令牌泄漏）**
   - **全模块一键备份 (`exportAllExtensionConfig` / `importAllExtensionConfig`)**：支持一键导出与恢复全部本地配置（白名单规则、排除目录、12 小时巡检与第三方 OAuth 拦截名单、邮箱分组及绑定资产、通讯录人员姓名与备注、岗位权限包、外部合作方档案、筛选预设与界面主题），严格剥离所有 OAuth 客户端密钥与账号令牌，换电脑或团队统一规则即导即用。

2. **Google 群组邮箱 (`@googlegroups.com` / 企业群组) 与分组人员姓名备注搜索**
   - **全链路群组邮箱支持 (`isGoogleGroupEmail` / `inferPermissionTargetType` / 双向智能回退)**：单文件检查器、伴随侧边栏、分组批量授权、链接批量授权、岗位权限包及 IMPORTRANGE 源表放行均原生支持 `@googlegroups.com` 及企业自建域名 Google 群组邮箱（`type: 'group'` <-> `'user'` 智能双向回退），并在界面展示 `👥 群组` 专属徽标。
   - **通讯录姓名 + 备注管理与全局检索 (`updateContactProfile`)**：支持填写或批量导入 `邮箱, 姓名, 备注`（及 Google 表格多列导入），提供独立通讯录搜索管理表（行内编辑姓名/备注/群组类型/默认角色），且资产列表、批量链接选人、人员审计与伴随栏全面支持按姓名或备注快速定位。

3. **第三方应用 OAuth 主动拦截禁止与网盘/表格权限封禁**
   - **主动阻断拦截 (`oauthGuardMode: 'block'`)**：实时监测浏览器访问的 Google OAuth 授权页，当命中禁止关联应用黑名单（如 `ChatGPT / OpenAI / Grok / xAI / Muse / Claude / Cursor / Notion / Zapier / Make`）或外部应用申请受禁的 **Google 网盘 (`drive`) / Google 表格 (`spreadsheets`)** 权限时，立即重定向拦截至内置安全保护页 (`oauth-blocked.html`)，并提供 5 分钟会话级临时放行与信任白名单。

4. **网页伴随侧边栏一键关闭公开权限 + 排除扫描目录保护 + 12 小时智能断点续检**
   - 伴随栏头部常驻 **「🔴 一键关闭公开权限」** 按钮与宽权限预警卡；独立「排除目录」递归保护对外公开资料文件夹（伴随栏最多 6 层祖先链自动回溯）；默认每 **12 小时** 自动巡检并支持浏览器启动防重与未完成账号断点续检。

5. **IMPORTRANGE 多账号极速批授权与多邮箱全盘清退**
   - 支持 `A列来源表 -> B列目标表` 多账号轮询极速批量放行 `IMPORTRANGE`、授权前自动暂停汇总表公式防卡顿，以及多邮箱全盘移除权限并导出 CSV 回执。

## 目录结构

- `manifest.json`：Manifest V3 扩展配置、Drive + Sheets OAuth 权限声明与 Side Panel 配置（`v1.2.2`）。
- `core.js`：底层治理引擎（全量配置导入导出、Google 群组智能授权与姓名备注通讯录、第三方 OAuth 主动拦截、排除目录递归推导、断点续检与 IMPORTRANGE 极速批授权）。
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
