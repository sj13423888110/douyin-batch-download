---
name: douyin-batch-download
description: 抖音按博主主页批量下载全部作品。CDP 接管用户已登录的 Chrome，绕过 a_bogus 签名风控，捕获作品列表 API 并下载视频/图集。触发词：下载抖音、抖音博主、批量下载抖音、抖音主页视频、douyin download。
version: 1.1.0
---

# 抖音博主作品批量下载（CDP 接管已登录 Chrome）

## 适用场景

用户给出抖音博主主页链接（`douyin.com/user/MS4wLjABAAAA...`、`v.douyin.com` 短链或 App 分享文案），要求下载该博主的视频。

**硬前提**：
1. 用户已在 Chrome 登录抖音（必须，游客模式被风控挡死）
2. Chrome 已在 `chrome://inspect/#remote-debugging` 勾选 "Allow remote debugging for this browser instance"
3. 用户明确授权使用其浏览器登录态

## 为什么是这条路（2026-09-30 实测结论，勿走回头路）

| 路线 | 结果 |
|---|---|
| yt-dlp | `douyin.com/user/xxx` → Unsupported URL（只认单视频页）；单视频还要 Cookie |
| f2 / 第三方采集器游客模式 | `HTTP 200 + 空 body` → 抖音 JS 虚拟机反爬壳（`_$jsvmprt`），需 a_bogus 签名 |
| 读 Chrome Cookies 文件给第三方工具 | Chrome 137+ 锁死数据库，连共享读都复制不了；且有 ABE 加密 |
| **CDP 接管真实 Chrome** | ✅ 唯一可靠：签名由浏览器自己生成，登录态自带 |

## 使用

```bash
node scripts/dy-dl.mjs "<主页链接|分享文案|短链|sec_uid>"   # 下载到 ~/Downloads/douyin_<昵称>
node scripts/dy-dl.mjs "<链接>" --resolve-only             # 只解析链接，自查 sec_uid
node scripts/dy-dl.mjs "<链接>" --max 5                    # 只试 5 条
node scripts/dy-dl.mjs "<链接>" --out "D:/某目录"           # 指定输出
node scripts/dy-dl.mjs "<链接>" --skip-gallery             # 跳过图集帖
node scripts/dy-dl.mjs "<链接>" --no-dl                    # 只采集清单不下载
```

输入支持四种形态，自动识别：完整主页 URL、`v.douyin.com` 短链、App 分享文案（整段粘贴即可）、sec_uid 本身。单条视频分享链接会被识别并拒绝（工具只做博主全量）。

## 步骤与坑（每条都实测踩过）

1. **CDP 握手挂起（TCP 通但 0 字节无响应）= Chrome 在等用户点「要允许远程调试吗？」弹窗**。解决：把 Chrome 窗口切到前台（`SetForegroundWindow`），弹窗出现后点「允许」。授权会过期，隔一段时间重连要重新点；点完可能仍需 Chrome 在前台才能完成握手。
2. **本机若设了 `http_proxy`**：curl 访问 localhost 一律加 `--noproxy '*'`；Node fetch/原生 WebSocket 不受该变量影响，可直接用。
3. **Chrome 136+ 关闭了 `/json/*` HTTP 端点**（返回 404），不能 `curl /json/list` 发现 target；必须读 `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort` 拿端口+browser 级 wsPath，然后 `Target.createTarget` 自建 tab。
4. **bash 会话回收会带走后台子进程**：用 `&` 把脚本挂后台再退出调用，进程会随会话死掉且不留报错。长任务必须在前台单次调用内完成。
5. **屏幕点击弹窗时的坐标换算**：ffmpeg gdigrab 截图是物理像素（如 1920x1080）；非 DPI 感知进程的 SetCursorPos 用逻辑坐标（/1.25）；Read 工具显示截图会缩放到 1080 宽。三套坐标别混。
6. **`duration_ms=0` 的作品是图集帖**：`play_addr` 是 BGM（m4a 纯音频），图片在 `images[]`。脚本已自动区分 video/gallery。
7. CDN 链接带签名时效，过期后 403/404 → 重新跑采集即可（清单文件 `_list.json` 会重写）。
8. 滚动加载：每页 18 条，`window.scrollBy(0,1000)` + 1.7s 等待；连续 15 轮无新增视为到底。
9. 下载用 `Referer: https://www.douyin.com/` + Chrome UA，无需 Cookie；每条之间 sleep 600ms 限速。

## 合规提醒（必须告知用户）

- 批量抓取违反抖音用户协议，消耗账号风控额度，可能限流/封号；Cookie 即账号凭证，勿交给不可信的第三方工具。
- 下载内容的二次发布/商用涉及版权。
- 浏览器自动化有检测风险，大额度采集前先小批量试。

## 参考

- 站点经验：`references/douyin-notes.md`
