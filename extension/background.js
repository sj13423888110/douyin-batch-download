// Service Worker：接收作品清单，探测可用 CDN 直链后调用 downloads API 下载
let busy = false;

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

async function processQueue(list, nickname) {
  const dir = 'douyin_' + seg(nickname, 'download');
  let i = 0, okCount = 0, failCount = 0;

  for (const it of list) {
    i++;
    const n = String(i).padStart(3, '0');
    const d = new Date((it.create_time || 0) * 1000).toISOString().slice(0, 10);
    const base = dir + '/' + n + '_' + d + '_' + seg(it.desc);

    let attempts = 0;
    const dl = async (url, filename) => {
      attempts++;
      try {
        // saveAs:false 必须显式传——用户若开了"下载前询问保存位置"，不传会每个文件都弹另存为对话框
        const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
        return typeof id === 'number' && id > 0;
      } catch (e) { return false; }
    };

    if (it.type === 'video') {
      const u = await pickUrl(it.play_urls);
      const done = await dl(u || it.play_urls[0], base + '.mp4');
      done ? okCount++ : failCount++;
    } else {
      // 图集：图片逐张直下（douyinpic 无需探测），音乐同
      let any = false;
      const imgs = it.image_urls || [];
      for (let k = 0; k < imgs.length; k++) {
        const ok = await dl(imgs[k], base + '/img_' + String(k + 1).padStart(2, '0') + '.jpg');
        if (ok) any = true;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (it.music_urls && it.music_urls[0]) {
        const ok = await dl(it.music_urls[0], base + '/bgm.mp3');
        if (ok) any = true;
      }
      attempts > 0 ? (any ? okCount++ : failCount++) : failCount++;
    }

    chrome.runtime.sendMessage({ type: 'dlprogress', done: i, total: list.length, ok: okCount, fail: failCount }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600)); // 轻微限速
  }

  chrome.runtime.sendMessage({ type: 'dlend', total: list.length, ok: okCount, fail: failCount }).catch(() => {});
}
