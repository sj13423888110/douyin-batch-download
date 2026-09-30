// 下载执行页：用 File System Access API 直接写盘，不经浏览器下载系统
// 依赖：chrome.storage.local.dyJob（由 background.js 写入）
'use strict';

const $ = (id) => document.getElementById(id);
const CONCURRENCY = 3;        // 同时下载数
const MIN_VALID_BYTES = 100000;
const DB_NAME = 'dy-fs';
const STORE = 'kv';
const HANDLE_KEY = 'rootDir';
const JOB_KEY = 'dyJob';

let job = null;               // { items, nickname, includeGallery }
let rootHandle = null;        // 用户选定的根目录
let authDir = null;           // 根目录下的 douyin_<博主名>
let running = false;
let cancelled = false;
const stats = { done: 0, ok: 0, skip: 0, fail: 0, bytes: 0 };

// ---------- 工具 ----------

const log = (text, cls = '') => {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function seg(s, fallback) {
  const t = (s || fallback || 'no_desc')
    .replace(/[\\/:*?"<>|#\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return t || 'no_desc';
}

// ---------- IndexedDB：持久化目录句柄（无法存进 chrome.storage） ----------

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function kvGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function kvSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---------- 目录 ----------

function refreshUI() {
  const has = !!authDir;
  $('start').disabled = !has || running || !job || !job.items.length;
  $('pick').textContent = has ? '更换文件夹' : '选择保存文件夹';
  $('dirName').textContent = has ? (rootHandle.name + ' / ' + authDir.name) : '尚未选择';
}

async function useRoot(handle) {
  rootHandle = handle;
  await kvSet(HANDLE_KEY, handle);
  const dirName = (job && job.platform === 'kuaishou' ? 'kuaishou_' : 'douyin_') + seg(job && job.nickname, 'download');
  authDir = await handle.getDirectoryHandle(dirName, { create: true });
  $('reuse').classList.add('hide');
  refreshUI();
  log('保存目录：' + handle.name + ' / ' + dirName, 'info');
}

async function pickDir() {
  if (!window.showDirectoryPicker) {
    log('当前浏览器不支持「文件系统访问」接口，请升级 Chrome。', 'fail');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'dy-dl', mode: 'readwrite' });
    await useRoot(handle);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    log('选择文件夹失败：' + ((e && e.message) || e), 'fail');
  }
}

async function restoreDir() {
  let handle = null;
  try { handle = await kvGet(HANDLE_KEY); } catch (e) { /* 忽略 */ }
  if (!handle) return;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') { await useRoot(handle); return; }
  // 需要用户手势才能重新授权
  $('reuse').classList.remove('hide');
  $('reuse').textContent = '授权上次的文件夹（' + handle.name + '）';
  log('上次使用的文件夹：' + handle.name + '（浏览器重启后需点一次授权）', 'info');
}

// ---------- 下载 ----------

async function exists(dir, name) {
  try {
    const fh = await dir.getFileHandle(name, { create: false });
    const f = await fh.getFile();
    return f.size >= MIN_VALID_BYTES;
  } catch (e) {
    return false;
  }
}

async function downloadTo(dir, name, url, state) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();       // 写入临时文件，close 时原子替换
  try {
    const resp = await fetch(url, { credentials: 'omit', signal: state.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    const okCt = /^(video|audio|image)\//.test(ct) || ct === 'application/octet-stream';
    if (!okCt) throw new Error('content-type ' + (ct || '未知'));
    const reader = resp.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (cancelled) throw new Error('已停止');
      await w.write(value);
      total += value.byteLength;
      stats.bytes += value.byteLength;
      tick();
    }
    if (total < MIN_VALID_BYTES) throw new Error('内容过小(' + total + ')');
    await w.close();
    return total;
  } catch (err) {
    try { await w.abort(); } catch (e) { /* 忽略 */ }
    throw err;
  }
}

// 逐个候选 URL 尝试，返回真实下载到的字节数
async function saveFile(dir, name, urls, state) {
  let lastErr = null;
  for (const u of urls || []) {
    if (!u) continue;
    try {
      return await downloadTo(dir, name, u, state);
    } catch (e) {
      lastErr = e;
      if (cancelled) throw e;
    }
  }
  throw lastErr || new Error('没有可用的直链');
}

let lastTick = 0;
let lastBytes = 0;
function tick() {
  const now = Date.now();
  if (now - lastTick < 400) return;
  const spd = (stats.bytes - lastBytes) / ((now - lastTick) / 1000);
  lastTick = now; lastBytes = stats.bytes;
  $('sBytes').textContent = mb(stats.bytes);
  $('sSpeed').textContent = spd > 0 ? mb(spd) + '/s' : '—';
}

function render() {
  $('sOk').textContent = stats.ok;
  $('sSkip').textContent = stats.skip;
  $('sFail').textContent = stats.fail;
  const total = job ? job.items.length : 0;
  $('sProg').textContent = stats.done + ' / ' + total;
  $('bar').style.width = total ? (stats.done / total * 100).toFixed(1) + '%' : '0';
  $('sBytes').textContent = mb(stats.bytes);
}

async function runOne(item, index) {
  const n = String(index + 1).padStart(3, '0');
  const d = new Date((item.create_time || 0) * 1000).toISOString().slice(0, 10);
  const base = n + '_' + d + '_' + seg(item.desc);

  if (item.type === 'gallery') {
    const sub = await authDir.getDirectoryHandle(base, { create: true });
    let got = 0;
    const imgs = item.image_urls || [];
    for (let k = 0; k < imgs.length; k++) {
      const name = 'img_' + String(k + 1).padStart(2, '0') + '.jpg';
      if (await exists(sub, name)) { stats.skip++; continue; }
      try {
        await saveFile(sub, name, [imgs[k]], { signal: null });
        got++;
      } catch (e) {
        log(n + ' 第 ' + (k + 1) + ' 张图失败：' + e.message, 'fail');
      }
    }
    const music = (item.music_urls || [])[0];
    if (music && !(await exists(sub, 'bgm.mp3'))) {
      try { await saveFile(sub, 'bgm.mp3', [music], { signal: null }); } catch (e) { /* 忽略 */ }
    }
    if (got) { stats.ok++; log(n + ' 图集已保存 ' + got + ' 张：' + base, 'ok'); }
    return;
  }

  const name = base + '.mp4';
  if (await exists(authDir, name)) {
    stats.skip++;
    log(n + ' 已存在，跳过：' + name, 'skip');
    return;
  }
  const bytes = await saveFile(authDir, name, item.play_urls, { signal: null });
  stats.ok++;
  log(n + ' 完成 ' + mb(bytes) + '：' + name, 'ok');
}

async function start() {
  if (running || !authDir || !job) return;
  running = true;
  cancelled = false;
  stats.done = stats.ok = stats.skip = stats.fail = stats.bytes = 0;
  lastTick = 0; lastBytes = 0;
  $('start').disabled = true;
  $('stop').classList.remove('hide');
  $('phase').textContent = '下载中…';
  render();
  log('=== 开始，共 ' + job.items.length + ' 个作品，并发 ' + CONCURRENCY + ' ===', 'info');

  const queue = job.items.map((it, i) => ({ it, i }));
  let cursor = 0;

  async function worker() {
    while (!cancelled) {
      const task = queue[cursor++];
      if (!task) return;
      try {
        await runOne(task.it, task.i);
      } catch (e) {
        stats.fail++;
        log(String(task.i + 1).padStart(3, '0') + ' 失败：' + ((e && e.message) || e), 'fail');
      } finally {
        stats.done++;
        render();
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  running = false;
  $('stop').classList.add('hide');
  $('start').disabled = false;
  $('phase').textContent = cancelled ? '已停止' : '已完成';
  render();
  log(
    (cancelled ? '=== 已停止。' : '=== 全部完成。') +
    ' 成功 ' + stats.ok + ' / 跳过 ' + stats.skip + ' / 失败 ' + stats.fail +
    '，共写入 ' + mb(stats.bytes),
    cancelled ? 'fail' : 'ok'
  );
}

// ---------- 启动 ----------

async function init() {
  const store = await chrome.storage.local.get(JOB_KEY);
  job = store[JOB_KEY];
  if (!job || !Array.isArray(job.items) || !job.items.length) {
    $('jobInfo').textContent = '没有待下载任务';
    log('没有待下载任务。请到抖音/快手博主主页打开插件，点「下载全部作品」。', 'fail');
    return;
  }
  $('jobInfo').textContent =
    '博主：' + (job.nickname || '(未知)') + '　作品：' + job.items.length + ' 个' +
    (job.includeGallery ? '（含图集）' : '（仅视频）');
  log('任务就绪：' + job.items.length + ' 个作品。', 'info');
  await restoreDir();
  refreshUI();
}

$('pick').addEventListener('click', pickDir);
$('reuse').addEventListener('click', async () => {
  try {
    const handle = await kvGet(HANDLE_KEY);
    if (!handle) return;
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') { await useRoot(handle); log('已授权。', 'ok'); }
    else log('未获授权，请改用「更换文件夹」。', 'fail');
  } catch (e) {
    log('授权失败：' + ((e && e.message) || e), 'fail');
  }
});
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => {
  cancelled = true;
  $('phase').textContent = '正在停止…';
});

init();
