// ISOLATED world：桥接 MAIN world 钩子，执行自动滚动，响应 popup 查询
// 双平台：抖音 .route-scroll-container / 快手 .wb-content（滚动方式不同，见 scrollStep）
(() => {
  const PLATFORM = location.hostname.includes('kuaishou') ? 'kuaishou' : 'douyin';
  const items = new Map();   // 作品 id -> 精简作品对象
  let nickname = '';
  let collecting = false;
  let timer = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== '__batchDlHook' || d.type !== 'items') return;
    if (d.nickname) nickname = d.nickname;
    for (const it of d.items || []) items.set(it.aweme_id, it);
    chrome.runtime.sendMessage({ type: 'count', count: items.size, nickname, platform: d.platform || PLATFORM }).catch(() => {});
  });

  // 滚动方式是两个平台最大的行为差异，都是实测踩出来的：
  // - 抖音：滚动发生在 .route-scroll-container，window.scrollBy 无效；
  //   一步 scrollTop=scrollHeight 可靠触发分页。
  // - 快手（2026-09-30 实测）：容器是 .wb-content（页面唯一 overflow:auto）。
  //   ⚠️ 一步把 scrollTop 跳到底【不触发分页】，且继续滚动会触发"切换到推荐页"
  //   的手势（整页跳去 /new-reco）。正确做法：小步 +500px，并派发 WheelEvent
  //   （页面监听 wheel 而非 scroll）。所以这里不能用 setInterval 里一次到底的写法，
  //   采集间隔也要放宽到 2.5s 给接口响应留时间。
  function scrollStep() {
    if (PLATFORM === 'kuaishou') {
      const c = document.querySelector('.wb-content');
      if (c) {
        c.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true }));
        c.scrollTop = Math.min(c.scrollTop + 500, c.scrollHeight);
      }
      return;
    }
    const c = document.querySelector('.route-scroll-container');
    if (c) c.scrollTop = c.scrollHeight;
    window.scrollBy(0, 1200); // 兜底
  }

  function startCollect() {
    if (collecting) return;
    collecting = true;
    let last = -1;
    let stagnant = 0;
    const stepMs = PLATFORM === 'kuaishou' ? 2500 : 2000;
    const maxStagnant = PLATFORM === 'kuaishou' ? 10 : 8;
    timer = setInterval(() => {
      // 实测（2026-09-30）：标签页在后台时 Chrome 冻结渲染管线，
      // IntersectionObserver 不触发 → 滚了也翻不了页，还会把停滞计数
      // 耗尽导致提前误判"采集完成"。后台时只回报暂停状态，不计停滞。
      if (document.hidden) {
        chrome.runtime.sendMessage({ type: 'progress', count: items.size, nickname, platform: PLATFORM, collecting: true, paused: true }).catch(() => {});
        return;
      }
      scrollStep();
      setTimeout(() => {
        const n = items.size;
        stagnant = n === last ? stagnant + 1 : 0;
        last = n;
        if (stagnant >= maxStagnant) {
          clearInterval(timer);
          timer = null;
          collecting = false;
          chrome.runtime.sendMessage({ type: 'done', count: n, nickname, platform: PLATFORM }).catch(() => {});
        } else {
          chrome.runtime.sendMessage({ type: 'progress', count: n, nickname, platform: PLATFORM, collecting: true }).catch(() => {});
        }
      }, stepMs - 400);
    }, stepMs);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'getItems') {
      sendResponse({ count: items.size, nickname, platform: PLATFORM, collecting, items: [...items.values()] });
      return;
    }
    if (msg.type === 'startCollect') {
      startCollect();
      sendResponse({ ok: true, collecting });
      return;
    }
    if (msg.type === 'getPageInfo') {
      const el = document.querySelector(PLATFORM === 'kuaishou' ? '.wb-content' : '.route-scroll-container');
      sendResponse({
        hookAlive: !!window.__batchDlHook,
        platform: PLATFORM,
        url: location.href,
        isUserProfile: PLATFORM === 'kuaishou'
          ? /^\/profile\//.test(location.pathname)
          : /^\/user\//.test(location.pathname),
        containerFound: !!el,
      });
      return;
    }
  });
})();
