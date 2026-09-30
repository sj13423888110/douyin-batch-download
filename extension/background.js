// Service Worker：接收作品清单，探测可用 CDN 直链后调用 downloads API 下载
let busy = false;

// 连续异常达到阈值就中止，避免在设置/环境不对时白跑几百个文件、留下一地残渣
// 2026-09-30 事故：旧版没有这层保护，prompt_for_download 开着时
// chrome.downloads.download() 会「立即返回」而不等用户确认，于是每 600ms 触发一个，
// 274 个作品 = 274 个挂起的下载 + 274 个另存为对话框，把 Chrome 直接拖死到只能强杀。
// 因此 blocked 的容忍度设为 1：环境不对就第一个停。
const MAX_BLOCKED = 1;      // 停在暂停态：基本等同「下载前询问保存位置」开着
const MAX_INTERRUPTED = 3;  // 被取消/失败：偶发网络问题，容忍几次
const CANCEL_REASONS = /USER_CANCEL|USER_CANCELED/i;  // 这个错误码专指环境问题，立刻停

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'download') {
    if (busy) { sendResponse({ ok: false, error: '已有下载任务在进行，请等它完成' }); return; }
    busy = true;
    const includeGallery = !!msg.includeGallery;
    const list = includeGallery ? msg.items : msg.items.filter((i) => i.type === 'video');
    sendResponse({ ok: true, total: list.length });
    processQueue(list, msg.nickname || '').catch(console.error).finally(() => { busy = false; });
    return;
  }

  if (msg.type === 'isBusy') { sendResponse({ busy }); return; }
});

// 探测：只要响应头合法就用这个 URL（body 立即取消，不占内存）
// 2026-09-30 实测：CDN 直链无需 Referer/Cookie；但候选列表中部分域名会 403，必须逐个探测
async function pickUrl(urls) {
  for (const u of urls || []) {
    try {
      const r = await fetch(u);
      const ct = r.headers.get('content-type') || '';
      const ok = r.ok && (ct.startsWith('video/') || ct.startsWith('audio/') || ct.startsWith('image/') || ct === 'application/octet-stream');
      if (r.body) { try { r.body.cancel(); } catch (e) { /* 忽略 */ } }
      if (ok) return u;
    } catch (e) { /* 换下一个候选 */ }
  }
  return null;
}

function seg(s, fallback) {
  const t = (s || fallback || 'no_desc').replace(/[\\/:*?"<>|#\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return t || 'no_desc';
}

// 发起下载并判断它「是否真的开始跑」：
//   complete    小文件已下完
//   started     数据已在传输（正常，放行）
//   blocked     10 秒内既没传数据也没报错 —— 判定被弹窗 / 下载管理器拦住
//   interrupted 被取消或报错
//
// 为什么不能只靠 saveAs:false：Chrome 的全局偏好
// 「下载前询问每个文件的保存位置」(chrome://settings/downloads) 优先级更高，
// 压不住。此时 download() 仍会「立即返回」一个 id，下载被挂成 paused 并弹出对话框，
// 所以必须逐个核验真实传输状态，否则会以 600ms/个 的速度把整个队列全触发出去。
async function dl(url, filename) {
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (e) {
    return { state: 'interrupted', detail: String((e && e.message) || e) };
  }
  if (typeof id !== 'number' || id <= 0) return { state: 'interrupted', detail: '未取得下载 ID' };

  const deadline = Date.now() + 10000;
  let prevBytes = 0, pausedTicks = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    let it = null;
    try { [it] = await chrome.downloads.search({ id }); } catch (e) { break; }
    if (!it) return { state: 'started' };
    if (it.state === 'complete') return { state: 'complete' };
    if (it.state === 'interrupted') return { state: 'interrupted', detail: it.error || 'INTERRUPTED' };

    // 信号一：被 Chrome 挂成暂停（等待另存为对话框时的典型表现）
    if (it.paused) {
      pausedTicks++;
      if (pausedTicks >= 4) return { state: 'blocked', detail: '下载被挂成暂停状态' };
      continue;
    }

    // 信号二：字节数在涨 = 真的在传，立即放行（不拖慢正常下载）
    const got = it.bytesReceived || 0;
    if (got > prevBytes) return { state: 'started' };
    prevBytes = got;
  }
  return { state: 'blocked', detail: '10 秒内没有开始传输' };
}

async function processQueue(list, nickname) {
  const dir = 'douyin_' + seg(nickname, 'download');
  let i = 0, okCount = 0, failCount = 0;
  let blockedRun = 0, interRun = 0, abortReason = '';

  // 逐次记录结果，连续异常到阈值就记下中止原因
  const track = (r) => {
    if (r.state === 'started' || r.state === 'complete') {
      blockedRun = 0; interRun = 0;
      return true;
    }
    if (r.state === 'blocked') {
      interRun = 0; blockedRun++;
      if (blockedRun >= MAX_BLOCKED) {
        abortReason = '第 ' + i + ' 个下载一直停在暂停状态（数据没在传）。'
          + '几乎可以确定是浏览器开着「下载前询问每个文件的保存位置」，或被 IDM / 迅雷等下载管理器接管了。'
          + '已立即停止，避免继续堆积挂起的下载任务。';
      }
    } else {
      blockedRun = 0; interRun++;
      if (CANCEL_REASONS.test(r.detail || '')) {
        abortReason = '下载被取消（' + r.detail + '），通常是 IDM / 迅雷等下载管理器扩展接管了下载。'
          + '已立即停止，避免继续堆积。';
      } else if (interRun >= MAX_INTERRUPTED) {
        abortReason = '连续 ' + interRun + ' 个下载失败（' + (r.detail || '未知原因') + '）。已停止任务。';
      }
    }
    return false;
  };

  for (const it of list) {
    if (abortReason) break;
    i++;
    const n = String(i).padStart(3, '0');
    const d = new Date((it.create_time || 0) * 1000).toISOString().slice(0, 10);
    const base = dir + '/' + n + '_' + d + '_' + seg(it.desc);

    if (it.type === 'video') {
      const u = await pickUrl(it.play_urls);
      const r = await dl(u || it.play_urls[0], base + '.mp4');
      track(r) ? okCount++ : failCount++;
    } else {
      // 图集：图片逐张直下（douyinpic 无需探测），音乐同
      let any = false;
      const imgs = it.image_urls || [];
      for (let k = 0; k < imgs.length && !abortReason; k++) {
        const r = await dl(imgs[k], base + '/img_' + String(k + 1).padStart(2, '0') + '.jpg');
        if (track(r)) any = true;
        await new Promise((res) => setTimeout(res, 250));
      }
      if (!abortReason && it.music_urls && it.music_urls[0]) {
        const r = await dl(it.music_urls[0], base + '/bgm.mp3');
        if (track(r)) any = true;
      }
      any ? okCount++ : failCount++;
    }

    chrome.runtime.sendMessage({ type: 'dlprogress', done: i, total: list.length, ok: okCount, fail: failCount }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600)); // 轻微限速
  }

  if (abortReason) {
    chrome.runtime.sendMessage({
      type: 'dlabort', reason: abortReason, done: i, total: list.length, ok: okCount, fail: failCount,
    }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({ type: 'dlend', total: list.length, ok: okCount, fail: failCount }).catch(() => {});
  }
}
