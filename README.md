# douyin-batch-download

抖音 / 快手按博主主页批量下载全部作品。

不逆向签名算法、不碰 Cookie 文件——通过 Chrome DevTools Protocol（CDP）接管你**已经登录的真实 Chrome**，让浏览器自己生成签名、自带登录态，绕开抖音 `a_bogus`、快手 `__NS_hxfalcon` 等风控。整个流程一个 Node 脚本完成，无第三方依赖；Chrome 插件则完全不需要任何配置。

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
5. ~~到 `chrome://settings/downloads` 关闭「下载前询问每个文件的保存位置」~~ —— **v2.0.0 起插件已不需要**：下载改为 File System Access 直接写盘，完全绕开浏览器下载系统，不再有「另存为」弹窗、不再产生 `.tmp` 残渣、也不受 IDM/迅雷等下载管理器影响。只需在下载页里选一次保存文件夹。

## 浏览器下载系统相关的历史问题（v1.x，已不再影响）

v1.x 走 `chrome.downloads` API，它的落盘行为受浏览器全局偏好、下载管理器扩展、崩溃恢复队列三层外部因素支配。实测在某些配置下即使 `prompt_for_download=false` + `saveAs:false` 仍会逐个弹「另存为」，且等待确认期间数据已在写入临时文件，导致刹车逻辑误判、雪崩式堆积（实测 101 个临时文件 / 12GB 垃圾，浏览器卡死只能强杀）。

已被拖死时，用 `tools/emergency-fix.cmd` 一键收尾（强杀 Chrome → 关询问设置 → 清未完成下载记录（先备份 History）→ 临时文件移入回收站）。

`tools/fix-chrome-download-prompt.cmd` 是只改那一条浏览器偏好（关 Chrome 后双击、自动备份）的轻量脚本，仍可单独使用。

## 使用

> **CLI 目前仅支持抖音。** 快手走下面的插件（页面接口结构与抖音差异大，CLI 未适配）。

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

## Chrome 插件（抖音 + 快手，推荐）

`extension/` 目录是免配置的 Chrome 扩展（v2.1.0 起双平台）。

**第一步：把代码拿到本地**（新电脑 / 重装时）

```bash
git clone https://github.com/sj13423888110/douyin-batch-download.git
```

不想用 git 就在仓库页面点 **`Code` → `Download ZIP`** 再解压，得到同样的目录。

**第二步：加载扩展**（插件不上架商店，只能开发者模式加载）

`chrome://extensions` 开启开发者模式 → 加载已解压的扩展程序 → 选 `douyin-batch-download/extension`

**第三步：使用**

1. 打开博主主页（`douyin.com/user/...` 或 `kuaishou.com/profile/...`）→ 点插件图标 → 开始采集
2. 「下载全部视频」→ 下载页里选一次保存文件夹 → 直接写盘

工作方式与 CLI 相同——签名由页面自己生成，插件只读页面接口的响应；
下载不经浏览器下载系统（File System Access 直写），无弹窗、无 `.tmp` 残渣、
自动跳过已存在文件。详见 `extension/README.md`。

**快手实测参考值**（2026-09-30，一位 351 作品的博主全量）：采集约 2 分钟；
列表接口 `POST /rest/v/profile/feed`（页面自己带 `__NS_hxfalcon` 签名），
直链在 `photo.photoUrls[]`，302 调度后免 Cookie 下载。
注意：快手分页靠 IntersectionObserver，**标签页切到后台就停止翻页**——
采集期间保持主页标签在前台（插件已内置暂停保护，切回来会自动继续）。

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
- **快手插件仅视频**：图集类作品接口样本未见过，首版不处理；采集期间页面须在前台（IntersectionObserver 在后台标签被 Chrome 冻结）
- **CLI 不支持快手**：快手接口为页面内 XHR + 动态签名，CLI 的 CDP 直连方案未适配

## 合规与风险声明

- 批量抓取**违反抖音用户协议**，消耗账号风控额度，可能被限流或封号。用自己登录的账号跑，风险自担。
- 下载的内容版权归原作者；二次发布、商用需获得授权。
- 本工具不破解任何加密、不逆向签名算法，只是自动化操作你自己的浏览器。但请注意平台对自动化操作的检测。
- 请勿将本工具用于侵犯他人隐私或权益的场景。

## License

[MIT](LICENSE)
