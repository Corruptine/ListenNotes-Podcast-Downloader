# ListenNotes Podcast Downloader

[English](README.md) | [简体中文](README.zh-CN.md)

Current version: V2.0

## Overview

ListenNotes Podcast Downloader is a Chrome extension for scanning ListenNotes podcast detail pages and batch downloading episode audio files. V2.0 focuses on localized UI, episode selection, ZIP packaging, task progress, and clearer error handling.

The extension is intended for personal learning, research, and lawful backup workflows.

## Supported Pages

- `https://www.listennotes.com/podcasts/*`
- `https://listennotes.com/podcasts/*`

## Features

- Scan episodes from ListenNotes podcast detail pages.
- Download selected episodes individually.
- Package selected episodes into one ZIP archive.
- Select all episodes, clear selection, select the first N visible episodes, and switch list order.
- Use localized UI in English, Simplified Chinese, Japanese, and Spanish.
- Resolve audio links through RSS entries, ListenNotes page data, DOM scanning, and fallback parsing.
- Show task state, byte progress, completed counts, and failure details for regular and ZIP downloads.
- Cancel the current ZIP task, cancel individual regular download items, and reset extension state.

## Installation

1. Run `npm install` to install development dependencies.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select this project folder.
6. Open a supported ListenNotes podcast page and click the extension icon.

## Usage

1. Open a ListenNotes podcast detail page.
2. Click the extension icon in the browser toolbar.
3. Click `Scan` to scan the current podcast page.
4. Choose episodes with the selection controls.
5. Click `Download` for regular batch downloads, or `Export ZIP` to generate one archive.
6. Watch task progress, failed counts, cancellation state, and error messages in the popup.

## Development Commands

```bash
npm test
npm run check
npm run qa:cancel-click
```

- `npm test` runs the Node unit tests.
- `npm run check` currently runs the same Node test suite.
- `npm run qa:cancel-click` runs the Playwright cancellation-click QA flow and writes local output under `test-results/`.

## Project Structure

```text
listennotes-podcast-downloader/
├── manifest.json
├── popup/
├── src/
├── offscreen/
├── _locales/
├── vendor/
├── scripts/
├── tests/
├── package.json
├── README.md
└── README.zh-CN.md
```

## V2.0 Highlights

- Added localized UI support for English, Simplified Chinese, Japanese, and Spanish.
- Added episode selection controls: select all, clear selection, first N, and list order switching.
- Added ZIP packaging through an offscreen document and vendored JSZip.
- Improved regular and ZIP download progress, state recovery, and cancellation.
- Improved audio URL resolution through RSS, ListenNotes page data, DOM scanning, and fallback parsing.
- Improved error messages for network failures, ZIP connection closures, missing audio links, and task conflicts.
- Narrowed content script injection to ListenNotes podcast detail pages only.
- Added Node unit tests and QA coverage for important helper behavior.

## V2.1 Preview

V2.1 is planned as a focused polish release around cancellation reliability and popup stability.

- Show per-episode cancellation state while an item is being cancelled.
- Cancel individual regular download items more reliably across URL resolution, audio fetching, and browser download stages.
- Throttle high-frequency audio progress updates so the popup remains responsive during large downloads.
- Preserve episode-list scroll position during status refreshes.
- Improve manager-window layout so the wider popup window fills available space correctly.
- Make `First N` selection add to the current selection instead of replacing it.
- Add Node unit tests for cancellation state, popup list rendering, and selection behavior.
- Add a Playwright QA script for the cancel-click flow.
- Ignore local dependency and QA output folders with `.gitignore` entries for `node_modules/` and `test-results/`.

## Icon Prompt

Use this with image2:

```text
A polished Chrome extension icon for a podcast downloader, square 1024x1024, modern vector-style app icon, a clean podcast microphone combined with a downward download arrow and subtle audio waveform rings, theme inspired by ListenNotes and podcast audio, dark midnight base with warm orange and soft lavender accents, high contrast, simple recognizable silhouette, centered composition, rounded app-icon feel, no text, no letters, no brand logos, no browser UI, crisp edges, suitable at 16px and 128px sizes
```

## Disclaimer

This tool is intended for personal learning, research, and lawful backup only. Follow ListenNotes terms of service, podcast copyright rules, and all applicable laws in your region.
