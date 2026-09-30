// ISOLATED world：桥接 MAIN world 钩子，执行自动滚动，响应 popup 查询
(() => {
  const items = new Map();   // aweme_id -> 精简作品对象
  let nickname = '';
  let collecting = false;
  let timer = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== '__dyDownloadHook' || d.type !== 'items') return;
    if (d.nickname) nickname = d.nickname;
    for (const it of d.items || []) items.set(it.aweme_id, it);
    chrome.runtime.sendMessage({ type: 'count', count: items.size, nickname }).catch(() => {});
  });

  // 关键：抖音网页版的滚动发生在 .route-scroll-container 容器里，
  // window.scrollBy 无效（2026-09-30 实测，274 条全靠容器滚动触发分页）
  function scrollStep() {
    const c = document.querySelector('.route-scroll-container');
    if (c) c.scrollTop = c.scrollHeight;
    window.scrollBy(0, 1200); // 兜底
  }

  function startCollect() {
    if (collecting) return;
    collecting = true;
    let last = -1;
    let stagnant = 0;
    timer = setInterval(() => {
      scrollStep();
      setTimeout(() => {
        const n = items.size;
        stagnant = n === last ? stagnant + 1 : 0;
        last = n;
        if (stagnant >= 8) {
          clearInterval(timer);
          timer = null;
          collecting = false;
          chrome.runtime.sendMessage({ type: 'done', count: n, nickname }).catch(() => {});
        } else {
          chrome.runtime.sendMessage({ type: 'progress', count: n, nickname, collecting: true }).catch(() => {});
        }
      }, 1800);
    }, 2000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'getItems') {
      sendResponse({ count: items.size, nickname, collecting, items: [...items.values()] });
      return;
    }
    if (msg.type === 'startCollect') {
      startCollect();
      sendResponse({ ok: true, collecting });
      return;
    }
    if (msg.type === 'getPageInfo') {
      const el = document.querySelector('.route-scroll-container');
      sendResponse({
        hookAlive: !!window.__dyDownloadHook,
        url: location.href,
        isUserProfile: /^\/user\//.test(location.pathname),
        containerFound: !!el,
      });
      return;
    }
  });
})();
