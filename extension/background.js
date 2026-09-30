// Service Worker：只做「收清单 -> 落盘任务 -> 打开下载页」的搬运
//
// v2.0.0 起不再使用 chrome.downloads：
//   那套 API 的落盘行为受浏览器全局偏好、下载管理器扩展、下载恢复队列影响，
//   在部分机器上即使 prompt_for_download=false + saveAs:false 仍会逐个弹「另存为」，
//   且等待期间数据已在往临时文件里灌，导致刹车逻辑误判、雪崩式堆积（实测 12GB 残渣）。
//   改为在扩展页里用 File System Access API 直接写盘，彻底绕开浏览器下载系统。

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'openDownloader') return;

  const includeGallery = !!msg.includeGallery;
  const items = Array.isArray(msg.items) ? msg.items : [];
  const list = includeGallery ? items : items.filter((i) => i.type === 'video');

  chrome.storage.local
    .set({
      dyJob: {
        items: list,
        includeGallery,
        nickname: msg.nickname || '',
        ts: Date.now(),
      },
    })
    .then(() => chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') }))
    .then(() => sendResponse({ ok: true, total: list.length }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));

  return true; // 异步响应
});
