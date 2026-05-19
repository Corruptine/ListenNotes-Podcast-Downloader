(() => {
  if (window.__listenNotesDownloaderLoaded) return;
  window.__listenNotesDownloaderLoaded = true;

  const {
    createEpisodeFromAnchor,
    createEpisodeFromEndpointEpisode,
    extractRssFeedUrl,
    findLoadMoreButton,
    getEpisodeDedupKey,
    getEpisodePaginationState,
    getScanDecision,
    getUniqueEpisodeAnchors,
    hasAllEpisodesTip,
    parsePodcastRss,
    SCAN_DECISIONS,
  } = window.ListenNotesContentHelpers;

  const LOAD_MORE_WAIT_MS = 8000;
  const MAX_LOAD_MORE_CLICKS = 50;
  const MAX_SCAN_MS = 120000;
  const POLL_INTERVAL_MS = 100;

  const episodeCache = new Map();

  function getTitleAnchors() {
    return getUniqueEpisodeAnchors(document, location.href);
  }

  function buildEpisodeCacheEntry(anchor, url, fallbackChannelTitle = '') {
    const episode = createEpisodeFromAnchor(document, {
      anchor,
      url,
      baseUrl: location.href,
      fallbackChannelTitle: fallbackChannelTitle || document.title.split(' - ')[0] || 'Podcast',
    });
    episodeCache.set(url, { ...episode, anchor });
    return episodeCache.get(url);
  }

  async function fetchRssText(url) {
    const response = await chrome.runtime.sendMessage({
      type: 'BG_FETCH_RSS_TEXT',
      url,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'RSS fetch failed');
    }
    return String(response.text || '');
  }

  async function scanRssEpisodes() {
    const rssUrl = extractRssFeedUrl(document, location.href);
    if (!rssUrl) return [];

    const xmlText = await fetchRssText(rssUrl);
    return parsePodcastRss(xmlText, rssUrl);
  }

  async function scanEpisodes() {
    try {
      const rssEpisodes = await scanRssEpisodes();
      if (rssEpisodes.length > 0) return rssEpisodes;
    } catch (error) {
      console.warn('[ContentScript] RSS scan failed, falling back to current page scan:', error);
    }

    return scanCurrentPageEpisodes();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getCsrfToken() {
    const match = String(document.cookie || '').match(/(?:^|; )csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function buildEndpointHeaders() {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['x-csrftoken'] = csrfToken;
    }
    return headers;
  }

  async function fetchEndpointEpisodeBundle(state) {
    const body = new URLSearchParams({
      for_transcripts: 'false',
      next_pub_date: state.nextPubDate,
      prev_pub_date: state.previousPubDate,
      sort_type: state.sortType,
    });
    const response = await fetch(`/endpoints/v1/channels/${encodeURIComponent(state.channelUuid)}/episodes`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildEndpointHeaders(),
      body,
    });

    if (!response?.ok) {
      throw new Error(`ListenNotes endpoint returned ${response?.status || 'an error'}`);
    }

    const payload = await response.json();
    const bundle = payload?.bundle;
    if (!bundle || !Array.isArray(bundle.episodes)) {
      throw new Error('ListenNotes endpoint returned an unexpected episode payload.');
    }
    return bundle;
  }

  async function scanEndpointEpisodes(deadlineMs) {
    let state = getEpisodePaginationState(document);
    if (!state) return [];

    const episodes = [];
    const seenPages = new Set();

    while (episodes.length < MAX_LOAD_MORE_CLICKS * 10 && Date.now() < deadlineMs && state.nextPubDate) {
      const pageKey = `${state.nextPubDate}:${state.previousPubDate}:${state.sortType}`;
      if (seenPages.has(pageKey)) break;
      seenPages.add(pageKey);

      const bundle = await fetchEndpointEpisodeBundle(state);
      const pageEpisodes = bundle.episodes
        .map((episode) => createEpisodeFromEndpointEpisode(episode, location.href))
        .filter((episode) => episode.title || episode.episodeId || episode.audioUrl);

      if (pageEpisodes.length === 0) break;
      episodes.push(...pageEpisodes);

      if (!bundle.has_next || !bundle.next_pub_date) break;
      state = {
        ...state,
        nextPubDate: String(bundle.next_pub_date),
        previousPubDate: String(bundle.previous_pub_date || state.previousPubDate),
      };
    }

    return episodes;
  }

  function dedupeEpisodes(episodes) {
    const seen = new Set();
    return episodes.filter((episode) => {
      const key = getEpisodeDedupKey(episode);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function clickLoadMoreButton(button) {
    button.scrollIntoView?.({ block: 'center', inline: 'center' });

    let dispatched = false;
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      if (typeof button.dispatchEvent !== 'function') break;

      try {
        button.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
        dispatched = true;
      } catch {
        try {
          button.dispatchEvent({ type, bubbles: true, cancelable: true });
          dispatched = true;
        } catch {}
      }
    }

    if (!dispatched && typeof button.click === 'function') {
      button.click();
    }
  }

  async function waitForEpisodeListChange(previousCount, deadlineMs) {
    const stopAt = Math.min(Date.now() + LOAD_MORE_WAIT_MS, deadlineMs);

    while (Date.now() < stopAt) {
      if (hasAllEpisodesTip(document)) return true;
      if (getTitleAnchors().length > previousCount) return true;
      await delay(POLL_INTERVAL_MS);
    }

    return false;
  }

  async function loadRemainingDomEpisodes() {
    const startedAt = Date.now();
    const deadlineMs = startedAt + MAX_SCAN_MS;
    let clickCount = 0;

    while (clickCount < MAX_LOAD_MORE_CLICKS) {
      const button = findLoadMoreButton(document);
      const decision = getScanDecision({
        hasEndTip: hasAllEpisodesTip(document),
        hasLoadMoreButton: Boolean(button),
        elapsedMs: Date.now() - startedAt,
        maxScanMs: MAX_SCAN_MS,
      });

      if (decision !== SCAN_DECISIONS.CLICK_LOAD_MORE) return;

      const previousCount = getTitleAnchors().length;
      clickLoadMoreButton(button);
      clickCount += 1;

      const changed = await waitForEpisodeListChange(previousCount, deadlineMs);
      if (!changed) return;
    }
  }

  async function scanCurrentPageEpisodes() {
    episodeCache.clear();
    const endpointDeadlineMs = Date.now() + MAX_SCAN_MS;
    let endpointEpisodes = [];

    try {
      endpointEpisodes = await scanEndpointEpisodes(endpointDeadlineMs);
    } catch (error) {
      console.warn('[ContentScript] ListenNotes endpoint scan failed, falling back to Load more:', error);
    }

    if (endpointEpisodes.length === 0) {
      await loadRemainingDomEpisodes();
    }

    const titleAnchors = getTitleAnchors();
    const channelTitle = document.title.split(' - ')[0] || 'Podcast';
    const episodes = titleAnchors
      .map(({ anchor, url }) => buildEpisodeCacheEntry(anchor, url, channelTitle))
      .map(({ anchor: _anchor, ...episode }) => episode);
    const mergedEpisodes = dedupeEpisodes([...episodes, ...endpointEpisodes]);

    if (mergedEpisodes.length === 0) {
      throw new Error('No ListenNotes episodes were found on the current page.');
    }

    return mergedEpisodes;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.type) return false;

    if (msg.type === 'CONTENT_PING') {
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'CONTENT_SCAN') {
      (async () => {
        try {
          sendResponse({ ok: true, episodes: await scanEpisodes() });
        } catch (e) {
          console.error('[ContentScript] Scan failed:', e);
          sendResponse({ ok: false, error: e?.message || 'Scan failed' });
        }
      })();
      return true;
    }

    return false;
  });
})();
