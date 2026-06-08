import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildEpisodeStatusSignature,
  createEpisodeListItem,
  replaceChildrenPreservingScroll,
  shouldRenderEpisodeList,
} from '../popup/popup-helpers.mjs';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }
}

const fakeDocument = {
  createElement: (tagName) => new FakeElement(tagName),
};

function findByClass(root, className) {
  if (String(root.className || '').split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function renderEpisode(result) {
  return createEpisodeListItem(
    fakeDocument,
    {
      episodeId: 'episode-1',
      title: 'Episode One',
      pageUrl: 'https://example.com/episode-1',
    },
    {
      cancelEpisodeLabel: 'Cancel',
      cancellingLabel: 'Cancelling',
      episodePageLabel: 'episode page',
      selectEpisodeLabel: 'Select',
    },
    {
      key: 'episode-1',
      checked: true,
      result,
    }
  );
}

test('createEpisodeListItem renders link and cancel control for cancellable items', () => {
  const item = renderEpisode({ canCancel: true });

  const link = findByClass(item, 'episode-link');
  const cancel = findByClass(item, 'episode-cancel');

  assert.ok(link);
  assert.equal(link.textContent, 'episode page');
  assert.ok(cancel);
  assert.equal(cancel.dataset.episodeId, 'episode-1');
  assert.equal(cancel.getAttribute('aria-label'), 'Cancel: Episode One');
});

test('createEpisodeListItem renders cancelling status without a cancel control', () => {
  const item = renderEpisode({ canCancel: false, isCancelling: true });

  const status = findByClass(item, 'episode-status-cancelling');
  const cancel = findByClass(item, 'episode-cancel');

  assert.ok(status);
  assert.equal(status.textContent, 'Cancelling');
  assert.equal(cancel, null);
});

test('popup list keeps episode actions away from the scrollbar', () => {
  const css = readFileSync(new URL('../popup/popup.css', import.meta.url), 'utf8');

  assert.match(css, /#list\s*\{[^}]*padding-inline-end:\s*20px;/s);
  assert.match(css, /#list\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(css, /#list\s*\{[^}]*overflow-x:\s*hidden;/s);
  assert.match(css, /\.episode-cancel:hover\s*\{/);
  assert.match(css, /\.episode-cancel:focus-visible\s*\{/);
});

test('manager window layout fills the wider popup window', () => {
  const css = readFileSync(new URL('../popup/popup.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');

  assert.match(js, /document\.body\.classList\.toggle\('is-manager-window',\s*isManagerWindow\);/);
  assert.match(css, /body\.is-manager-window\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*380px;/s);
  assert.match(css, /body\.is-manager-window\s+\.wrap\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*100vh;/s);
  assert.match(css, /body\.is-manager-window\s+#list\s*\{[^}]*padding-inline-end:\s*12px;/s);
});

test('replaceChildrenPreservingScroll keeps list scroll position when rerendering', () => {
  const list = new FakeElement('ul');
  const first = new FakeElement('li');
  const second = new FakeElement('li');
  list.scrollTop = 96;
  list.appendChild(first);

  replaceChildrenPreservingScroll(list, second);

  assert.equal(list.scrollTop, 96);
  assert.deepEqual(list.children, [second]);
});

test('episode status signature ignores pure byte progress changes', () => {
  const before = {
    taskBytesLoaded: 1024,
    results: {
      'episode-1': { status: 'fetching_audio', canCancel: true },
    },
  };
  const after = {
    taskBytesLoaded: 1024 * 1024 * 5,
    results: {
      'episode-1': { status: 'fetching_audio', canCancel: true },
    },
  };

  assert.equal(buildEpisodeStatusSignature(before, ['episode-1']), buildEpisodeStatusSignature(after, ['episode-1']));
  assert.equal(shouldRenderEpisodeList(before, after, ['episode-1']), false);
});

test('episode status signature changes when cancel state changes', () => {
  const before = {
    results: {
      'episode-1': { status: 'fetching_audio', canCancel: true, isCancelling: false },
    },
  };
  const after = {
    results: {
      'episode-1': { status: 'cancelling', canCancel: false, isCancelling: true },
    },
  };

  assert.equal(shouldRenderEpisodeList(before, after, ['episode-1']), true);
});

test('cancelled items do not require list rerender for later byte progress', () => {
  const before = {
    taskBytesLoaded: 1024,
    results: {
      'episode-1': { status: 'cancelled', error: 'Cancelled', canCancel: false },
    },
  };
  const after = {
    taskBytesLoaded: 1024 * 1024 * 8,
    results: {
      'episode-1': { status: 'cancelled', error: 'Cancelled', canCancel: false },
    },
  };

  assert.equal(shouldRenderEpisodeList(before, after, ['episode-1']), false);
});
