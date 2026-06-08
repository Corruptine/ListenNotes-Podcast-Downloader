# ListenNotes Podcast Downloader

[English](README.md) | [简体中文](README.zh-CN.md)

Current version: V2.1

## Overview

ListenNotes Podcast Downloader is a Chrome extension for scanning ListenNotes podcast detail pages and batch downloading episode audio files. V2.1 improves cancellation feedback, popup stability, and episode selection while keeping the V2.0 localization and ZIP download workflow.

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
- Find available audio links from the podcast page automatically.
- Show task state, byte progress, completed counts, and failure details for regular and ZIP downloads.
- Cancel the current ZIP task, cancel individual regular download items, and reset extension state.

## Usage

After installing the extension, open a supported ListenNotes podcast page and click the extension icon in the browser toolbar.

1. Click `Scan` to scan the current podcast page.
2. Choose episodes with the selection controls.
3. Click `Download` for regular batch downloads, or `Export ZIP` to generate one archive.
4. Watch task progress, failed counts, cancellation state, and error messages in the popup.

## V2.0 New Features

- Added localized UI support for English, Simplified Chinese, Japanese, and Spanish.
- Added episode selection controls: select all, clear selection, first N, and list order switching.
- Added ZIP downloads for selected episodes.
- Improved regular and ZIP download progress, state recovery, and cancellation.
- Improved automatic audio link detection.
- Improved error messages for network failures, ZIP connection closures, missing audio links, and task conflicts.

## V2.1 New Features

- Cancel individual episode downloads directly from the episode list.
- See a clear cancelling state for episodes that are being stopped.
- Keep the episode list steadier while download progress updates.
- Keep your scroll position when the episode list refreshes.
- Use an improved manager-window layout for longer download sessions.
- Add the first N visible episodes to the current selection instead of replacing it.

## Disclaimer

This tool is intended for personal learning, research, and lawful backup only. Follow ListenNotes terms of service, podcast copyright rules, and all applicable laws in your region.
