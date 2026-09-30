---
domain: douyin.com
aliases: [抖音, douyin]
updated: 2026-09-30
---

## 平台特征

- 网页端在没有有效签名（a_bogus / X-Bogus）或登录 Cookie 时，接口会返回 **HTTP 200 + 空响应体**——不是 403，不是验证码页。只看到状态码会误判为正常，必须检查 body 长度。（2026-09-30 实测，f2 0.0.1.7 游客模式抓主页作品，连续 3 次 200 空体后抛 `APIRetryExhaustedError`）
- 服务端可达性与风控无关：`curl` 带普通 Chrome UA 访问 `https://www.douyin.com/user/{sec_uid}` 返回 200、约 72KB HTML，耗时 0.3s 内。页面能拿到 ≠ 数据接口能调用。（2026-09-30 实测）
- 真正访问主页 HTML 时返回的是 72914 字节的 `_$jsvmprt` JS 虚拟机反爬壳页面，必须执行混淆 JS 才有内容——静态解析 HTML 拿不到作品列表。（2026-09-30 实测）
- 用户主页 URL 形如 `https://www.douyin.com/user/{sec_uid}`，sec_uid 是 `MS4wLjABAAAA...` 形式的 base64 串；视频页 URL 是 `https://www.douyin.com/video/{数字ID}`。
- 主页里点开视频会变成 `?modal_id={数字ID}` 形式的 URL（弹窗），需要规范化成 `/video/{id}` 才是直链。

## 有效模式

- **采集博主全部作品（2026-09-30 全链路验证通过，两次独立复测）**：CDP 直连接管已登录 Chrome，创建后台 tab 导航 `douyin.com/user/{sec_uid}`，监听 `Network.responseReceived` 捕获 `/aweme/v1/web/aweme/post/` 响应体，`window.scrollBy` 滚动触发分页（每页 18 条）。签名由真实浏览器自己生成，登录态自带，无需处理 a_bogus。
- **视频直链下载**：`video.play_addr.url_list` 里的 CDN 链接可直接 curl 下载，带 `-e https://www.douyin.com/` + Chrome UA 即可，无需 Cookie，约 2s/条。
- 短链 `v.douyin.com/xxx` 用 curl -L（或 Node fetch redirect:follow）即可展开，桌面/移动 UA 都会 302 到 `iesdouyin.com/share/user/{sec_uid}`，从 Location 里抠 sec_uid。App 分享文案里直接正则提取 URL 再展开即可。
- 判断图集帖：`duration_ms=0` 或 `aweme_type ∈ [2,60] 且有 images[]` 字段。

## 已知陷阱

- **yt-dlp 只支持单视频 URL**：`DouyinIE._VALID_URL` 仅匹配 `douyin.com/video/[0-9]+`，用户主页与合集 URL 均报 `Unsupported URL`；且单视频也常报 `Fresh cookies (not necessarily logged in) are needed`。想要按博主批量，必须换专门的采集工具，不能指望 yt-dlp。（2026-09-30 实测）
- 带 UA 的 curl 能拿到主页 HTML，但从 HTML 里解析作品列表同样受签名限制，不要因为"页面拿到了"就认为可以静态抓取列表。（2026-09-30 实测：分享页与网页版均返回反爬壳页面）
- **`duration_ms=0` 的作品是图集帖**：其 `play_addr` 是背景音乐（下下来是 m4a 纯音频），真正的图片在 `images[]` 字段。按视频下载会得到错误产物。（2026-09-30 实测）
- 批量抓取会消耗账号风控额度，用自己账号的 Cookie 做大规模采集存在被限流/封禁的风险。
- 本机若设了 `http_proxy`，curl 访问 localhost 的 CDP/代理端口必须加 `--noproxy '*'`。（2026-09-30 实测）
