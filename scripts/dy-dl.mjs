// 抖音博主作品批量下载（CDP 接管已登录 Chrome）
//
// 用法：node dy-dl.mjs "<主页链接|分享文案|短链|sec_uid>" [选项]
//   --out DIR        输出目录（默认 ~/Downloads/douyin_<博主昵称>）
//   --max N          最多下载 N 条（默认 0 = 全部）
//   --skip-gallery   跳过图集帖
//   --no-dl          只采集清单，不下载
//   --resolve-only   只解析链接并打印 sec_uid，不碰浏览器（用于自查链接是否正确）
//
// 前提：
//   1. Chrome 已在 chrome://inspect/#remote-debugging 勾选
//      "Allow remote debugging for this browser instance"
//   2. 该 Chrome 已登录抖音
//   3. 连接时 Chrome 会弹「要允许远程调试吗？」——必须点「允许」，
//      并且 Chrome 窗口需处于前台才能完成握手
//
// 已验证环境：Chrome 153 / Node 22 / Windows 11 / 2026-09-30

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const target = argv[0];
if (!target || target === '-h' || target === '--help') {
  console.log(`用法: node dy-dl.mjs "<主页链接|分享文案|短链|sec_uid>" [--out DIR] [--max N] [--skip-gallery] [--no-dl]

示例:
  node dy-dl.mjs "https://www.douyin.com/user/MS4wLjABAAAA..."
  node dy-dl.mjs "长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/xxxx/"
  node dy-dl.mjs "MS4wLjABAAAA..." --max 20
  node dy-dl.mjs "<链接>" --out "D:/videos" --skip-gallery`);
  process.exit(target ? 0 : 1);
}
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const OUT_OPT = opt('--out', null);
const MAX = parseInt(opt('--max', '0'), 10) || Infinity;   // 0 = 全部
const SKIP_GALLERY = argv.includes('--skip-gallery');
const NO_DL = argv.includes('--no-dl');
const RESOLVE_ONLY = argv.includes('--resolve-only');

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|#\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// ---------- 1. 解析输入，拿到 sec_uid ----------
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const pickSecUid = (s) => {
  const m = String(s).match(/sec_uid=([A-Za-z0-9_-]+)/) || String(s).match(/\/user\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
};
const extractUrl = (text) => {
  const m = String(text).match(/https?:\/\/[^\s,，。、"'<>）)】\]]+/);
  return m ? m[0] : null;
};

async function resolveSecUid(input) {
  // a) 输入本身就是 sec_uid
  if (/^MS4wLjABAAAA[A-Za-z0-9_-]+$/.test(input)) return input;
  // b) 完整主页 URL 里直接抠
  const direct = pickSecUid(input);
  if (direct) return direct;
  // c) 从分享文案里提取 URL
  const url = extractUrl(input) || input;
  if (!/^https?:\/\//.test(url)) {
    throw new Error('无法识别输入。支持：主页链接 / 抖音分享文案 / v.douyin.com 短链 / sec_uid 本身');
  }
  // d) 短链 → 跟随跳转
  if (/v\.douyin\.com|iesdouyin\.com\/share/.test(url)) {
    console.log('展开短链:', url);
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA_MOBILE } });
    const s = pickSecUid(r.url);
    if (s) { console.log(`  → 定位到博主 ${s}（HTTP ${r.status}）`); return s; }
    const vid = r.url.match(/\/video\/(\d+)/);
    if (vid) throw new Error(`这是单条视频（ID ${vid[1]}），不是博主主页。本工具用于下载博主全部作品。`);
    throw new Error('短链展开后仍未找到 sec_uid：' + r.url);
  }
  throw new Error('无法从该链接提取 sec_uid：' + url);
}

let SEC;
try {
  SEC = await resolveSecUid(String(target).trim());
} catch (e) {
  console.error('错误：' + e.message);
  process.exit(1);
}
if (RESOLVE_ONLY) {
  console.log('sec_uid =', SEC);
  console.log('主页地址 =', `https://www.douyin.com/user/${SEC}`);
  process.exit(0);
}

// ---------- 2. 连接 Chrome（CDP） ----------
const DAP = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
if (!fs.existsSync(DAP)) {
  console.error('未找到 DevToolsActivePort —— Chrome 未开启远程调试。');
  console.error('请在 Chrome 地址栏打开 chrome://inspect/#remote-debugging 并勾选允许。');
  process.exit(1);
}
const [port, wsPath] = fs.readFileSync(DAP, 'utf8').trim().split(/\r?\n/);

let id = 0;
const pending = new Map();
const listeners = [];
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
const send = (method, params, sessionId) => new Promise((resolve, reject) => {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  pending.set(msg.id, { resolve, reject });
  ws.send(JSON.stringify(msg));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else if (m.method) { for (const fn of listeners) fn(m); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`连接 Chrome（端口 ${port}）...`);
console.log('若卡住：看 Chrome 是否弹出「要允许远程调试吗？」，需点「允许」，并把 Chrome 切到前台。');
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('CDP 握手超时 —— 见上方提示')), 30000);
  ws.onopen = () => { clearTimeout(t); res(); };
  ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); };
});
console.log('CDP 已连接');

const { targetId } = await send('Target.createTarget', { url: 'about:blank', background: false });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
// 前台窗口必须调到正常尺寸：过小的视口不触发懒加载（2026-09-30 实测 263px 视口时列表高度只有 450px）
const { windowId } = await send('Browser.getWindowForTarget', { targetId }).catch(() => ({ windowId: null }));
if (windowId) await send('Browser.setWindowBounds', { windowId, bounds: { width: 1440, height: 900, windowState: 'normal' } }).catch(() => {});

// ---------- 3. 采集作品列表 ----------
const newBodies = new Set();
let nickname = '';
listeners.push((m) => {
  if (m.sessionId !== sessionId || m.method !== 'Network.responseReceived') return;
  if (/\/aweme\/v1\/web\/aweme\/post\//.test(m.params.response.url)) newBodies.add(m.params.requestId);
});

await send('Page.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Page.navigate', { url: `https://www.douyin.com/user/${SEC}` }, sessionId);
await send('Page.bringToFront', {}, sessionId).catch(() => {});
console.log('已打开博主主页，等待加载...');
await sleep(9000);

const raw = new Map();
let hasMore = null;
async function drain() {
  const ids = [...newBodies]; newBodies.clear();
  for (const rid of ids) {
    try {
      const { body } = await send('Network.getResponseBody', { requestId: rid }, sessionId);
      const data = JSON.parse(body);
      for (const it of (data.aweme_list || [])) {
        if (!it.aweme_id) continue;
        if (!nickname && it.author?.nickname) nickname = it.author.nickname;
        raw.set(it.aweme_id, it);
      }
      hasMore = data.has_more;
      console.log(`  已捕获 ${raw.size} 条 (has_more=${data.has_more})`);
    } catch { /* 响应体可能已被回收，忽略 */ }
  }
}
await drain();

let stagnant = 0;
let prev = -1;
// 关键：抖音网页版的滚动发生在 .route-scroll-container 容器里，
// window.scrollBy(0,1000) 滚不动它——2026-09-30 实测，274 条全靠容器滚动触发分页
const SCROLL = '(() => { const c = document.querySelector(".route-scroll-container"); if (c) c.scrollTop = c.scrollHeight; window.scrollBy(0, 1000); return "ok"; })()';
while (raw.size < MAX) {
  await send('Runtime.evaluate', { expression: SCROLL }, sessionId).catch(() => {});
  await sleep(1700);
  await drain();
  stagnant = raw.size === prev ? stagnant + 1 : 0;
  prev = raw.size;
  if (stagnant > 15) { console.log('连续多轮无新增，停止滚动'); break; }
  if (hasMore === 0) { await drain(); if (hasMore === 0) { console.log('已到最后一页'); break; } }
}
await drain();
console.log(`采集完成：${raw.size} 条 (has_more=${hasMore})`);
await send('Target.closeTarget', { targetId }).catch(() => {});
ws.close();

// ---------- 4. 整理 ----------
const items = [...raw.values()].map((it) => {
  const isGallery = !it.video?.duration || (it.aweme_type >= 2 && it.aweme_type <= 60 && !!it.images);
  return {
    aweme_id: it.aweme_id,
    type: isGallery ? 'gallery' : 'video',
    desc: (it.desc || '').trim(),
    create_time: it.create_time,
    duration_ms: it.video?.duration || 0,
    play_urls: isGallery ? [] : (it.video?.play_addr?.url_list || []),
    image_urls: isGallery
      ? (it.images || []).map((im) => (im.url_list || []).pop() || (im.url_list || [])[0]).filter(Boolean)
      : [],
    music_urls: isGallery ? (it.music?.play_url?.url_list || []) : [],
  };
});

const OUTDIR = OUT_OPT || path.join(os.homedir(), 'Downloads', `douyin_${safeName(nickname) || SEC.slice(-8)}`);
fs.mkdirSync(OUTDIR, { recursive: true });
console.log(`博主：${nickname || '(未知)'}`);
fs.writeFileSync(
  path.join(OUTDIR, '_list.json'),
  JSON.stringify({ sec_uid: SEC, nickname, total: items.length, has_more: hasMore, items }, null, 1),
);
console.log('清单已写出:', path.join(OUTDIR, '_list.json'));
if (NO_DL) process.exit(0);

// ---------- 5. 下载 ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Referer': 'https://www.douyin.com/' };
const safe = (s) => (s || 'no_desc').replace(/[\\/:*?"<>|#\s]+/g, '_').slice(0, 40);

let i = 0;
let okCount = 0;
let failCount = 0;
for (const it of items) {
  i++;
  const n = String(i).padStart(3, '0');
  const d = new Date(it.create_time * 1000).toISOString().slice(0, 10);
  const base = `${n}_${d}_${safe(it.desc)}`;

  if (it.type === 'gallery') {
    if (SKIP_GALLERY) { console.log(`${n} 跳过图集`); continue; }
    const dir = path.join(OUTDIR, base);
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < it.image_urls.length; k++) {
      try {
        const r = await fetch(it.image_urls[k], { headers: HEADERS });
        if (r.ok) fs.writeFileSync(path.join(dir, `img_${String(k + 1).padStart(2, '0')}.jpg`), Buffer.from(await r.arrayBuffer()));
      } catch { /* 单张失败不中断 */ }
    }
    if (it.music_urls[0]) {
      try {
        const r = await fetch(it.music_urls[0], { headers: HEADERS });
        if (r.ok) fs.writeFileSync(path.join(dir, 'bgm.mp3'), Buffer.from(await r.arrayBuffer()));
      } catch { /* 忽略 */ }
    }
    console.log(`${n} 图集 ${it.image_urls.length} 图 已保存`);
    okCount++;
    continue;
  }

  const dest = path.join(OUTDIR, `${base}.mp4`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) { console.log(`${n} 已存在，跳过`); continue; }
  let ok = false;
  for (const u of it.play_urls) {
    try {
      const r = await fetch(u, { headers: HEADERS, redirect: 'follow' });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100000) continue;
      fs.writeFileSync(dest, buf);
      console.log(`${n} 已下载 ${(buf.length / 1048576).toFixed(1)}MB`);
      ok = true; okCount++; break;
    } catch { /* 换下一个 url 源 */ }
  }
  if (!ok) { console.log(`${n} 下载失败（CDN 链接可能过期，重新采集即可）`); failCount++; }
  await sleep(600); // 轻微限速
}
console.log(`全部完成 → ${OUTDIR}`);
console.log(`成功 ${okCount} / 失败 ${failCount} / 总计 ${items.length}`);
