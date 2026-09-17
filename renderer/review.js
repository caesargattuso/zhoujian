'use strict';
/* ============================================================
   周笺 · 回顾窗口逻辑
   ============================================================ */

const $ = (s) => document.querySelector(s);
const API = window.zb;
window.__zb = { ready: true };

/* 右键禁用：不弹上下文菜单 */
document.addEventListener('contextmenu', (e) => e.preventDefault());

const S = {
  weeks: [],          // listWeeks 结果
  stats: null,
  sel: null,          // 选中的周键
  filter: 'all',      // all | open | star
  query: '',
  cache: new Map()    // weekKey -> 完整周数据
};

function toast(msg, ms = 1700) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.hidden = true, 220); }, ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hi(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';

/** 父任务完成度由子任务推导，和主进程侧的规则保持一致 */
function syncDone(entry) {
  if (entry && entry.children && entry.children.length) {
    entry.done = entry.children.every(c => c.done);
  }
}

/* ─────────────────────────── 数据加载 ─────────────────────────── */

async function getWeek(key) {
  if (!S.cache.has(key)) S.cache.set(key, await API.loadWeek(key));
  return S.cache.get(key);
}

async function reload({ keepSel = true } = {}) {
  S.cache.clear();
  S.weeks = await API.listWeeks();
  S.stats = await API.stats();
  if (!keepSel || !S.sel || !S.weeks.some(w => w.week === S.sel)) {
    S.sel = S.weeks.length ? S.weeks[0].week : null;
  }
  renderStats();
  renderWeekList();
  renderDetail();
}

/* ─────────────────────────── 统计条 ─────────────────────────── */

function renderStats() {
  const s = S.stats || {};
  const cur = S.weeks.find(w => w.week === s.currentWeek);
  $('#subTitle').textContent = s.weeks
    ? `共 ${s.weeks} 周 · ${s.total} 项可勾选${s.subs ? `（含 ${s.subs} 条子任务）` : ''} · 完成率 ${s.rate}%`
    : '暂无记录';

  const cards = [
    { k: '记录周数', v: s.weeks || 0, cls: '' },
    { k: '任务 / 子任务', v: `${s.parents || 0}<small> / ${s.subs || 0}</small>`, cls: '', raw: true },
    { k: '已完成', v: s.done || 0, cls: 'ok' },
    { k: '待办', v: s.open || 0, cls: '' },
    { k: '总完成率', v: (s.rate || 0) + '<small>%</small>', cls: 'accent', raw: true },
    {
      k: `本周（${s.currentRange || '—'}）`,
      v: cur ? `${cur.done}<small>/${cur.total}</small>` : '0<small>/0</small>',
      cls: '', raw: true
    }
  ];
  $('#stats').innerHTML = cards.map(c =>
    `<div class="card ${c.cls}"><div class="k">${esc(c.k)}</div><div class="v">${c.raw ? c.v : c.v}</div></div>`
  ).join('');
}

/* ─────────────────────────── 周列表 ─────────────────────────── */

function filteredWeeks() {
  if (S.filter === 'all') return S.weeks;
  return S.weeks.filter(w => S.filter === 'open' ? w.open > 0 : w.stars > 0);
}

function renderWeekList() {
  const box = $('#weekList');
  const list = filteredWeeks();
  const curKey = S.stats && S.stats.currentWeek;

  if (!list.length) {
    box.innerHTML = `<div class="placeholder" style="padding:34px 10px">${
      S.weeks.length ? '当前筛选下没有记录' : '<b>还没有任何记录</b>在便签里记几笔，这里就会自动汇总'
    }</div>`;
    return;
  }

  box.innerHTML = list.map(w => `
    <div class="witem ${w.week === S.sel ? 'sel' : ''} ${w.week === curKey ? 'now' : ''}" data-w="${w.week}">
      <div class="top">
        <span class="t">${esc(w.title.replace(/ 年第 /, '·第').replace(/ 周$/, '周'))}</span>
        <span class="badge">${w.total}</span>
      </div>
      <div class="r">${esc(w.range)}</div>
      <div class="meter"><i style="width:${w.rate}%"></i></div>
      <div class="meta">
        <span>完成 ${w.done}/${w.total}</span>
        ${w.open ? `<span>待办 ${w.open}</span>` : '<span style="color:var(--ok)">全部完成</span>'}
        ${w.subs ? `<span>子任务 ${w.subs}</span>` : ''}
        ${w.stars ? `<span class="s">★ ${w.stars}</span>` : ''}
      </div>
    </div>`).join('');

  box.querySelectorAll('.witem').forEach(el => {
    el.addEventListener('click', () => {
      S.sel = el.dataset.w;
      $('#q').value = ''; S.query = ''; $('#qclear').hidden = true;
      renderWeekList();
      renderDetail();
    });
  });
}

/* ─────────────────────────── 明细 ─────────────────────────── */

function matchFilter(e) {
  if (S.filter === 'open') return !e.done;
  if (S.filter === 'star') return e.star;
  return true;
}

async function renderDetail() {
  const box = $('#detail');

  if (S.query.trim()) { renderSearch(box); return; }

  if (!S.sel) {
    box.innerHTML = `<div class="placeholder"><b>还没有任何记录</b>
      在桌面便签里记一条，就会按周自动归档到这里<br>
      数据保存在本机 data/weeks 目录，纯文本可读</div>`;
    return;
  }

  const w = await getWeek(S.sel);
  const all = w.entries || [];

  const leaves = (e) => (e.children && e.children.length) ? e.children : [e];
  let total = 0, doneN = 0;
  for (const e of all) { const ls = leaves(e); total += ls.length; doneN += ls.filter(x => x.done).length; }
  const subCount = all.reduce((n, e) => n + (e.children ? e.children.length : 0), 0);
  const rate = total ? Math.round(doneN / total * 100) : 0;

  // 父任务自己命中、或它的任一子任务命中，都要显示出来
  const shown = all.filter(e => matchFilter(e) || (e.children || []).some(matchFilter));

  const rowHtml = (e, isChild, parentId) => {
    const kids = e.children || [];
    const title = isChild ? '切换完成'
      : (kids.length ? `全选 / 全不选 ${kids.length} 个子任务` : '切换完成');
    const doneKids = kids.filter(c => c.done).length;
    return `
    <div class="row ${e.done ? 'done' : ''}${isChild ? ' child' : ''}" data-id="${e.id}" data-parent="${parentId || ''}">
      <button class="box" title="${title}">${CHECK_SVG}</button>
      <div class="txt">${esc(e.text)}</div>
      ${e.star ? '<span class="star" title="重点">★</span>' : ''}
      ${!isChild && kids.length ? `<span class="prog${doneKids === kids.length ? ' all' : ''}">${doneKids}/${kids.length}</span>` : ''}
      <span class="wk">${e.createdAt ? esc(String(e.createdAt).slice(5, 10).replace('-', '/')) : ''}</span>
    </div>`;
  };

  const blockHtml = (e) => {
    let h = rowHtml(e, false, null);
    const kids = (e.children || []).filter(matchFilter);
    // 父任务自己没命中但子任务命中时，仍然把全部子任务显示出来，便于看上下文
    const showKids = kids.length ? kids : (e.children || []);
    if ((e.children || []).length) {
      h += `<div class="sublist">${showKids.map(c => rowHtml(c, true, e.id)).join('')}</div>`;
    }
    return h;
  };

  let body = '';
  if (!all.length) {
    body = `<div class="placeholder">这一周没有记录</div>`;
  } else if (!shown.length) {
    body = `<div class="placeholder">当前筛选条件下没有匹配条目</div>`;
  } else {
    const open = shown.filter(e => !e.done);
    const done = shown.filter(e => e.done);
    if (open.length) body += `<div class="grp">待办 ${open.length}</div>` + open.map(blockHtml).join('');
    if (done.length) body += `<div class="grp">已完成 ${done.length}</div>` + done.map(blockHtml).join('');
  }

  box.innerHTML = `
    <div class="dhead">
      <div>
        <h2>${esc(w.title)}</h2>
        <div class="range">${esc(w.range)}　·　${all.length} 条任务${subCount ? ` · ${subCount} 条子任务` : ''}　·　可勾选 ${total} 项</div>
      </div>
      <div class="rate"><b>${rate}%</b><br>完成 ${doneN}/${total}</div>
    </div>
    <div class="dbar"><i style="width:${rate}%"></i></div>
    ${body}
    <div class="summarybox">
      <h4>本周复盘</h4>
      <textarea id="sumEdit" placeholder="这一周做成了什么、卡在哪、下周重点…（自动保存）">${esc(w.summary || '')}</textarea>
    </div>`;

  /* 勾选切换：父任务等于全选/全不选它的子任务 */
  box.querySelectorAll('.row .box').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.row');
      const id = row.dataset.id;
      const pid = row.dataset.parent;
      const owner = pid ? all.find(x => x.id === pid) : null;
      const node = pid
        ? (owner && (owner.children || []).find(c => c.id === id))
        : all.find(x => x.id === id);
      if (!node) return;
      const next = !node.done;
      if (!pid && node.children && node.children.length) {
        const t = new Date().toISOString();
        node.children.forEach(c => { c.done = next; c.updatedAt = t; });
      }
      node.done = next;
      if (owner) syncDone(owner);
      await persist(w);
      renderWeekList();
      renderDetail();
    });
  });

  /* 复盘编辑 */
  const ta = $('#sumEdit');
  let t = null;
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      w.summary = ta.value;
      await persist(w, true);
    }, 600);
  });
  ta.addEventListener('blur', async () => {
    clearTimeout(t);
    if ((w.summary || '') !== ta.value) { w.summary = ta.value; await persist(w, true); }
  });
}

async function persist(w, silent = false) {
  await API.saveWeek(w.week, { entries: w.entries, summary: w.summary });
  S.stats = await API.stats();
  S.weeks = await API.listWeeks();
  renderStats();
  if (!silent) renderWeekList();
  API.broadcast({ type: 'week-saved', week: w.week });
}

/* ─────────────────────────── 检索 ─────────────────────────── */

async function renderSearch(box) {
  const q = S.query.trim();
  const hits = await API.search(q);

  if (!hits.length) {
    box.innerHTML = `<div class="placeholder"><b>没有找到「${esc(q)}」</b>换个关键词试试</div>`;
    return;
  }
  const total = hits.reduce((n, h) => n + h.hits.length, 0);
  box.innerHTML = `
    <div class="dhead">
      <div>
        <h2>搜索：${esc(q)}</h2>
        <div class="range">命中 ${hits.length} 周 · ${total} 条记录</div>
      </div>
    </div>
    <div style="height:14px"></div>
    ${hits.map(h => `
      <div class="sechit">
        <div class="h">
          <b data-w="${h.week}">${esc(h.title)}　${esc(h.range)}</b>
          <span>${h.hits.length} 条命中${h.hitSummary ? ' · 复盘命中' : ''}</span>
        </div>
        ${h.hitSummary ? `<div class="ctx">复盘：${hi(h.summary.slice(0, 160), q)}</div>` : ''}
        ${h.hits.map(e => `
          <div class="row ${e.done ? 'done' : ''}${e.parentText ? ' child' : ''}">
            <span class="box" style="${e.done ? 'background:var(--ok);border-color:var(--ok)' : ''}">${CHECK_SVG}</span>
            <div class="txt">${e.parentText ? `<span class="parentref">${hi(e.parentText, q)}</span><br>` : ''}${hi(e.text, q)}</div>
            ${e.star ? '<span class="star">★</span>' : ''}
            ${e.subCount ? `<span class="prog">+${e.subCount}</span>` : ''}
          </div>`).join('')}
      </div>`).join('')}`;

  box.querySelectorAll('.sechit b[data-w]').forEach(b => {
    b.addEventListener('click', () => {
      S.sel = b.dataset.w;
      $('#q').value = ''; S.query = ''; $('#qclear').hidden = true;
      renderWeekList();
      renderDetail();
    });
  });
}

/* ─────────────────────────── 事件绑定 ─────────────────────────── */

function bind() {
  $('#btnMin').addEventListener('click', () => API.minimize());
  $('#btnClose').addEventListener('click', () => API.close());
  $('#btnMax').addEventListener('click', () => API.toggleMaximize());
  $('#btnData').addEventListener('click', () => API.revealData());

  $('#btnExport').addEventListener('click', async () => {
    try {
      const r = await API.exportMd();
      toast('已导出到 export 目录');
      API.revealFile(r.file);
    } catch (e) { toast('导出失败：' + e.message); }
  });

  $('#btnCopy').addEventListener('click', async () => {
    try {
      const r = await API.exportMd();
      await API.writeClipboard(r.markdown);
      toast('Markdown 已复制到剪贴板');
    } catch (e) { toast('失败：' + e.message); }
  });

  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.filter = b.dataset.f;
    $('#filters').querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
    renderWeekList();
    renderDetail();
  });

  let qt = null;
  $('#q').addEventListener('input', (e) => {
    S.query = e.target.value;
    $('#qclear').hidden = !S.query;
    clearTimeout(qt);
    qt = setTimeout(() => { renderWeekList(); renderDetail(); }, 180);
  });
  $('#qclear').addEventListener('click', () => {
    $('#q').value = ''; S.query = ''; $('#qclear').hidden = true;
    renderWeekList(); renderDetail(); $('#q').focus();
  });

  document.addEventListener('keydown', async (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if (e.key === 'Escape' && document.activeElement === $('#q')) {
      $('#q').value = ''; S.query = ''; $('#qclear').hidden = true; renderWeekList(); renderDetail(); return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (document.activeElement === $('#q') || document.activeElement.tagName === 'TEXTAREA') return;
      const list = filteredWeeks();
      const i = list.findIndex(w => w.week === S.sel);
      const n = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
      if (i >= 0 && n !== i && list[n]) {
        e.preventDefault();
        S.sel = list[n].week;
        renderWeekList(); renderDetail();
      }
    }
  });

  API.onFocusWeek((w) => { if (w) { S.sel = w; renderWeekList(); renderDetail(); } });
  API.onMainEvent(async (msg) => {
    if (!msg) return;
    if (msg.type === 'settings-changed') {
      const s = await API.settings();
      document.documentElement.dataset.theme = s.theme || 'ink';
    }
    if (msg.type === 'week-saved' && msg.week !== S.sel) { S.cache.delete(msg.week); reload(); }
  });
}

async function boot() {
  // 先绑事件，保证界面立刻可交互
  bind();

  try {
    const s = await API.settings();
    document.documentElement.dataset.theme = s.theme || 'ink';
  } catch (_) {}

  try {
    const cur = await API.currentWeek();
    S.sel = cur;
    await reload({ keepSel: true });
    if (!S.sel && S.weeks.length) S.sel = S.weeks[0].week;
    renderWeekList();
    renderDetail();
  } catch (e) {
    $('#detail').innerHTML = `<div class="placeholder"><b>加载失败</b>${esc(e && e.message || e)}</div>`;
  }
}

boot();
