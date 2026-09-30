---
name: douyin-batch-download
description: 抖音按博主主页批量下载全部作品。CDP 接管用户已登录的 Chrome，绕过 a_bogus 签名风控，捕获作品列表 API 并下载视频/图集；也可用随附的 Chrome 插件免终端操作。触发词：下载抖音、抖音博主、批量下载抖音、抖音主页视频、douyin download。
version: 1.3.0
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

## 插件形态：两个 Chrome 层面的硬约束

插件下载依赖 `chrome.downloads`，有两个**用代码解决不了**的坑，必须让用户改浏览器侧配置：

1. **`saveAs:false` 压不住"下载前询问每个文件的保存位置"**
   这是 Chrome 的**用户级偏好** `download.prompt_for_download`，优先级高于扩展 API。开着时每个文件都弹另存为对话框，且对话框会丢掉 `filename` 里的子目录结构。
   判定方式：读 `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Preferences` 里的 `download.prompt_for_download`。旁证是同一文件里 `savefile.default_directory` 会变成插件建议的子目录路径。
   修复（Chrome 必须**完全退出**，否则退出时会被内存覆盖）：

   ```python
   import json, os, shutil
   p = os.path.join(os.environ['LOCALAPPDATA'], 'Google/Chrome/User Data/Default/Preferences')
   shutil.copy2(p, p + '.bak')            # 先备份
   d = json.load(open(p, encoding='utf-8'))
   d.setdefault('download', {})['prompt_for_download'] = False
   json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False)
   ```

   多 Profile 要遍历 `Default` 与 `Profile *`。仓库提供了现成脚本 `tools/fix-chrome-download-prompt.cmd`（会自己等 Chrome 退出）。

2. **IDM / 迅雷 / NeatDownloadManager 等下载管理器扩展会接管下载**
   表现为 `chrome.downloads` 记录 `interrupted` + `USER_CANCELED`，文件落到下载管理器自己的目录、丢子目录。让用户临时停用这些扩展。

3. **⚠️ 雪崩陷阱：`chrome.downloads.download()` 在被询问时「立即返回」**
   这是 2026-09-30 实际闯祸的设计缺陷，务必守住：
   当 `prompt_for_download=true` 时，`download()` **不等用户确认就 resolve 一个 id**。
   如果像这样逐条 await：

   ```js
   for (const it of list) {
     await chrome.downloads.download({ url, saveAs: false });   // ← 立刻返回，不阻塞
     await sleep(600);
   }
   ```

   就会以 600ms/个 的速度把**整个清单全部触发出去**。274 个作品 = 274 个挂起下载
   + 274 个另存为对话框，Chrome UI 被拖死（用户描述"像中病毒一样，无法取消暂停，
   只能在任务管理器结束任务"），`Downloads` 里堆出 500MB+ 的 UUID 命名 `.tmp` 残渣。

   **正确做法**：每触发一个就核验它**是否真的在传数据**，第一个被拦就中止：
   ```js
   // paused 连续 4 次 或 10 秒内 bytesReceived 无增长 → blocked
   // 首个轮询就看到 bytesReceived 增长 → started（放行，不拖慢）
   // detail 命中 USER_CANCELED → 立即停（下载管理器接管）
   ```
   容忍度必须设成 **1**（不是 3）：环境不对时多触发两个就是多两个对话框。

**Chrome 没有"第一次询问后记住"这种机制**，只有"询问"和"不询问"两态。用户说"希望一次确定、全部下载"，唯一落点是把偏好切成不询问。

### 已经卡死时的收尾

浏览器已被挂起任务拖死时，唯一出路是强杀 + 清场，仓库提供了现成脚本
`tools/emergency-fix.cmd`（先手动输入 y 确认）：
1. `taskkill /F /IM chrome.exe /T` 强杀全部进程
2. 关掉 `prompt_for_download`
3. 删 `History` 库里 `downloads` 表 `state != 1` 的记录（未完成的挂起项，保留已完成历史）
4. `Downloads\*.tmp` 移入回收站

Chrome 不会自动重试这些挂起下载，所以强杀后不删记录也不会再产生垃圾，但删掉更清爽。

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
