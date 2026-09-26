/**
 * 持久化（主进程内存 + userData/state.json，原子写入 + 去抖）。
 * 结构：
 * { window:{...}, settings:{...}, recent:[{path,name,size,at}], books:{[path]:{...}} }
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

export const DEFAULT_WINDOW = { width: 1180, height: 820, x: null, y: null, maximized: false };

const MAX_RECENT = 15;

function defaults() {
  return { window: { ...DEFAULT_WINDOW }, settings: { ...DEFAULT_SETTINGS }, recent: [], books: {} };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.data = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = {
        window: { ...DEFAULT_WINDOW, ...(raw.window ?? {}) },
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        recent: Array.isArray(raw.recent) ? raw.recent : [],
        books: raw.books && typeof raw.books === 'object' ? raw.books : {},
      };
    } catch {
      /* 首次运行或文件损坏：用默认值 */
    }
  }

  get settings() {
    return this.data.settings;
  }

  get recent() {
    return this.data.recent;
  }

  patchSettings(patch) {
    Object.assign(this.data.settings, patch ?? {});
    this.save();
    return this.data.settings;
  }

  patchWindow(bounds) {
    Object.assign(this.data.window, bounds ?? {});
    this.save();
  }

  touchRecent({ path: filePath, name, size }) {
    const list = this.data.recent.filter((r) => r.path !== filePath);
    list.unshift({ path: filePath, name, size, at: Date.now() });
    this.data.recent = list.slice(0, MAX_RECENT);
    this.save();
  }

  removeRecent(filePath) {
    this.data.recent = this.data.recent.filter((r) => r.path !== filePath);
    this.save();
  }

  clearRecent() {
    this.data.recent = [];
    this.save();
  }

  getBook(filePath) {
    const b = this.data.books[filePath];
    return {
      encoding: 'auto',
      name: null,
      size: null,
      chapterIndex: 0,
      ratio: 0,
      percent: 0,
      bookmarks: [],
      updatedAt: 0,
      ...(b ?? {}),
    };
  }

  /**
   * 文件被移动/改名后沿用原阅读记录：按「文件名 + 字节数」匹配旧记录。
   * 仅当目标路径本身还没有记录时才继承，且不删除原记录。
   * @returns {object|null} 继承到的记录（含 inheritedFrom），没有则 null
   */
  inheritBook(filePath, { name, size }) {
    if (!name || !Number.isFinite(size)) return null;
    const own = this.data.books[filePath];
    if (own && own.updatedAt) return null;
    for (const [oldPath, book] of Object.entries(this.data.books)) {
      if (oldPath === filePath || !book) continue;
      if (book.name !== name || book.size !== size) continue;
      const next = this.setBook(filePath, {
        ...book,
        name,
        size,
        inheritedFrom: oldPath,
      });
      return next;
    }
    return null;
  }

  setBook(filePath, patch) {
    const next = { ...this.getBook(filePath), ...(patch ?? {}), updatedAt: Date.now() };
    this.data.books[filePath] = next;
    this.save();
    return next;
  }

  /** 去抖写盘 */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
  }

  /** 立即同步写盘（退出前调用） */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 写入失败:', err);
    }
  }
}
