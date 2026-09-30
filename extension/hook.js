// MAIN world 注入（document_start）：挂钩 fetch/XHR，捕获作品列表接口
// 支持双平台：抖音 / 快手
// 签名由页面自己的代码生成，这里只读取响应，不构造任何签名请求。
//
// 快手实测（2026-09-30）：
//   列表接口是 POST /rest/v/profile/feed?__NS_hxfalcon=...（XHR），
//   页面加载史上首屏到全部翻页都走它，没有 graphql（performance API 核实）。
//   网上大量资料说的 /graphql + visionProfilePhotoList 是旧版行为，别照抄。
(() => {
  if (window.__batchDlHook) return;

  const host = location.hostname;
  const PLATFORM = host.includes('kuaishou') ? 'kuaishou' : 'douyin';

  const store = new Map();          // 作品 id -> 精简后的作品对象
  let nickname = '';
  const API = PLATFORM === 'kuaishou'
    ? /\/rest\/v\/profile\/feed/
    : /\/aweme\/v1\/web\/aweme\/post\//;

  const pick = (list) => Array.isArray(list) ? list.filter(Boolean) : [];

  // ---- 字段映射（平台差异全部收敛在这里） ----

  // 抖音：aweme_list，create_time 秒，直链在 video.play_addr.url_list
  const compactDy = (it) => {
    if (!nickname && it.author && it.author.nickname) nickname = it.author.nickname;
    const gallery = (Array.isArray(it.images) && it.images.length > 0) || !it.video?.duration;
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

  // 快手：feeds[]，timestamp 毫秒（统一转秒），直链在 photo.photoUrls[].url
  //   两个 URL 是同一文件的不同 CDN 签名实例，作为候选交给下载器逐个尝试。
  //   图集样本未见过（列表实测全部 type=1），photoUrls 为空的作品直接跳过不采集。
  const compactKs = (feed) => {
    const p = feed.photo || {};
    if (!nickname && feed.author && feed.author.name) nickname = feed.author.name;
    const urls = pick((p.photoUrls || []).map((u) => u && u.url)).filter(Boolean);
    if (!p.id || !urls.length) return null;
    return {
      aweme_id: p.id,
      type: 'video',
      desc: (p.caption || '').trim(),
      create_time: p.timestamp ? Math.round(p.timestamp / 1000) : 0,
      duration_ms: p.duration || 0,
      play_urls: urls,
      image_urls: [],
      music_urls: [],
    };
  };

  const add = (d) => {
    let fresh = [];
    if (PLATFORM === 'kuaishou') {
      for (const feed of (d.feeds || [])) {
        const c = compactKs(feed);
        if (!c || store.has(c.aweme_id)) continue;
        store.set(c.aweme_id, c);
        fresh.push(c);
      }
    } else {
      for (const it of (d.aweme_list || [])) {
        if (!it.aweme_id || store.has(it.aweme_id)) continue;
        const c = compactDy(it);
        store.set(it.aweme_id, c);
        fresh.push(c);
      }
    }
    if (fresh.length) {
      // 跨隔离世界通知 content.js
      window.postMessage({ source: '__batchDlHook', type: 'items', platform: PLATFORM, nickname, items: fresh }, '*');
    }
  };

  // ---- 拦截 fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (API.test(u)) res.clone().json().then(add).catch(() => {});
    } catch (e) { /* 忽略 */ }
    return res;
  };

  // ---- 拦截 XHR（快手实测走 XHR；抖音 axios 时兜底） ----
  const OrigXHR = window.XMLHttpRequest;
  function HookedXHR() {
    const x = new OrigXHR();
    const origOpen = x.open;
    x.open = function (m, u, ...rest) { x.__batchUrl = u; return origOpen.call(this, m, u, ...rest); };
    x.addEventListener('load', () => {
      try {
        if (API.test(x.__batchUrl || '') && (x.responseType === '' || x.responseType === 'text')) {
          add(JSON.parse(x.responseText));
        }
      } catch (e) { /* 忽略 */ }
    });
    return x;
  }
  HookedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = HookedXHR;

  // 供页面控制台/测试脚本查询
  window.__batchDlHook = { platform: PLATFORM, count: () => store.size, dump: () => [...store.values()] };
})();
