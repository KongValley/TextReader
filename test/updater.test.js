import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdates, compareVersions, pickSetupAsset } from '../src/main/updater.js';

test('compareVersions：v 前缀 / 缺段 / 数值比较', () => {
  assert.equal(compareVersions('1.0.0', 'v1.0.1'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', 'v10.0.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('garbage', 'v1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0);
});

test('pickSetupAsset：只挑 setup.exe 资产', () => {
  const setup = { name: 'TXTReader-9.9.9-setup.exe', browser_download_url: 'https://example.test/TXTReader-9.9.9-setup.exe' };
  const portable = { name: 'TXTReader-9.9.9-portable.exe', browser_download_url: 'https://example.test/TXTReader-9.9.9-portable.exe' };
  assert.equal(pickSetupAsset([portable, setup]), setup.browser_download_url);
  assert.equal(pickSetupAsset([portable]), null);
  assert.equal(pickSetupAsset(undefined), null);
  assert.equal(pickSetupAsset([]), null);
});

/** 组装一轮 checkForUpdates 的注入间谍。 */
function harness({ release, button = 0, fetchError = null } = {}) {
  const logs = [];
  const dialogs = [];
  const opened = [];
  const fetchJson = async () => {
    if (fetchError) throw fetchError;
    return release;
  };
  const showDialog = async (opts) => {
    dialogs.push(opts);
    return button;
  };
  const openExternal = (url) => opened.push(url);
  return {
    logs,
    dialogs,
    opened,
    deps: { currentVersion: '1.0.0', fetchJson, showDialog, openExternal, log: (l) => logs.push(l) },
  };
}

const fakeRelease = (over = {}) => ({
  tag_name: 'v9.9.9',
  html_url: 'https://example.test/releases/tag/v9.9.9',
  body: '修复若干问题',
  assets: [{ name: 'TXTReader-9.9.9-setup.exe', browser_download_url: 'https://example.test/TXTReader-9.9.9-setup.exe' }],
  ...over,
});

test('checkForUpdates：新版本 + 下载 → 打开 setup 直链', async () => {
  const h = harness({ release: fakeRelease(), button: 0 });
  const res = await checkForUpdates(h.deps);
  assert.deepEqual(res, { branch: 'update-available', latestTag: 'v9.9.9' });
  assert.ok(h.logs.some((l) => l.includes('dialog=update-available latest=v9.9.9')), h.logs.join(' / '));
  assert.deepEqual(h.opened, ['https://example.test/TXTReader-9.9.9-setup.exe']);
  assert.deepEqual(h.dialogs[0].buttons, ['下载更新', '查看发布页', '取消']);
});

test('checkForUpdates：取消 → 不打开任何链接', async () => {
  const h = harness({ release: fakeRelease(), button: 2 });
  const res = await checkForUpdates(h.deps);
  assert.equal(res.branch, 'update-available');
  assert.deepEqual(h.opened, []);
});

test('checkForUpdates：缺 setup 资产 → 降级为发布页按钮', async () => {
  const h = harness({
    release: fakeRelease({ assets: [{ name: 'TXTReader-9.9.9-portable.exe', browser_download_url: 'https://example.test/TXTReader-9.9.9-portable.exe' }] }),
    button: 0,
  });
  await checkForUpdates(h.deps);
  assert.deepEqual(h.dialogs[0].buttons, ['查看发布页', '取消']);
  assert.deepEqual(h.opened, ['https://example.test/releases/tag/v9.9.9']);
});

test('checkForUpdates：已是最新', async () => {
  const h = harness({ release: fakeRelease({ tag_name: 'v1.0.0', assets: [] }) });
  const res = await checkForUpdates(h.deps);
  assert.equal(res.branch, 'up-to-date');
  assert.ok(h.logs.some((l) => l.includes('dialog=up-to-date')), h.logs.join(' / '));
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].type, 'info');
});

test('checkForUpdates：请求失败 → 错误对话框', async () => {
  const h = harness({ fetchError: new Error('HTTP 403') });
  const res = await checkForUpdates(h.deps);
  assert.equal(res.branch, 'error');
  assert.ok(h.logs.some((l) => l.includes('dialog=error')), h.logs.join(' / '));
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].type, 'warning');
});

test('checkForUpdates：响应缺 tag_name → 错误分支', async () => {
  const h = harness({ release: {} });
  const res = await checkForUpdates(h.deps);
  assert.equal(res.branch, 'error');
  assert.ok(h.logs.some((l) => l.includes('响应缺少 tag_name')), h.logs.join(' / '));
});
