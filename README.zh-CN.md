# ListenNotes Podcast Downloader

[English](README.md) | [简体中文](README.zh-CN.md)

当前版本：V2.0

## 项目简介

ListenNotes Podcast Downloader 是一个 Chrome 扩展，用于在 ListenNotes 播客详情页扫描剧集，并批量下载对应的音频文件。V2.0 重点完善了多语言界面、剧集选择、ZIP 打包、任务进度展示和错误提示。

本扩展适用于个人学习、研究和合法备份场景。

## 适用页面

- `https://www.listennotes.com/podcasts/*`
- `https://listennotes.com/podcasts/*`

## 主要功能

- 扫描 ListenNotes 播客详情页中的剧集。
- 将选中的剧集作为普通下载任务逐个下载。
- 将选中的剧集打包导出为一个 ZIP 文件。
- 支持全选、清空选择、选择当前可见列表前 N 集，以及切换列表顺序。
- 支持英文、简体中文、日文、西班牙文界面。
- 通过 RSS 条目、ListenNotes 页面数据、DOM 扫描和回退解析获取音频链接。
- 展示普通下载和 ZIP 下载的任务状态、字节进度、完成数量和失败详情。
- 支持取消当前 ZIP 任务、取消单个普通下载项，以及重置扩展状态。

## 安装方法

1. 运行 `npm install` 安装开发依赖。
2. 打开 Chrome，进入 `chrome://extensions/`。
3. 开启开发者模式。
4. 点击 `Load unpacked`。
5. 选择当前项目目录。
6. 打开支持的 ListenNotes 播客页面，然后点击浏览器工具栏中的扩展图标。

## 使用方法

1. 打开 ListenNotes 播客详情页。
2. 点击浏览器工具栏中的扩展图标。
3. 点击 `Scan` 扫描当前播客页。
4. 使用选择控件选择需要下载的剧集。
5. 点击 `Download` 进行普通批量下载，或点击 `Export ZIP` 生成一个压缩包。
6. 在弹窗中查看任务进度、失败数量、取消状态和错误提示。

## 开发命令

```bash
npm test
npm run check
npm run qa:cancel-click
```

- `npm test` 运行 Node 单元测试。
- `npm run check` 当前运行同一套 Node 测试。
- `npm run qa:cancel-click` 运行 Playwright 取消点击 QA 流程，并将本地输出写入 `test-results/`。

## 项目结构

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

## V2.0 亮点

- 新增英文、简体中文、日文、西班牙文界面支持。
- 新增剧集选择能力：全选、清空选择、选择前 N 集、切换列表顺序。
- 新增基于 offscreen document 和 vendored JSZip 的 ZIP 打包流程。
- 优化普通下载和 ZIP 下载的进度展示、状态恢复与取消能力。
- 优化音频链接解析，覆盖 RSS、ListenNotes 页面数据、DOM 扫描和回退解析。
- 优化网络失败、ZIP 连接关闭、缺失音频链接、任务冲突等场景的错误提示。
- 缩小 content script 注入范围，仅针对 ListenNotes 播客详情页。
- 增加 Node 单元测试和关键 helper 行为的 QA 覆盖。

## V2.1 Preview

V2.1 计划作为一个聚焦取消可靠性和弹窗稳定性的打磨版本。

- 展示单个剧集取消中的状态。
- 提升单个普通下载项在链接解析、音频抓取和浏览器下载阶段的取消可靠性。
- 对高频音频进度更新做节流，让弹窗在大文件下载时保持流畅。
- 状态刷新时保留剧集列表滚动位置。
- 优化管理窗口布局，使较宽的弹窗窗口能正确填满可用空间。
- 将“前 N 集”选择改为追加到当前选择，而不是替换当前选择。
- 增加取消状态、弹窗列表渲染和选择行为的 Node 单元测试。
- 增加取消点击流程的 Playwright QA 脚本。
- 通过 `.gitignore` 忽略 `node_modules/` 和 `test-results/`，避免本地依赖和 QA 输出被误提交。

## 插件头像提示词

可在 image2 中使用：

```text
A polished Chrome extension icon for a podcast downloader, square 1024x1024, modern vector-style app icon, a clean podcast microphone combined with a downward download arrow and subtle audio waveform rings, theme inspired by ListenNotes and podcast audio, dark midnight base with warm orange and soft lavender accents, high contrast, simple recognizable silhouette, centered composition, rounded app-icon feel, no text, no letters, no brand logos, no browser UI, crisp edges, suitable at 16px and 128px sizes
```

## 注意事项

本工具仅用于个人学习、研究和合法备份。请遵守 ListenNotes 的使用条款、播客版权要求以及你所在地区的相关法律法规。
