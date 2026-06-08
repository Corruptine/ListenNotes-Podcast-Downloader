import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOrderedEpisodes,
  REVERSE_LIST_ORDER,
  selectFirstEpisodes,
} from '../popup/popup-selection.mjs';

const episodes = [
  { episodeId: 'episode-1', title: 'One' },
  { episodeId: 'episode-2', title: 'Two' },
  { episodeId: 'episode-3', title: 'Three' },
  { episodeId: 'episode-4', title: 'Four' },
  { episodeId: 'episode-5', title: 'Five' },
];

test('selectFirstEpisodes selects only the first items by default', () => {
  assert.deepEqual([...selectFirstEpisodes(episodes, 3)], [
    'episode-1',
    'episode-2',
    'episode-3',
  ]);
});

test('selectFirstEpisodes appends to an existing selection', () => {
  const existing = new Set(['episode-5']);

  assert.deepEqual([...selectFirstEpisodes(episodes, 3, existing)], [
    'episode-5',
    'episode-1',
    'episode-2',
    'episode-3',
  ]);
});

test('selectFirstEpisodes does not mutate the existing selection', () => {
  const existing = new Set(['episode-5']);

  selectFirstEpisodes(episodes, 3, existing);

  assert.deepEqual([...existing], ['episode-5']);
});

test('selectFirstEpisodes caps selection at the available visible episodes', () => {
  assert.deepEqual([...selectFirstEpisodes(episodes, 50)], [
    'episode-1',
    'episode-2',
    'episode-3',
    'episode-4',
    'episode-5',
  ]);
});

test('selectFirstEpisodes follows the current visible order', () => {
  const reversed = getOrderedEpisodes(episodes, REVERSE_LIST_ORDER);

  assert.deepEqual([...selectFirstEpisodes(reversed, 2)], [
    'episode-5',
    'episode-4',
  ]);
});
