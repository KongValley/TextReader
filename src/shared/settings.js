/** 共享常量：主进程与渲染进程共用，避免两处默认值漂移。 */

export const DEFAULT_SETTINGS = {
  theme: 'sepia',
  mode: 'paged',
  fontSize: 19,
  lineHeight: 1.9,
  letterSpacing: 0.02,
  fontCjk: '',
  fontLatin: '',
  contentWidth: 780,
  justify: true,
  pdfScale: 0,
  customThemeBase: '',
  customThemeColors: {},
  restReminder: false,
  autoScrollSpeed: 60,
  alwaysOnTop: false,
  shelfDirs: [],
};

/** PDF 缩放：0 = 适应窗口（默认），其余为用户手动比例（Ctrl+= / Ctrl+- 每次 0.1）。 */
export const PDF_SCALE = { min: 0.5, max: 3, step: 0.1, auto: 0 };

export const THEMES = [
  { id: 'light', label: '日间' },
  { id: 'sepia', label: '护眼' },
  { id: 'dark', label: '夜间' },
  { id: 'moss', label: '墨绿' },
  { id: 'custom', label: '自定义' },
];

export const THEME_LABEL = Object.fromEntries(THEMES.map((t) => [t.id, t.label]));

export const MODE_LABEL = { paged: '翻页', scroll: '滚动' };

/** 可作自定义基座的预设主题 id 集合（'custom' 自身不能做基座）。 */
export const THEME_BASE_IDS = ['light', 'sepia', 'dark', 'moss'];

/** 自定义主题可编辑的 6 个核心变量（其余跟随基座）。 */
export const CUSTOM_THEME_VARS = [
  { var: '--bg', label: '背景' },
  { var: '--fg', label: '正文' },
  { var: '--fg-soft', label: '次级文字' },
  { var: '--panel', label: '面板' },
  { var: '--accent', label: '强调' },
  { var: '--hl', label: '高亮' },
];

/** 是否为合法的 6 位 hex 颜色。 */
export const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/** 自定义基座 id 校验，非法回退 'sepia'。 */
export function resolveCustomBase(base) {
  return THEME_BASE_IDS.includes(base) ? base : 'sepia';
}

/** 字体名净化：去掉引号/逗号/分号/反斜杠/控制字符（防 CSS 注入），截 60。 */
export function sanitizeFontName(name) {
  return typeof name === 'string' ? name.replace(/["';,\\\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
}

/** 中/英两组都留空时的兜底字体栈（原「系统默认」）。 */
export const FALLBACK_FONT_STACK = 'system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';

/** 中/英分开时拼 --reading-font（拉丁在前中文在后，便于逐字形回退；全空 → null 走兜底）。 */
export function splitFontStack({ latin = '', cjk = '' } = {}) {
  const l = sanitizeFontName(latin);
  const c = sanitizeFontName(cjk);
  const parts = [];
  if (l) parts.push(`"${l}"`);
  if (c) parts.push(`"${c}"`);
  return parts.length ? [...parts, '"Microsoft YaHei"', 'system-ui', 'sans-serif'].join(', ') : null;
}

/** 旧存档 fontFamily/customFontName → fontCjk/fontLatin 一次性迁移；无旧字段或已迁移 → null。 */
export function migrateFontKeys(raw) {
  if (!raw || typeof raw !== 'object' || !('fontFamily' in raw) || 'fontCjk' in raw) return null;
  const oldCjk = { song: 'SimSun', kai: 'KaiTi', hei: 'SimHei', fangsong: 'FangSong', yahei: 'Microsoft YaHei' };
  if (raw.fontFamily === 'custom') {
    const n = sanitizeFontName(raw.customFontName);
    return { fontLatin: n, fontCjk: n };
  }
  return { fontLatin: '', fontCjk: oldCjk[raw.fontFamily] ?? '' };
}

/** 久坐提醒判定：开启、且 idleMs 内有活动、且距上次提醒 ≥ everyMs。 */
export function restReminderDue({ now, lastActivity, lastPrompt, enabled, everyMs = 45 * 60_000, idleMs = 5 * 60_000 }) {
  if (!enabled) return false;
  if (now - lastActivity > idleMs) return false;
  return now - lastPrompt >= everyMs;
}
