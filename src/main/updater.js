/** 「检查更新」的纯逻辑：版本比对、资产挑选与对话框流程。
 * 不 import 'electron'：网络 / 对话框 / 打开链接 / 日志全部注入，node:test 可直接 import 测试。 */

/** 三段数字版本比较（忽略 v 前缀与预发行后缀，非数字段按 0）：a<b → -1，a==b → 0，a>b → 1。 */
export function compareVersions(a, b) {
  const norm = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((s) => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const [x, y] = [norm(a), norm(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 从 GitHub release 的 assets 里取 setup 安装包直链；没有则返回 null（调用方降级为发布页）。 */
export function pickSetupAsset(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find((a) => /setup\.exe$/i.test(String(a?.name ?? '')))?.browser_download_url ?? null;
}

/** 一次检查更新：fetchJson 取 latest release → 与 currentVersion 比对 → 弹对应对话框。
 * 返回 { branch: 'update-available' | 'up-to-date' | 'error', latestTag }。 */
export async function checkForUpdates({ currentVersion, fetchJson, showDialog, openExternal, log = console.log, notesMaxChars = 800 }) {
  try {
    const rel = await fetchJson();
    const latestTag = String(rel?.tag_name ?? '');
    if (!latestTag) throw new Error('响应缺少 tag_name');

    if (compareVersions(currentVersion, latestTag) >= 0) {
      log(`[update] dialog=up-to-date latest=${latestTag}`);
      await showDialog({
        type: 'info',
        title: '检查更新',
        message: `当前已是最新版本 v${currentVersion}`,
        detail: `服务器最新版本 ${latestTag}`,
        buttons: ['好'],
        defaultId: 0,
        cancelId: 0,
      });
      return { branch: 'up-to-date', latestTag };
    }

    const notes = String(rel?.body ?? '').replace(/\r/g, '').trim().slice(0, notesMaxChars);
    const setupUrl = pickSetupAsset(rel.assets);
    log(`[update] dialog=update-available latest=${latestTag}`);
    const r = await showDialog({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${latestTag}`,
      detail: notes ? `当前版本 v${currentVersion}\n\n更新说明：\n${notes}` : `当前版本 v${currentVersion}`,
      buttons: setupUrl ? ['下载更新', '查看发布页', '取消'] : ['查看发布页', '取消'],
      defaultId: 0,
      cancelId: setupUrl ? 2 : 1,
    });
    if (r === 0) openExternal(setupUrl ?? String(rel.html_url ?? ''));
    else if (r === 1 && setupUrl) openExternal(String(rel.html_url ?? ''));
    return { branch: 'update-available', latestTag };
  } catch (err) {
    const reason = String(err?.message ?? err);
    log(`[update] dialog=error reason=${reason}`);
    await showDialog({
      type: 'warning',
      title: '检查更新',
      message: '无法检查更新',
      detail: `原因：${reason}\n\n可稍后重试，或手动访问 https://github.com/KongValley/TextReader/releases 查看。`,
      buttons: ['好'],
      defaultId: 0,
      cancelId: 0,
    });
    return { branch: 'error', latestTag: null };
  }
}
