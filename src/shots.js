'use strict';
/**
 * 界面快照：electron . --shots
 * 用临时数据目录灌入示例数据，把便签窗口 / 设置面板 / 回顾窗口各截一张图，
 * 便于在没有人盯着屏幕的情况下确认排版与配色。
 */

const fs = require('fs');
const path = require('path');
const weekUtil = require('./week');

function sample(store) {
  const cur = weekUtil.weekKey();
  const k = (d) => weekUtil.shiftKey(cur, d);

  const W = (n, entries, summary) => store.saveWeek(k(n), { entries, summary: summary || '' });
  const E = (text, done, star, children) => ({
    text, done: !!done, star: !!star,
    children: (children || []).map(([t, d, s]) => ({ text: t, done: !!d, star: !!s }))
  });

  W(0, [
    E('完成登录模块与后端联调，覆盖率补到 78%', false, false, [
      ['补齐登录接口单测', true, false],
      ['联调短信验证码链路', true, false],
      ['异常分支兜底 & 错误码对齐', false, false],
      ['提测并跟进回归', false, false]
    ]),
    E('评审 3.2 需求文档，提了 5 条修改意见', true, true),
    E('排查线上偶发的订单重复提交问题', false, true, [
      ['复现并抓取日志', true, false],
      ['定位到重试缺少幂等键', true, true],
      ['跟后端确认补幂等方案', false, false]
    ]),
    E('整理下周灰度发布方案', false, false),
    E('和设计对齐新版本首页交互稿', true, false),
    E('准备季度述职材料', false, false)
  ], '本周主线是登录链路收口。重复提交定位到是重试没做幂等，下周跟后端一起补上。周会纪要已归档到知识库。');

  W(-1, [
    E('制定 Q4 目标拆解，落到三个可交付项', true, false),
    E('优化接口响应，P95 从 820ms 降到 310ms', true, true, [
      ['合并两次串行查询', true, false],
      ['加一层本地缓存', true, false]
    ]),
    E('搭建前端埋点看板', false, false)
  ], '响应优化比预期顺利，主要是把两次串行查询合并了。');

  W(-2, [
    E('接手订单模块，梳理现有边界', true, false),
    E('修复优惠券叠加计算错误', true, false),
    E('编写模块上手文档', true, false)
  ], '');

  W(-3, [
    E('完成新人培训并转正述职', true, true),
    E('熟悉团队 CI/CD 流程', true, false)
  ], '转正通过。');
}

async function runShots(ctx) {
  const { store, createNoteWindow, createReviewWindow, app } = ctx;
  const outDir = path.join(__dirname, '..', 'shots');
  fs.mkdirSync(outDir, { recursive: true });

  sample(store);

  const saved = [];
  const save = async (win, name) => {
    const img = await win.webContents.capturePage();
    const p = path.join(outDir, name + '.png');
    fs.writeFileSync(p, img.toPNG());
    const sz = img.getSize();
    let dom = '';
    try {
      dom = await win.webContents.executeJavaScript(`(() => {
        const r = {
          title: (document.querySelector('#weekTitle')||{}).textContent,
          items: document.querySelectorAll('#list .item').length,
          panel: document.querySelector('#panel') ? !document.querySelector('#panel').hidden : null,
          summaryHidden: document.querySelector('#summaryWrap') ? document.querySelector('#summaryWrap').hidden : null,
          scale: getComputedStyle(document.documentElement).getPropertyValue('--scale').trim(),
          body: getComputedStyle(document.body).backgroundColor,
          card: document.querySelector('.card') ? getComputedStyle(document.querySelector('.card')).backgroundColor : null
        };
        return JSON.stringify(r);
      })()`);
    } catch (e) { dom = 'ERR:' + e.message; }
    saved.push({ name, file: p, size: `${sz.width}x${sz.height}`, dom });
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  /* ── 便签窗口 ── */
  const note = createNoteWindow();
  await new Promise(res => note.webContents.once('did-finish-load', res));
  await wait(1800);
  note.show();
  await wait(600);
  note.setBounds({ x: 60, y: 40, width: 372, height: 588 });
  await wait(500);

  /* 默认就是只读内容态 */
  await note.webContents.executeJavaScript(`window.__zbTest.lite(true, false)`);
  await wait(600);
  await save(note, '01-note-lite');

  /* 双击后进入编辑态 */
  await note.webContents.executeJavaScript(`window.__zbTest.lite(false, false)`);
  await note.setBounds({ x: 60, y: 40, width: 372, height: 588 });
  await wait(700);
  await save(note, '02-note-edit');

  /* 缩到最小宽度，验证窄窗口下标题/输入框不拥挤 */
  await note.setBounds({ x: 60, y: 40, width: 320, height: 588 });
  await wait(700);
  await save(note, '02b-note-edit-narrow');
  await note.setBounds({ x: 60, y: 40, width: 372, height: 588 });
  await wait(300);

  /* 换一周看看 */
  await note.webContents.executeJavaScript(`document.querySelector('#prev').click()`);
  await wait(900);
  await save(note, '03-note-prev-week');
  await note.webContents.executeJavaScript(`document.querySelector('#next').click()`);
  await wait(700);

  /* 展开复盘 */
  await note.webContents.executeJavaScript(`document.querySelector('#btnSum').click()`);
  await wait(400);
  await save(note, '04-note-summary');

  /* 设置面板 */
  await note.webContents.executeJavaScript(`document.querySelector('#btnMore').click()`);
  await wait(700);
  await save(note, '05-note-settings');
  await note.webContents.executeJavaScript(`document.querySelector('#btnMore').click()`);
  await wait(300);

  /* 放大到 130% 看缩放下排版 */
  await note.webContents.executeJavaScript(`document.querySelector('#segScale').querySelectorAll('button')[2].click()`);
  await wait(1000);
  await save(note, '06-note-zoom130');

  /* 回到只读态，自动贴合内容高度 */
  await note.webContents.executeJavaScript(`window.__zbTest.lite(true, true)`);
  await wait(1200);
  await save(note, '07-note-lite-fitted');

  /* ── 回顾窗口 ── */
  const rv = createReviewWindow(weekUtil.weekKey());
  await new Promise(res => rv.webContents.once('did-finish-load', res));
  await wait(1800);
  rv.show();
  rv.setBounds({ x: 40, y: 20, width: 1120, height: 760 });
  await wait(900);
  await save(rv, '08-review-overview');

  /* 搜索态 */
  await rv.webContents.executeJavaScript(`(() => {
    const q = document.querySelector('#q');
    q.value = '接口';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(1000);
  await save(rv, '09-review-search');

  /* 清空搜索，选一个更早的周 */
  await rv.webContents.executeJavaScript(`(() => {
    const q = document.querySelector('#q');
    q.value = '';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(800);
  await rv.webContents.executeJavaScript(`(() => {
    const items = document.querySelectorAll('.witem');
    if (items[1]) items[1].click();
  })()`);
  await wait(900);
  await save(rv, '10-review-week-detail');

  fs.writeFileSync(path.join(outDir, 'shots.json'),
    JSON.stringify({ saved, dataDir: store.root }, null, 2), 'utf8');

  app.exit(saved.length >= 10 ? 0 : 1);
}

module.exports = { runShots };
