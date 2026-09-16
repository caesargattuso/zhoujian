'use strict';
/**
 * 数据层：所有便签内容按周存盘。
 *
 * 目录结构（默认 <项目或exe同级>/data，不可写则回落到 userData/data）：
 *   data/
 *     settings.json          全局配置（置顶/透明度/缩放/自启/窗口位置…）
 *     weeks/2026-W37.json    每周一份，人类可读
 *     weeks/.backup/         每次覆盖前的快照，按周保留最近 N 份
 *     export/                导出的 Markdown
 *
 * 写入策略：先写 .tmp → fsync → rename 原子替换，再做备份轮换。
 */

const fs = require('fs');
const path = require('path');
const weekUtil = require('./week');

const BACKUP_KEEP = 8;

const DEFAULT_SETTINGS = {
  alwaysOnTop: true,
  topStrong: true,          // 用本机可用的最强置顶层级（能压过其他置顶窗口）
  transparency: true,         // 圆角 + 投影（关掉则退化为不透明直角窗口）
  disableGpu: false,          // 兼容模式：关硬件加速（默认关；部分机器反而会白底/不可见）
  opacity: 0.97,
  scale: 1,
  scaleWindow: true,          // 布局缩放时窗口一起缩放
  theme: 'ink',               // ink | paper | amber
  accent: '#e8b04b',
  autoStart: false,
  startMinimized: false,
  closeToTray: true,
  showTray: true,
  firstRunDone: false,
  bounds: { x: null, y: null, width: 372, height: 588 }
};

function nowISO() { return new Date().toISOString(); }

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------- 条目结构
 * 一条记录可以带子任务（只支持一层，便签宽度有限，再深就没法看了）：
 *   { id, text, done, star, children: [ {id, text, done, star, ...} ], createdAt, updatedAt }
 * 约定：父任务的 done 是「派生值」—— 有子任务时，全部子任务完成才算完成。
 *       这样不会出现「父任务勾了但子任务没做完」的矛盾状态。
 */

function normChild(c) {
  return {
    id: c && c.id || uid(),
    text: String(c && c.text == null ? '' : c.text),
    done: !!(c && c.done),
    star: !!(c && c.star),
    createdAt: (c && c.createdAt) || nowISO(),
    updatedAt: (c && c.updatedAt) || (c && c.createdAt) || nowISO()
  };
}

function normEntry(e, touch) {
  const children = (Array.isArray(e && e.children) ? e.children : [])
    .map(normChild)
    .filter(c => c.text.trim() !== '');
  if (children.length) {
    // 父任务状态由子任务推导
    const all = children.every(c => c.done);
    return {
      id: (e && e.id) || uid(),
      text: String(e && e.text == null ? '' : e.text),
      done: all,
      star: !!(e && e.star),
      children,
      createdAt: (e && e.createdAt) || nowISO(),
      updatedAt: touch ? nowISO() : ((e && e.updatedAt) || nowISO())
    };
  }
  return {
    id: (e && e.id) || uid(),
    text: String(e && e.text == null ? '' : e.text),
    done: !!(e && e.done),
    star: !!(e && e.star),
    children: [],
    createdAt: (e && e.createdAt) || nowISO(),
    updatedAt: touch ? nowISO() : ((e && e.updatedAt) || nowISO())
  };
}

/** 展开成叶子节点：有子任务就算子任务，否则算自己 */
function leavesOf(e) {
  return (e.children && e.children.length) ? e.children : [e];
}

/** 父任务进度（没有子任务返回 null） */
function childProgress(e) {
  if (!e.children || !e.children.length) return null;
  const done = e.children.filter(c => c.done).length;
  return { done, total: e.children.length, all: done === e.children.length };
}

/** 一条记录贡献多少个「可勾选单元」*/
function countEntry(e) {
  const ls = leavesOf(e);
  return { total: ls.length, done: ls.filter(x => x.done).length, stars: (e.star ? 1 : 0) + (e.children || []).filter(c => c.star).length };
}


class Store {
  constructor(rootDir) {
    this.root = rootDir;
    this.weeksDir = path.join(rootDir, 'weeks');
    this.backupDir = path.join(this.weeksDir, '.backup');
    this.exportDir = path.join(rootDir, 'export');
    this.settingsPath = path.join(rootDir, 'settings.json');

    for (const d of [this.root, this.weeksDir, this.backupDir, this.exportDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    }
    this.settings = this._readSettings();
  }

  // ---------------------------------------------------------------- 配置

  _readSettings() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')); } catch (_) {}
    const s = Object.assign({}, DEFAULT_SETTINGS, raw);
    s.bounds = Object.assign({}, DEFAULT_SETTINGS.bounds, raw.bounds || {});
    return s;
  }

  getSettings() { return this.settings; }

  patchSettings(patch) {
    this.settings = Object.assign({}, this.settings, patch || {});
    this.settings.bounds = Object.assign({}, this.settings.bounds, (patch && patch.bounds) || {});
    try { this._atomicWrite(this.settingsPath, JSON.stringify(this.settings, null, 2)); } catch (_) {}
    return this.settings;
  }

  // ---------------------------------------------------------------- 单周

  weekPath(key) { return path.join(this.weeksDir, `${key}.json`); }

  emptyWeek(key) {
    const d = weekUtil.describe(key);
    return { v: 1, week: key, year: d.year, weekNo: d.week, start: d.start, end: d.end,
             title: d.title, range: d.range, summary: '', entries: [],
             createdAt: nowISO(), updatedAt: nowISO() };
  }

  loadWeek(key) {
    if (!weekUtil.parseKey(key)) throw new Error('非法的周键: ' + key);
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.weekPath(key), 'utf8')); } catch (_) {}
    if (!data || !Array.isArray(data.entries)) {
      const base = this.emptyWeek(key);
      return data ? Object.assign(base, data, { entries: [] }) : base;
    }
    // 兼容性兜底：老周文件没有 children 字段，这里补成空数组
    data.entries = data.entries
      .map(e => normEntry(e, false))
      .filter(e => e.text.trim() !== '' || e.children.length > 0);
    return data;
  }

  saveWeek(key, data) {
    if (!weekUtil.parseKey(key)) throw new Error('非法的周键: ' + key);
    const current = this.loadWeek(key);
    const merged = Object.assign({}, current, data, {
      week: key,
      v: 1,
      entries: (data && Array.isArray(data.entries) ? data.entries : current.entries)
        .map(e => normEntry(e, true))
        .filter(e => String(e.text).trim() !== '' || (e.children && e.children.length > 0)),
      updatedAt: nowISO()
    });
    this._backup(key);
    this._atomicWrite(this.weekPath(key), JSON.stringify(merged, null, 2));
    return merged;
  }

  /** 只保留有内容的周文件，空周不落盘 */
  deleteWeek(key) {
    try { fs.unlinkSync(this.weekPath(key)); return true; } catch (_) { return false; }
  }

  hasWeek(key) {
    try { return fs.statSync(this.weekPath(key)).isFile(); } catch (_) { return false; }
  }

  // ---------------------------------------------------------------- 列表/检索

  allWeekKeys() {
    let files = [];
    try { files = fs.readdirSync(this.weeksDir); } catch (_) { return []; }
    return files
      .filter(f => /^\d{4}-W\d{2}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
  }

  listWeeks() {
    return this.allWeekKeys().map(k => {
      const w = this.loadWeek(k);
      let total = 0, done = 0, stars = 0, parents = 0, subs = 0;
      for (const e of w.entries) {
        const c = countEntry(e);
        total += c.total; done += c.done; stars += c.stars;
        parents++;
        subs += (e.children || []).length;
      }
      return {
        week: k, title: w.title, range: w.range, start: w.start, end: w.end,
        total, done, open: total - done,
        rate: total ? Math.round((done / total) * 100) : 0,
        stars, parents, subs,
        summary: w.summary || '',
        updatedAt: w.updatedAt
      };
    });
  }

  /**
   * 全文检索：父任务和子任务都会命中。
   * hits 里每条都带 parent 信息，方便界面展示「这条在哪条任务下面」。
   */
  search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const k of this.allWeekKeys()) {
      const w = this.loadWeek(k);
      const hits = [];
      for (const e of w.entries) {
        if (e.text.toLowerCase().includes(q)) {
          hits.push({ id: e.id, text: e.text, done: e.done, star: e.star,
                      parentId: null, parentText: null, subCount: (e.children || []).length });
        }
        for (const c of (e.children || [])) {
          if (c.text.toLowerCase().includes(q)) {
            hits.push({ id: c.id, text: c.text, done: c.done, star: c.star,
                        parentId: e.id, parentText: e.text, subCount: 0 });
          }
        }
      }
      const inSummary = (w.summary || '').toLowerCase().includes(q);
      if (hits.length || inSummary) {
        out.push({ week: k, title: w.title, range: w.range, summary: w.summary || '', hits, hitSummary: inSummary });
      }
    }
    return out;
  }

  stats() {
    const keys = this.allWeekKeys();
    let total = 0, done = 0, stars = 0, parents = 0, subs = 0;
    for (const k of keys) {
      const w = this.loadWeek(k);
      for (const e of w.entries) {
        const c = countEntry(e);
        total += c.total; done += c.done; stars += c.stars;
        parents++;
        subs += (e.children || []).length;
      }
    }
    const cur = weekUtil.weekKey();
    const cw = this.loadWeek(cur);
    let cTotal = 0, cDone = 0, cParents = 0, cSubs = 0;
    for (const e of cw.entries) {
      const c = countEntry(e);
      cTotal += c.total; cDone += c.done;
      cParents++;
      cSubs += (e.children || []).length;
    }
    return {
      weeks: keys.length,
      total, done, open: total - done, stars, parents, subs,
      rate: total ? Math.round((done / total) * 100) : 0,
      currentWeek: cur,
      currentTitle: cw.title,
      currentRange: cw.range,
      currentTotal: cTotal,
      currentDone: cDone,
      currentParents: cParents,
      currentSubs: cSubs,
      dataDir: this.root
    };
  }

  // ---------------------------------------------------------------- 导出

  toMarkdown(keys) {
    const list = (keys && keys.length ? keys : this.allWeekKeys());
    const lines = [`# 工作周记 · 全部回顾`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')}　共 ${list.length} 周`, ''];
    for (const k of list) {
      const w = this.loadWeek(k);
      let total = 0, done = 0;
      for (const e of w.entries) { const c = countEntry(e); total += c.total; done += c.done; }
      lines.push(`## ${w.title}　（${w.range}）`);
      lines.push('');
      lines.push(`完成进度：**${done}/${total}**　${total ? Math.round(done / total * 100) + '%' : '—'}`);
      lines.push('');
      if (w.entries.length) {
        for (const e of w.entries) {
          const box = e.done ? 'x' : ' ';
          const star = e.star ? ' ⭐' : '';
          lines.push(`- [${box}] ${e.text.replace(/\n/g, '\n    ')}${star}`);
          for (const c of (e.children || [])) {
            const cbox = c.done ? 'x' : ' ';
            const cstar = c.star ? ' ⭐' : '';
            lines.push(`    - [${cbox}] ${c.text.replace(/\n/g, '\n        ')}${cstar}`);
          }
        }
      } else {
        lines.push('- （本周暂无记录）');
      }
      lines.push('');
      if (w.summary && w.summary.trim()) {
        lines.push(`**本周复盘**：`);
        lines.push('');
        lines.push(w.summary.trim().split('\n').map(l => '> ' + l).join('\n'));
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 单周导出为 Markdown（用于「复制为 Markdown」）：标题用周标题，含进度、条目、子任务、复盘 */
  weekToMarkdown(key) {
    const w = this.loadWeek(key);
    const isCur = key === weekUtil.weekKey();
    let total = 0, done = 0;
    for (const e of w.entries) { const c = countEntry(e); total += c.total; done += c.done; }
    const lines = [`# ${w.title}　（${w.range}）`, ''];
    lines.push(`完成进度：**${done}/${total}**　${total ? Math.round(done / total * 100) + '%' : '—'}${isCur ? '　· 本周' : ''}`);
    lines.push('');
    if (w.entries.length) {
      for (const e of w.entries) {
        const box = e.done ? 'x' : ' ';
        const star = e.star ? ' ⭐' : '';
        lines.push(`- [${box}] ${e.text.replace(/\n/g, '\n    ')}${star}`);
        for (const c of (e.children || [])) {
          const cbox = c.done ? 'x' : ' ';
          const cstar = c.star ? ' ⭐' : '';
          lines.push(`    - [${cbox}] ${c.text.replace(/\n/g, '\n        ')}${cstar}`);
        }
      }
    } else {
      lines.push('- （本周暂无记录）');
    }
    lines.push('');
    if (w.summary && w.summary.trim()) {
      lines.push('**本周复盘**：');
      lines.push('');
      lines.push(w.summary.trim().split('\n').map(l => '> ' + l).join('\n'));
      lines.push('');
    }
    return lines.join('\n').replace(/\n+$/, '\n');
  }

  exportMarkdown() {
    const md = this.toMarkdown();
    const stamp = weekUtil.fmtDate(new Date());
    const file = path.join(this.exportDir, `工作周记-${stamp}.md`);
    this._atomicWrite(file, md);
    return { file, markdown: md };
  }

  /* -------------------------------------------------------------- 内部 */

  _atomicWrite(file, text) {
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      try { fs.fsyncSync(fd); } catch (_) {}
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  _backup(key) {
    const src = this.weekPath(key);
    if (!this.hasWeek(key)) return;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(src, path.join(this.backupDir, `${key}.${stamp}.json`));
      const mine = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith(key + '.'))
        .sort();
      while (mine.length > BACKUP_KEEP) {
        fs.unlinkSync(path.join(this.backupDir, mine.shift()));
      }
    } catch (_) {}
  }
}

module.exports = Store;
module.exports.uid = uid;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.normEntry = normEntry;
module.exports.normChild = normChild;
module.exports.leavesOf = leavesOf;
module.exports.childProgress = childProgress;
module.exports.countEntry = countEntry;
