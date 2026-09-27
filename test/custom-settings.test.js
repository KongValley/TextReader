import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOM_THEME_VARS,
  DEFAULT_SETTINGS,
  THEMES,
  THEME_BASE_IDS,
  THEME_LABEL,
  isHexColor,
  migrateFontKeys,
  resolveCustomBase,
  sanitizeFontName,
  splitFontStack,
} from '../src/shared/settings.js';

test('THEMES 末尾是自定义槽位，默认主题不变', () => {
  assert.equal(THEMES.at(-1).id, 'custom');
  assert.equal(THEME_LABEL.custom, '自定义');
  assert.equal(DEFAULT_SETTINGS.theme, 'sepia');
  assert.equal(DEFAULT_SETTINGS.customThemeBase, '');
  assert.deepEqual(DEFAULT_SETTINGS.customThemeColors, {});
});

test('DEFAULT_SETTINGS 字体键为中/英两空串，旧键已清', () => {
  assert.equal(DEFAULT_SETTINGS.fontCjk, '');
  assert.equal(DEFAULT_SETTINGS.fontLatin, '');
  assert.equal(DEFAULT_SETTINGS.fontFamily, undefined);
  assert.equal(DEFAULT_SETTINGS.customFontName, undefined);
});

test('CUSTOM_THEME_VARS 就是 6 个核心色且顺序固定', () => {
  assert.equal(CUSTOM_THEME_VARS.length, 6);
  assert.deepEqual(
    CUSTOM_THEME_VARS.map((v) => v.var),
    ['--bg', '--fg', '--fg-soft', '--panel', '--accent', '--hl'],
  );
  assert.ok(CUSTOM_THEME_VARS.every((v) => v.label.length > 0));
});

test('THEME_BASE_IDS 与 resolveCustomBase 只接受四个基座', () => {
  assert.deepEqual(THEME_BASE_IDS, ['light', 'sepia', 'dark', 'moss']);
  assert.equal(resolveCustomBase('moss'), 'moss');
  assert.equal(resolveCustomBase('custom'), 'sepia');
  assert.equal(resolveCustomBase(undefined), 'sepia');
  assert.equal(resolveCustomBase(''), 'sepia');
});

test('isHexColor 只认 6 位 hex', () => {
  assert.ok(isHexColor('#1e2a20'));
  assert.ok(isHexColor('#AABBCC'));
  assert.ok(!isHexColor('#123'));
  assert.ok(!isHexColor('red'));
  assert.ok(!isHexColor('#1234567'));
  assert.ok(!isHexColor(null));
  assert.ok(!isHexColor(''));
});

test('sanitizeFontName 去注入字符并限长', () => {
  assert.equal(sanitizeFontName('  LXGW WenKai  '), 'LXGW WenKai');
  assert.equal(sanitizeFontName('霞鹜文楷;江"湖,'), '霞鹜文楷江湖');
  assert.equal(sanitizeFontName('a'.repeat(80)), 'a'.repeat(60));
  assert.equal(sanitizeFontName(123), '');
});

test('splitFontStack：拉丁在前中文在后，全空回退 null', () => {
  assert.equal(splitFontStack({ latin: '', cjk: '' }), null);
  assert.equal(splitFontStack({}), null);
  assert.equal(splitFontStack({ latin: 'Arial' }), '"Arial", "Microsoft YaHei", system-ui, sans-serif');
  assert.equal(splitFontStack({ cjk: 'KaiTi' }), '"KaiTi", "Microsoft YaHei", system-ui, sans-serif');
  assert.equal(
    splitFontStack({ latin: '霞鹜文楷;江"湖,', cjk: 'KaiTi' }),
    '"霞鹜文楷江湖", "KaiTi", "Microsoft YaHei", system-ui, sans-serif',
  );
  assert.equal(splitFontStack({ latin: '   ', cjk: '' }), null);
});

test('migrateFontKeys：旧存档一次性映射', () => {
  assert.deepEqual(migrateFontKeys({ fontFamily: 'kai' }), { fontLatin: '', fontCjk: 'KaiTi' });
  assert.deepEqual(migrateFontKeys({ fontFamily: 'system', fontSize: 20 }), { fontLatin: '', fontCjk: '' });
  assert.deepEqual(migrateFontKeys({ fontFamily: 'custom', customFontName: 'LXGW WenKai' }), {
    fontLatin: 'LXGW WenKai',
    fontCjk: 'LXGW WenKai',
  });
  assert.deepEqual(migrateFontKeys({ fontFamily: 'custom', customFontName: '"hack";' }), { fontLatin: 'hack', fontCjk: 'hack' });
  assert.equal(migrateFontKeys({}), null);
  assert.equal(migrateFontKeys({ fontFamily: 'song', fontCjk: 'X' }), null);
  assert.equal(migrateFontKeys(null), null);
});
