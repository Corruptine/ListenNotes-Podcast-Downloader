async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function $(sel) { return document.querySelector(sel); }
const els = {
  btnScan: $('#btn-scan'),
  btnDownload: $('#btn-download'),
  btnReset: $('#btn-reset'),
  info: $('#info'),
  progress: $('#progress'),
  list: $('#list'),
  count: $('#count'),

  defaultDir: $('#defaultDir'),
};

let lastEpisodes = [];

function renderList(episodes) {
  els.list.innerHTML = '';
  for (const ep of episodes) {
    const li = document.createElement('li');
    const title = ep.title || ep.episodeId;
    // 在扫描阶段，我们只有详情页的链接（episodeId），没有最终的audioUrl
    li.innerHTML = `
      <div class="item">
        <div class="title" title="${title}">${title}</div>
        <a href="${ep.episodeId}" target="_blank">episode page</a>
      </div>
    `;
    els.list.appendChild(li);
  }
  els.count.textContent = String(episodes.length);
}

function setInfo(msg) { els.info.textContent = msg; }

async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
  } catch (e) {
    // ignore injection errors
  }
}

async function scan() {
  try {
    const tab = await getActiveTab();
    if (!tab || !/^https?:\/\/(www\.)?listennotes\.com\//.test(tab.url || '')) {
      setInfo('请在 ListenNotes 的播客详情页上使用');
      return { ok: false };
    }

    await ensureContent(tab.id);

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_SCAN' });
    } catch (e) {
      if (/Receiving end does not exist/i.test(e?.message || '')) {
        await ensureContent(tab.id);
        await new Promise(r => setTimeout(r, 200));
        res = await chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_SCAN' });
      } else {
        throw e;
      }
    }

    if (!res || !res.ok) {
      throw new Error(res.error || '内容脚本未响应或执行失败');
    }
    
    lastEpisodes = res.episodes || [];
    renderList(lastEpisodes);
    setInfo(`扫描完成，找到 ${lastEpisodes.length} 条播客。`);
    return { ok: true, episodes: lastEpisodes };
  } catch (e) {
    console.error('扫描失败:', e);
    setInfo(`扫描失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function queueDownloads(episodes) {
  console.log(`[Popup] 开始下载，剧集数量: ${episodes?.length || 0}`);
  console.log(`[Popup] 剧集数据:`, episodes);
  
  try {
    console.log(`[Popup] 发送 BG_QUEUE_DOWNLOADS 消息到 background.js...`);
    const res = await chrome.runtime.sendMessage({ type: 'BG_QUEUE_DOWNLOADS', episodes });
    console.log(`[Popup] 收到 background.js 响应:`, res);
    
    if (!res) {
      console.error(`[Popup] background.js 未返回响应`);
      throw new Error('后台脚本未响应');
    }
    
    if (!res.ok) {
      console.error(`[Popup] background.js 返回错误:`, res);
      throw new Error(res.error || '后台队列失败');
    }
    
    console.log(`[Popup] 下载队列已创建: 直接下载 ${res.direct} 个，需要点击 MORE ${res.needMore} 个`);
    await refreshStatus();
  } catch (e) {
    console.error(`[Popup] queueDownloads 出错:`, e);
    console.error(`[Popup] 错误堆栈:`, e.stack);
    throw e;
  }
}

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BG_STATUS' });
    if (!res || !res.ok) return;
    const s = res.status;
    const parts = [];
    parts.push(`队列中: ${s.inQueue}`);
    parts.push(`正在处理: ${s.active > 0 ? '是' : '否'}`);
    parts.push(`解析中: ${s.counts.resolving} 下载中: ${s.counts.downloading} 已提交: ${s.counts.queued_in_downloads} 失败: ${s.counts.error}`);
    els.progress.textContent = parts.join(' ｜ ');
    if (s.defaultDir) {
      els.defaultDir.textContent = s.defaultDir;
    }
  } catch {}
}

async function initDefaultDirGuess() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BG_GUESS_DEFAULT_DIR' });
    if (res?.ok && res.defaultDir) {
      els.defaultDir.textContent = res.defaultDir;
    }
  } catch {}
}

function setupListeners() {
  els.btnScan.addEventListener('click', async () => {
    setInfo('扫描中，请稍候...');
    const r = await scan();
    if (r.ok && r.episodes?.length) {
      lastEpisodes = r.episodes;
      setInfo(`扫描完成，共找到 ${r.episodes.length} 条。`);
    }
  });

  els.btnDownload.addEventListener('click', async () => {
    console.log(`[Popup] 点击"下载"按钮`);
    try {
      if (!lastEpisodes || lastEpisodes.length === 0) {
        setInfo('请先扫描页面，再点击下载。');
        return;
      }

      console.log(`[Popup] 准备下载，剧集数量: ${lastEpisodes.length}`);
      setInfo(`正在将 ${lastEpisodes.length} 条播客提交到后台处理...`);
      await queueDownloads(lastEpisodes);
      console.log(`[Popup] queueDownloads 完成`);

    } catch (e) {
      console.error(`[Popup] 下载流程出错:`, e);
      console.error(`[Popup] 错误堆栈:`, e.stack);
      setInfo(`❌ 下载失败: ${e.message || '未知错误'}`);
    }
  });

  els.btnReset.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'BG_RESET' });
    lastEpisodes = [];
    renderList(lastEpisodes);
    els.progress.textContent = '';
    setInfo('已重置');
  });



  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'BG_PROGRESS' || msg.type === 'BG_DOWNLOAD_COMPLETE') {
      refreshStatus();
    }
  });
}

setupListeners();
initDefaultDirGuess();
refreshStatus();