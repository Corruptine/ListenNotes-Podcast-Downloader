// Service worker (MV3)
const state = {
  queue: [],
  active: 0,
  results: {}, // key(uuid||audioUrl) -> {status, error, downloadId, finalUrl, filename}
  startedAt: null,
  defaultDir: '', // 仅展示用途
  maxResultsSize: 1000, // 最多保留1000条记录
};

// 日志工具函数
function logError(tag, message, error) {
  console.error(`[${tag}] ${message}`, error);
}

function logWarn(tag, message) {
  console.warn(`[${tag}] ${message}`);
}

function sanitize(name) {
  const replaced = name
    .replace(/[\\/:*?"<>|]/g, ' ') // illegal on Windows
    .replace(/\s+/g, ' ')
    .trim();
  return replaced || 'untitled';
}

function dirname(absPath) {
  if (!absPath) return '';
  const p = absPath.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

function setDefaultDirFromFilename(filename) {
  const dir = dirname(filename);
  if (dir && dir !== state.defaultDir) {
    state.defaultDir = dir;
    try { 
      chrome.storage.local.set({ defaultDir: dir }); 
    } catch (e) {
      logError('SetDefaultDir', '保存默认目录失败', e);
    }
    try { 
      chrome.runtime.sendMessage({ type: 'BG_PROGRESS', state: getStatus() }); 
    } catch (e) {
      logWarn('SetDefaultDir', '发送进度消息失败: ' + e.message);
    }
  }
}

// 清理已完成的下载记录，防止内存泄漏
function cleanupResults() {
  const keys = Object.keys(state.results);
  if (keys.length > state.maxResultsSize) {
    // 按状态优先级删除：先删除 error，再删除 completed，最后删除其他
    const toDelete = [];
    const errorKeys = keys.filter(k => state.results[k]?.status === 'error');
    const completedKeys = keys.filter(k => state.results[k]?.status === 'complete');
    const otherKeys = keys.filter(k => !['error', 'complete'].includes(state.results[k]?.status));
    
    toDelete.push(...errorKeys.slice(0, Math.max(1, Math.floor(keys.length * 0.2))));
    if (toDelete.length < 100) {
      toDelete.push(...completedKeys.slice(0, 100 - toDelete.length));
    }
    if (toDelete.length < 100) {
      toDelete.push(...otherKeys.slice(0, 100 - toDelete.length));
    }
    
    toDelete.forEach(k => delete state.results[k]);
    console.log(`[Cleanup] 清理了 ${toDelete.length} 条过期记录，当前记录数: ${Object.keys(state.results).length}`);
  }
}

(async () => {
  try {
    const { defaultDir = '' } = await chrome.storage.local.get(['defaultDir']);
    state.defaultDir = defaultDir || '';
  } catch {}
})();

function getKey(ep) {
  // 使用 episodeId 作为最优先的唯一标识符
  return ep?.episodeId || ep?.uuid || ep?.audioUrl || Math.random().toString(36).slice(2);
}

// 添加超时机制的 fetch 包装
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveFinalUrl(audioPageUrl, depth = 0) {
  const maxDepth = 5; // 防止无限递归
  console.log(`[ResolveURL] 开始解析URL (深度${depth}): ${audioPageUrl}`);
  
  if (depth > maxDepth) {
    throw new Error(`递归深度超过限制 (${maxDepth})`);
  }
  
  try {
    // Quick path: if already a direct media file
    if (/\.(m4a|mp3|aac)(\?|$)/i.test(audioPageUrl)) {
      console.log(`[ResolveURL] URL已经是直接音频文件，直接返回`);
      return audioPageUrl;
    }

    // 如果是 audio.listennotes.com/e/p/ 格式的URL，尝试直接访问获取重定向
    if (/audio\.listennotes\.com\/e\/p\/[a-f0-9]{32}\/?/i.test(audioPageUrl)) {
      console.log(`[ResolveURL] 检测到 audio.listennotes.com/e/p/ 格式，尝试获取重定向`);
      try {
        console.log(`[ResolveURL] 尝试 HEAD 请求...`);
        const res = await fetchWithTimeout(audioPageUrl, { 
          method: 'HEAD', 
          credentials: 'omit', 
          redirect: 'follow' 
        }, 10000);
        console.log(`[ResolveURL] HEAD 响应状态: ${res.status}, 最终URL: ${res.url}`);
        if (res.url && /\.(m4a|mp3|aac)(\?|$)/i.test(res.url)) {
          console.log(`[ResolveURL] HEAD 成功获取音频URL: ${res.url}`);
          return res.url;
        }
        // 如果HEAD失败，尝试GET
        console.log(`[ResolveURL] HEAD 未获取到音频URL，尝试 GET 请求...`);
        const res2 = await fetchWithTimeout(audioPageUrl, { 
          method: 'GET', 
          credentials: 'omit', 
          redirect: 'follow' 
        }, 10000);
        console.log(`[ResolveURL] GET 响应状态: ${res2.status}, 最终URL: ${res2.url}`);
        if (res2.url && /\.(m4a|mp3|aac)(\?|$)/i.test(res2.url)) {
          console.log(`[ResolveURL] GET 成功获取音频URL: ${res2.url}`);
          return res2.url;
        }
      } catch (e) {
        logWarn('ResolveURL', `直接访问失败: ${e.message}，继续解析流程`);
      }
    }

    console.log(`[ResolveURL] 开始访问页面: ${audioPageUrl}`);
    const res = await fetchWithTimeout(audioPageUrl, { 
      credentials: 'omit', 
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, 15000);

    console.log(`[ResolveURL] 页面响应状态: ${res.status}, 最终URL: ${res.url}`);

    // If redirected to a direct media file, use the final URL immediately
    if (res.url && /\.(m4a|mp3|aac)(\?|$)/i.test(res.url)) {
      console.log(`[ResolveURL] 重定向到直接音频文件: ${res.url}`);
      return res.url;
    }

    console.log(`[ResolveURL] 开始解析页面内容...`);
    const text = await res.text();
    console.log(`[ResolveURL] 页面内容长度: ${text.length} 字符`);

    // 1) 页面中 data-audio 属性（ListenNotes 常用）
    const mDataAudio = text.match(/data-audio\s*=\s*["'](https?:[^"']+?)["']/i);
    if (mDataAudio && mDataAudio[1]) {
      console.log(`[ResolveURL] 找到 data-audio 属性: ${mDataAudio[1]}`);
      const u = mDataAudio[1];
      if (/audio\.listennotes\.com\/e\/p\//i.test(u)) {
        console.log(`[ResolveURL] data-audio 是 e/p 格式，递归解析...`);
        return await resolveFinalUrl(u, depth + 1);
      }
      if (/\.(m4a|mp3|aac)(\?|$)/i.test(u)) {
        console.log(`[ResolveURL] data-audio 是直接音频文件: ${u}`);
        return u;
      }
    }

    // 2) 页面出现 e/p 直链
    const mEp = text.match(/https?:\/\/audio\.listennotes\.com\/e\/p\/[a-f0-9]{32}\/?/i);
    if (mEp && mEp[0]) {
      console.log(`[ResolveURL] 找到 e/p 直链: ${mEp[0]}，递归解析...`);
      return await resolveFinalUrl(mEp[0], depth + 1);
    }

    // 3) 常规直接媒体地址
    console.log(`[ResolveURL] 尝试正则匹配音频文件URL...`);
    const patterns = [
      /src\s*=\s*["'](https?:[^"']+?\.(?:m4a|mp3|aac)(?:\?[^"']*)?)["']/i,
      /href\s*=\s*["'](https?:[^"']+?\.(?:m4a|mp3|aac)(?:\?[^"']*)?)["']/i,
      /(https?:\/\/[^"'\s>]+?\.(?:m4a|mp3|aac)(?:\?[^"'\s>]*)?)/i,
    ];
    for (let i = 0; i < patterns.length; i++) {
      const re = patterns[i];
      const m = text.match(re);
      if (m && (m[1] || m[0])) {
        const foundUrl = (m[1] || m[0]);
        console.log(`[ResolveURL] 模式 ${i + 1} 匹配到音频URL: ${foundUrl}`);
        return foundUrl;
      }
    }

    // 4) 嵌入 JSON
    const jsonUrl = text.match(/["']src["']\s*:\s*["'](https?:[^"]+?\.(?:m4a|mp3|aac)[^"]*)["']/i);
    if (jsonUrl && jsonUrl[1]) {
      console.log(`[ResolveURL] 找到 JSON 中的音频URL: ${jsonUrl[1]}`);
      return jsonUrl[1];
    }

    console.error(`[ResolveURL] 所有解析方法都失败，未能在页面中解析出音频直链`);
    throw new Error('未能在页面中解析出音频直链');
  } catch (e) {
    logError('ResolveURL', '解析过程出错', e);
    throw new Error(`解析失败: ${e.message}`);
  }
}

// 为函数添加超时控制
function withTimeout(asyncFn, timeoutMs) {
  return function(...args) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`操作超时（${timeoutMs / 1000}秒）`));
      }, timeoutMs);

      try {
        const result = await asyncFn(...args);
        clearTimeout(timer);
        resolve(result);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  };
}

// 串行处理单个剧集的完整流程
async function processOneEpisode(ep) {
  const key = getKey(ep);
  const titleBase = sanitize(`${ep.channelTitle || 'ListenNotes'} - ${ep.title || ep.episodeId}`);
  const pickExt = (u) => {
    const m = (u || '').match(/\.([a-z0-9]{2,4})(?=($|\?))/i);
    const ext = m ? m[1].toLowerCase() : 'm4a';
    return ['m4a', 'mp3', 'aac'].includes(ext) ? ext : 'm4a';
  };
  
  try {
    // 1. 从 content.js 获取中间链接
    state.results[key] = { status: 'getting_url' };
    console.log(`[ProcessOne] [${ep.title}] 步骤1: 获取中间链接...`);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) throw new Error('找不到活动标签页');
    const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'CONTENT_GET_URL', episodeId: ep.episodeId });
    if (!res || !res.ok) throw new Error(res.error || '从页面获取URL失败');
    const intermediateUrl = res.audioUrl;
    console.log(`[ProcessOne] [${ep.title}] 步骤1完成，已收到原始地址: ${intermediateUrl}`);
  
    // 2. 解析最终下载地址
    state.results[key] = { status: 'resolving' };
    console.log(`[ProcessOne] [${ep.title}] 步骤2: 解析最终链接...`);
    const finalUrl = await resolveFinalUrl(intermediateUrl);
    console.log(`[ProcessOne] [${ep.title}] 步骤2完成，成功解析出转换后的地址: ${finalUrl}`);

    // 3. 开始下载
    const filename = `${titleBase}.${pickExt(finalUrl)}`;
    state.results[key] = { status: 'downloading', finalUrl, filename };
    console.log(`[ProcessOne] [${ep.title}] 步骤3: 调用下载API，文件名: ${filename}`);
    const downloadId = await chrome.downloads.download({
      url: finalUrl,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });

    state.results[key] = { status: 'queued_in_downloads', downloadId, finalUrl, filename };
    console.log(`[ProcessOne] [${ep.title}] 下载已提交, ID: ${downloadId}`);
    cleanupResults();
    return { ok: true };

  } catch (error) {
    logError('ProcessOne', `[${ep.title}] 处理失败`, error);
    state.results[key] = { status: 'error', error: error.message };
    return { ok: false, error: error.message };
  }
}

// 严格串行处理下载队列
async function pumpQueue() {
  // 如果已经有任务在执行，则退出，防止并发
  if (state.active > 0) {
    return;
  }

  state.active = 1; // 标记开始处理

  while (state.queue.length > 0) {
    const ep = state.queue.shift();
    console.log(`[PumpQueue] 开始处理: ${ep.title} | 剩余: ${state.queue.length}`);
    
    // 使用60秒超时来处理单个剧集，并【等待】其完成
    const processWithTimeout = withTimeout(processOneEpisode, 60000);
    await processWithTimeout(ep).catch(error => {
      // 捕获超时或其他在 processOneEpisode 中发生的错误
      const key = getKey(ep);
      logError('PumpQueue', `[${ep.title}] 处理失败`, error);
      state.results[key] = { status: 'error', error: error.message };
    });

    // 发送进度更新
        try { 
          chrome.runtime.sendMessage({ type: 'BG_PROGRESS', state: getStatus() }); 
        } catch (e) {
          logWarn('PumpQueue', '发送进度消息失败: ' + e.message);
        }
  }
  
  state.active = 0; // 标记所有任务处理完毕
  console.log(`[PumpQueue] 队列处理完成`);
}

function getStatus() {
  // 改进状态计数准确性
  const counts = { resolving: 0, downloading: 0, queued_in_downloads: 0, error: 0, complete: 0, pending: 0 };
  for (const k in state.results) {
    const s = state.results[k]?.status;
    if (s && counts.hasOwnProperty(s)) counts[s] += 1;
  }
  
  // 总数 = 已处理的 + 队列中的 + 正在处理的
  const total = Object.keys(state.results).length + state.queue.length;
  
  return {
    total,
    inQueue: state.queue.length,
    active: state.active,

    counts,
    startedAt: state.startedAt,
    defaultDir: state.defaultDir,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log(`[Background] 收到消息:`, msg.type);
  if (!msg || !msg.type) return;



  if (msg.type === 'BG_QUEUE_DOWNLOADS') {
    console.log(`[BG_QUEUE] 收到下载请求，剧集数量: ${msg.episodes?.length || 0}`);
    const episodes = Array.isArray(msg.episodes) ? msg.episodes : [];
    const seen = new Set(Object.keys(state.results));
    const added = [];
    
    for (const ep of episodes) {
      const key = getKey(ep);
      if (key && !seen.has(key)) {
        seen.add(key);
        state.results[key] = { status: 'pending' };
        added.push(ep);
      } else {
        console.log(`[BG_QUEUE] 跳过重复或无效的剧集: ${key}`);
      }
    }
    
    state.queue.push(...added);
    if (!state.startedAt) state.startedAt = Date.now();
    console.log(`[BG_QUEUE] 将 ${added.length} 个新剧集加入下载队列。`);
    
    pumpQueue();
    
    sendResponse({ ok: true, queued: added.length, status: getStatus() });
    return true;
  }

  if (msg.type === 'BG_STATUS') {
    sendResponse({ ok: true, status: getStatus() });
    return true;
  }

  if (msg.type === 'BG_GUESS_DEFAULT_DIR') {
    chrome.downloads.search({}, (items) => {
      try {
        const list = Array.isArray(items) ? items.slice() : [];
        list.sort((a, b) => {
          const ta = Date.parse(a.startTime || 0) || 0;
          const tb = Date.parse(b.startTime || 0) || 0;
          return tb - ta; // desc
        });
        const it = list[0];
        if (it?.filename) setDefaultDirFromFilename(it.filename);
      } catch (e) {
        logError('BG_GUESS_DEFAULT_DIR', '获取默认目录失败', e);
      }
      sendResponse({ ok: true, defaultDir: state.defaultDir });
    });
    return true;
  }

  if (msg.type === 'BG_RESET') {
    state.queue = [];
    state.active = 0;
    state.results = {};
    state.startedAt = null;
    sendResponse({ ok: true });
    return true;
  }
});

// 监听下载变更，推断默认下载目录
chrome.downloads.onChanged.addListener((delta) => {
  if (delta?.filename?.current) {
    setDefaultDirFromFilename(delta.filename.current);
  }
  if (!delta || delta.state?.current !== 'complete') return;
  try { 
    chrome.runtime.sendMessage({ type: 'BG_DOWNLOAD_COMPLETE', id: delta.id }); 
  } catch (e) {
    logWarn('DownloadListener', '发送下载完成消息失败: ' + e.message);
  }
});
