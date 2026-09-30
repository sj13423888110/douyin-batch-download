const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let tabId = null;

function say(t) { statusEl.textContent = t; }

const PLATFORMS = {
  douyin: {
    re: /^https:\/\/(www\.)?douyin\.com/,
    homeHint: 'douyin.com/user/...',
    label: '抖音',
  },
  kuaishou: {
    re: /^https:\/\/(www\.)?kuaishou\.com/,
    homeHint: 'kuaishou.com/profile/...',
    label: '快手',
  },
};

function detectPlatform(url) {
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (p.re.test(url || '')) return key;
  }
  return null;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pf = detectPlatform(tab && tab.url);
  if (!pf) {
    showWarn('请先在当前标签页打开抖音博主主页（douyin.com/user/...）或快手博主主页（kuaishou.com/profile/...），再点击本插件。');
    setButtons({ count: 0 });
    say('未检测到支持的页面。');
    return;
  }
  tabId = tab.id;
  let info = null;
  try {
    info = await chrome.tabs.sendMessage(tabId, { type: 'getPageInfo' });
  } catch (e) { info = null; }

  if (!info || !info.hookAlive) {
    showWarn('检测到' + PLATFORMS[pf].label + '页面，但采集钩子未注入。若插件是刚安装/刚启用的，请刷新（F5）博主主页后重试。');
    setButtons({ count: 0 });
    return;
  }
  if (!info.isUserProfile) {
    showWarn('当前不是博主主页。请先进入某个博主的主页（地址形如 ' + PLATFORMS[info.platform || pf].homeHint + '）。');
  }

  const res = await chrome.tabs.sendMessage(tabId, { type: 'getItems' }).catch(() => null);
  if (res) render(res);
  say(info.containerFound ? '已连接页面。' : '未找到滚动容器，采集可能不完整。');
}

function showWarn(t) { $('warn').textContent = t; $('warn').classList.remove('hidden'); }

function render(res) {
  $('count').textContent = res.count;
  $('nickname').textContent = res.nickname ? '博主：' + res.nickname : '';
  setButtons(res);
  if (res.collecting) say(res.paused ? '页面切到了后台，采集已自动暂停 —— 切回主页标签会自动继续。' : '正在自动滚动采集，期间请保持主页标签在前台。');
}

function setButtons(res) {
  const has = res.count > 0;
  $('dlVideo').disabled = !has;
  $('dlAll').disabled = !has;
  $('collect').disabled = !!res.collecting;
  $('collect').textContent = res.collecting ? '采集中…（可关闭窗口）' : '开始采集全部作品（自动滚动）';
}

$('collect').addEventListener('click', async () => {
  if (!tabId) return;
  $('collect').disabled = true;
  $('collect').textContent = '采集中…（可关闭窗口）';
  say('自动滚动中：页面会自己往下滚，直到没有新作品。');
  const r = await chrome.tabs.sendMessage(tabId, { type: 'startCollect' }).catch(() => null);
  if (!r || !r.ok) say('采集启动失败，请刷新页面后重试。');
});

async function download(includeGallery) {
  if (!tabId) return;
  const res = await chrome.tabs.sendMessage(tabId, { type: 'getItems' }).catch(() => null);
  if (!res || !res.count) { say('没有可下载的作品，请先采集。'); return; }
  const r = await chrome.runtime
    .sendMessage({
      type: 'openDownloader',
      items: res.items,
      includeGallery,
      nickname: res.nickname,
      platform: res.platform || detectPlatform((await chrome.tabs.get(tabId)).url),
    })
    .catch(() => null);
  if (!r || !r.ok) { say('打开下载页失败：' + ((r && r.error) || '未知错误')); return; }
  say('已新建下载页，共 ' + r.total + ' 个作品。请在新页面里选一次保存文件夹，然后点「开始下载」。');
  window.close();
}

$('dlVideo').addEventListener('click', () => download(false));
$('dlAll').addEventListener('click', () => download(true));

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'progress') { $('count').textContent = m.count; render(m); if (m.paused) say('页面切到了后台，采集已自动暂停 —— 切回主页标签会自动继续。'); }
  if (m.type === 'done') { $('count').textContent = m.count; if (m.nickname) $('nickname').textContent = '博主：' + m.nickname; setButtons({ count: m.count }); say('采集完成：' + m.count + ' 条。'); }
  if (m.type === 'dyProgress') say('下载进度 ' + m.done + '/' + m.total + '（成功 ' + m.ok + ' / 跳过 ' + m.skip + ' / 失败 ' + m.fail + '）');
});

init();
