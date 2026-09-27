/** 应用菜单（中文）。所有交互都通过 IPC 命令交给渲染进程处理。 */
import { app, Menu, dialog } from 'electron';

export function buildMenu({ getSettings, getRecent, getWindow, getActiveKind, send, checkUpdate }) {
  const s = getSettings();
  const recent = getRecent();
  // PDF 没有「编码」概念，重新加载只对文本有意义
  const isPdf = getActiveKind?.() === 'pdf';

  const recentSubmenu = recent.length
    ? [
        ...recent.map((r) => ({ label: r.name, click: () => send('open-recent', r.path) })),
        { type: 'separator' },
        { label: '清除记录', click: () => send('clear-recent') },
      ]
    : [{ label: '（暂无）', enabled: false }];

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开 文本 / PDF…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', enabled: !isPdf, click: () => send('reload') },
        { label: '最近打开', submenu: recentSubmenu },
        { type: 'separator' },
        { label: '在文件夹中显示', click: () => send('reveal') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '阅读',
      submenu: [
        { label: '上一章', accelerator: 'CmdOrCtrl+PageUp', click: () => send('prev-chapter') },
        { label: '下一章', accelerator: 'CmdOrCtrl+PageDown', click: () => send('next-chapter') },
        { type: 'separator' },
        { label: '目录', accelerator: 'CmdOrCtrl+T', click: () => send('toc') },
        { label: '书签', accelerator: 'CmdOrCtrl+B', click: () => send('bookmark') },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { type: 'separator' },
        { label: '翻页模式', type: 'radio', checked: s.mode === 'paged', click: () => send('mode', 'paged') },
        { label: '滚动模式', type: 'radio', checked: s.mode === 'scroll', click: () => send('mode', 'scroll') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '日间', type: 'radio', checked: s.theme === 'light', click: () => send('theme', 'light') },
        { label: '护眼', type: 'radio', checked: s.theme === 'sepia', click: () => send('theme', 'sepia') },
        { label: '夜间', type: 'radio', checked: s.theme === 'dark', click: () => send('theme', 'dark') },
        { label: '墨绿', type: 'radio', checked: s.theme === 'moss', click: () => send('theme', 'moss') },
        { label: '自定义', type: 'radio', checked: s.theme === 'custom', click: () => send('theme', 'custom') },
        { type: 'separator' },
        { label: '放大字号', accelerator: 'CmdOrCtrl+=', click: () => send('font', 1) },
        { label: '缩小字号', accelerator: 'CmdOrCtrl+-', click: () => send('font', -1) },
        { label: '阅读设置', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => checkUpdate() },
        { type: 'separator' },
        { label: '快捷键', click: () => send('help') },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(getWindow(), {
              type: 'info',
              title: '关于',
              message: `TXT 阅读器 ${app.getVersion()}`,
              detail:
                '本地 TXT / PDF 阅读器\n' +
                '· 自动识别 GB18030/GBK、Big5、UTF-8、UTF-16 编码\n' +
                '· 章节目录、书签、全文查找（PDF 走大纲与页号）\n' +
                '· PDF 原样渲染（pdf.js），缩放 50%–300%\n' +
                '· 翻页/滚动两种模式，阅读进度自动记忆',
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
