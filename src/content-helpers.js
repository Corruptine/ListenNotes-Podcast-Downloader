(function attachListenNotesContentHelpers(globalScope) {
  const ALL_EPISODES_TIP_TEXT = 'You have seen all episodes of this podcast';
  const ALL_EPISODES_TIP_SELECTOR = '.text-center.my-4.text-muted-color.text-sm';
  const EPISODE_LINK_SELECTOR = [
    'h3 a[href]',
  ].join(', ');
  const AUDIO_PLAYER_SELECTOR = 'div[data-type="episode-audio-player"]';
  const LOAD_MORE_BUTTON_SELECTOR = [
    '#episodes-pagination button',
    '#episodes-pagination a[role="button"]',
    '#episodes-pagination a.ln-btn',
    'button.ln-btn.ln-btn-secondary',
    'a.ln-btn.ln-btn-secondary',
  ].join(', ');
  const EPISODES_PAGINATION_SELECTOR = '#episodes-pagination';
  const SCAN_DECISIONS = {
    CLICK_LOAD_MORE: 'click_load_more',
    COMPLETE: 'complete',
    WAIT_FOR_BOTTOM: 'wait_for_bottom',
    TIMEOUT: 'timeout',
  };

  function getElementText(element) {
    return String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeEpisodeTitle(text) {
    return getElementText({ textContent: text }).toLowerCase();
  }

  function normalizeUrl(value, baseUrl) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return raw;
    }
  }

  function decodeXmlEntities(value) {
    return String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
      .trim();
  }

  function stripXmlTags(value) {
    return decodeXmlEntities(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeHttpUrl(value, baseUrl) {
    const url = normalizeUrl(decodeXmlEntities(value), baseUrl);
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function getDocumentHtml(documentRef) {
    return String(documentRef?.documentElement?.outerHTML || '');
  }

  function isExcludedRssCandidate(url) {
    try {
      const parsed = new URL(url);
      return /(^|\.)listennotes\.com$/i.test(parsed.hostname)
        && /\/opensearch\.xml$/i.test(parsed.pathname);
    } catch {
      return true;
    }
  }

  function isListenNotesHost(url) {
    try {
      return /(^|\.)listennotes\.com$/i.test(new URL(url).hostname);
    } catch {
      return true;
    }
  }

  function addRssCandidate(candidates, value, baseUrl) {
    const decoded = decodeXmlEntities(value);
    if (!/\.xml(?:[?#/]|$)/i.test(decoded)) return;

    const directUrl = normalizeHttpUrl(decoded, baseUrl);
    if (directUrl && !isExcludedRssCandidate(directUrl)) {
      candidates.push(directUrl);
    }

    try {
      const parsed = new URL(directUrl || decoded, baseUrl);
      for (const paramValue of parsed.searchParams.values()) {
        const nestedUrl = normalizeHttpUrl(paramValue, baseUrl);
        if (nestedUrl && /\.xml(?:[?#/]|$)/i.test(nestedUrl) && !isExcludedRssCandidate(nestedUrl)) {
          candidates.push(nestedUrl);
        }
      }
    } catch {}
  }

  function extractRssFeedUrl(documentRef, baseUrl) {
    const candidates = [];
    const html = getDocumentHtml(documentRef);

    for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+?\.xml(?:\?[^\s"'<>]*)?/gi)) {
      addRssCandidate(candidates, match[0], baseUrl);
    }

    if (documentRef?.querySelectorAll) {
      for (const element of Array.from(documentRef.querySelectorAll('a[href], link[href]'))) {
        addRssCandidate(candidates, element.getAttribute?.('href') || '', baseUrl);
      }
    }

    const unique = [...new Set(candidates)];
    return unique.find((url) => !isListenNotesHost(url)) || unique[0] || '';
  }

  function getFirstXmlText(block, tagNames) {
    for (const tagName of tagNames) {
      const escaped = tagName.replace(':', '\\:');
      const match = String(block || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
      if (match) return stripXmlTags(match[1]);
    }
    return '';
  }

  function getFirstXmlElement(block, tagNames) {
    for (const tagName of tagNames) {
      const escaped = tagName.replace(':', '\\:');
      const match = String(block || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?\\/?>`, 'i'));
      if (match) return match[0];
    }
    return '';
  }

  function getXmlAttr(element, attrName) {
    const match = String(element || '').match(new RegExp(`\\s${attrName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
    return match ? decodeXmlEntities(match[2]) : '';
  }

  function parsePodcastRss(xmlText, baseUrl = '') {
    const xml = String(xmlText || '');
    const channelStart = xml.match(/<channel(?:\s[^>]*)?>/i);
    const firstItemIndex = xml.search(/<item(?:\s[^>]*)?>/i);
    const channelPrefix = channelStart
      ? xml.slice(channelStart.index + channelStart[0].length, firstItemIndex >= 0 ? firstItemIndex : xml.length)
      : xml;
    const channelTitle = getFirstXmlText(channelPrefix, ['title']) || 'Podcast';
    const itemBlocks = [...xml.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].map((match) => match[0]);

    return itemBlocks.map((item) => {
      const enclosure = getFirstXmlElement(item, ['enclosure']);
      const mediaContent = getFirstXmlElement(item, ['media:content']);
      const audioUrl = normalizeHttpUrl(getXmlAttr(enclosure, 'url') || getXmlAttr(mediaContent, 'url'), baseUrl);
      if (!audioUrl) return null;

      const title = getFirstXmlText(item, ['title']) || audioUrl;
      const guid = getFirstXmlText(item, ['guid']);
      const link = normalizeHttpUrl(getFirstXmlText(item, ['link']), baseUrl);
      const duration = getFirstXmlText(item, ['itunes:duration', 'duration']);
      const pubDate = getFirstXmlText(item, ['pubDate']);
      const pubDateMs = Date.parse(pubDate);

      return {
        title,
        audioUrl,
        episodeId: guid || link || audioUrl,
        pageUrl: link,
        channelTitle,
        episodeUuid: guid,
        duration,
        embedPlayerUrl: '',
        pubDateMs: Number.isFinite(pubDateMs) ? pubDateMs : null,
        source: 'rss',
      };
    }).filter(Boolean);
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return String(value || '');
    }
  }

  function hasMalformedPercentEncoding(value) {
    return /%(?![0-9a-f]{2})/i.test(String(value || ''));
  }

  function isValidEpisodeSlug(slug) {
    const value = String(slug || '').trim();
    if (!value || hasMalformedPercentEncoding(value)) return false;

    try {
      const decoded = decodeURIComponent(value);
      return Boolean(decoded.trim()) && decoded !== '%' && decoded.length > 1;
    } catch {
      return false;
    }
  }

  function isListenNotesEpisodeUrl(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      return /^(www\.)?listennotes\.com$/i.test(parsed.hostname)
        && parts.length === 3
        && parts[0] === 'podcasts'
        && isValidEpisodeSlug(parts[1])
        && isValidEpisodeSlug(parts[2]);
    } catch {
      return false;
    }
  }

  function getUniqueEpisodeAnchors(documentRef, baseUrl) {
    if (!documentRef?.querySelectorAll) return [];

    const seenUrls = new Set();
    const anchors = [];

    for (const anchor of Array.from(documentRef.querySelectorAll(EPISODE_LINK_SELECTOR))) {
      const href = anchor.getAttribute?.('href') || '';
      if (!href) continue;

      try {
        const url = new URL(href, baseUrl).href;
        if (!isListenNotesEpisodeUrl(url) || seenUrls.has(url)) continue;
        seenUrls.add(url);
        anchors.push({ anchor, url });
      } catch {}
    }

    return anchors;
  }

  function findEpisodeAnchorByUrl(documentRef, baseUrl, episodeUrl) {
    let normalizedEpisodeUrl = '';
    try {
      normalizedEpisodeUrl = new URL(episodeUrl, baseUrl).href;
    } catch {
      normalizedEpisodeUrl = String(episodeUrl || '');
    }

    return getUniqueEpisodeAnchors(documentRef, baseUrl)
      .find((item) => item.url === normalizedEpisodeUrl) || null;
  }

  function getEpisodeSlug(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      return safeDecodeURIComponent(parts[parts.length - 1] || '');
    } catch {
      const parts = String(url || '').split('/').filter(Boolean);
      return safeDecodeURIComponent(parts[parts.length - 1] || '');
    }
  }

  function readEpisodePlayerData(player, baseUrl) {
    if (!player?.getAttribute) {
      return {
        audioUrl: '',
        episodeUuid: '',
        title: '',
        channelTitle: '',
        duration: '',
        embedPlayerUrl: '',
      };
    }

    return {
      audioUrl: normalizeUrl(player.getAttribute('data-audio'), baseUrl),
      episodeUuid: String(player.getAttribute('data-episode-uuid') || '').trim(),
      title: String(player.getAttribute('data-title') || '').trim(),
      channelTitle: String(player.getAttribute('data-channel-title') || '').trim(),
      duration: String(player.getAttribute('data-duration') || '').trim(),
      embedPlayerUrl: normalizeUrl(player.getAttribute('data-embed-player-url'), baseUrl),
    };
  }

  function getEpisodePlayers(documentRef) {
    if (!documentRef?.querySelectorAll) return [];
    return Array.from(documentRef.querySelectorAll(AUDIO_PLAYER_SELECTOR));
  }

  function getEpisodePlayerDataList(documentRef, baseUrl) {
    return getEpisodePlayers(documentRef).map((player) => readEpisodePlayerData(player, baseUrl));
  }

  function createEpisodeFromAnchor(documentRef, {
    anchor,
    url,
    baseUrl,
    fallbackChannelTitle = '',
  } = {}) {
    const player = findEpisodePlayerForAnchor(documentRef, anchor, url);
    const playerData = player ? readEpisodePlayerData(player, baseUrl) : readEpisodePlayerData(null, baseUrl);
    const title = playerData.title || getElementText(anchor) || url || '';

    return {
      title,
      episodeId: url,
      channelTitle: playerData.channelTitle || fallbackChannelTitle || 'Podcast',
      audioUrl: playerData.audioUrl,
      episodeUuid: playerData.episodeUuid,
      duration: playerData.duration,
      embedPlayerUrl: playerData.embedPlayerUrl,
    };
  }

  function getNestedValue(object, path) {
    return path.reduce((current, key) => current?.[key], object);
  }

  function firstStringValue(object, paths) {
    for (const path of paths) {
      const value = Array.isArray(path) ? getNestedValue(object, path) : object?.[path];
      const normalized = String(value || '').trim();
      if (normalized) return normalized;
    }
    return '';
  }

  function buildEmbedPlayerUrl(pageUrl, baseUrl) {
    const normalizedPageUrl = normalizeHttpUrl(pageUrl, baseUrl);
    if (!normalizedPageUrl) return '';

    return `${normalizedPageUrl.replace(/\/?$/, '/')}embed/`;
  }

  function createEpisodeFromEndpointEpisode(endpointEpisode, baseUrl = '') {
    const title = firstStringValue(endpointEpisode, ['episode_title', 'title', 'absolute_url', 'audio']);
    const pageUrl = normalizeHttpUrl(firstStringValue(endpointEpisode, ['absolute_url', 'episode_url', 'url', 'episodeId']), baseUrl);
    const audioUrl = normalizeUrl(firstStringValue(endpointEpisode, [
      'audio_play_url',
      'audio',
      'audio_play_url_extension',
      'audioUrl',
    ]), baseUrl);
    const episodeUuid = firstStringValue(endpointEpisode, ['episode_uuid', 'episodeUuid', 'guid']);

    return {
      title,
      episodeId: pageUrl || episodeUuid || audioUrl || title,
      channelTitle: firstStringValue(endpointEpisode, [
        ['channel', 'channel_title'],
        ['channel', 'title'],
        ['channel', 'channelTitle'],
        'channelTitle',
      ]) || 'Podcast',
      audioUrl,
      episodeUuid,
      duration: firstStringValue(endpointEpisode, ['audio_length_humanized', 'duration']),
      embedPlayerUrl: normalizeHttpUrl(firstStringValue(endpointEpisode, ['embed_url', 'embedPlayerUrl']), baseUrl)
        || buildEmbedPlayerUrl(pageUrl, baseUrl),
    };
  }

  function getEpisodeDedupKey(episode) {
    const episodeId = String(episode?.episodeId || episode?.absolute_url || '').trim();
    if (episodeId) return `url:${episodeId}`;

    const episodeUuid = String(episode?.episodeUuid || episode?.episode_uuid || '').trim();
    if (episodeUuid) return `uuid:${episodeUuid}`;

    const audioUrl = String(episode?.audioUrl || episode?.audio || '').trim();
    if (audioUrl) return `audio:${audioUrl}`;

    return '';
  }

  function getEpisodePaginationState(documentRef) {
    const pagination = documentRef?.querySelector?.(EPISODES_PAGINATION_SELECTOR);
    if (!pagination?.getAttribute) return null;

    const channelUuid = getElementAttribute(pagination, 'data-channel-uuid');
    const nextPubDate = getElementAttribute(pagination, 'data-next-pubdate');
    if (!channelUuid || !nextPubDate) return null;

    return {
      channelUuid,
      nextPubDate,
      previousPubDate: getElementAttribute(pagination, 'data-prev-pubdate'),
      sortType: getElementAttribute(pagination, 'data-sort-type') || 'recent_first',
    };
  }

  function playerEmbedMatchesSlug(player, episodeSlug) {
    if (!episodeSlug || !player?.getAttribute) return false;

    const embedUrl = String(player.getAttribute('data-embed-player-url') || '');
    if (!embedUrl) return false;

    const encodedSlug = encodeURIComponent(episodeSlug);
    const haystacks = [
      embedUrl,
      safeDecodeURIComponent(embedUrl),
    ].map((value) => value.toLowerCase());
    const needles = [
      episodeSlug,
      encodedSlug,
    ].map((value) => value.toLowerCase());

    return haystacks.some((haystack) => needles.some((needle) => haystack.includes(needle)));
  }

  function findNearbyEpisodePlayer(anchor) {
    const root = anchor?.closest?.('div.grid.grid-cols-1, #ln-episode-list, article, li, .flex');
    return root?.querySelector?.(AUDIO_PLAYER_SELECTOR) || null;
  }

  function findEpisodePlayerForAnchor(documentRef, anchor, episodeUrl) {
    const players = getEpisodePlayers(documentRef);
    const episodeSlug = getEpisodeSlug(episodeUrl || anchor?.getAttribute?.('href') || '');
    const slugMatch = players.find((player) => playerEmbedMatchesSlug(player, episodeSlug));
    if (slugMatch) return slugMatch;

    const nearbyPlayer = findNearbyEpisodePlayer(anchor);
    if (nearbyPlayer) return nearbyPlayer;

    const anchorTitle = normalizeEpisodeTitle(getElementText(anchor));
    if (!anchorTitle) return null;

    return players.find((player) => {
      const playerTitle = normalizeEpisodeTitle(player.getAttribute?.('data-title') || '');
      return playerTitle && (playerTitle === anchorTitle || playerTitle.includes(anchorTitle) || anchorTitle.includes(playerTitle));
    }) || null;
  }

  function hasAllEpisodesTip(documentRef) {
    if (!documentRef?.querySelectorAll) return false;

    const candidates = Array.from(documentRef.querySelectorAll(ALL_EPISODES_TIP_SELECTOR));
    return candidates.some((element) => getElementText(element).includes(ALL_EPISODES_TIP_TEXT));
  }

  function getElementAttribute(element, name) {
    return String(element?.getAttribute?.(name) || '').trim();
  }

  function normalizeLoadMoreText(text) {
    return String(text || '')
      .replace(/[▼▾▿⌄⌵]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isVisibleElement(element) {
    if (!element) return false;
    if (element.hidden || element.disabled) return false;
    if (getElementAttribute(element, 'aria-hidden') === 'true') return false;

    const rect = element.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.width > 0 && rect.height > 0;
  }

  function isEpisodeMoreMenuButton(element) {
    const text = normalizeLoadMoreText(getElementText(element));
    const ariaLabel = normalizeLoadMoreText(getElementAttribute(element, 'aria-label'));
    const title = normalizeLoadMoreText(getElementAttribute(element, 'title'));
    return text === 'more' || ariaLabel === 'more' || title === 'more';
  }

  function isLoadMoreButtonText(text) {
    const normalized = normalizeLoadMoreText(text);
    return normalized.includes('load more')
      || normalized.includes('more episodes')
      || normalized.includes('加载更多');
  }

  function findLoadMoreButton(documentRef) {
    if (!documentRef?.querySelectorAll) return null;

    const candidates = Array.from(documentRef.querySelectorAll(LOAD_MORE_BUTTON_SELECTOR));
    return candidates.find((element) => (
      isVisibleElement(element)
      && !isEpisodeMoreMenuButton(element)
      && isLoadMoreButtonText(getElementText(element))
    )) || null;
  }

  function getScanDecision({
    hasEndTip,
    hasLoadMoreButton = false,
    elapsedMs,
    maxScanMs,
  }) {
    if (elapsedMs > maxScanMs) return SCAN_DECISIONS.TIMEOUT;
    if (hasEndTip) return SCAN_DECISIONS.COMPLETE;
    if (hasLoadMoreButton) return SCAN_DECISIONS.CLICK_LOAD_MORE;
    return SCAN_DECISIONS.WAIT_FOR_BOTTOM;
  }

  globalScope.ListenNotesContentHelpers = {
    ALL_EPISODES_TIP_TEXT,
    ALL_EPISODES_TIP_SELECTOR,
    EPISODE_LINK_SELECTOR,
    AUDIO_PLAYER_SELECTOR,
    LOAD_MORE_BUTTON_SELECTOR,
    EPISODES_PAGINATION_SELECTOR,
    SCAN_DECISIONS,
    createEpisodeFromAnchor,
    createEpisodeFromEndpointEpisode,
    extractRssFeedUrl,
    findEpisodeAnchorByUrl,
    findLoadMoreButton,
    findEpisodePlayerForAnchor,
    getEpisodeDedupKey,
    getEpisodePaginationState,
    getElementText,
    getEpisodePlayerDataList,
    getEpisodePlayers,
    getEpisodeSlug,
    getUniqueEpisodeAnchors,
    getScanDecision,
    hasAllEpisodesTip,
    isListenNotesEpisodeUrl,
    normalizeEpisodeTitle,
    parsePodcastRss,
    readEpisodePlayerData,
  };
})(globalThis);
