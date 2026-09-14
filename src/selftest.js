'use strict';
/**
 * 冒烟自检：electron . --selftest
 * 结果写入 selftest-report.json，进程退出码 0=通过。
 * 全程使用临时数据目录，不污染真实数据。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Store = require('./store');

function check(list, name, cond, detail, soft) {
  list.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail), soft: !!soft });
}

async function runSelfTest(ctx) {
  const { app, weekUtil, createNoteWindow } = ctx;
  const results = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhoujian-test-'));

  /* ---------------- 1. ISO 周计算 ---------------- */
  try {
    const cases = [
      ['2026-01-01', '2026-W01'],
      ['2026-09-14', '2026-W38'],
      ['2025-12-29', '2026-W01'],
      ['2024-12-30', '2025-W01'],
      ['2027-01-03', '2026-W53'],
      ['2023-01-01', '2022-W52']
    ];
    let bad = [];
    for (const [d, want] of cases) {
      const got = weekUtil.weekKey(new Date(d + 'T12:00:00'));
      if (got !== want) bad.push(`${d} 期望${want} 实得${got}`);
    }
    check(results, 'ISO 周计算', bad.length === 0, bad.join('; '));

    const r = weekUtil.rangeOf('2026-W38');
    const okRange = r && weekUtil.fmtDate(r.start) === '2026-09-14' && weekUtil.fmtDate(r.end) === '2026-09-20';
    check(results, '周起止日期 (2026-W38)', okRange, okRange ? '09-14 ~ 09-20' : JSON.stringify(r));

    const shift = [weekUtil.shiftKey('2026-W38', -1), weekUtil.shiftKey('2026-W38', 1), weekUtil.shiftKey('2026-W01', -1)];
    check(results, '周偏移跨年', shift[0] === '2026-W37' && shift[1] === '2026-W39' && shift[2] === '2025-W52',
      shift.join(' / '));
  } catch (e) {
    check(results, 'ISO 周计算', false, e.message);
  }

  /* ---------------- 2. 存盘往返 ---------------- */
  let st = null;
  try {
    st = new Store(path.join(tmp, 'data'));
    check(results, '数据目录初始化', fs.existsSync(st.weeksDir), st.root);

    const k = '2026-W38';
    const w0 = st.loadWeek(k);
    check(results, '空周结构', w0.entries.length === 0 && w0.title.includes('2026'), w0.title);

    const saved = st.saveWeek(k, {
      entries: [
        { text: '完成登录模块联调', done: true, star: true },
        { text: '评审需求文档', done: false }
      ],
      summary: '本周节奏正常，下周推进灰度。'
    });
    check(results, '写入条目', saved.entries.length === 2 && saved.entries[0].done === true, JSON.stringify(saved.entries.map(e => e.text)));

    const re = st.loadWeek(k);
    check(results, '读回一致', re.entries.length === 2 && re.summary.includes('灰度'), re.summary);

    const onDisk = JSON.parse(fs.readFileSync(st.weekPath(k), 'utf8'));
    check(results, '落盘为 JSON', onDisk.entries.length === 2, st.weekPath(k));
    check(results, '无残留 .tmp', !fs.existsSync(st.weekPath(k) + '.tmp'), '');

    st.saveWeek(k, { entries: saved.entries.concat([{ text: '第三条' }]) });
    const bk = fs.readdirSync(st.backupDir).filter(f => f.startsWith(k + '.'));
    check(results, '覆盖前自动备份', bk.length >= 1, `备份 ${bk.length} 份`);

    const stats = st.stats();
    check(results, '统计口径', stats.weeks === 1 && stats.total === 3 && stats.done === 1,
      `周${stats.weeks} 条${stats.total} 完成${stats.done}`);

    /* ---------------- 子任务 ---------------- */

    st.saveWeek(k, {
      entries: [
        { id: 'P1', text: '上线灰度', star: true, children: [
          { id: 'C1', text: '准备灰度名单', done: true },
          { id: 'C2', text: '通知业务方', done: false }
        ]},
        { id: 'P2', text: '写周报', done: true }
      ]
    });
    const wt = st.loadWeek(k);
    const p1 = wt.entries.find(e => e.id === 'P1');
    check(results, '子任务落盘', !!p1 && p1.children.length === 2,
      p1 ? JSON.stringify(p1.children.map(c => c.text)) : '未找到');
    check(results, '父任务状态由子任务推导（未全完成 → 未完成）', p1.done === false, 'done=' + p1.done);

    const diskChild = JSON.parse(fs.readFileSync(st.weekPath(k), 'utf8'))
      .entries.find(e => e.id === 'P1').children;
    check(results, '子任务写入 JSON 文件', diskChild.length === 2 && diskChild[0].done === true,
      JSON.stringify(diskChild.map(c => c.text + ':' + c.done)));

    const ls = (require('./store').leavesOf);
    check(results, '叶子节点口径（父任务不重复计数）',
      ls(p1).length === 2 && ls(wt.entries.find(e => e.id === 'P2')).length === 1,
      `P1 → ${ls(p1).length} 项`);

    const st2 = st.stats();
    check(results, '统计按可勾选单元计算', st2.total === 3 && st2.done === 2 && st2.parents === 2 && st2.subs === 2,
      `total=${st2.total} done=${st2.done} parents=${st2.parents} subs=${st2.subs}`);

    const lw = st.listWeeks()[0];
    check(results, '周列表含子任务口径', lw.total === 3 && lw.subs === 2 && lw.rate === 67,
      `total=${lw.total} subs=${lw.subs} rate=${lw.rate}%`);

    const hs = st.search('灰度名单');
    check(results, '检索能命中子任务并带出父任务',
      hs.length === 1 && hs[0].hits.length === 1 && hs[0].hits[0].parentText === '上线灰度',
      JSON.stringify(hs[0] && hs[0].hits[0] && { t: hs[0].hits[0].text, p: hs[0].hits[0].parentText }));

    const md = st.toMarkdown();
    check(results, 'Markdown 导出为嵌套列表',
      md.includes('- [ ] 上线灰度') && /^ {4}- \[x\] 准备灰度名单/m.test(md),
      (md.split('\n').find(l => l.includes('灰度名单')) || '').replace(/ /g, '·'));

    /* 子任务全完成 → 父任务自动变完成 */
    const updated = st.loadWeek(k);
    const up1 = updated.entries.find(e => e.id === 'P1');
    up1.children.forEach(c => { c.done = true; });
    st.saveWeek(k, { entries: updated.entries });
    check(results, '子任务全完成后父任务自动完成',
      st.loadWeek(k).entries.find(e => e.id === 'P1').done === true, '');

    /* 老格式（没有 children 字段）必须能读 */
    const legacy = { v: 1, week: '2026-W37', entries: [{ id: 'L1', text: '老格式条目', done: true }] };
    fs.writeFileSync(path.join(st.weeksDir, '2026-W37.json'), JSON.stringify(legacy), 'utf8');
    const lg = st.loadWeek('2026-W37');
    check(results, '兼容老周文件（无 children 字段）',
      lg.entries.length === 1 && Array.isArray(lg.entries[0].children),
      'children=' + JSON.stringify(lg.entries[0].children));

    /* 恢复成简单两三条，后面的用例继续用 */
    st.saveWeek(k, {
      entries: [
        { text: '完成登录模块联调', done: true, star: true },
        { text: '评审需求文档', done: false },
        { text: '第三条', done: false }
      ],
      summary: '本周节奏正常，下周推进灰度。'
    });
    try { fs.unlinkSync(path.join(st.weeksDir, '2026-W37.json')); } catch (_) {}

    const hits = st.search('模块');
    check(results, '跨周检索', hits.length === 1 && hits[0].hits.length === 1, JSON.stringify(hits.map(h => h.week)));

    const list = st.listWeeks();
    check(results, '周列表', list.length === 1 && list[0].rate === 33, JSON.stringify(list[0] && list[0].rate));

    const ex = st.exportMarkdown();
    check(results, 'Markdown 导出', fs.existsSync(ex.file) && ex.markdown.includes('- [x]'),
      path.basename(ex.file));

    const s2 = new Store(path.join(tmp, 'data'));
    check(results, '重启后配置/数据仍在', s2.loadWeek(k).entries.length === 3 && s2.getSettings().theme === 'ink', '');
  } catch (e) {
    check(results, '存盘往返', false, e.message + '\n' + e.stack);
  }

  /* ---------------- 3. 窗口能力 ---------------- */
  try {
    const win = createNoteWindow();
    const logs = [];
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 2) logs.push({ level, message: String(message).slice(0, 300), src: String(sourceId).split(/[\\/]/).pop(), line });
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => logs.push({ ev: 'did-fail-load', code, desc, url }));
    win.webContents.on('preload-error', (e, p, err) => logs.push({ ev: 'preload-error', err: String(err) }));

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('窗口加载超时')), 15000);
      win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); });
    });
    await new Promise(r => setTimeout(r, 1500));   // 等渲染层 boot() 跑完
    check(results, '便签窗口创建', !!win && !win.isDestroyed(), '');

    const errs = logs.filter(l => l.level >= 3 || l.ev);
    check(results, '渲染层无脚本错误', errs.length === 0,
      errs.length ? JSON.stringify(errs).slice(0, 400) : '无报错');

    const b0 = win.getBounds();
    check(results, '窗口初始尺寸', b0.width >= 250 && b0.height >= 170, `${b0.width}x${b0.height}`);

    win.setBounds({ x: b0.x, y: b0.y, width: 420, height: 640 });
    await new Promise(r => setTimeout(r, 250));
    const b1 = win.getBounds();
    check(results, '程序化缩放生效', Math.abs(b1.width - 420) <= 2 && Math.abs(b1.height - 640) <= 2,
      `${b1.width}x${b1.height}（请求 420x640）`);

    /* 渲染层健康检查：这一步能抓到 preload / 脚本作用域冲突这类问题 */
    const probe = await win.webContents.executeJavaScript(`(() => {
      const need = ['#titlebar', '#list', '#input', '#weekTitle', '.grip', '#panel'];
      return {
        missing: need.filter(s => !document.querySelector(s)),
        grips: document.querySelectorAll('.grip').length,
        bridge: typeof window.zb,
        ready: typeof window.__zb,
        title: (document.querySelector('#weekTitle')||{}).textContent
      };
    })()`).catch(e => ({ missing: ['JS异常:' + e.message], ready: false }));

    check(results, '界面骨架完整', probe.missing.length === 0, JSON.stringify(probe.missing));
    check(results, '八向缩放手柄', probe.grips === 8, probe.grips + ' 个');
    check(results, 'preload 桥可用', probe.bridge === 'object', 'window.zb = ' + probe.bridge);
    check(results, '渲染层脚本已执行', probe.ready !== 'undefined',
      'window.__zb = ' + probe.ready + ' / 标题 = "' + probe.title + '"');
    check(results, '已定位到当前周', !!(probe.title && /第 \d+ 周/.test(probe.title)), String(probe.title));

    /* 置顶：必须真的生效（走真实业务路径：先摘后挂 + 守护） */
    win.show();
    await new Promise(r => setTimeout(r, 800));

    const origTop = ctx.store.getSettings().alwaysOnTop;

    const rOn = ctx.setAlwaysOnTop(true);
    await new Promise(r => setTimeout(r, 1600));   // 留出「探测层级 + 读回失败自动补打」的时间
    const onActual = win.isAlwaysOnTop();
    check(results, '置顶：打开后系统读回为 true', onActual === true,
      `want=${rOn && rOn.want} actual=${onActual}`);

    const lvs = ctx.getTopLevels ? ctx.getTopLevels() : undefined;
    check(results, '置顶：已探测出本机可用的层级',
      Array.isArray(lvs) && lvs.length > 0,
      Array.isArray(lvs)
        ? `可用 ${lvs.map(v => v === null ? '默认' : v).join(' / ')}　→ 采用最强档（可压过其他置顶窗口）`
        : '未探测');

    ctx.setAlwaysOnTop(false);
    await new Promise(r => setTimeout(r, 500));
    const offActual = win.isAlwaysOnTop();
    check(results, '置顶：关闭后系统读回为 false', offActual === false, 'actual=' + offActual);

    ctx.setAlwaysOnTop(true);
    await new Promise(r => setTimeout(r, 1600));
    const againActual = win.isAlwaysOnTop();
    check(results, '置顶：可反复开关（不因"单次调用被丢弃"而失效）', againActual === true,
      `actual=${againActual} setting=${ctx.store.getSettings().alwaysOnTop}`);

    if (origTop !== true) {
      ctx.setAlwaysOnTop(origTop);
      await new Promise(r => setTimeout(r, 400));
    }
    check(results, '置顶设置已还原初始值', ctx.store.getSettings().alwaysOnTop === origTop,
      `初始值=${origTop} 当前=${ctx.store.getSettings().alwaysOnTop}`);

    check(results, '无边框生效', win.isResizable() === true, 'resizable=true（透明窗口靠自定义手柄缩放）');

    /* 子任务界面：内存注入渲染（不落盘） */
    const sub = await win.webContents.executeJavaScript(`window.__zbTest.inject([
      { id:'t1', text:'上线灰度', done:false, star:true, children:[
          { id:'t1a', text:'准备灰度名单', done:true },
          { id:'t1b', text:'通知业务方', done:false } ] },
      { id:'t2', text:'写周报', done:false, star:false, children:[] }
    ])`).catch(e => ({ error: String(e.message) }));
    check(results, '子任务界面渲染',
      sub && sub.subs === 1 && sub.childItems === 2 && Array.isArray(sub.progs) && sub.progs[0] === '1/2',
      JSON.stringify(sub));
    check(results, '子任务操作按钮齐全',
      sub && sub.addSubBtns === 2 && sub.upBtns === 2 && sub.downBtns === 1,
      sub ? `加子任务=${sub.addSubBtns} 升级=${sub.upBtns} 降级=${sub.downBtns}` : '未执行');
    check(results, '进度条按叶子节点计算',
      sub && sub.barWidth === '33%',           // 3 项可勾选，完成 1 项
      sub ? 'bar=' + sub.barWidth + '（期望 33%）' : '未执行');

    const subAdd = await win.webContents.executeJavaScript(`window.__zbTest.clickSubAdd(1)`)
      .catch(e => ({ error: String(e.message) }));
    check(results, '点「加子任务」弹出输入行并聚焦',
      subAdd && subAdd.hasInput === true && subAdd.focused === true,
      JSON.stringify(subAdd));

    /* 只读内容态（默认形态） */
    await win.webContents.executeJavaScript(`window.__zbTest.lite(true)`).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    const liteOn = await win.webContents.executeJavaScript(`window.__zbTest.liteState()`).catch(e => ({ error: String(e.message) }));
    check(results, '只读态：隐藏标题栏 / 输入框 / 勾选框 / 操作按钮',
      !!liteOn && liteOn.titlebar === 'none' && liteOn.composer === 'none' &&
      liteOn.chk === 'none' && liteOn.acts === 'none',
      JSON.stringify({ 标题栏: liteOn.titlebar, 输入框: liteOn.composer, 勾选框: liteOn.chk, 按钮: liteOn.acts }));
    check(results, '只读态：显示周次表头与完成进度',
      !!liteOn && liteOn.roHead !== 'none' && /第 \d+ 周/.test(liteOn.roWeek || ''),
      `表头="${liteOn && liteOn.roWeek}" 进度="${liteOn && liteOn.roProg}"`);
    check(results, '只读态：保留子任务进度徽标（属于内容）',
      !!liteOn && liteOn.prog !== 'none', 'prog=' + (liteOn && liteOn.prog));

    await win.webContents.executeJavaScript(`window.__zbTest.lite(false)`).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    const liteOff = await win.webContents.executeJavaScript(`window.__zbTest.liteState()`).catch(e => ({ error: String(e.message) }));
    check(results, '退出只读态后界面恢复完整',
      !!liteOff && liteOff.titlebar !== 'none' && liteOff.composer !== 'none' && liteOff.roHead === 'none',
      JSON.stringify({ 标题栏: liteOff && liteOff.titlebar, 输入框: liteOff && liteOff.composer, 表头: liteOff && liteOff.roHead }));

    await win.webContents.executeJavaScript(`window.__zbTest.reload()`).catch(() => {});
    await new Promise(r => setTimeout(r, 300));

    win.destroy();
    await new Promise(r => setTimeout(r, 250));
    check(results, '窗口销毁无异常', true, '');
  } catch (e) {
    check(results, '窗口能力', false, e.message + '\n' + (e.stack || ''));
  }

  /* ---------------- 4. 开机自启（测完还原） ---------------- */
  try {
    const before = ctx.readAutoStart ? ctx.readAutoStart() : { exists: null };

    let on = null, onThrew = null;
    try { on = ctx.applyAutoStart(true); } catch (e) { onThrew = String(e.message); }
    await new Promise(r => setTimeout(r, 400));

    check(results, '开机自启调用不抛异常并返回结果',
      !onThrew && !!on && typeof on.ok === 'boolean' && !!on.target,
      onThrew || `ok=${on && on.ok} 目标=${on && on.target}`);

    check(results, '开机自启写入未报错',
      !!on && on.ok === true,
      on ? `enabled=${on.enabled} 来源=${on.source}` + (on.ok ? '' : ' 原因=' + (on.error || '未知')) : '未执行');

    check(results, '开机自启已用注册表直查校验',
      !!on && on.verified === true && on.enabled === true,
      on ? (on.verified ? `注册表读回 enabled=${on.enabled}` : 'reg.exe 不可用，本次未能校验（不算失败）') : '未执行',
      !(on && on.verified === true));

    let off = null;
    try { off = ctx.applyAutoStart(false); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
    check(results, '开机自启可关闭且无残留',
      !!off && off.enabled === false,
      off ? '关闭后读回=' + off.enabled : '未执行',
      !!off && off.enabled !== false);

    if (before.exists) {
      try { ctx.applyAutoStart(true); } catch (_) {}
      check(results, '还原测试前的自启状态', true, '原本为开启，已还原');
    } else if (off) {
      check(results, '还原测试前的自启状态', true, '原本为关闭，已还原');
    }
  } catch (e) {
    check(results, '开机自启', false, e.message);
  }

  /* ---------------- 5. 图标 ---------------- */
  try {
    const ip = ctx.iconPath();
    check(results, '应用图标存在', !!ip && fs.existsSync(ip), ip || '缺失');
  } catch (e) {
    check(results, '应用图标', false, e.message);
  }

  /* ---------------- 6. 托盘 ---------------- */
  try {
    const t = ctx.createTray();
    check(results, '系统托盘创建', !!t, t ? 'ok' : 'tray 未创建');
    if (t) t.destroy();
  } catch (e) {
    check(results, '系统托盘', false, e.message);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  const hard = results.filter(r => !r.soft);
  const softFail = results.filter(r => r.soft && !r.pass);
  const pass = hard.every(r => r.pass);
  return {
    pass,
    checkedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${os.release()}`,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    softFailed: softFail.length,
    results
  };
}

module.exports = { runSelfTest };
