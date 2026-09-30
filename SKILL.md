---
name: douyin-batch-download
description: 抖音按博主主页批量下载全部作品。CDP 接管用户已登录的 Chrome，绕过 a_bogus 签名风控，捕获作品列表 API 并下载视频/图集；也可用随附的 Chrome 插件免终端操作。触发词：下载抖音、抖音博主、批量下载抖音、抖音主页视频、douyin download。
version: 2.0.1
---

# 抖音博主作品批量下载（CDP 接管已登录 Chrome）

## 适用场景

用户给出抖音博主主页链接（`douyin.com/user/MS4wLjABAAAA...`、`v.douyin.com` 短链或 App 分享文案），要求下载该博主的视频。

**硬前提**：
1. 用户已在 Chrome 登录抖音（必须，游客模式被风控挡死）
2. CLI 版还需：Chrome 已在 `chrome://inspect/#remote-debugging` 勾选 "Allow remote debugging for this browser instance"
3. 用户明确授权使用其浏览器登录态

## 为什么是这条路（2026-09-30 实测结论，勿走回头路）

| 路线 | 结果 |
|---|---|
| yt-dlp | `douyin.com/user/xxx` → Unsupported URL（只认单视频页）；单视频还要 Cookie |
| f2 / 第三方采集器游客模式 | `HTTP 200 + 空 body` → 抖音 JS 虚拟机反爬壳（`_$jsvmprt`），需 a_bogus 签名 |
| 读 Chrome Cookies 文件给第三方工具 | Chrome 137+ 锁死数据库，连共享读都复制不了；且有 ABE 加密 |
| **CDP 接管真实 Chrome / 页面内 hook** | ✅ 唯一可靠：签名由浏览器自己生成，登录态自带 |

## 两种形态

| 形态 | 位置 | 特点 |
|---|---|---|
| CLI | 仓库 `scripts/dy-dl.mjs` | CDP 接管 + Node 下载。**不走浏览器下载系统，不受下载管理器/浏览器设置干扰** |
| Chrome 插件 | 仓库 `extension/` | 免终端。但下载走 `chrome.downloads`，受 Chrome 下载设置与下载管理器扩展影响（见下节） |

## CLI 使用

```bash
node scripts/dy-dl.mjs "<主页链接|分享文案|短链|sec_uid>"   # 下载到 ~/Downloads/douyin_<昵称>
node scripts/dy-dl.mjs "<链接>" --resolve-only             # 只解析链接，自查 sec_uid
node scripts/dy-dl.mjs "<链接>" --max 5                    # 只试 5 条
node scripts/dy-dl.mjs "<链接>" --out "D:/某目录"           # 指定输出
node scripts/dy-dl.mjs "<链接>" --skip-gallery             # 跳过图集帖
node scripts/dy-dl.mjs "<链接>" --no-dl                    # 只采集清单不下载
```

输入支持四种形态，自动识别：完整主页 URL、`v.douyin.com` 短链、App 分享文案（整段粘贴即可）、sec_uid 本身。单条视频分享链接会被识别并拒绝（工具只做博主全量）。

## 插件形态：**不要用 `chrome.downloads`**（v2.0.0 结论）

**结论先行**：批量下载场景下 `chrome.downloads` 不可用。它的落盘行为受三层外部因素支配——
浏览器全局偏好（`download.prompt_for_download`）、下载管理器扩展、崩溃后的下载恢复队列——
插件无法从代码层控制。实测踩过的坑（2026-09-30，用户机器）：

- 即使 `prompt_for_download=false`（且 Chrome 三次自行回写偏好文件时都保持 false）、无任何注册表/云策略、
  代码传了 `saveAs:false`，下载**仍然逐个弹「另存为」**，且弹窗会丢掉 `filename` 里的子目录结构
- 强杀 Chrome 后，处于"未确认保存位置"状态的下载会被**恢复并重新弹窗**，取消一条弹下一条，
  表现为"明明已经修好了却还在弹"的幽灵弹窗
- 判断"下载是否正常"**不能用「字节数是否在涨」**：等待用户确认保存位置期间，Chrome 已经在往
  临时文件里灌数据（实测等待中单个临时文件涨到 113MB），所以任何"在传就算正常"的刹车逻辑都会误判，
  一条接一条触发出去。曾因此堆出 **101 个临时文件 / 12GB 垃圾**，浏览器 UI 卡死到弹窗无法取消，
  只能任务管理器强杀。

> 核心教训：**用「是否在传输」判断「是否被拦」是无效的——被拦时数据照样在传。**

### 正确做法：扩展页 + File System Access API 直接写盘

在扩展页（`chrome-extension://` 页面是安全上下文）里：

```js
const root = await showDirectoryPicker({ id: 'dy-dl', mode: 'readwrite' });  // 需用户手势，选一次
const dir  = await root.getDirectoryHandle('douyin_<昵称>', { create: true });
const fh   = await dir.getFileHandle(name, { create: true });
const w    = await fh.createWritable();      // 写临时文件，close() 才原子替换；abort() 自动丢弃
const resp = await fetch(cdnUrl, { credentials: 'omit' });
const reader = resp.body.getReader();
for (;;) { const { done, value } = await reader.read(); if (done) break; await w.write(value); }
await w.close();
```

要点：
- **目录句柄存 IndexedDB**（`chrome.storage` 存不了 `FileSystemHandle`）；Chrome 重启后
  `queryPermission()` 变 `prompt`，需要用户点一次按钮触发 `requestPermission()`（必须用户手势）
- 挑器必须在**扩展页/弹窗这类有用户手势的文档**里调用，Service Worker 里没有这个 API
- 跨域 fetch 依赖 `host_permissions`（`*.douyinvod.com` / `*.douyinpic.com` / `*.douyinstatic.com`）
- 重名文件用 `getFileHandle(name, {create:false})` 探测 + 跳过，天然解决重复下载
- 并发 2-3 个即可；`createWritable` 的原子替换意味着**中断不留残渣**，不需要事后清理

代价：下载页标签要保持打开；这是可接受的（换来的是零弹窗、零垃圾、可跳过已存在）。

### v1.x 遗留：这些坑仍会在别处遇到

1. Chrome **没有"第一次询问后记住"**这种机制，只有"询问"和"不询问"两态。
   想让用户"一次确定、全部下载"，靠 `saveAs:false` 是做不到的（见上）。
2. IDM / 迅雷 / NeatDownloadManager 扩展接管时，`chrome.downloads` 会记 `USER_CANCELED`。
   禁用状态可从 `Secure Preferences` 的 `extensions.settings.<id>.disable_reasons` 判断（`[1]` = 用户禁用）。
3. **History 的 `downloads` 表是最好的取证源**：`target_path`（空 = 保存位置未确认）、
   `current_path`（进行中时是临时文件名）、`by_ext_id` / `by_ext_name`（**发起扩展**）、
   `state`（1=完成 2=中断）、`interrupt_reason`（**40 = USER_CANCELED**、50 = CRASH）、
   `end_time`（`start→end` 可判断是"秒完成"还是"等人工点击"）。
   排查"弹窗是谁弹的"时，比对**弹窗里的文件名与 `target_path`**最快：
   插件建议的文件名带自己的前缀（如 `005_`），没有前缀的就是页面侧发起的下载。

### 已经卡死时的收尾

浏览器已被挂起任务拖死时，唯一出路是强杀 + 清场，仓库提供了现成脚本
`tools/emergency-fix.cmd`（先手动输入 y 确认）：
1. `taskkill /F /IM chrome.exe /T` 强杀全部进程
2. 关掉 `prompt_for_download`
3. 备份 `History`，再删其中 `downloads` 表 `state != 1` 的记录（未完成的挂起项，保留已完成历史）
   —— 不删的话，下次启动 Chrome 会**恢复这些未确认下载并重新弹窗**
4. `Downloads\*.tmp` 移入回收站（先报告体积，12GB 级要让用户知道）

**收尾脚本的两条硬约束（2026-09-30 实际踩过）：**

- **绝不依赖第三方库**。第一版用 `send2trash` 移回收站，而用户双击时用的是系统解释器、
  里面没装这个包 → 第 4 步整步空转，13GB 一个没清，脚本却照样打印"全部完成"（误报，
  比报错更糟）。回收站改用 `ctypes.windll.shell32.SHFileOperationW` + `FOF_ALLOWUNDO`
  自己实现，要点三条：
  * `pFrom` 必须是 `\0` 分隔、并以 `\0\0` 结尾的**绝对路径**串
  * `SHFILEOPSTRUCTW.fFlags` 是 `WORD`，字段必须声明为 `c_uint16`；写成 `c_uint` 会
    让 64 位下结构体对齐错位，返回码/行为全乱
  * 返回码非 0 或 `fAnyOperationsAborted` 为真都算失败，要能降级（逐个重试），
    并**复核文件是否真的不在了**再报成功
- **脚本不能空转**：先探测解释器（managed > 常规安装路径 > `where python`），
  找不到就明确报错退出，别让窗口一闪而过。

**⚠️「移入回收站」不等于"可还原"**：回收站有按卷的容量配额（默认约为卷容量的 5%）。
实测：13GB 的 `.tmp` 被清后，回收站里**根本没有它们**（回收站总占用仅 0.5GB），
即超配额的文件被**直接永久删除**。所以：
- 不要对用户承诺"可随时还原"，除非体积明显小于配额
- 真要保底，先 `shutil.move` 到同盘的 `_trash_<日期>` 目录，确认无误再让用户自己删

**第 4 步报"没有 .tmp 中间文件"时先别怀疑脚本**：`Downloads` 可能已被其他途径清掉
（用户手动删、Chrome 自行清理临时文件）。用"回收站里有没有、总体积对不对"来反推
是移入回收站还是被永久删除。

### Windows 批处理的行尾（易漏）

`.cmd` / `.bat` **必须是 CRLF 行尾**。用工具写出来的文件默认 LF，`cmd.exe` 在
LF-only + 多行 `if (...)` 块下会解析异常，表现为脚本行为诡异或直接不执行。
写完务必转 CRLF 并复核，仓库已用 `.gitattributes` 固化（`*.cmd text eol=crlf`）。
另外中文提示不要放进 `.cmd`（代码页问题），全部交给 Python 输出。

## 步骤与坑（每条都实测踩过）

1. **CDP 握手挂起（TCP 通但 0 字节无响应）= Chrome 在等用户点「要允许远程调试吗？」弹窗**。解决：把 Chrome 窗口切到前台（`SetForegroundWindow`），弹窗出现后点「允许」。授权会过期，隔一段时间重连要重新点；点完可能仍需 Chrome 在前台才能完成握手。
2. **本机若设了 `http_proxy`**：curl 访问 localhost 一律加 `--noproxy '*'`；Node fetch/原生 WebSocket 不受该变量影响，可直接用。
3. **Chrome 136+ 关闭了 `/json/*` HTTP 端点**（返回 404），不能 `curl /json/list` 发现 target；必须读 `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort` 拿端口+browser 级 wsPath，然后 `Target.createTarget` 自建 tab。
4. **bash 会话回收会带走后台子进程**：用 `&` 把脚本挂后台再退出调用，进程会随会话死掉且不留报错。长任务必须在前台单次调用内完成。
5. **屏幕点击弹窗时的坐标换算**：ffmpeg gdigrab 截图是物理像素（如 1920x1080）；非 DPI 感知进程的 SetCursorPos 用逻辑坐标（/1.25）；Read 工具显示截图会缩放到 1080 宽。三套坐标别混。
6. **`duration_ms=0` 的作品是图集帖**：`play_addr` 是 BGM（m4a 纯音频），图片在 `images[]`。脚本已自动区分 video/gallery。图集判定用 `images[]` 字段，`aweme_type` 不可靠（实测有 type=68 的图集）。
7. CDN 链接带签名时效，过期后 403/404 → 重新跑采集即可（清单文件 `_list.json` 会重写）。CDN 直链**无需 Referer/Cookie**，但候选域名里部分会 403，必须逐个探测。
8. **滚动必须滚 `.route-scroll-container` 容器**，不是 window。
   ❌ `window.scrollBy(0,1000)` → 只能采到首屏 36 条，还会误判为"到底"，报出错误的"全量"数字。
   ✅ `document.querySelector('.route-scroll-container').scrollTop = scrollHeight` + 1.7s 等待；每页 18 条，连续 15 轮无新增视为到底。修复后 274 条全量成功（140 视频 + 134 图集，`has_more=0`）。
   插件侧的 `content.js` 同样要滚这个容器。
9. CDP 新开的后台标签页视口可能只有 263px 高，滚不动 → 先设窗口尺寸再滚。
10. CLI 下载用 `Referer: https://www.douyin.com/` + Chrome UA，无需 Cookie；每条之间 sleep 600ms 限速。

## 合规提醒（必须告知用户）

- 批量抓取违反抖音用户协议，消耗账号风控额度，可能限流/封号；Cookie 即账号凭证，勿交给不可信的第三方工具。
- 下载内容的二次发布/商用涉及版权。
- 浏览器自动化有检测风险，大额度采集前先小批量试。

## 参考

- 仓库：`https://github.com/3441293738/douyin-batch-download`
- 本地克隆：`C:\Users\sj134\douyin-batch-download`（含 `tools/fix-chrome-download-prompt.cmd`）
- 站点经验：仓库 `references/douyin-notes.md`
