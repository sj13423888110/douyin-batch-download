// MAIN world 注入（document_start）：挂钩 fetch/XHR，捕获作品列表接口
// 签名由页面自己的代码生成，这里只读取响应，不构造任何签名请求。
(() => {
  if (window.__dyDownloadHook) return;

  const store = new Map();          // aweme_id -> 精简后的作品对象
  let nickname = '';
  const API = /\/aweme\/v1\/web\/aweme\/post\//;

  const pick = (list) => Array.isArray(list) ? list.filter(Boolean) : [];
  const isGallery = (it) => (Array.isArray(it.images) && it.images.length > 0) || !it.video?.duration;

  const compact = (it) => {
    if (!nickname && it.author && it.author.nickname) nickname = it.author.nickname;
    const gallery = isGallery(it);
    return {
      aweme_id: it.aweme_id,
      type: gallery ? 'gallery' : 'video',
      desc: (it.desc || '').trim(),
      create_time: it.create_time || 0,
      duration_ms: (it.video && it.video.duration) || 0,
      play_urls: gallery ? [] : pick(it.video && it.video.play_addr && it.video.play_addr.url_list),
      image_urls: gallery
        ? (it.images || []).map((im) => ((im.url_list || []).pop() || (im.url_list || [])[0])).filter(Boolean)
        : [],
      music_urls: gallery ? pick(it.music && it.music.play_url && it.music.play_url.url_list) : [],
    };
  };

  const add = (d) => {
    const fresh = [];
    for (const it of (d.aweme_list || [])) {
      if (!it.aweme_id || store.has(it.aweme_id)) continue;
      const c = compact(it);
      store.set(it.aweme_id, c);
      fresh.push(c);
    }
    if (fresh.length) {
      // 跨隔离世界通知 content.js
      window.postMessage({ source: '__dyDownloadHook', type: 'items', nickname, items: fresh }, '*');
    }
  };

  // ---- 拦截 fetch（2026-09-30 实测：抖音主页走 fetch，18 条/页） ----
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (API.test(u)) res.clone().json().then(add).catch(() => {});
    } catch (e) { /* 忽略 */ }
    return res;
  };

  // ---- 拦截 XHR（兜底，接口切换到 axios 时仍可用） ----
  const OrigXHR = window.XMLHttpRequest;
  function HookedXHR() {
    const x = new OrigXHR();
    const origOpen = x.open;
    x.open = function (m, u, ...rest) { x.__dyUrl = u; return origOpen.call(this, m, u, ...rest); };
    x.addEventListener('load', () => {
      try {
        if (API.test(x.__dyUrl || '') && (x.responseType === '' || x.responseType === 'text')) {
          add(JSON.parse(x.responseText));
        }
      } catch (e) { /* 忽略 */ }
    });
    return x;
  }
  HookedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = HookedXHR;

  // 供页面控制台/测试脚本查询
  window.__dyDownloadHook = { count: () => store.size, dump: () => [...store.values()] };
})();
