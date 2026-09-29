# TXT 阅读器

Electron 写的本地 TXT / PDF 阅读器。打开即读，自动识别中文编码，按章节切分、翻页/滚动阅读，记住每本书的阅读位置；PDF 用内置的 pdf.js 原样渲染。

![阅读界面](docs/screenshot-reading.png)

| 夜间主题 + 阅读设置 | 章节目录 | 全文查找 |
| --- | --- | --- |
| ![夜间](docs/screenshot-dark.png) | ![目录](docs/screenshot-toc.png) | ![查找](docs/screenshot-search.png) |

## 功能

- **编码自动识别**：BOM → 无 BOM 的 UTF-16（NUL 位序）→ 严格 UTF-8 → GB18030/GBK/GB2312 与 Big5 打分择优；识别不准时可在「设置」里手动指定编码并重新加载。
- **章节目录**：识别 `第 N 章/节/回/卷/部/篇/集/话`、`序章`、`楔子`、`番外`、`终章` 等标题行，也识别网络小说常见的纯编号标题 `001 一切都那么美好`（要求编号构成连续递增序列，≥5 章才采信，避免把正文里的“5 分钟后”当成标题）；生成可跳转目录。无标题的纯文本按 4000 字自动分段，超长章节（>6 万字）自动再切分。
- **两种阅读模式**：翻页（CSS 多列分页，`←/→`、空格、点击左右两侧、滚轮翻页）与滚动（滚到底自动进入下一章）。
- **阅读设置**：主题（日间/护眼/夜间/墨绿/自定义——自定义可选基座预设并调整背景、正文、次级文字、面板、强调、高亮六个核心色）、字体（中文字体/英文字体分开设置，两栏都可用「系统已装字体列表」下拉搜索，留空即系统默认）、字号、行距、字距、版心宽度、两端对齐，全部即时生效并保存。
- **书签与全文查找**：`Ctrl+B` 收藏当前页（记录章节 + 段落 + 预览），书签列表内可重命名（✎ 行内编辑，Enter 提交 / Esc 取消），`Ctrl+F` 全文查找、上一处/下一处跳转并高亮命中。
- **进度记忆**：按文件路径记录章节、页内比例与全书百分比，下次打开自动回到原处并提示「已恢复到上次位置」；最近阅读列表可一键打开或移除。**文件被移动/改名后，同名同大小的新文件会自动沿用原进度与书签**（打开时提示「已沿用原阅读记录（第 N 章）」）。底部进度条可点击 / 拖动，按全书比例直达（PDF 等比跳页）。
- **舒适细节**：鼠标侧键翻页（后退 / 前进键，TXT 与 PDF 通用）；`Alt+←` 回退跳转；自动翻章时提示章节名；进度条悬停预览该位置章节 / 页码；久坐提醒（设置中开启，默认关，连续阅读 45 分钟提示休息）；最近列表显示上次阅读时间。
- **划线与复制**：选中正文后 `Ctrl+H` 或右键「划线」，高亮随书持久化，侧边「划线」面板可跳转 / 删除（仅 TXT，PDF 保持原样渲染）；右键菜单按场景给出复制 / 剪切 / 粘贴 / 划线 / 全选，主菜单「编辑」组修复了选中文本的 `Ctrl+C` 复制。
- **自动阅读**：菜单「阅读 > 自动阅读」或 `F5` 开关——滚动模式平滑滚屏、翻页模式定时翻页，`+` / `-` 或设置面板调速（20–200px/s），任意手动操作自动停止。
- **窗口置顶**：菜单「视图 > 窗口置顶」或 `Ctrl+Shift+T`，阅读小窗钉在最上层，状态持久化。
- **阅读时长**：按书累计（闲置 5 分钟暂停计时），状态栏满 1 分钟后显示「已读 X 分钟」。
- **标题栏跟随主题**：无边框标题栏 + 系统 overlay 按钮随主题变色（夜间不再白条刺眼）；标题栏可拖动窗口，菜单栏改 `Alt` 呼出；最近列表每项显示该书阅读进度百分比。
- **PDF 阅读**：内置 pdf.js 原样渲染（不做重排/水印/批注），默认按窗口适应整页显示，`Ctrl+=` / `Ctrl+-` 缩放（50%–300%）、`Ctrl+0` 适应窗口；翻页/滚动两种模式与 TXT 一致；PDF 大纲自动变成可跳转目录（没有大纲时提示「暂无目录」）；文字可选中复制；全文查找命中后跳到对应页并画出高亮框；书签记录页号与该页文字快照；加密 PDF 弹出密码框（输错会提示重试，取消则保持当前文档），验证通过的密码只记在内存里，同一次运行内再打开不再询问。PDF 的阅读位置与书签同样走「同名同大小继承」。
- **书架**：欢迎页可把多个小说目录加入书架（可多选、可移除、可拖文件夹入窗口直接加入，只移出书架不删文件），根视图每个文件夹显示存书数与最近在读；进入目录后已读的按最近阅读排序，点开文件夹逐层浏览，点书名直接阅读；「刷新」重扫目录变化；书架行右键可「在资源管理器中显示 / 刷新该目录 / 从书架移除」。阅读中按工具栏「书架」按钮或 `Esc`（先关面板、再按才返回）回到书架。
- **拖拽打开**、命令行参数打开（`TXTReader.exe "D:\书\某小说.txt"`、`TXTReader.exe "D:\报告.pdf"`）、单实例（再次打开文件会聚焦已有窗口）。
- **检查更新**：菜单「帮助 > 检查更新…」与 GitHub Releases 的最新版本比对（仅手动触发，平时不联网）；有新版本时可直接在浏览器下载最新安装包。
- **使用说明**：菜单「帮助 > 使用说明」内置用法指南（打开与书架、目录与跳转、划线与查找、阅读模式、自动阅读与久坐提醒、进度记忆、更新检查），与「快捷键」列表互斥显示，一次只看一种。

## 使用

```bash
npm install
npm start          # 开发运行
```

> 已构建的版本见 [Releases](https://github.com/KongValley/TextReader/releases)：`TXTReader-<版本>-setup.exe`（安装包）与 `TXTReader-<版本>-portable.exe`（便携版，Windows 10/11 x64，未做代码签名）。

> npm 12 起默认拦截依赖的 install 脚本，`electron` 的二进制不会自动下载。若 `npm start` 报 “Electron failed to install correctly”，执行一次 `npm run electron:install` 即可（本仓库已下载完成，无需重复）。

窗口标题栏菜单：文件 / 阅读 / 视图 / 帮助。

数据文件：窗口位置、设置、书架目录、最近列表与每本书的进度 / 书签 / 划线 / 阅读时长都保存在 `%APPDATA%\TXT阅读器\state.json`；便携版与安装版共用同一份（数据不随 exe 走）。各版本变更见 [CHANGELOG.md](CHANGELOG.md)。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl+O` | 打开文件（文本 / PDF） |
| `Ctrl+T` / `Ctrl+F` / `Ctrl+B` / `Ctrl+,` | 目录 / 查找 / 添加书签 / 阅读设置 |
| `←` `→` `空格` `PgUp` `PgDn` | 翻页（滚动模式下为翻屏） |
| `↑` `↓` | 翻页模式翻页；滚动模式逐行滚动，到顶/到底进入上/下一章（PDF 为上/下一页） |
| `Home` / `End` | 全书第一章 / 最后一章（PDF 为首 / 末页） |
| `Ctrl+PageUp` / `Ctrl+PageDown` | 上一章 / 下一章（PDF 为上 / 下一页） |
| `Ctrl+=` / `Ctrl+-` | 放大 / 缩小字号（PDF 为缩放） |
| `Ctrl+0` | PDF 适应窗口 |
| `Ctrl+滚轮` | TXT 字号 / PDF 缩放 |
| `Alt+←` | 返回上次跳转前位置（目录 / 书签 / 查找 / 进度条 / Home / End 跳转均可回退） |
| `Ctrl+H` | 划线选中的正文（TXT），右键「取消划线」 |
| `F5` | 自动阅读开 / 关（`+` / `-` 调速，任意操作停止） |
| `Ctrl+Shift+T` | 窗口置顶开 / 关 |
| `Enter` / `Esc` | 密码框：解锁 / 取消（加密 PDF） |
| `F11` / `Esc` | 全屏沉浸（工具栏/状态栏自动隐藏，鼠标移到顶部/底部唤出）/ 关闭面板；阅读中面板全关时再按 `Esc` 返回书架 |

## 打包

```bash
npm run pack       # 免安装目录：dist/win-unpacked/
npm run dist       # 安装包 + 便携版：dist/TXTReader-<版本>-setup.exe、TXTReader-<版本>-portable.exe
npm run icon       # 重新生成 build/icon.png 与 build/icon.ico（纯 Node，无第三方依赖）
```

打包会把 pdf.js 一并收进 `app.asar`（只保留用得到的 `build/pdf.mjs`、`build/pdf.worker.min.mjs`、`cmaps/`、`standard_fonts/`、`wasm/`、`iccs/`，见 `electron-builder.yml`），asar 约 5.4MB、安装包体积比纯 TXT 版大约 +6MB。

## 发布

改好 `package.json` 版本并提交后，打 tag 推送即可，GitHub Actions 会在服务器上打包并自动发布 Release（安装包 / 便携版 / blockmap / `latest.yml`，应用内更新直接可用）：

```bash
npm version 1.3.1 --no-git-tag-version && git commit -am "发布 v1.3.1" && git push
git tag v1.3.1 && git push origin v1.3.1
```

工作流见 `.github/workflows/release.yml`；版本号与 tag 不一致会直接报错终止。也可以在 Actions 页手动触发（只打包，产物作为 workflow artifact 下载，不发 Release）。

## 测试

```bash
npm test           # 单元测试：编码探测、章节切分、PDF 打开链路与大纲解析（node:test）
npm run smoke      # 端到端冒烟：真实 Electron 窗口里跑完整交互，截图输出到 shots/
TXT_SMOKE_REAL="D:\书\某小说.txt" npm run smoke   # 额外用你自己的书跑一遍并截图
node scripts/gen-fixtures.mjs   # 重新生成测试样本（编码样本需要 Windows PowerShell）
```

冒烟测试用独立的 `--user-data-dir` 运行，不会污染真实配置；它会依次验证 GBK / UTF-8+CRLF 无标题 / UTF-16LE / Big5 文件的识别与渲染、翻页与滚动、目录跳转、书签、查找、字号与主题切换、进度记忆、窗口缩放重排，并把每一步截图写入 `shots/`。

PDF 部分用的是内置手写样本 `test/fixtures/outline.pdf`（2 页 + 3 级大纲 + 可查找标记串）与 `test/fixtures/locked.pdf`（同一份内容、按 PDF 规范 V1/R2 真加密，密码见 `scripts/pdf-fixtures.mjs` 的 `LOCKED_PDF_PASSWORD`）。冒烟覆盖：画布真的画出了内容（逐像素找暗点）、文本层可选中、大纲目录与页号跳转、翻页/滚动、缩放与「适应窗口」、查找命中与高亮框、书签、进度记忆、主题切换后纸面仍为白色；加密 PDF 走完整密码链路（弹框 → 输错提示重试 → 输对解锁并解出大纲/正文/查找 → 同一次运行内重开不再询问 → 取消则保持当前文档）；损坏文件给出提示且不影响当前文档。若本地存在 `test/fixtures/sample.pdf`（真实中文 PDF，**不入库**，见 `.gitignore`），会额外跑一遍中文渲染与中文查找；缺这个文件时该用例自动跳过。

实测：13.5MB、486 万字、1733 章的真实网络小说，编码探测 + 切分合计约 50ms，翻页与目录跳转无卡顿。

## 目录结构

```
src/
  main/
    main.js       主进程：窗口、app:// 协议（含 /vendor/pdfjs/ 映射）、IPC、命令行参数
    encoding.js   编码探测与解码（含 GB18030/Big5 打分）
    pdf.js        PDF 打开路径：读字节 + 记录进度（解析交给渲染进程的 pdf.js）
    store.js      userData/state.json 持久化（窗口、设置、最近、每本书进度与书签）
    menu.js       中文应用菜单
  preload/
    preload.cjs   contextBridge 白名单 API（渲染进程无 Node 权限）
  renderer/
    index.html / app.css / app.js   阅读界面与翻页引擎（TXT / PDF 共用外壳）
    pdf/pdf-view.js                 PDF 视图：canvas 渲染、文本层、虚拟化、缩放、查找高亮
    pdf/outline.js                  大纲拍平与 dest → 页号解析（纯逻辑，可单测）
  shared/
    chapters.js   章节切分（纯函数，主进程/渲染/测试共用）
    settings.js   默认设置、字体主题常量、PDF 缩放常量
test/             单元测试与样本（outline.pdf / locked.pdf 入库；sample.pdf 仅本地）
scripts/          冒烟测试、样本生成（pdf-fixtures.mjs 手写 PDF 与 RC4 加密）、图标生成
```

## 实现要点

- 渲染层通过自定义 `app://` 协议加载（`file://` 下 ES module 会被 CORS 拦），并带 CSP，禁用 `nodeIntegration`、开启 `contextIsolation` 与 `sandbox`。
- 正文一律用 `textContent` 注入，不拼接 HTML。
- 分页用 CSS 多列：`column-width = 版心宽度`、`column-fill: auto`，通过 `scrollLeft = 页号 × (列宽 + 列间距)` 翻页；窗口缩放、字号/版心变化时按页内比例保持位置。
- 只渲染当前章（大文件不整本入 DOM），查找与书签基于全局字符偏移映射到「章 → 段 → 段内偏移」。
- 查找高亮使用 CSS Custom Highlight API，不修改 DOM 结构。
- PDF 走 `app://local/vendor/pdfjs/`：主进程把 `node_modules/pdfjs-dist` 的只读子集映射进同一个协议（`.mjs`/`.wasm` 显式给 MIME），worker 与主模块同源加载，CSP 只需 `worker-src 'self'`；cmaps/标准字体/wasm 由主线程取回后转交 worker，所以额外放行 `connect-src 'self'`。`isEvalSupported: false` 避免 pdf.js 去 `new Function`（CSP 无 `unsafe-eval`）。
- PDF 渲染：canvas 按 `devicePixelRatio` 放大绘制，叠 pdf.js `TextLayer` 提供选中/复制；只为当前页前后各 2 页保留画布，其余页保留占位尺寸（滚动条与页码计算稳定）；翻页模式用 `translateX` 平移并只显示当前页，滚动模式用原生纵向滚动 + 滚动位置反推当前页。
- PDF 查找：`getTextContent` 逐页拼接成串做 `indexOf` 推进，命中映射回 item 几何，用绝对定位的半透明框画高亮（跨 item 的命中拆成多个框），不依赖 CSS Highlight API。
- PDF 进度复用同一套持久化字段（`chapterIndex` 存页号、`percent` 存全书百分比），因此「同名同大小继承」对 TXT 与 PDF 一视同仁。
- PDF 密码：pdf.js 只认挂在 `loadingTask` 上的 `onPassword`（写在 `getDocument` 参数里不生效），回调里给字符串就重试、给 `Error` 就放弃加载；取消时 pdf.js 只会抛 `PasswordException("No password given")`，所以「用户是否取消」由界面自己记。验证通过的密码只放在渲染进程内存里（`Map<路径, 密码>`），不写入 `state.json`，重开进程需要重新输入。

## 已知限制

- 文本支持 `.txt/.text/.log/.md`；PDF 只支持本地 `.pdf`，不做在线解析、重排、批注与水印处理。
- 加密 PDF 支持输入密码解锁（密码只在本进程内存里记着，不写入 `state.json`）；证书/公钥等非 Standard 安全处理器不支持。
- 扫描件（纯图片）没有文字层，查找与选中不可用。
- TXT 单文件上限 256MB；PDF 上限 100MB（整份字节经 IPC 交给渲染进程）。
- PDF 缩放范围 50%–300%，页内旋转文字只跳转不画查找高亮框。
- Shift_JIS、EUC-KR 等非中文编码不在自动识别范围内（可在设置里手动选择 UTF-8/GB18030/Big5/UTF-16）。
- 翻页模式下目录/设置抽屉是浮层，会遮住部分正文（关闭后恢复）。
