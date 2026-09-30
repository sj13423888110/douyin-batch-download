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
3. 会新开一个**下载页**：第一次点「选择保存文件夹」选个目录（例如「下载」），之后点「开始下载」
4. 文件写入 `<所选目录>/douyin_<博主昵称>/`

## v2.0.0：改为直接写盘，彻底不再有「另存为」弹窗

**为什么改**：v1.x 走 `chrome.downloads`。这个 API 的落盘行为受三层外部因素支配——浏览器全局偏好、下载管理器扩展、崩溃后的下载恢复队列。实测在某台机器上即使 `prompt_for_download=false` 且传了 `saveAs:false`，仍会**逐个弹「另存为」**；更糟的是等待确认期间 Chrome 已在往临时文件灌数据，所以"字节在涨就放行"的刹车逻辑会误判成正常下载，于是一条接一条往外触发，最终堆出 **101 个临时文件、12GB 垃圾**、浏览器 UI 卡死到无法取消弹窗、只能强杀。

**现在**：`background.js` 只负责把清单交给新开的下载页，实际下载由 `downloader.js` 用 **File System Access API** 完成：

| | v1.x（chrome.downloads） | v2.0.0（File System Access） |
|---|---|---|
| 弹「另存为」 | 受浏览器偏好影响，可能每个文件都弹 | **不会**，选一次文件夹即可 |
| 临时垃圾 | 崩溃/取消后残留 `.tmp` | 用 `createWritable` 写临时文件，`close()` 才原子替换；取消自动丢弃 |
| 重名文件 | `uniquify` 生成 `(1)`、`(2)` 副本 | 已存在同名文件**自动跳过** |
| 进度 | 只能在下载气泡里看 | 页面里有进度条、速度、成功/跳过/失败计数、实时日志 |
| 下载管理器劫持 | IDM/NDM 会取消原生下载（`USER_CANCELED`） | 不经过下载系统，**不受影响** |

代价：下载期间那个下载页标签**要保持打开**（关掉即中断），首次使用需点一次「选择保存文件夹」（浏览器重启后可能要再点一次"授权上次的文件夹"）。

### 历史教训（保留备查）

v1.1.x 加了"第一个被拦就中止"的刹车，但刹车依赖「字节数是否增长」判断，而 Chrome 在**等待用户确认保存位置时会持续把数据写进临时文件** —— 判据不成立，刹车形同虚设。**教训：用"是否在传输"判断"是否被拦"是无效的，因为被拦时数据照样在传。** 正确做法是绕开这套系统。

> 浏览器已被拖死时，用根目录 `tools/emergency-fix.cmd` 一键收尾（强杀 Chrome → 关询问设置 → 清未完成下载记录（先备份 History）→ 临时文件移入回收站）。

## 工作原理

```
hook.js        (MAIN world, document_start)  挂钩 fetch/XHR，捕获 /aweme/v1/web/aweme/post/ 响应
    │  window.postMessage 跨世界传精简作品对象
    ▼
content.js     (ISOLATED)  汇总清单；自动滚动 .route-scroll-container 触发分页（每页 18 条）
    │  chrome.runtime 消息
    ▼
background.js  (Service Worker)  把清单写进 chrome.storage.local，新开下载页
    ▼
downloader.html/js  (扩展页)  showDirectoryPicker 选一次目录 -> fetch 各 CDN 直链
                              -> createWritable 流式写盘（带进度/速度/跳过已存在）
```

- 签名由页面自己的 JS 生成，插件不构造任何签名请求、不接触 Cookie
- `window.scrollBy` 在抖音网页版无效，必须滚 `.route-scroll-container` 容器（实测踩坑）
- 图集帖判定用 `images[]` 字段（`aweme_type` 不可靠，实测有 type=68 的图集）
- CDN 直链无需 Referer/Cookie，但候选列表中部分域名 403，必须逐个探测
- 目录句柄存在 IndexedDB（`chrome.storage` 存不了 FileSystemHandle）

## 与 CLI 版的关系

同一仓库的 `scripts/dy-dl.mjs` 是等价的命令行版（走 CDP 接管 Chrome + Node 下载）。CLI 下载**不经过浏览器下载系统，不受 IDM 等干扰**；插件则免终端。二者采集逻辑一致。
