/**
 * 端到端冒烟测试：在真实 Electron 窗口里跑完整交互链路，并截图到 shots/。
 * 仅当环境变量 TXT_SMOKE=1 时由主进程动态加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Menu } from 'electron';
import { LOCKED_PDF_PASSWORD } from './pdf-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(ctx) {
  const { app, win, openFile, updateMarkers } = ctx;
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
  /** 触发真实菜单项（等价于点菜单或按快捷键，走菜单 → IPC → 渲染进程的完整链路） */
  const menuClick = (label) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.items.flatMap((m) => m.submenu?.items ?? []).find((i) => i.label === label);
    if (!item) return false;
    item.click();
    return true;
  };
  /** 画布是否真的画了东西（找暗像素，避免"有 canvas 但是白纸"的假通过） */
  const canvasPainted = (selector) =>
    js(`(() => {
      const c = document.querySelector(${JSON.stringify(selector)});
      if (!c || !c.width || !c.height) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 0) return true;
      return false;
    })()`);
  const search = async (query, wait = 1400) => {
    await js(`(() => { const i = document.querySelector('#search-input'); i.value = ${JSON.stringify(query)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(wait);
    await js(`(() => { const i = document.querySelector('#search-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(wait);
  };
  const canvasWidth = (selector) =>
    js(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width ?? 0`);

  const watchdog = setTimeout(() => {
    console.error('FAIL 冒烟测试整体超时');
    app.exit(4);
  }, 360000);

  // 渲染进程的报错必须浮到冒烟日志里，否则只能看到"脚本执行失败"
  win.webContents.on('console-message', (event, ...rest) => {
    const d = rest[0] && typeof rest[0] === 'object' ? rest[0] : { level: rest[0], message: rest[1] };
    const level = typeof d.level === 'number' ? d.level : d.level === 'error' ? 3 : d.level === 'warning' ? 2 : 1;
    const message = String(d.message ?? '');
    if (level >= 2 || message.includes('[pdf]')) console.log(`[renderer:${level}] ${message}`);
  });

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

    /* 主题四选一：新增「墨绿」预设（设置面板按钮 + 视图菜单） */
    const themeBtnCount = await js(`document.querySelectorAll('#set-theme button').length`);
    check('主题按钮是四选一', themeBtnCount === 4, `${themeBtnCount} 个`);
    check('墨绿主题按钮已提供', await js(`Boolean(document.querySelector('#set-theme [data-theme="moss"]'))`));
    await click('#set-theme [data-theme="moss"]', 400);
    check(
      '墨绿主题生效',
      await js(`document.documentElement.dataset.theme === 'moss' && getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#1e2a20' && getComputedStyle(document.body).backgroundColor === 'rgb(30, 42, 32)'`),
      `--bg=${await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg')`)} / body=${await js(`getComputedStyle(document.body).backgroundColor`)}`,
    );
    await click('#btn-settings', 300);
    await shot('06b-settings-moss.png');
    await click('#settings [data-close]', 200);
    await click('#set-theme [data-theme="dark"]', 250);
    check('菜单可切换墨绿', await (async () => {
      if (!menuClick('墨绿')) return false;
      await sleep(400);
      return (await js(`document.documentElement.dataset.theme`)) === 'moss';
    })());

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

    /* ---------- 场景 10：PDF（内置大纲样本，走 pdf.js 渲染） ---------- */
    const pdfOutline = path.join(FIXTURES, 'outline.pdf');
    if (fs.existsSync(pdfOutline)) {
      check('打开 PDF（含大纲）', await openAndWait(pdfOutline, `document.querySelector('#file-name').textContent.includes('outline.pdf')`), pdfOutline);
      await sleep(1600);

      check('工具栏出现 PDF 标记', (await text('#enc-label')).toUpperCase() === 'PDF', await text('#enc-label'));
      check('PDF 容器已显示、文本流已隐藏', await js(`!document.querySelector('#pdf-pages').hidden && document.querySelector('#flow').hidden`));
      check('状态栏显示页数', /PDF\s*2\s*页/.test(await text('#status-meta')), await text('#status-meta'));
      check('状态栏显示当前页', (await text('#status-meta')).includes('第 1 页'), await text('#status-meta'));
      const canvasCount = await js(`document.querySelectorAll('#pdf-pages canvas').length`);
      check('PDF 画布已创建', canvasCount >= 1, `${canvasCount} 个`);
      check('PDF 画布已绘制内容', await canvasPainted('#pdf-pages .pdf-page[data-page="0"] canvas'));
      check('文本层已生成（可选中/复制）', (await js(`document.querySelectorAll('#pdf-pages .textLayer span').length`)) > 0, `${await js(`document.querySelectorAll('#pdf-pages .textLayer span').length`)} 个 span`);
      check('目录读到大纲', (await text('#toc-count')) === '3 项', await text('#toc-count'));
      check('目录项带页号提示', (await js(`document.querySelector('.toc-item').title`)).includes('第 1 页'), await js(`document.querySelector('.toc-item').title`));
      await shot('15-pdf-outline.png');

      /* 翻页 */
      const pp0 = Number(await attr('#viewport', 'page'));
      await key('Right');
      await sleep(700);
      const pp1 = Number(await attr('#viewport', 'page'));
      check('→ 键翻到下一页（PDF）', pp1 === pp0 + 1, `${pp0} → ${pp1}`);
      check('翻页后状态栏跟随', (await text('#status-meta')).includes('第 2 页'), await text('#status-meta'));
      check('第二页画布已绘制', await canvasPainted('#pdf-pages .pdf-page[data-page="1"] canvas'));
      await key('Left');
      await sleep(700);
      check('← 键翻回上一页（PDF）', Number(await attr('#viewport', 'page')) === pp0, `page=${await attr('#viewport', 'page')}`);

      /* 目录跳转 */
      await click('#btn-toc', 350);
      await click('.toc-item[data-i="2"]', 1000);
      check('目录跳转到对应页', Number(await attr('#viewport', 'page')) === 1, `page=${await attr('#viewport', 'page')}`);
      check('目录项高亮当前页', await js(`Boolean(document.querySelector('.toc-item.active'))`));
      await click('#toc [data-close]', 250);

      /* 查找：命中 + 高亮框 + 跳页 */
      await search('MARKER-BETA');
      check('PDF 查找命中并显示位置', /1\/1\s*处|1\s*处/.test(await text('#search-count')), await text('#search-count'));
      check('查找停在命中页', Number(await attr('#viewport', 'page')) === 1, `page=${await attr('#viewport', 'page')}`);
      await waitFor(`document.querySelectorAll('#pdf-pages .pdf-hl-box').length > 0`, 5000);
      check('命中处画出高亮框', (await js(`document.querySelectorAll('#pdf-pages .pdf-hl-box').length`)) > 0);
      await shot('16-pdf-search.png');

      /* 缩放：默认适应窗口 → 菜单命令放大 → Ctrl+0 回到适应窗口 */
      const fitW = await canvasWidth('#pdf-pages .pdf-page[data-page="1"] canvas');
      check('默认按窗口适应（整页可见）', await js(`(() => {
        const page = document.querySelector('#pdf-pages .pdf-page[data-page="1"]');
        const vp = document.querySelector('#viewport');
        const p = page.getBoundingClientRect();
        const v = vp.getBoundingClientRect();
        return p.height <= v.height + 1 && p.width <= v.width + 1;
      })()`), `页宽 ${fitW}`);
      check('状态栏显示缩放比例', /\d+%$/.test(await text('#status-meta')), await text('#status-meta'));
      check('放大命令可触发', menuClick('放大字号'));
      await sleep(1100);
      const zoomW = await canvasWidth('#pdf-pages .pdf-page[data-page="1"] canvas');
      check('PDF 缩放放大页面', zoomW > fitW, `${fitW} → ${zoomW}`);
      check('缩放后重新绘制', await canvasPainted('#pdf-pages .pdf-page[data-page="1"] canvas'));
      await shot('17-pdf-zoom.png');
      await key('0', ['control']);
      await sleep(1100);
      const resetW = await canvasWidth('#pdf-pages .pdf-page[data-page="1"] canvas');
      check('Ctrl+0 回到适应窗口', Math.abs(resetW - fitW) < 1.5, `${resetW} vs ${fitW}`);

      /* 书签（PDF 记的是页号 + 该页文字快照） */
      await click('#btn-add-bookmark', 1000);
      check('PDF 书签已添加', (await js(`document.querySelectorAll('#bookmark-list .bm-row').length`)) === 1, `${await js(`document.querySelectorAll('#bookmark-list .bm-row').length`)} 条`);
      check('书签标题为所在目录项', (await text('#bookmark-list .bm-title')).includes('Section 2.1'), await text('#bookmark-list .bm-title'));
      check('书签预览为页面文字', (await text('#bookmark-list .bm-preview')).includes('MARKER-BETA'), await text('#bookmark-list .bm-preview'));
      await click('#btn-bookmarks', 300);
      await shot('18-pdf-bookmarks.png');
      await click('#bookmarks [data-close]', 200);

      check('翻页模式只显示当前页', (await js(`[...document.querySelectorAll('#pdf-pages .pdf-page')].filter((p) => getComputedStyle(p).visibility !== 'hidden').length`)) === 1, `${await js(`[...document.querySelectorAll('#pdf-pages .pdf-page')].filter((p) => getComputedStyle(p).visibility !== 'hidden').length`)} 页可见`);

      /* 主题：外壳跟随主题，PDF 纸面必须保持白色 */
      await click('#btn-settings', 250);
      await click('#set-theme [data-theme="dark"]', 700);
      check('夜间主题生效（外壳）', (await js(`document.documentElement.dataset.theme`)) === 'dark');
      check('夜间主题下 PDF 纸面仍是白色', (await js(`getComputedStyle(document.querySelector('#pdf-pages .pdf-page')).backgroundColor`)) === 'rgb(255, 255, 255)', await js(`getComputedStyle(document.querySelector('#pdf-pages .pdf-page')).backgroundColor`));
      check('夜间主题下工具栏变暗', (await js(`getComputedStyle(document.querySelector('#toolbar')).backgroundColor`)) !== 'rgb(255, 255, 255)');
      await shot('24-pdf-dark.png');
      await click('#set-theme [data-theme="sepia"]', 500);
      await click('#settings [data-close]', 250);

      /* 滚动模式 */
      await click('#set-mode [data-mode="scroll"]', 1200);
      check('PDF 切换滚动模式', (await attr('#viewport', 'mode')) === 'scroll');
      check('滚动模式页间距生效（第二页在下方）', await js(`(() => {
        const a = document.querySelector('#pdf-pages .pdf-page[data-page="0"]').getBoundingClientRect();
        const b = document.querySelector('#pdf-pages .pdf-page[data-page="1"]').getBoundingClientRect();
        return b.top >= a.bottom - 1;
      })()`));
      await shot('19-pdf-scroll.png');
      await click('#set-mode [data-mode="paged"]', 900);

      /* 切回文本：PDF 视图要干净地让位 */
      await openAndWait(gbk, `document.querySelector('#file-name').textContent.includes('novel-gbk')`);
      await sleep(700);
      check('切回文本后 PDF 容器隐藏', await js(`document.querySelector('#pdf-pages').hidden`));
      check('切回文本后文本流恢复', await js(`!document.querySelector('#flow').hidden`));
      check('切回文本后 PDF 标记消失', (await text('#enc-label')).toUpperCase() !== 'PDF', await text('#enc-label'));
      check('文本专用设置项恢复显示', await js(`getComputedStyle(document.querySelector('#set-font-family').closest('label')).display !== 'none'`));
      check('文本分页引擎仍可用', (await attr('#viewport', 'pages')) !== '0', `${await attr('#viewport', 'pages')} 页`);

      /* 进度记忆：PDF 页号与书签都要回来 */
      await openAndWait(pdfOutline, `document.querySelector('#file-name').textContent.includes('outline.pdf')`);
      await sleep(1800);
      check('PDF 阅读位置已记忆', Number(await attr('#viewport', 'page')) === 1, `page=${await attr('#viewport', 'page')}`);
      check('PDF 书签一并保留', (await js(`document.querySelectorAll('#bookmark-list .bm-row').length`)) === 1);
      check('重开后设置项按 PDF 隐藏文本项', await js(`getComputedStyle(document.querySelector('#set-font-family').closest('label')).display === 'none'`));
      check('PDF 页码越界保护（End 到末页）', await (async () => {
        await key('End');
        await sleep(600);
        return Number(await attr('#viewport', 'page')) === 1;
      })());
      await shot('20-pdf-reopen.png');
    }

    /* ---------- 场景 11：本地真实 PDF（不入库，存在时才跑） ---------- */
    const pdfSample = path.join(FIXTURES, 'sample.pdf');
    if (fs.existsSync(pdfSample)) {
      check('打开本地真实 PDF', await openAndWait(pdfSample, `document.querySelector('#file-name').textContent.includes('sample.pdf')`), path.basename(pdfSample));
      await sleep(2200);
      check('真实 PDF 页数正确', /PDF\s*3\s*页/.test(await text('#status-meta')), await text('#status-meta'));
      check('真实 PDF 画布已创建', (await js(`document.querySelectorAll('#pdf-pages canvas').length`)) === 3, `${await js(`document.querySelectorAll('#pdf-pages canvas').length`)} 个`);
      check('真实 PDF 首页已绘制', await canvasPainted('#pdf-pages .pdf-page[data-page="0"] canvas'));
      check('中文文本层已生成', (await js(`document.querySelectorAll('#pdf-pages .textLayer span').length`)) > 5, `${await js(`document.querySelectorAll('#pdf-pages .textLayer span').length`)} 个 span`);
      check('无大纲时目录给出提示', (await text('#toc-list')).includes('暂无目录'), await text('#toc-list'));
      check('状态栏显示文件名之外的大小', (await text('#status-meta')).includes('KB'), await text('#status-meta'));

      const realText = await js(`document.querySelector('#pdf-pages .textLayer')?.textContent ?? ''`);
      check('中文文字可被选中复制（textContent 非空）', realText.trim().length > 20, `${realText.trim().length} 字`);
      await shot('21-pdf-real.png');

      await search('科翔股份');
      check('中文查找命中', /\d+\/\d+\s*处/.test(await text('#search-count')), await text('#search-count'));
      await waitFor(`document.querySelectorAll('#pdf-pages .pdf-hl-box').length > 0`, 5000);
      check('中文命中高亮框已绘制', (await js(`document.querySelectorAll('#pdf-pages .pdf-hl-box').length`)) > 0);
      await shot('22-pdf-real-search.png');
    }

    /* ---------- 场景 12：加密 PDF 的密码输入 ---------- */
    const lockedPdf = path.join(FIXTURES, 'locked.pdf');
    const brokenPdf = path.join(SHOTS, 'userdata', 'broken.pdf');
    fs.mkdirSync(path.dirname(brokenPdf), { recursive: true });
    fs.writeFileSync(brokenPdf, '%PDF-1.4\nthis is not a real pdf\n', 'latin1');
    const pwHidden = () => js(`document.querySelector('#pw-modal').hidden`);
    const submitPassword = (value) =>
      js(`(() => {
        const i = document.querySelector('#pw-input');
        i.value = ${JSON.stringify(value)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#pw-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()`);

    const keepName = await text('#file-name');
    const keepCanvases = await js(`document.querySelectorAll('#pdf-pages canvas').length`);

    /* 12.1 取消：当前文档不受影响 */
    openFile(lockedPdf);
    check('加密 PDF 弹出密码框', await waitFor(`!document.querySelector('#pw-modal').hidden`, 15000));
    check('密码框提示需要密码', (await text('#pw-hint')).includes('需要密码'), await text('#pw-hint'));
    check('提示里带文件名', (await text('#pw-hint')).includes('locked.pdf'), await text('#pw-hint'));
    await shot('25-pdf-password.png');
    await click('#pw-cancel', 500);
    check('取消后密码框关闭', await pwHidden());
    check('取消后提示已取消', (await text('#toast')).includes('已取消'), await text('#toast'));
    await sleep(700);
    check('取消后当前文档仍在', (await text('#file-name')) === keepName, `${keepName} → ${await text('#file-name')}`);
    check('取消后画布未被清空', (await js(`document.querySelectorAll('#pdf-pages canvas').length`)) === keepCanvases);

    /* 12.1b 密码框还开着时改开别的文件：框要自己收起来，别卡住界面 */
    openFile(lockedPdf);
    check('密码框再次弹出（等待处理）', await waitFor(`!document.querySelector('#pw-modal').hidden`, 15000));
    await openAndWait(gbk, `document.querySelector('#file-name').textContent.includes('novel-gbk')`);
    await sleep(700);
    check('改开文本后密码框自动关闭', await pwHidden());
    check('改开文本后文本视图正常', await js(`!document.querySelector('#flow').hidden && document.querySelector('#pdf-pages').hidden`));

    /* 12.2 先输错再输对 */
    openFile(lockedPdf);
    check('再次弹出密码框', await waitFor(`!document.querySelector('#pw-modal').hidden`, 15000));
    await submitPassword('definitely-wrong');
    check('密码错误会再次弹框并提示', await waitFor(`!document.querySelector('#pw-modal').hidden && document.querySelector('#pw-hint').textContent.includes('不正确')`, 15000), await text('#pw-hint'));
    check('密码错误时输入框标红', (await attr('#pw-input', 'error')) === '1', `error=${await attr('#pw-input', 'error')}`);
    await shot('26-pdf-password-wrong.png');
    await submitPassword(LOCKED_PDF_PASSWORD);
    check('正确密码后密码框关闭', await waitFor(`document.querySelector('#pw-modal').hidden`, 15000));
    await sleep(2200);
    check('正确密码后打开加密 PDF', (await text('#file-name')).includes('locked.pdf'), await text('#file-name'));
    check('加密 PDF 页数正确', /PDF\s*2\s*页/.test(await text('#status-meta')), await text('#status-meta'));
    check('加密 PDF 画布已绘制', await canvasPainted('#pdf-pages .pdf-page[data-page="0"] canvas'));
    check('加密 PDF 大纲解出（说明真的解密了）', (await text('#toc-count')) === '3 项', await text('#toc-count'));
    check('加密 PDF 文本层已生成', (await js(`document.querySelectorAll('#pdf-pages .textLayer span').length`)) > 0);
    await search('MARKER-BETA');
    check('加密 PDF 内可查找', /1\/1\s*处|1\s*处/.test(await text('#search-count')), await text('#search-count'));
    await shot('27-pdf-unlocked.png');

    /* 12.3 同一次运行内再打开：记住已验证的密码，不再询问 */
    await openAndWait(gbk, `document.querySelector('#file-name').textContent.includes('novel-gbk')`);
    await sleep(600);
    openFile(lockedPdf);
    check('再次打开加密 PDF 直接成功', await waitFor(`document.querySelector('#file-name').textContent.includes('locked.pdf')`, 15000));
    check('已记住密码时不再弹框', await pwHidden());
    await sleep(1200);
    check('记住密码后仍能渲染', (await js(`document.querySelectorAll('#pdf-pages canvas').length`)) >= 1, `${await js(`document.querySelectorAll('#pdf-pages canvas').length`)} 个`);

    /* ---------- 场景 13：损坏 PDF 要有明确提示，且不影响当前文档 ---------- */
    openFile(brokenPdf);
    check('损坏 PDF 给出解析失败提示', await waitFor(`document.querySelector('#toast').textContent.includes('无法解析')`, 15000), await text('#toast'));
    await sleep(600);
    check('损坏 PDF 后当前文档仍可翻页', await (async () => {
      await key('Home');
      await sleep(700);
      const first = Number(await attr('#viewport', 'page'));
      await key('Right');
      await sleep(800);
      const second = Number(await attr('#viewport', 'page'));
      const canvases = await js(`document.querySelectorAll('#pdf-pages canvas').length`);
      return first === 0 && second === 1 && canvases >= 1;
    })(), `page=${await attr('#viewport', 'page')}`);
    await shot('28-pdf-broken.png');

    /* ---------- 场景 14：检查更新（TXT_UPDATE_FAKE 假响应，不走真实网络） ---------- */
    const fakeRelease = (payload) => { process.env.TXT_UPDATE_FAKE = payload; };
    const hasMarker = (frag) => (updateMarkers ?? []).some((m) => m.includes(frag));
    const markersSoFar = () => (updateMarkers ?? []).join(' / ');

    delete process.env.TXT_UPDATE_FAKE; // 先清零旧值再进入场景
    fakeRelease(JSON.stringify({
      tag_name: 'v9.9.9',
      html_url: 'https://example.test/releases/tag/v9.9.9',
      body: '修复若干问题',
      assets: [
        { name: 'TXTReader-9.9.9-portable.exe', browser_download_url: 'https://example.test/TXTReader-9.9.9-portable.exe' },
        { name: 'TXTReader-9.9.9-setup.exe', browser_download_url: 'https://example.test/TXTReader-9.9.9-setup.exe' },
      ],
    }));
    check('菜单「检查更新…」可触发', menuClick('检查更新…'));
    await sleep(600);
    check('识别到新版本并弹出新版本对话框', hasMarker('dialog=update-available latest=v9.9.9'), markersSoFar());
    check('「下载更新」打开 setup.exe 直链', hasMarker('open-external=https://example.test/TXTReader-9.9.9-setup.exe'), markersSoFar());

    fakeRelease(JSON.stringify({ tag_name: `v${app.getVersion()}`, html_url: 'https://example.test/releases', body: '', assets: [] }));
    menuClick('检查更新…');
    await sleep(600);
    check('当前已是最新时提示已是最新', hasMarker('dialog=up-to-date'), markersSoFar());

    fakeRelease('{ broken json');
    menuClick('检查更新…');
    await sleep(600);
    check('检查失败时给出错误提示', hasMarker('dialog=error'), markersSoFar());
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
