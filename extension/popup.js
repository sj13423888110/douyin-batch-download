const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let tabId = null;

function say(t) { statusEl.textContent = t; }

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(www\.)?douyin\.com/.test(tab.url || '')) {
    showWarn('请先在当前标签页打开抖音博主主页（douyin.com/user/...），再点击本插件。');
    setButtons({ count: 0 });
    say('未检测到抖音页面。');
    return;
  }
  tabId = tab.id;
  let info = null;
  try {
    info = await chrome.tabs.sendMessage(tabId, { type: 'getPageInfo' });
  } catch (e) { info = null; }

  if (!info || !info.hookAlive) {
    showWarn('检测到抖音页面，但采集钩子未注入。若插件是刚安装/刚启用的，请刷新（F5）博主主页后重试。');
    setButtons({ count: 0 });
    return;
  }
  if (!info.isUserProfile) {
    showWarn('当前不是博主主页。请先进入某个博主的主页（地址形如 douyin.com/user/MS4wLjAB...）。');
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
  if (res.collecting) say('正在自动滚动采集，可关闭此窗口，完成后回来下载。');
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
  const r = await chrome.runtime.sendMessage({ type: 'download', items: res.items, includeGallery, nickname: res.nickname }).catch((e) => null);
  if (!r || !r.ok) { say('下载启动失败：' + ((r && r.error) || '未知错误')); return; }
  say('已开始下载 ' + r.total + ' 个作品 → 下载到「下载」目录 douyin_<博主名>/。可关闭此窗口。');
}

$('dlVideo').addEventListener('click', () => download(false));
$('dlAll').addEventListener('click', () => download(true));

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'progress') { $('count').textContent = m.count; render(m); }
  if (m.type === 'done') { $('count').textContent = m.count; if (m.nickname) $('nickname').textContent = '博主：' + m.nickname; setButtons({ count: m.count }); say('采集完成：' + m.count + ' 条。'); }
  if (m.type === 'dlprogress') say('下载进度 ' + m.done + '/' + m.total + '（成功 ' + m.ok + ' / 失败 ' + m.fail + '）');
  if (m.type === 'dlabort') say('已中止（进行到 ' + m.done + '/' + m.total + '，成功 ' + m.ok + ' / 失败 ' + m.fail + '）：' + m.reason);
  if (m.type === 'dlend') say('下载结束：成功 ' + m.ok + ' / 失败 ' + m.fail + '，共 ' + m.total + ' 个作品。文件在「下载」目录。');
});

init();
