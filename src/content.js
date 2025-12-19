(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 在脚本顶层创建一个缓存，用于存储扫描到的标题链接元素
  let anchorCache = new Map();

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none'
    );
  }

  function smartClick(el) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
    for (const type of events) {
      try {
        const evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(evt);
      } catch {}
    }
  }

  // 查找“加载更多”按钮
  function findLoadMoreButton() {
    const pools = [
      'button.ln-btn.ln-btn-secondary',
      'a.ln-btn.ln-btn-secondary',
      'button', 'a[role="button"]'
    ];
    const candidates = pools.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    const matchText = (t) => {
      const s = (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return s.includes('load more') || s.includes('more episodes') || s.includes('更多') || s.includes('加载更多');
    };
    const filtered = candidates.filter((btn) => isVisible(btn) && (matchText(btn.innerText || '') || matchText(btn.textContent || '')));
    return filtered[0] || null;
  }

  // 检测是否已加载完所有条目
  function checkAllEpisodesLoaded() {
    const text = document.body.innerText || document.body.textContent || '';
    return text.includes('You have seen all episodes of this podcast') || 
           text.includes('你已经看完了这个播客的所有剧集');
  }

  // 获取所有剧集的标题链接
  function getTitleAnchors() {
    const allAnchors = Array.from(document.querySelectorAll('h3 a[href]'));
    const seenUrls = new Set();
    const validAnchors = [];
    
    for (const a of allAnchors) {
      const href = a.getAttribute('href') || '';
      if (!href) continue;
      
      try {
        const url = new URL(href, location.href).href;
        if (!/\/podcasts\/[^\/]+\/[^\/]+/.test(url)) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        validAnchors.push(a);
      } catch (e) {
        continue;
      }
    }
    return validAnchors;
  }

  // ===================================================================
  // 阶段一：扫描所有剧集（简化版，只加载和收集，不点击MORE）
  // ===================================================================
  async function scanAllEpisodes() {
    console.log('[Scanner] 开始执行简化版扫描...');
    anchorCache.clear(); // 清空旧的缓存

    // 1. 循环点击“加载更多”按钮
    for (let i = 0; i < 500; i++) { // 最多点击500次，防止死循环
      if (checkAllEpisodesLoaded()) {
        console.log('[Scanner] 检测到所有剧集已加载');
        break;
      }
      
      const btn = findLoadMoreButton();
      if (!btn) {
        console.log('[Scanner] 未找到“加载更多”按钮，扫描结束');
        break;
      }
      
      console.log(`[Scanner] 第 ${i + 1} 次点击“加载更多”...`);
      smartClick(btn);
      await sleep(2000); // 等待内容加载
    }

    // 1.5 额外确认：等待页面底部出现 “You have seen all episodes of this podcast” 提示
    // 最长等待 2 分钟，期间每秒检查一次
    const start = Date.now();
    const maxWaitMs = 120000;
    while (Date.now() - start < maxWaitMs) {
      const tipEl = document.querySelector('div.text-center.my-4.text-muted-color.text-sm');
      if (tipEl && /You have seen all episodes of this podcast/i.test(tipEl.innerText || '')) {
        console.log('[Scanner] 检测到底部提示：You have seen all episodes of this podcast');
        break;
      }
      // 如果已经没有 Load More 按钮并且文本检测也通过，就认为加载完成
      if (!findLoadMoreButton() && checkAllEpisodesLoaded()) {
        console.log('[Scanner] 通过文本检测和按钮消失，确认所有剧集已加载');
        break;
      }
      await sleep(1000);
    }
    if (Date.now() - start >= maxWaitMs) {
      console.error('[Scanner] 等待所有剧集加载超时（2分钟内未出现底部提示）');
      throw new Error('等待所有剧集加载超时，请稍后重试');
    }

    // 2. 收集所有剧集信息并缓存链接元素
    const titleAnchors = getTitleAnchors();
    const episodes = [];
    console.log(`[Scanner] 找到 ${titleAnchors.length} 个剧集`);

    for (const anchor of titleAnchors) {
      const title = anchor.textContent.trim();
      const episodeId = new URL(anchor.getAttribute('href'), location.href).href;
      const channelTitle = document.title.split(' - ')[0] || 'Podcast';
      
      episodes.push({ title, episodeId, channelTitle });
      anchorCache.set(episodeId, anchor); // 将链接元素存入缓存
    }
    
    console.log(`[Scanner] 扫描完成，成功收集并缓存 ${episodes.length} 个剧集`);
    return episodes;
      }

  // ===================================================================
  // 阶段二：为单个剧集获取下载链接
  // ===================================================================
  async function getDownloadUrlForEpisode(episodeId) {
    console.log(`[Downloader] 开始为剧集 ${episodeId} 获取下载链接`);
    
    // 1. 从缓存中拿到对应标题链接元素
    const anchor = anchorCache.get(episodeId);
    if (!anchor) {
      throw new Error('在缓存中未找到对应的剧集链接元素');
    }

    // 2. 根据不同布局，找到这一集对应的“剧集块”容器
    // 先尝试通用的 grid 容器（适用于前10条和 Load More 加载出来的条目）
    let episodeBlock = anchor.closest('div.grid.grid-cols-1');

    // 如果没找到，再尝试最新一集所在的卡片容器
    if (!episodeBlock) {
      const latestCard = anchor.closest('#ln-episode-list');
      if (latestCard) {
        episodeBlock = latestCard.querySelector('div.grid.grid-cols-1') || latestCard;
      }
    }

    // 兜底：再尝试从播放器节点反向找到所在的 flex / grid
    if (!episodeBlock) {
      const player = document.querySelector(
        `div[data-type="episode-audio-player"][data-embed-player-url*="${encodeURIComponent(episodeId.split('/').pop() || '')}"]`
      );
      if (player) {
        episodeBlock = player.closest('div.grid.grid-cols-1, .flex') || player;
      }
    }

    if (!episodeBlock) {
      throw new Error('找到了链接元素，但未能定位到对应的剧集容器');
    }

    episodeBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);

    // 3. 在该剧集块中寻找 MORE 按钮
    const moreBtn = episodeBlock.querySelector('a.ln-btn[aria-label="MORE"]');
    if (!moreBtn) {
      // 备用路径：有些条目可能直接在块内就包含下载链接
      const directLink = episodeBlock.querySelector('a[href*="audio.listennotes.com/e/p/"]');
      if (directLink) {
        const directUrl = directLink.getAttribute('href');
        console.log(`[Downloader] [${episodeId}] 未找到“MORE”按钮，但直接找到了下载链接: ${directUrl}`);
        return directUrl;
      }
      throw new Error('未找到“MORE”按钮');
    }

    console.log(`[Downloader] [${episodeId}] 找到并点击“MORE”按钮`);
    smartClick(moreBtn);
    await sleep(500);

    // 4. 弹出菜单是绝对定位的，放在文档任意位置，因此从整个 document 查找
    const downloadLink = document.querySelector('a[href*="audio.listennotes.com/e/p/"]');
    if (!downloadLink) throw new Error('点击“MORE”后，在整个页面上都未找到下载链接');

    const audioUrl = downloadLink.getAttribute('href');
    console.log(`[Downloader] [${episodeId}] 成功提取原始地址: ${audioUrl}`);
    return audioUrl;
  }

  // ===================================================================
  // 消息监听器
  // ===================================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return true;

    if (msg.type === 'CONTENT_SCAN') {
      (async () => {
        try {
          const episodes = await scanAllEpisodes();
          sendResponse({ ok: true, episodes });
        } catch (e) {
          console.error('[ContentScript] 扫描出错:', e);
          sendResponse({ ok: false, error: e?.message });
        }
      })();
      return true;
    }

    if (msg.type === 'CONTENT_GET_URL') {
      (async () => {
        try {
          const audioUrl = await getDownloadUrlForEpisode(msg.episodeId);
          sendResponse({ ok: true, audioUrl });
        } catch (e) {
          console.error('[ContentScript] 获取下载链接出错:', e);
          sendResponse({ ok: false, error: e?.message });
        }
      })();
      return true;
    }
  });
})();