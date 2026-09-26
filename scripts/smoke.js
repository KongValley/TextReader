/**
 * 端到端冒烟测试：在真实 Electron 窗口里跑完整交互链路，并截图到 shots/。
 * 仅当环境变量 TXT_SMOKE=1 时由主进程动态加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(ctx) {
  const { app, win, openFile } = ctx;
  fs.mkdirSync(SHOTS, { recursive: true });

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').trim()`);
  const attr = (sel, name) => js(`document.querySelector(${JSON.stringify(sel)})?.dataset?.[${JSON.stringify(name)}] ?? ''`);
  const click = async (sel, wait = 300) => {
    await js(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true; })()`);
    await sleep(wait);
  };
  const shot = async (name) => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const img = await win.webContents.capturePage();
        if (!img.isEmpty()) {
          fs.writeFileSync(path.join(SHOTS, name), img.toPNG());
          return true;
        }
      } catch (err) {
        if (attempt === 6) console.warn(`截图失败 ${name}: ${err.message}`);
      }
      await sleep(400);
    }
    return false;
  };
  const key = async (keyCode, modifiers = [], wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(wait);
  };
  async function waitFor(expr, ms = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await js(`Boolean(${expr})`)) return true;
      } catch {
        /* 页面仍在加载 */
      }
      await sleep(120);
    }
    return false;
  }
  const openAndWait = (file, predicate) => {
    openFile(file);
    return waitFor(predicate);
  };

  const watchdog = setTimeout(() => {
    console.error('FAIL 冒烟测试整体超时');
    app.exit(4);
  }, 240000);

  try {
    check('渲染进程就绪', await waitFor(`document.documentElement.dataset.ready === '1'`));
    if (!win.isVisible()) win.show();
    win.focus();
    await sleep(900);
    check('欢迎页可见', await js(`!document.body.classList.contains('has-file')`));
    await shot('01-welcome.png');

    /* ---------- 场景 1：GBK 小说全流程 ---------- */
    const gbk = path.join(FIXTURES, 'novel-gbk.txt');
    check('打开 GBK 文件', await openAndWait(gbk, `document.body.classList.contains('has-file')`), gbk);
    await sleep(700);

    const enc = (await text('#enc-label')).toUpperCase();
    check('编码自动识别为 GB18030', enc.includes('GB18030'), `识别结果：${enc}`);
    check('文件名显示', (await text('#file-name')).includes('novel-gbk'), await text('#file-name'));
    const tocCount = Number((await text('#toc-count')).match(/\d+/)?.[0] ?? 0);
    check('目录解析出章节', tocCount >= 6, `${tocCount} 章`);
    check('首章已渲染', (await text('#status-chapter')).length > 0, await text('#status-chapter'));
    await click('.toc-item[data-i="0"]', 450);
    check('开篇章节仅含题名两行', (await js(`document.querySelectorAll('#flow p').length`)) === 2, `${await js(`document.querySelectorAll('#flow p').length`)} 段`);
    await shot('02-paged-gbk.png');

    /* 跳到正文章节：段落数与翻页 */
    await click('.toc-item[data-i="1"]', 500);
    check('序章已渲染', (await text('#status-chapter')) === '序章 深潜', await text('#status-chapter'));
    check('正文含多个中文段落', (await js(`document.querySelectorAll('#flow p').length`)) >= 5, `${await js(`document.querySelectorAll('#flow p').length`)} 段`);
    const page0 = Number(await attr('#viewport', 'page'));
    check('短章只占 1 页', (await attr('#viewport', 'pages')) === '1', `${await attr('#viewport', 'pages')} 页`);

    /* 目录 */
    await click('#btn-toc');
    await shot('03-toc.png');
    const tocTitle = await js(`document.querySelectorAll('.toc-item')[3].textContent.trim()`);
    await click(`.toc-item[data-i="3"]`, 500);
    check('目录跳转到第 4 章', (await text('#status-chapter')) === tocTitle, `${await text('#status-chapter')} / ${tocTitle}`);

    /* 书签：添加 → 面板 → 跳转 */
    await click('#btn-add-bookmark', 400);
    check('书签已添加', (await js(`document.querySelectorAll('#bookmark-list .bm-row').length`)) === 1);
    await click('#btn-bookmarks', 350);
    await shot('04-bookmarks.png');
    await click('#bookmark-list .bm-row .bm-main', 500);
    check('书签跳转高亮该段', await js(`Boolean(document.querySelector('#flow p.flash'))`));

    /* 查找 */
    await click('#settings [data-close]', 150);
    await js(`(() => { const i = document.querySelector('#search-input'); i.value = '回声'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(700);
    await js(`(() => { const i = document.querySelector('#search-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(700);
    const sc = await text('#search-count');
    check('全文查找命中并定位', /\d+\s*处|\d+\/\d+/.test(sc), sc);
    await shot('05-search.png');

    /* 设置：字号 + 夜间主题 */
    await click('#btn-settings');
    await js(`(() => { const r = document.querySelector('#set-font-size'); r.value = '26'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(600);
    check('字号设置生效', (await js(`getComputedStyle(document.documentElement).getPropertyValue('--font-size')`)).includes('26'), await js(`getComputedStyle(document.documentElement).getPropertyValue('--font-size')`));
    await click('#set-theme [data-theme="dark"]', 400);
    check('夜间主题生效', (await js(`document.documentElement.dataset.theme`)) === 'dark');
    await shot('06-settings-dark.png');
    await click('#settings [data-close]');
    await shot('07-dark-paged.png');

    /* 滚动模式 */
    await click('#set-mode [data-mode="scroll"]', 700);
    check('切换到滚动模式', (await attr('#viewport', 'mode')) === 'scroll');
    await shot('08-scroll-dark.png');

    /* 回到护眼 + 默认字号 + 翻页模式 */
    await click('#set-theme [data-theme="sepia"]', 250);
    await js(`(() => { const r = document.querySelector('#set-font-size'); r.value = '19'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    await click('#set-mode [data-mode="paged"]', 500);
    await click('#settings [data-close]', 300);
    await shot('09-final-sepia.png');

    /* ---------- 场景 2：UTF-8 + CRLF + 无章节标题 ---------- */
    const plain = path.join(FIXTURES, 'novel-noheading-crlf.txt');
    check('打开无章节 UTF-8/CRLF 文件', await openAndWait(plain, `document.querySelector('#file-name').textContent.includes('noheading')`));
    await sleep(700);
    check('无章节文件识别为 UTF-8', (await text('#enc-label')).toUpperCase().includes('UTF-8'), await text('#enc-label'));
    const chunks = Number((await text('#toc-count')).match(/\d+/)?.[0] ?? 0);
    check('无章节文件被分段', chunks >= 2, `${chunks} 段`);
    const firstChunk = await js(`document.querySelector('.toc-item')?.textContent?.trim() ?? ''`);
    check('分段标题形如“第 N 段”', /^第 \d+ 段$/.test(firstChunk), firstChunk);
    check('CRLF 未残留 \\r', (await js(`document.querySelector('#flow p')?.textContent?.includes('\\r') ?? false`)) === false);

    /* 长文本才有多页：在这里验证翻页引擎 */
    const longPages = Number(await attr('#viewport', 'pages'));
    const longParas = await js(`document.querySelectorAll('#flow p').length`);
    check('长分段自动分多页', longPages > 2, `${longPages} 页`);
    check('长分段渲染全部段落', longParas > 20, `${longParas} 段`);
    const lp0 = Number(await attr('#viewport', 'page'));
    await key('Right');
    const lp1 = Number(await attr('#viewport', 'page'));
    check('→ 键翻到下一页', lp1 === lp0 + 1, `${lp0} → ${lp1}`);
    const scrolled = await js(`document.querySelector('#flow').scrollLeft`);
    check('分页位移已生效', Number(scrolled) > 0, `scrollLeft=${scrolled}`);
    await key('Left');
    check('← 键翻回上一页', Number(await attr('#viewport', 'page')) === lp0, `${await attr('#viewport', 'page')}`);
    await shot('10-noheading.png');

    /* 分页数量随字号变化 */
    await click('#btn-settings', 250);
    await js(`(() => { const r = document.querySelector('#set-font-size'); r.value = '34'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(700);
    const biggerPages = Number(await attr('#viewport', 'pages'));
    check('放大字号后页数增加', biggerPages > longPages, `${longPages} → ${biggerPages}`);
    await js(`(() => { const r = document.querySelector('#set-font-size'); r.value = '19'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(600);
    check('恢复字号后页数还原', Number(await attr('#viewport', 'pages')) === longPages, `${await attr('#viewport', 'pages')}`);
    await click('#settings [data-close]', 200);

    /* ---------- 场景 3：UTF-16LE（带 BOM） ---------- */
    const u16 = path.join(FIXTURES, 'novel-utf16le.txt');
    check('打开 UTF-16LE 文件', await openAndWait(u16, `document.querySelector('#file-name').textContent.includes('utf16le')`));
    await sleep(600);
    check('UTF-16LE 识别', (await text('#enc-label')).toUpperCase().includes('UTF-16LE'), await text('#enc-label'));

    /* ---------- 场景 4：Big5 ---------- */
    const big5 = path.join(FIXTURES, 'novel-big5.txt');
    if (fs.existsSync(big5)) {
      check('打开 Big5 文件', await openAndWait(big5, `document.querySelector('#file-name').textContent.includes('big5')`));
      await sleep(600);
      check('Big5 识别', (await text('#enc-label')).toUpperCase().includes('BIG5'), await text('#enc-label'));
    }

    /* ---------- 场景 5：文件不存在 ---------- */
    await js(`window.api.openFile('F:/definitely/missing-file.txt').then((r) => { window.__err = r?.error ?? ''; return true; })`);
    await sleep(400);
    check('缺失文件返回错误信息', (await js(`window.__err ?? ''`)).length > 0, await js(`window.__err ?? ''`));

    /* ---------- 场景 6：阅读进度记忆 ---------- */
    check('重新打开 GBK 文件', await openAndWait(gbk, `document.querySelector('#file-name').textContent.includes('novel-gbk')`));
    await sleep(600);
    await click(`.toc-item[data-i="5"]`, 600);
    await click('#btn-toc', 200);
    const before = await text('#status-chapter');
    await key('Right');
    await sleep(1800);
    await openAndWait(u16, `document.querySelector('#file-name').textContent.includes('utf16le')`);
    await sleep(400);
    await openAndWait(gbk, `document.querySelector('#file-name').textContent.includes('novel-gbk')`);
    await sleep(900);
    const after = await text('#status-chapter');
    check('再次打开恢复阅读位置', after === before, `${before} → ${after}`);

    /* ---------- 场景 7：窗口缩放重排 ---------- */
    const sizeBefore = await attr('#viewport', 'pages');
    win.setSize(900, 640);
    await sleep(900);
    const sizeAfter = await attr('#viewport', 'pages');
    check('窗口缩放后重新分页', sizeAfter !== '' && sizeAfter !== '0', `${sizeBefore} 页 → ${sizeAfter} 页`);
    await shot('11-resized.png');

    /* ---------- 场景 8：真实小说（可选，环境变量 TXT_SMOKE_REAL 指定路径） ---------- */
    const realFile = process.env.TXT_SMOKE_REAL;
    if (realFile && fs.existsSync(realFile)) {
      win.setSize(1180, 820);
      await sleep(600);
      check('打开真实小说', await openAndWait(realFile, `document.querySelector('#file-name').textContent.includes(${JSON.stringify(path.basename(realFile).slice(0, 8))})`), path.basename(realFile));
      await sleep(2500);
      const realChapters = Number((await text('#toc-count')).match(/\d+/)?.[0] ?? 0);
      check('真实小说解析出 > 500 章', realChapters > 500, `${realChapters} 章`);
      const firstTitle = await js(`document.querySelector('.toc-item')?.textContent?.trim() ?? ''`);
      check('首章标题为编号式', /^\d{3,4} \S/.test(firstTitle), firstTitle);
      check('正文已渲染', (await js(`document.querySelectorAll('#flow p').length`)) > 5, `${await js(`document.querySelectorAll('#flow p').length`)} 段`);
      check('状态栏统计字数', (await text('#status-meta')).includes('字'), await text('#status-meta'));
      await shot('12-real-novel.png');

      const rp0 = Number(await attr('#viewport', 'page'));
      await key('Right');
      const rp1 = Number(await attr('#viewport', 'page'));
      const rpages = Number(await attr('#viewport', 'pages'));
      check('真实小说翻页', rp1 === rp0 + 1 || rpages === 1, `${rp0} → ${rp1} / 共 ${rpages} 页`);

      await click('#btn-toc', 500);
      await click('.toc-item[data-i="900"]', 1200);
      const jumped = await text('#status-chapter');
      check('跳到大文件第 901 章', /^9\d\d /.test(jumped), jumped);
      await shot('13-real-chapter901.png');
      await click('#toc [data-close]', 300);
      check('跳转后正文非空', (await js(`document.querySelectorAll('#flow p').length`)) > 3);
    }

    /* ---------- 场景 9：文件移动/改名后自动继承阅读记录 ---------- */
    check('重新打开 GBK 小说', await openAndWait(gbk, `document.querySelector('#file-name').textContent.includes('novel-gbk')`), gbk);
    await sleep(500);
    await click('#btn-toc', 300);
    await click('.toc-item[data-i="6"]', 700);
    await sleep(1400); // 等进度写盘
    const beforeMove = await text('#status-chapter');

    const movedDir = path.join(SHOTS, 'userdata', 'moved');
    fs.mkdirSync(movedDir, { recursive: true });
    const movedFile = path.join(movedDir, 'novel-gbk.txt'); // 同名同大小、路径不同
    fs.copyFileSync(gbk, movedFile);

    openFile(movedFile);
    check('打开移动后的同名文件', await waitFor(`document.querySelector('#toast').textContent.includes('沿用')`, 15000));
    await sleep(700);
    const afterMove = await text('#status-chapter');
    check('阅读位置自动继承', afterMove === beforeMove, `${beforeMove} → ${afterMove}`);
    check('继承提示已显示', (await text('#toast')).includes('沿用'), await text('#toast'));
    check('书签一并继承', (await js(`document.querySelectorAll('#bookmark-list .bm-row').length`)) >= 1, `${await js(`document.querySelectorAll('#bookmark-list .bm-row').length`)} 条`);
    await shot('14-inherit-progress.png');

    // 只有名字相同、大小不同 → 不应继承（字节级拷贝后追加 ASCII 尾巴，内容与编码不受影响）
    const diffDir = path.join(SHOTS, 'userdata', 'moved-bigger');
    fs.mkdirSync(diffDir, { recursive: true });
    const diffFile = path.join(diffDir, 'novel-gbk.txt');
    fs.copyFileSync(gbk, diffFile);
    fs.appendFileSync(diffFile, '\nA new trailing line.\n');
    openFile(diffFile);
    const freshStart = await waitFor(`document.querySelector('#status-chapter').textContent.trim() === '开篇'`, 15000);
    await sleep(500);
    check('同名不同大小不继承（仍从第一章开始）', freshStart, `当前：${await text('#status-chapter')}`);
    check('没有继承提示', !(await text('#toast')).includes('沿用'), await text('#toast'));
  } catch (err) {
    check('冒烟测试异常', false, String(err?.stack ?? err));
  } finally {
    clearTimeout(watchdog);
    fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n冒烟测试完成：${results.length - failed}/${results.length} 通过`);
    await sleep(300);
    app.exit(failed ? 1 : 0);
  }
}
