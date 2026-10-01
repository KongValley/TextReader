# 更新日志

本项目的所有重要变更都记录在此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- EPUB 阅读：`Ctrl+O` / 拖拽 / 命令行 / 书架均可打开 `.epub`。主进程零新依赖解析（`node:zlib.inflateRawSync` 解 ZIP + 自写 XML tokenizer），按 spine 抽取正文并按目录生成章节表——目录取 EPUB3 `nav`，无效时回退 NCX，再无则用 TXT 同款标题识别兜底；`#锚点` 精确章节定位、同偏移去重、标题行去重。解析结果与 TXT 同构（`text` + `chapters`），主题/字体/字号/版心/划线/书签/查找/进度记忆/自动阅读全部自动生效；不被目录引用的封面页、导航页不进入正文。
- EPUB 打开后工具栏显示 `EPUB` 标记，「设置」里的编码选择对 EPUB 隐藏（其余文本设置保留）；关于对话框、欢迎页、书架文案同步说明 EPUB。

### 工程

- `src/shared/chapters.js` 抽出 `splitLongChapters`（TXT 与 EPUB 共用的超长章再切分），行为与原内联实现一致。
- 新增 `test/epub.test.js`（10 项）、`scripts/epub-fixtures.mjs`（手写 ZIP 样本）与 4 个 fixture；冒烟新增场景 11b（打开、目录、段落渲染、状态栏、翻页、查找、书签、进度记忆、损坏报错）与截图 `30-epub.png` / `31-epub-reopen.png`。

## [1.3.1] - 2026-09-29

### 文档

- README 更新：补充「使用说明」入口、数据文件存放位置（`%APPDATA%\TXT阅读器\state.json`，便携版与安装版共用同一份）与发布流程说明。
- 新增本 CHANGELOG。

## [1.3.0] - 2026-09-29

### 新增

- 帮助菜单新增「使用说明」：内置用法指南（打开与书架、目录与跳转、划线与查找、阅读模式、自动阅读与久坐提醒、进度记忆、更新检查），与「快捷键」列表互斥显示。

### 工程

- 新增 GitHub Actions 发布工作流：打 tag 推送即在 GitHub 服务器上打包并自动发布 Release（安装包 / 便携版 / blockmap / `latest.yml`）；支持手动触发，只打包不发 Release。

## [1.2.0] - 2026-09-29

### 新增

- 书架体验增强：根视图显示每个文件夹的存书数与「最近在读」；目录内已读的书按最近阅读排序；书架行右键菜单（在资源管理器中显示 / 刷新该目录 / 从书架移除）；把文件夹拖进窗口即可加入书架。
- 阅读中一键返回书架：工具栏「书架」按钮；`Esc` 分层——先关密码框 / 面板，面板全关时再按才返回书架，全屏下先退全屏；返回时自动保存阅读进度与时长。
- 本版一并带上此前累积的改进：划线与复制、自动阅读（`F5`）、窗口置顶（`Ctrl+Shift+T`）、阅读时长统计、久坐提醒、鼠标侧键翻页、`Alt+←` 跳转回退、书签重命名、进度条拖动跳转、标题栏随主题变色、自定义主题与中英字体分开设置等。

## [1.1.0] - 2026-09-27

### 新增

- 检查更新：菜单「帮助 > 检查更新…」手动比对 GitHub Releases 的最新版本（平时不联网）；发现新版本时可一键在浏览器下载最新安装包，或打开发布页自行选择。
- 新增「墨绿」主题：主题由三选一变为四选一（日间 / 护眼 / 夜间 / 墨绿）。

### 变更

- 关于对话框改为显示运行时版本号，不再写死。

## [1.0.0] - 2026-09-27

### 新增

- 首个正式版本：TXT 阅读——编码自动识别（GB18030/GBK、Big5、UTF-8、UTF-16）、章节切分与可跳转目录、翻页（CSS 多列）/ 滚动两种模式、阅读设置（字体 / 字号 / 行距 / 字距 / 版心 / 对齐 / 主题）、书签与全文查找、进度记忆与「同名同大小继承」。
- PDF 阅读：内置 pdf.js 原样渲染（缩放 50%–300% 与适应窗口、大纲目录、文本层选中复制、跨页查找与高亮框、书签、加密 PDF 密码解锁）。

[1.3.1]: https://github.com/KongValley/TextReader/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/KongValley/TextReader/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/KongValley/TextReader/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/KongValley/TextReader/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/KongValley/TextReader/releases/tag/v1.0.0
