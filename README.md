# ListenNotes Podcast Downloader

Current version: V2.0

## 中文说明

### 项目简介

ListenNotes Podcast Downloader 是一个 Chrome 扩展，用于在 ListenNotes 播客详情页扫描剧集，并批量下载对应的音频文件。V2.0 重点优化了多语言界面、剧集选择、ZIP 打包下载、任务进度和错误提示，适合在发布目录中直接加载或提交到 Chrome 扩展发布流程。

### 适用页面

- `https://www.listennotes.com/podcasts/*`
- `https://listennotes.com/podcasts/*`

### 主要功能

- 自动扫描 ListenNotes 播客详情页中的剧集。
- 支持普通批量下载和 ZIP 打包下载。
- 支持全选、清空、选择前 N 集和列表顺序切换。
- 支持英文、简体中文、日文、西班牙文界面。
- 自动解析音频链接，覆盖 RSS、ListenNotes 页面接口、DOM 扫描和回退解析。
- 显示普通下载与 ZIP 下载的任务状态、字节进度和失败信息。
- 支持取消当前任务、取消单个下载项和重置状态。

### 安装方法

1. 运行 `npm install` 安装依赖。
2. 运行 `npm run check` 确认项目检查通过。
3. 运行 `npm run package` 生成发布目录。
4. 打开 Chrome，进入 `chrome://extensions/`。
5. 开启右上角的开发者模式。
6. 点击“加载已解压的扩展程序”。
7. 选择 `dist/listennotes-podcast-downloader` 目录。

### 使用方法

1. 打开 ListenNotes 播客详情页。
2. 点击浏览器工具栏中的扩展图标。
3. 点击 `Scan` 扫描当前播客剧集。
4. 按需选择剧集：全部、清空、前 N 集或切换列表顺序。
5. 点击 `Download` 进行普通批量下载，或点击 `ZIP` 生成打包下载。
6. 在弹窗中查看任务进度、失败数量和错误提示。

### 发布目录说明

执行 `npm run package` 后，会生成：

```text
dist/listennotes-podcast-downloader
```

该目录是本次发布使用的最终扩展目录，包含：

- `manifest.json`
- `src/`
- `popup/`
- `offscreen/`
- `_locales/`
- `vendor/`
- `README.md`

发布目录不应包含 `node_modules/`、`.playwright-mcp/`、`test-results/`、测试报告或临时缓存。

### 项目结构

```text
listennotes-podcast-downloader/
├── manifest.json
├── popup/
├── src/
├── offscreen/
├── _locales/
├── vendor/
├── test/
├── e2e/
├── package.json
└── README.md
```

### V2.0 优化点

- 新增多语言界面：英文、简体中文、日文、西班牙文。
- 新增剧集选择能力：全选、清空、选择前 N 集、列表顺序切换。
- 新增 ZIP 打包下载流程，使用 offscreen document 和 vendored JSZip。
- 优化普通下载与 ZIP 下载的进度展示、状态恢复和取消能力。
- 优化音频链接解析，支持 RSS、ListenNotes 页面接口、DOM 扫描和回退解析。
- 优化错误提示，覆盖网络失败、ZIP 连接关闭、无音频链接、任务冲突等场景。
- 缩小 content script 注入范围，仅针对 ListenNotes 播客详情页。
- 增加 Node 单元测试、包资源检查和 Playwright E2E 测试配置。

### 测试与打包命令

```bash
npm run check
npm run package
```

### 注意事项

本工具仅用于个人学习、研究和合法备份。请遵守 ListenNotes 的使用条款、播客版权要求以及你所在地区的相关法律法规。

---

## English

### Overview

ListenNotes Podcast Downloader is a Chrome extension for scanning ListenNotes podcast detail pages and batch downloading episode audio files. V2.0 improves localization, episode selection, ZIP packaging, task progress, and error handling, making the generated release folder ready for local loading or extension publishing workflows.

### Supported Pages

- `https://www.listennotes.com/podcasts/*`
- `https://listennotes.com/podcasts/*`

### Features

- Scan episodes from ListenNotes podcast detail pages.
- Download selected episodes individually or package them into one ZIP file.
- Select all episodes, clear selection, select the first N episodes, and switch list order.
- Localized UI for English, Simplified Chinese, Japanese, and Spanish.
- Resolve audio links through RSS, ListenNotes page endpoints, DOM scanning, and fallback parsing.
- Show task state, byte progress, completed counts, and failure details for regular and ZIP downloads.
- Cancel the current task, cancel individual download items, and reset extension state.

### Installation

1. Run `npm install` to install dependencies.
2. Run `npm run check` to verify the project.
3. Run `npm run package` to generate the release folder.
4. Open Chrome and go to `chrome://extensions/`.
5. Enable Developer mode.
6. Click `Load unpacked`.
7. Select `dist/listennotes-podcast-downloader`.

### Usage

1. Open a ListenNotes podcast detail page.
2. Click the extension icon in the browser toolbar.
3. Click `Scan` to scan the current podcast page.
4. Choose episodes with all, clear, first N, or list order controls.
5. Click `Download` for regular batch downloads, or `ZIP` to generate one archive.
6. Watch task progress, failed counts, and error messages in the popup.

### Release Folder

After running `npm run package`, the release folder is:

```text
dist/listennotes-podcast-downloader
```

It contains only the extension resources needed for release:

- `manifest.json`
- `src/`
- `popup/`
- `offscreen/`
- `_locales/`
- `vendor/`
- `README.md`

The release folder should not include `node_modules/`, `.playwright-mcp/`, `test-results/`, reports, or temporary caches.

### Project Structure

```text
listennotes-podcast-downloader/
├── manifest.json
├── popup/
├── src/
├── offscreen/
├── _locales/
├── vendor/
├── test/
├── e2e/
├── package.json
└── README.md
```

### V2.0 Improvements

- Added localized UI support for English, Simplified Chinese, Japanese, and Spanish.
- Added episode selection controls: all, clear, first N, and list order switching.
- Added ZIP packaging through an offscreen document and vendored JSZip.
- Improved regular and ZIP download progress, state recovery, and cancellation.
- Improved audio URL resolution through RSS, ListenNotes page endpoints, DOM scanning, and fallback parsing.
- Improved error messages for network failures, ZIP connection closures, missing audio links, and task conflicts.
- Narrowed content script injection to ListenNotes podcast detail pages only.
- Added Node unit tests, package resource checks, and Playwright E2E configuration.

### Test and Package Commands

```bash
npm run check
npm run package
```

### Disclaimer

This tool is intended for personal learning, research, and lawful backup only. Follow ListenNotes terms of service, podcast copyright rules, and all applicable laws in your region.
