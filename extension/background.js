// Service Worker：接收作品清单，探测可用 CDN 直链后调用 downloads API 下载
let busy = false;

// 连续异常达到阈值就中止，避免在设置/环境不对时白跑几百个文件、留下一地残渣
const MAX_BLOCKED = 3;      // 一直停在暂停态：多半是「下载前询问保存位置」开着
const MAX_INTERRUPTED = 3;  // 被取消：多半是 IDM / 迅雷等下载管理器把下载接管走了

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
//   started     已在传输中（正常，立即返回）
//   blocked     长时间停在暂停态 —— 判定被弹窗 / 下载管理器拦住
//   interrupted 被取消或报错
// 关键：saveAs:false 压不住 Chrome 的全局偏好
// 「下载前询问每个文件的保存位置」(chrome://settings/downloads)，
// 那种情况下载会挂着不走，只能靠 blocked 识别出来。
async function dl(url, filename) {
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (e) {
    return { state: 'interrupted', detail: String((e && e.message) || e) };
  }
  if (typeof id !== 'number' || id <= 0) return { state: 'interrupted', detail: '未取得下载 ID' };

  const deadline = Date.now() + 6000;
  let sawPaused = false;
  while (Date.now() < deadline) {
    let it = null;
    try { [it] = await chrome.downloads.search({ id }); } catch (e) { break; }
    if (!it) return { state: 'started' };
    if (it.state === 'complete') return { state: 'complete' };
    if (it.state === 'interrupted') return { state: 'interrupted', detail: it.error || 'INTERRUPTED' };
    if (it.state === 'in_progress' && !it.paused) return { state: 'started' };
    if (it.paused) sawPaused = true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return sawPaused ? { state: 'blocked', detail: '长时间暂停' } : { state: 'started' };
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
        abortReason = '连续 ' + blockedRun + ' 个下载一直停在暂停状态。'
          + '基本可以确定是浏览器开着「下载前询问每个文件的保存位置」，或被 IDM / 迅雷等下载管理器接管了。';
      }
    } else {
      blockedRun = 0; interRun++;
      if (interRun >= MAX_INTERRUPTED) {
        abortReason = '连续 ' + interRun + ' 个下载被取消（' + (r.detail || '未知原因') + '）。'
          + '通常是 IDM / 迅雷等下载管理器扩展接管了下载。';
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
