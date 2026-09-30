# Chrome 插件：抖音博主作品批量下载

在抖音博主主页点击插件图标，一键采集并下载该博主的全部作品（视频 + 图集）。

**已实测**：Chrome 153 / Windows 11，某 275 作品博主全量采集 274 条约 40 秒，单个 6MB 视频下载完成验证通过（2026-09-30）。

## 安装（开发者模式加载，无需上架商店）

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**
2. 点 **加载已解压的扩展程序**，选择本 `extension/` 目录
3. 打开任意抖音博主主页（`douyin.com/user/...`），点工具栏插件图标

> 注：通过 CDP `Extensions.loadUnpacked` 装入的实例已带在浏览器里（ID `fhmanpfhpj...`），无需重复加载。

## 使用

1. 进入博主主页 → 点插件图标 → **开始采集全部作品**（页面自动滚动，可关闭弹窗）
2. 采集完成后点 **下载全部视频**（或勾选"图集帖同时保存图片和音乐"）
3. 文件保存到 Chrome 下载目录下的 `douyin_<博主昵称>/`

## 使用前必须检查（否则批量下载会失败）

- **关闭"下载前询问每个文件的保存位置"**：`chrome://settings/downloads`。实测开启时即使 API 传了 `saveAs:false` 仍会每个文件弹另存为对话框（且对话框会丢掉子文件夹结构）。
- **暂停 IDM Integration Module / NeatDownloadManager 等下载管理器扩展**：它们会取消浏览器原生下载再自己接管（表现为 `chrome.downloads` 记录 `interrupted/USER_CANCELED`，文件落到下载管理器自己的目录、丢失子目录）。用完插件再启用即可。

## 工作原理

```
hook.js     (MAIN world, document_start)  挂钩 fetch/XHR，捕获 /aweme/v1/web/aweme/post/ 响应
    │  window.postMessage 跨世界传精简作品对象
    ▼
content.js  (ISOLATED)  汇总清单；自动滚动 .route-scroll-container 触发分页（每页 18 条）
    │  chrome.runtime 消息
    ▼
background.js (Service Worker)  逐个探测 CDN 直链（部分候选 403），调 downloads API 下载
```

- 签名由页面自己的 JS 生成，插件不构造任何签名请求、不接触 Cookie
- `window.scrollBy` 在抖音网页版无效，必须滚 `.route-scroll-container` 容器（实测踩坑）
- 图集帖判定用 `images[]` 字段（`aweme_type` 不可靠，实测有 type=68 的图集）
- CDN 直链无需 Referer/Cookie，但候选列表中部分域名 403，必须逐个探测

## 与 CLI 版的关系

同一仓库的 `scripts/dy-dl.mjs` 是等价的命令行版（走 CDP 接管 Chrome + Node 下载）。CLI 下载**不经过浏览器下载系统，不受 IDM 等干扰**；插件则免终端。二者采集逻辑一致。
