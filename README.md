# douyin-batch-download

抖音按博主主页批量下载全部作品。

不逆向签名算法、不碰 Cookie 文件——通过 Chrome DevTools Protocol（CDP）接管你**已经登录抖音的真实 Chrome**，让浏览器自己生成签名、自带登录态，绕开抖音的 `a_bogus` 风控。整个流程一个 Node 脚本完成，无第三方依赖。

## 它解决什么问题

想批量下载某个博主的作品时，常规工具几乎都会卡在抖音的风控上：

| 常见路线 | 实测结果 |
|---|---|
| yt-dlp | 主页 URL 直接 `Unsupported URL`（只支持单视频页） |
| 各类采集器游客模式 | 接口返回 `HTTP 200 + 空响应体`（反爬壳要求 a_bogus 签名） |
| 导出浏览器 Cookie 喂给工具 | Chrome 137+ 锁死 Cookie 数据库 + 应用绑定加密，取不出来 |
| **本工具（CDP 接管）** | **可行：签名由真实浏览器生成，登录态自带** |

以上均为 2026-09-30 在 Chrome 153 / Windows 11 上实测的结论。

## 前提条件

1. **Node.js ≥ 18**（仅 CLI 需要；插件零依赖，装好即用）
2. **Windows + Chrome**（其他平台未验证）
3. Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 **"Allow remote debugging for this browser instance"**（仅 CLI 需要；插件不需要）
4. 在这个 Chrome 里**登录抖音**
5. **重要（插件批量下载）**：到 `chrome://settings/downloads` 关闭 **"下载前询问每个文件的保存位置"**，并暂停 IDM / NeatDownloadManager 等下载管理器扩展——否则每个文件都会弹另存为对话框、或被下载管理器接管取消（`USER_CANCELED`）

## 使用

```bash
# 最常用：直接粘贴 App 分享文案（含 v.douyin.com 短链）也可以
node scripts/dy-dl.mjs "长按复制此条消息，打开抖音搜索… https://v.douyin.com/xxxx/"

# 主页链接
node scripts/dy-dl.mjs "https://www.douyin.com/user/MS4wLjABAAAA..."

# 全部选项
node scripts/dy-dl.mjs "<链接>" \
  --out "D:/videos" \        # 输出目录（默认 ~/Downloads/douyin_<博主昵称>）
  --max 50 \                 # 最多下 50 条（默认全部）
  --skip-gallery \           # 跳过图集帖
  --no-dl \                  # 只采集清单，不下载
  --resolve-only             # 只解析链接打印 sec_uid，用于自查
```

## 输出

```
~/Downloads/douyin_Sunflower🌻/
├── _list.json                    # 完整清单（id/文案/日期/时长/各清晰度直链）
├── 001_2026-09-29_没有捷径….mp4
├── 002_2026-09-28_时间不会回头….mp4
└── 005_2026-09-26_根基/          # 图集帖 = 一个文件夹
    ├── img_01.jpg
    ├── img_02.jpg
    └── bgm.mp3
```

命名规则：`序号_发布日期_文案前40字`。重复运行会跳过已存在的文件（断点续传）。

## 工作原理

```
你的 Chrome（已登录抖音，远程调试已开启）
        │  ws://127.0.0.1:<port>/devtools/browser/<uuid>
        ▼
本脚本（Node，CDP 客户端）
  1. Target.createTarget 开后台标签页 → douyin.com/user/<sec_uid>
  2. Network.responseReceived 监听 /aweme/v1/web/aweme/post/ 接口
  3. Runtime.evaluate 执行 window.scrollBy 滚动触发分页（每页 18 条）
  4. Network.getResponseBody 取回每页作品 JSON
  5. 从 video.play_addr.url_list 拿 CDN 直链，带 Referer 直接下载
```

签名由 Chrome 自己生成，脚本全程不接触 `a_bogus`；下载 CDN 直链不需要 Cookie。

## 实测参考值

- 采集：36 条约 40 秒（滚动加载），275 条全量约 5-8 分钟
- 下载：约 2-3 秒/条（720p，6MB 左右）
- 一位 275 作品的博主全量约 1-1.5GB

## 已知边界

- **短链接解析**：支持 `v.douyin.com` 短链与 App 分享文案；单条视频分享会被识别并拒绝（本工具只做博主全量）
- **CDN 链接有时效**：`_list.json` 里的直链过期会 403，重新跑一次采集即可
- **图集帖识别**：`duration_ms=0` 的作品是图集帖，其 `play_addr` 是背景音乐而非视频
- **风控授权会过期**：隔一段时间再连，Chrome 会重新弹确认框
- **每页 18 条**：滚动触发分页，页面加载完需等待约 9 秒

## 合规与风险声明

- 批量抓取**违反抖音用户协议**，消耗账号风控额度，可能被限流或封号。用自己登录的账号跑，风险自担。
- 下载的内容版权归原作者；二次发布、商用需获得授权。
- 本工具不破解任何加密、不逆向签名算法，只是自动化操作你自己的浏览器。但请注意平台对自动化操作的检测。
- 请勿将本工具用于侵犯他人隐私或权益的场景。

## License

[MIT](LICENSE)
