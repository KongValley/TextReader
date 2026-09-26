/** 共享常量：主进程与渲染进程共用，避免两处默认值漂移。 */

export const DEFAULT_SETTINGS = {
  theme: 'sepia',
  mode: 'paged',
  fontSize: 19,
  lineHeight: 1.9,
  letterSpacing: 0.02,
  fontFamily: 'system',
  contentWidth: 780,
  justify: true,
  pdfScale: 0,
};

/** PDF 缩放：0 = 适应窗口（默认），其余为用户手动比例（Ctrl+= / Ctrl+- 每次 0.1）。 */
export const PDF_SCALE = { min: 0.5, max: 3, step: 0.1, auto: 0 };

export const THEMES = [
  { id: 'light', label: '日间' },
  { id: 'sepia', label: '护眼' },
  { id: 'dark', label: '夜间' },
];

export const THEME_LABEL = Object.fromEntries(THEMES.map((t) => [t.id, t.label]));

export const MODE_LABEL = { paged: '翻页', scroll: '滚动' };

export const FONTS = [
  { id: 'system', label: '系统默认', stack: 'system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif' },
  { id: 'song', label: '宋体', stack: '"Songti SC", SimSun, "Noto Serif SC", serif' },
  { id: 'kai', label: '楷体', stack: 'KaiTi, "Kaiti SC", STKaiti, "Noto Serif SC", serif' },
  { id: 'hei', label: '黑体', stack: 'SimHei, "Heiti SC", "Microsoft YaHei", sans-serif' },
  { id: 'fangsong', label: '仿宋', stack: 'FangSong, "FangSong SC", STFangsong, serif' },
  { id: 'yahei', label: '微软雅黑', stack: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif' },
];

export const FONT_STACK = Object.fromEntries(FONTS.map((f) => [f.id, f.stack]));
