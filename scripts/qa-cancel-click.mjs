import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(repoRoot, 'test-results', 'qa-cancel-click');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(outputRoot, runId);
const popupStateKey = 'listenNotesPopupState';
const scrollTolerance = 6;

function buildEpisodes(count = 36) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      episodeId: `episode-${String(number).padStart(2, '0')}`,
      title: `Fixture Episode ${String(number).padStart(2, '0')}`,
      pageUrl: `https://www.listennotes.com/podcasts/fixture/episode-${number}`,
      audioUrl: `https://audio.listennotes.com/e/p/${String(number).padStart(32, 'a')}/`,
      channelTitle: 'QA Fixture Podcast',
    };
  });
}

function buildPopupSession(episodes, targetKey) {
  return {
    version: 1,
    sourceTabId: 101,
    sourceUrl: 'https://www.listennotes.com/podcasts/qa-fixture/',
    episodes,
    selectedEpisodeIds: [targetKey],
    selectFirstCount: '',
    listOrder: 'normal',
    savedAt: Date.now(),
  };
}

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(
      'Playwright is not installed. Run `npm install` first, then retry `npm run qa:cancel-click`.'
    );
  }
}

async function getExtensionId(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const url = new URL(worker.url());
  return {
    extensionId: url.host,
    workerUrl: worker.url(),
    worker,
  };
}

async function sendRealBackgroundMessage(context, extensionId, message) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    return await page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  } finally {
    await page.close().catch(() => {});
  }
}

function buildMockInitScript({ episodes, targetKey }) {
  const session = buildPopupSession(episodes, targetKey);
  return ({ popupStateKey: key, sessionState, targetEpisodeKey }) => {
    if (!location.href.startsWith('chrome-extension://') || !location.pathname.endsWith('/popup/popup.html')) {
      return;
    }

    const originalChrome = globalThis.chrome || {};
    const messageListeners = [];
    let bytesLoaded = 1024 * 128;
    const statusState = {
      [targetEpisodeKey]: {
        status: 'fetching_audio',
        error: '',
        taskId: 'audio:e2e-fixture',
        downloadId: 42,
        blobUrl: 'blob:e2e-fixture',
        canCancel: true,
        isCancelling: false,
      },
    };

    const buildStatus = () => ({
      total: sessionState.episodes.length,
      inQueue: 0,
      active: 1,
      counts: {
        pending: 0,
        getting_url: 0,
        resolving: 0,
        downloading: 0,
        queued_in_downloads: 0,
        complete: 0,
        error: 0,
        missing_audio: 0,
        fetching_audio: 1,
        ready_to_save: 0,
        save_prompt: 0,
        cancelling: statusState[targetEpisodeKey]?.status === 'cancelling' ? 1 : 0,
        cancelled: statusState[targetEpisodeKey]?.status === 'cancelled' ? 1 : 0,
      },
      startedAt: Date.now(),
      defaultDir: 'QA Downloads',
      zipStatus: 'idle',
      zipCurrent: 0,
      zipTotal: 0,
      zipError: '',
      results: { ...statusState },
      taskKind: 'download',
      taskCurrent: statusState[targetEpisodeKey]?.status === 'cancelled' ? 1 : 0,
      taskTotal: 1,
      taskStatus: statusState[targetEpisodeKey]?.status === 'cancelled' ? 'complete' : 'running',
      taskBytesLoaded: bytesLoaded,
      taskBytesTotal: 1024 * 1024 * 4,
      taskUnknownTotal: 0,
      taskUnknownDone: 0,
      taskCanCancel: true,
    });

    globalThis.__qaCancelClickMessages = [];
    globalThis.__qaEmitHighFrequencyProgress = (count = 30) => {
      for (let index = 0; index < count; index += 1) {
        bytesLoaded += 64 * 1024;
        const message = {
          type: 'BG_PROGRESS',
          progressOnly: true,
          state: buildStatus(),
        };
        for (const listener of messageListeners) {
          listener(message, {}, () => {});
        }
      }
    };
    globalThis.chrome = {
      ...originalChrome,
      i18n: {
        ...originalChrome.i18n,
        getUILanguage: () => 'en',
      },
      storage: {
        ...originalChrome.storage,
        local: {
          get: async () => ({ language: 'en' }),
          set: async () => {},
        },
        session: {
          get: async () => ({ [key]: sessionState }),
          set: async () => {},
          remove: async () => {},
        },
      },
      tabs: {
        query: async () => [{ id: sessionState.sourceTabId, url: sessionState.sourceUrl }],
        sendMessage: async () => ({ ok: true, episodes: sessionState.episodes }),
      },
      runtime: {
        ...originalChrome.runtime,
        getURL: (resourcePath) => `chrome-extension://${originalChrome.runtime.id}/${resourcePath}`,
        onMessage: {
          addListener: (listener) => {
            messageListeners.push(listener);
          },
          removeListener: (listener) => {
            const index = messageListeners.indexOf(listener);
            if (index >= 0) messageListeners.splice(index, 1);
          },
        },
        sendMessage: async (message) => {
          globalThis.__qaCancelClickMessages.push(message);
          if (message?.type === 'BG_STATUS') return { ok: true, status: buildStatus() };
          if (message?.type === 'BG_RESET') return { ok: true, status: buildStatus() };
          if (message?.type === 'BG_CANCEL_DOWNLOAD_ITEM') {
            if (message.key !== targetEpisodeKey) {
              return { ok: false, error: 'Unexpected cancellation key', status: buildStatus() };
            }
            statusState[targetEpisodeKey] = {
              ...statusState[targetEpisodeKey],
              status: 'cancelled',
              error: 'Cancelled',
              canCancel: false,
              isCancelling: false,
              blobUrl: '',
            };
            return { ok: true, status: buildStatus() };
          }
          if (message?.type === 'BG_OPEN_MANAGER_WINDOW') {
            return { ok: true, reused: false, windowId: 90210 };
          }
          return { ok: true };
        },
      },
    };
  };
}

async function collectUiState(page, targetKey) {
  return page.evaluate((key) => {
    const list = document.querySelector('#list');
    const wrap = document.querySelector('.wrap');
    const items = [...document.querySelectorAll('#list li')];
    const index = items.findIndex((item) => item.querySelector(`.episode-cancel[data-episode-id="${key}"], .episode-checkbox[data-episode-id="${key}"]`));
    const target = index >= 0 ? items[index] : null;
    const wrapRect = wrap?.getBoundingClientRect();
    return {
      scrollTop: list?.scrollTop ?? 0,
      itemCount: items.length,
      targetIndex: index,
      targetText: target?.textContent || '',
      hasCancelButton: Boolean(target?.querySelector('.episode-cancel')),
      hasCancellingStatus: Boolean(target?.querySelector('.episode-status-cancelling')),
      infoText: document.querySelector('#info')?.textContent || '',
      messages: globalThis.__qaCancelClickMessages || [],
      layout: {
        viewportWidth: window.innerWidth,
        bodyWidth: document.body.getBoundingClientRect().width,
        wrapWidth: wrapRect?.width ?? 0,
        wrapRight: wrapRect?.right ?? 0,
        rightGap: wrapRect ? Math.round(window.innerWidth - wrapRect.right) : null,
        bodyClass: document.body.className,
      },
    };
  }, targetKey);
}

async function runScenario({ context, extensionId, mode, directUrl, targetKey, report }) {
  const pageErrors = [];
  const consoleMessages = [];
  const failedRequests = [];
  let page;
  let usedFallback = false;

  if (mode === 'action-popup') {
    const [popupPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
      context.serviceWorkers()[0]?.evaluate(() => chrome.action.openPopup()).catch(() => null),
    ]);
    page = popupPage;
    if (!page) {
      usedFallback = true;
      page = await context.newPage();
      await page.goto(directUrl);
    }
  } else {
    page = await context.newPage();
    await page.goto(directUrl);
  }

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[ListenNotes Downloader]')) {
      consoleMessages.push(`${message.type()}: ${text}`);
    }
    if (['error', 'warning'].includes(message.type())) {
      pageErrors.push(`${message.type()}: ${text}`);
    }
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  });

  await page.waitForSelector('#list li', { state: 'attached', timeout: 10000 });
  await page.locator('details').evaluate((details) => {
    details.open = true;
  });
  await page.waitForSelector('#list li', { state: 'visible', timeout: 10000 });
  await page.locator('#list').evaluate((list) => {
    list.scrollTop = Math.max(0, Math.floor(list.scrollHeight / 2));
  });
  await page.evaluate(() => globalThis.__qaEmitHighFrequencyProgress?.(40));
  await page.waitForTimeout(50);

  const before = await collectUiState(page, targetKey);
  const beforeShot = path.join(outputDir, `${mode}-before.png`);
  await page.screenshot({ path: beforeShot, fullPage: true });

  await page.evaluate(() => globalThis.__qaEmitHighFrequencyProgress?.(40));
  const clickStartedAt = Date.now();
  await page.locator(`.episode-cancel[data-episode-id="${targetKey}"]`).click();
  const afterClick = await collectUiState(page, targetKey);
  const clickToAfterClickMs = Date.now() - clickStartedAt;
  const afterClickShot = path.join(outputDir, `${mode}-after-click.png`);
  await page.screenshot({ path: afterClickShot, fullPage: true });

  await page.waitForFunction((key) => {
    const items = [...document.querySelectorAll('#list li')];
    const target = items.find((item) => item.querySelector(`.episode-checkbox[data-episode-id="${key}"]`));
    return target && !target.querySelector('.episode-cancel');
  }, targetKey, { timeout: 5000 }).catch(() => {});

  const afterStatus = await collectUiState(page, targetKey);
  const afterStatusShot = path.join(outputDir, `${mode}-after-status.png`);
  await page.screenshot({ path: afterStatusShot, fullPage: true });

  const statusResponse = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'BG_STATUS' }));
  const targetStatus = statusResponse?.status?.results?.[targetKey] || null;
  const scrollDelta = Math.abs((afterStatus.scrollTop || 0) - (before.scrollTop || 0));
  const targetStayedPut = before.targetIndex === afterStatus.targetIndex;
  const statusOk = ['cancelling', 'cancelled'].includes(targetStatus?.status);
  const scrollOk = scrollDelta <= scrollTolerance;
  const managerLayoutOk = mode !== 'manager-window' || (afterStatus.layout?.rightGap ?? Infinity) <= 16;

  const scenario = {
    mode,
    url: page.url(),
    usedFallback,
    before,
    afterClick,
    afterStatus,
    targetStatus,
    highFrequencyProgress: {
      emittedBeforeSnapshot: 40,
      emittedBeforeClick: 40,
      clickToAfterClickMs,
    },
    assertions: {
      scrollOk,
      scrollDelta,
      targetStayedPut,
      statusOk,
      managerLayoutOk,
      passed: scrollOk && targetStayedPut && statusOk && managerLayoutOk,
    },
    screenshots: {
      before: beforeShot,
      afterClick: afterClickShot,
      afterStatus: afterStatusShot,
    },
    consoleMessages,
    consoleAndPageErrors: pageErrors,
    failedRequests,
  };

  report.scenarios.push(scenario);
  await page.close().catch(() => {});
  return scenario;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const { chromium } = await importPlaywright();
  const userDataDir = path.join(outputDir, 'chromium-profile');
  const report = {
    runId,
    repoRoot,
    outputDir,
    extension: {},
    backgroundProbe: {},
    scenarios: [],
  };

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 480, height: 760 },
    acceptDownloads: false,
    args: [
      `--disable-extensions-except=${repoRoot}`,
      `--load-extension=${repoRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const { extensionId, workerUrl } = await getExtensionId(context);
    report.extension = { extensionId, workerUrl };

    try {
      const reset = await sendRealBackgroundMessage(context, extensionId, { type: 'BG_RESET' });
      const status = await sendRealBackgroundMessage(context, extensionId, { type: 'BG_STATUS' });
      report.backgroundProbe = { reset, status };
    } catch (error) {
      report.backgroundProbe = { error: error.message };
    }

    const episodes = buildEpisodes();
    const targetKey = episodes[18].episodeId;
    await context.addInitScript(
      buildMockInitScript({ episodes, targetKey }),
      { popupStateKey, sessionState: buildPopupSession(episodes, targetKey), targetEpisodeKey: targetKey }
    );

    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const managerUrl = `chrome-extension://${extensionId}/popup/popup.html?mode=window`;
    await runScenario({
      context,
      extensionId,
      mode: 'action-popup',
      directUrl: popupUrl,
      targetKey,
      report,
    });
    await runScenario({
      context,
      extensionId,
      mode: 'manager-window',
      directUrl: managerUrl,
      targetKey,
      report,
    });
  } finally {
    await context.close().catch(() => {});
  }

  report.passed = report.scenarios.length > 0 && report.scenarios.every((scenario) => scenario.assertions.passed);
  const reportPath = path.join(outputDir, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`QA cancel-click report: ${reportPath}`);
  for (const scenario of report.scenarios) {
    console.log(`${scenario.mode}: ${scenario.assertions.passed ? 'PASS' : 'FAIL'} scrollDelta=${scenario.assertions.scrollDelta} targetIndex=${scenario.before.targetIndex}->${scenario.afterStatus.targetIndex} status=${scenario.targetStatus?.status || 'unknown'} clickMs=${scenario.highFrequencyProgress.clickToAfterClickMs} rightGap=${scenario.afterStatus.layout?.rightGap} fallback=${scenario.usedFallback}`);
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
