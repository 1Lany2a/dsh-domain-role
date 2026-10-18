#!/usr/bin/env node
/**
 * render-doc.mjs — 通用文档渲染器（结构化数据 -> 单文件 HTML）
 *
 * 用法：
 *   node {体系根}\tools\render-doc.mjs <数据文件>          # 写同目录同名 .html
 *   node {体系根}\tools\render-doc.mjs <数据文件> --out <file>
 *   node {体系根}\tools\render-doc.mjs <数据文件> --dry-run # 只打印，不写盘
 *   node {体系根}\tools\render-doc.mjs <数据文件> --check   # 只报数据/页面谁新，不写
 *
 * 退出码：0 正常；1 数据非法或读不到（stderr 说明第几个 block、哪个字段、期望什么）
 * 只依赖 Node 标准库；模板在同级 ../templates/doc-view/。
 * 审计日志：TraceID TR-20261015-DOCVIEW（见 projectlog/2026-10-15-文档渲染器与模板.md）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const TRACE_ID = 'TR-20261015-DOCVIEW';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_ABS = path.join(HERE, 'render-doc.mjs');
const TPL_DIR = path.resolve(HERE, '..', 'templates', 'doc-view');
// 注意：这里**没有**第二个 schema 常量。决策导出体的版本只由模板 templates/doc-view/view.js 里的
// SCHEMA 决定（2026-10-15 E02–E04 起＝dsh-decisions/2）；渲染器从不生成导出体，
// 原先那个 "dsh-decisions/1" 常量谁都没用、留着只会让人以为改这里就能改导出体，故删掉。
const KINDS = ['md', 'table', 'timeline', 'decisions', 'svg'];

function die(msg) {
  process.stderr.write(`[错误] ${msg}\n`);
  process.exit(1);
}

/* ---------------- 参数 ---------------- */

function usage() {
  process.stdout.write([
    '通用文档渲染器：把结构化数据渲染成单文件 HTML。',
    '',
    '  node tools/render-doc.mjs <数据文件>            写同目录同名 .html',
    '  node tools/render-doc.mjs <数据文件> --out <f>  指定输出文件',
    '  node tools/render-doc.mjs <数据文件> --dry-run  只打印 HTML，不写盘',
    '  node tools/render-doc.mjs <数据文件> --check    只报“数据 vs 页面谁新”，不写盘',
    '',
  ].join('\n'));
}

const argv = process.argv.slice(2);
let dataArg = null;
let outArg = null;
let dryRun = false;
let checkOnly = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') {
    outArg = argv[++i];
    if (!outArg) { die('--out 后面缺少输出文件路径'); }
  } else if (a === '--dry-run') { dryRun = true; }
  else if (a === '--check') { checkOnly = true; }
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('--')) { die(`未知参数 ${a}（可用：--out <file> / --dry-run / --check / --help）`); }
  else if (dataArg === null) { dataArg = a; }
  else { die(`只接受一个数据文件参数，多出来的是：${a}`); }
}

if (!dataArg) { usage(); die('缺少数据文件参数'); }

const dataPath = path.resolve(dataArg);
if (!fs.existsSync(dataPath)) { die(`读不到数据文件（不存在）：${dataPath}`); }
if (!fs.statSync(dataPath).isFile()) { die(`数据文件不是一个普通文件：${dataPath}`); }

const outPath = outArg ? path.resolve(outArg) : dataPath.replace(/\.(data\.)?js$/i, '') + '.html';
const outIsSameAsData = outPath === dataPath;
if (outIsSameAsData) { die(`输出文件与数据文件是同一个路径，会自毁：${outPath}`); }

/* ---------------- 取数 ---------------- */

function loadDoc(p) {
  let code;
  try { code = fs.readFileSync(p, 'utf8'); }
  catch (e) { die(`读不到数据文件：${p}\n  原因：${e.message}`); }

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  try {
    new vm.Script(code, { filename: p }).runInContext(sandbox, { timeout: 10000 });
  } catch (e) {
    die(`数据文件执行失败（期望形如 window.__DOC__ = { ... };）：${p}\n  原因：${e.message}`);
  }
  const doc = sandbox.window && sandbox.window.__DOC__;
  if (!doc) { die(`数据文件没有定义 window.__DOC__：${p}`); }
  return doc;
}

/* ---------------- 校验（错就错在第几个 block、哪个字段） ---------------- */

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  return typeof v;
}
const isStr = (v) => typeof v === 'string';
const isStrArr = (v) => Array.isArray(v) && v.every(isStr);
/** rec：字符串或字符串数组；"" / 空白 = 无推荐（真实数据用 "" 表示不推荐） */
const recList = (rec) => (Array.isArray(rec) ? rec : (rec == null ? [] : [rec]))
  .filter((r) => isStr(r) && r.trim()).map((r) => r.trim());

function validate(doc) {
  const errs = [];
  if (!isObj(doc)) {
    errs.push(`根对象：期望 { title, updated, blocks }，实际 ${typeName(doc)}`);
    return errs;
  }
  if (!isStr(doc.title) || !doc.title.trim()) {
    errs.push(`根对象 字段 title：期望非空字符串，实际 ${JSON.stringify(doc.title)}`);
  }
  if (!isStr(doc.updated) || !doc.updated.trim()) {
    errs.push(`根对象 字段 updated：期望非空字符串 "YYYY-MM-DD HH:mm"，实际 ${JSON.stringify(doc.updated)}`);
  } else if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(doc.updated.trim())) {
    errs.push(`根对象 字段 updated：期望 "YYYY-MM-DD HH:mm" 格式，实际 ${JSON.stringify(doc.updated)}`);
  }
  if (doc.subtitle != null && !isStr(doc.subtitle)) {
    errs.push(`根对象 字段 subtitle：期望字符串或省略，实际 ${typeName(doc.subtitle)}`);
  }
  if (doc.selfNote != null && !isStr(doc.selfNote)) {
    errs.push(`根对象 字段 selfNote：期望字符串或省略，实际 ${typeName(doc.selfNote)}`);
  }
  if (!Array.isArray(doc.blocks)) {
    errs.push(`根对象 字段 blocks：期望数组，实际 ${typeName(doc.blocks)}`);
    return errs;
  }
  doc.blocks.forEach((b, i) => validateBlock(b, i, errs));
  return errs;
}

function validateBlock(b, i, errs) {
  const at = `第 ${i + 1} 个 block`;
  if (!isObj(b)) { errs.push(`${at}：期望对象 { k, ... }，实际 ${typeName(b)}`); return; }
  if (!KINDS.includes(b.k)) {
    errs.push(`${at} 字段 k：期望 ${KINDS.join(' | ')} 之一，实际 ${JSON.stringify(b.k)}`);
    return;
  }
  const at2 = `${at} (k=${b.k})`;
  if (b.src !== undefined && !isStrArr(b.src)) {
    errs.push(`${at2} 字段 src：期望 ["路径", "路径:行号"] 这样的字符串数组，实际 ${typeName(b.src)}`);
  }
  if (b.caption !== undefined && !isStr(b.caption)) {
    errs.push(`${at2} 字段 caption：期望字符串，实际 ${typeName(b.caption)}`);
  }

  if (b.k === 'md') {
    const t = b.t;
    if (!isStr(t) && !isStrArr(t)) {
      errs.push(`${at2} 字段 t：期望 markdown 字符串 或 字符串数组（按行），实际 ${typeName(t)}`);
    }
    if (b.tone !== undefined && b.tone !== null && b.tone !== 'lede' && b.tone !== 'note') {
      errs.push(`${at2} 字段 tone：期望 null | "lede" | "note"，实际 ${JSON.stringify(b.tone)}`);
    }
  }

  // 2026-10-18 加：内联 SVG 图（图文页用）。只认整段 <svg …>…</svg>，不内联任意 HTML。
  if (b.k === 'svg') {
    if (!isStr(b.svg) || !b.svg.trim()) {
      errs.push(`${at2} 字段 svg：期望整段 <svg …>…</svg> 字符串，实际 ${typeName(b.svg)}`);
    } else if (!/^<svg[\s>]/.test(b.svg.trim()) || !b.svg.trim().endsWith('</svg>')) {
      errs.push(`${at2} 字段 svg：必须以 <svg 开头、以 </svg> 结尾（不接受任意 HTML 片段）`);
    }
  }

  if (b.k === 'table') {
    if (!isStrArr(b.cols)) {
      errs.push(`${at2} 字段 cols：期望字符串数组（表头），实际 ${typeName(b.cols)}`);
    }
    if (!Array.isArray(b.rows)) {
      errs.push(`${at2} 字段 rows：期望二维字符串数组，实际 ${typeName(b.rows)}`);
    } else {
      b.rows.forEach((r, ri) => {
        if (!isStrArr(r)) { errs.push(`${at2} 字段 rows[${ri}]：期望字符串数组（一行单元格），实际 ${typeName(r)}`); }
        else if (isStrArr(b.cols) && r.length !== b.cols.length) {
          errs.push(`${at2} 字段 rows[${ri}]：单元格数量 ${r.length} 与表头 cols 的 ${b.cols.length} 不一致`);
        }
      });
    }
  }

  if (b.k === 'timeline' || b.k === 'decisions') {
    if (!Array.isArray(b.items)) {
      errs.push(`${at2} 字段 items：期望数组，实际 ${typeName(b.items)}`);
      return;
    }
  }

  if (b.k === 'timeline') {
    b.items.forEach((it, ii) => {
      const p = `${at2} 字段 items[${ii}]`;
      if (!isObj(it)) { errs.push(`${p}：期望 { d, t }，实际 ${typeName(it)}`); return; }
      if (!isStr(it.d)) { errs.push(`${p}.d：期望日期字符串，实际 ${typeName(it.d)}`); }
      if (!isStr(it.t)) { errs.push(`${p}.t：期望文字字符串，实际 ${typeName(it.t)}`); }
    });
  }

  if (b.k === 'decisions') {
    b.items.forEach((it, ii) => {
      const p = `${at2} 字段 items[${ii}]`;
      if (!isObj(it)) { errs.push(`${p}：期望 { id, q, options, ... }，实际 ${typeName(it)}`); return; }
      if (!isStr(it.id) || !it.id.trim()) { errs.push(`${p}.id：期望非空字符串（如 "A01"），实际 ${JSON.stringify(it.id)}`); }
      if (!isStr(it.q) || !it.q.trim()) { errs.push(`${p}.q：期望非空字符串（题干），实际 ${JSON.stringify(it.q)}`); }
      // v2（2026-10-15 E02 选 A）：tbd＝预置待确认标记搬出来的纯文本数组，
      // 每条都不该再带 `[待确认…]` 包裹（页面只认这个字段，不再从备注里正则抽）。
      const tbdOk = isStrArr(it.tbd) && it.tbd.length > 0;
      if (it.tbd !== undefined) {
        if (!isStrArr(it.tbd)) {
          errs.push(`${p}.tbd：期望字符串数组（每条＝不含 [待确认…] 包裹的纯文本），实际 ${typeName(it.tbd)}`);
        } else {
          it.tbd.forEach((t, ti) => {
            if (!t.trim()) {
              errs.push(`${p}.tbd[${ti}]：期望非空纯文本，实际 ${JSON.stringify(t)}`);
            } else if (/\[待确认/.test(t)) {
              errs.push(`${p}.tbd[${ti}]：不该再含 [待确认…] 包裹（tbd 存的是剥掉包裹后的纯文本），实际 ${JSON.stringify(t)}`);
            }
          });
        }
      }
      // 允许「零选项题」：options 为空数组、但 tbd 非空（源页只给了一句待确认标记，不替它编选项）。
      if (!Array.isArray(it.options) || (it.options.length === 0 && !tbdOk)) {
        errs.push(`${p}.options：期望非空数组 [{v, label}]（只有 .tbd 非空时才允许空数组＝零选项题），实际 ${typeName(it.options)}`);
      } else {
        it.options.forEach((o, oi) => {
          const q = `${p}.options[${oi}]`;
          if (!isObj(o)) { errs.push(`${q}：期望 { v, label }，实际 ${typeName(o)}`); return; }
          if (!isStr(o.v) || !o.v.trim()) { errs.push(`${q}.v：期望非空字符串（选项代号），实际 ${JSON.stringify(o.v)}`); }
          if (!isStr(o.label)) { errs.push(`${q}.label：期望字符串，实际 ${typeName(o.label)}`); }
        });
      }
      if (it.multi !== undefined && typeof it.multi !== 'boolean') {
        errs.push(`${p}.multi：期望 true | false，实际 ${typeName(it.multi)}`);
      }
      const recs = recList(it.rec);
      if (recs.length) {
        if (Array.isArray(it.options) && it.options.length) {
          const vs = it.options.filter(isObj).map((o) => o.v);
          recs.forEach((r) => {
            if (!vs.includes(r)) { errs.push(`${p}.rec：推荐项 ${JSON.stringify(r)} 不在 options 的 v 里（${vs.join(', ')}）`); }
          });
        }
      } else if (it.rec != null && !Array.isArray(it.rec) && !isStr(it.rec)) {
        errs.push(`${p}.rec：期望选项代号字符串（多选时可为数组），实际 ${JSON.stringify(it.rec)}`);
      } else if (Array.isArray(it.rec) && it.rec.some((r) => !isStr(r))) {
        errs.push(`${p}.rec：期望选项代号字符串（多选时可为数组），实际 ${JSON.stringify(it.rec)}`);
      }
      if (it.impact !== undefined && !isStr(it.impact)) {
        errs.push(`${p}.impact：期望字符串，实际 ${typeName(it.impact)}`);
      }
      if (it.note !== undefined && !isStr(it.note)) {
        errs.push(`${p}.note：期望字符串（备注预置内容），实际 ${typeName(it.note)}`);
      }
    });
  }
}

/* ---------------- 行内 markdown ---------------- */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(u) {
  const s = String(u).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) { return /^(https?|mailto):/i.test(s) ? s : '#'; }
  return s;
}

function inline(src) {
  let out = esc(src);
  const codes = [];
  // `代码` 先占位，避免被粗体/链接规则吃掉内部字符
  out = out.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000C${codes.length - 1}\u0000`; });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
    `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  out = out.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  return warnTbd(out);
}

/**
 * 2026-10-15 E02 选 A：数据里残留、没被搬进 `tbd` 字段的 `[待确认…]` 一律**只标不改**——
 * 页面给它套一层 `.tbd-warn` 黄底提示（连 <code> 里的也算，因为真实残留就在反引号里），
 * 绝不自动剥掉或改写文字。搬进 `tbd` 的标记由卡片上的徽章渲染，不会走到这里。
 */
function warnTbd(html) {
  return String(html).replace(/\[待确认(?::[^\]]*)?\]?/g,
    (m) => `<span class="tbd-warn" title="未被提取的待确认标记（v2 起只标不改）">${m}</span>`);
}

/* ---------------- 块级 markdown ---------------- */

function mdToHtml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type:'ul'|'ol', items:[] }

  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>` + list.items.map((t) => `<li>${t}</li>`).join('') + `</${list.type}>`);
      list = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushAll(); continue; }

    let m;
    if ((m = /^(#{2,4})\s+(.*)$/.exec(line))) {
      flushAll();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = /^-\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(inline(m[1]));
      continue;
    }
    if ((m = /^\d+\.\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(inline(m[1]));
      continue;
    }
    flushList();
    para.push(inline(line));
  }
  flushAll();
  return out.join('\n');
}

/* ---------------- 块渲染 ---------------- */

const srcLine = (b) => (b.src && b.src.length
  ? `<div class="src">来源：${b.src.map(esc).join(' · ')}</div>` : '');

const capLine = (b) => (b.caption ? `<div class="cap">${inline(b.caption)}</div>` : '');

function renderBlock(b) {
  if (b.k === 'md') {
    const tone = b.tone === 'lede' ? ' lede' : (b.tone === 'note' ? ' note' : '');
    const text = Array.isArray(b.t) ? b.t.join('\n') : b.t;
    return `<section class="blk md${tone}">\n${mdToHtml(text)}\n${srcLine(b)}</section>`;
  }

  if (b.k === 'table') {
    const head = b.cols.map((c) => `<th>${inline(c)}</th>`).join('');
    const body = b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('\n');
    return `<section class="blk tbl">\n${capLine(b)}`
      + `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>\n`
      + `${srcLine(b)}</section>`;
  }

  if (b.k === 'timeline') {
    const items = b.items.map((it) =>
      `<li><span class="d">${inline(it.d)}</span><span class="t">${inline(it.t)}</span></li>`).join('\n');
    return `<section class="blk tl">\n${capLine(b)}<ol class="tl-list">\n${items}\n</ol>\n${srcLine(b)}</section>`;
  }

  // 2026-10-18 加：内联 SVG 图。data 是本地数据文件，svg 已在 validateBlock 里限定为整段 <svg>…</svg>。
  if (b.k === 'svg') {
    return `<section class="blk fig">\n${capLine(b)}<div class="figwrap">${b.svg}</div>\n${srcLine(b)}</section>`;
  }

  // decisions
  const cards = b.items.map((d) => {
    // 2026-10-15 E03 选 A：默认全部可多选，只有**显式** multi:false 的题才保留单选（opt-out）。
    const multi = d.multi !== false;
    const type = multi ? 'checkbox' : 'radio';
    const recs = recList(d.rec);
    const id = String(d.id);
    const hasOpts = Array.isArray(d.options) && d.options.length > 0;
    const opts = (d.options || []).map((o) => {
      const isRec = recs.includes(o.v);
      return `<label class="opt"><input type="${type}" name="d-${esc(id)}" value="${esc(o.v)}" data-did="${esc(id)}">`
        + `<span class="v">${esc(o.v)}</span><span class="lbl">${inline(o.label)}</span>`
        + `${isRec ? '<span class="rec">推荐</span>' : ''}</label>`;
    }).join('\n');
    // 2026-10-15 E02 选 A：预置待确认标记（tbd）＝独立徽章，每条带一个「删除」按钮（点了失效、可「撤销」）。
    const tbds = (Array.isArray(d.tbd) && d.tbd.length)
      ? `\n<div class="tbds">\n` + d.tbd.map((t) =>
        `<span class="tbd" data-did="${esc(id)}">`
        + `<span class="tbd-badge">⚠ 待确认</span>`
        + `<span class="tbd-text">${inline(t)}</span>`
        + `<button type="button" class="tbd-del" data-did="${esc(id)}" title="删掉这条标记（只进 tbdRemoved，不算拍板；可点「撤销」恢复）">删除</button>`
        + `</span>`).join('\n') + `\n</div>`
      : '';
    const optsHtml = hasOpts
      ? `<div class="opts">\n${opts}\n</div>`
      : `<p class="noopts">本题源未给选项，请在备注里写决定。</p>`;
    const modeText = hasOpts ? (multi ? '多选' : '单选') : '无选项';
    const impact = d.impact ? `<div class="meta2"><b>影响：</b>${inline(d.impact)}</div>` : '';
    return `<article class="card" id="card-${esc(id)}" data-did="${esc(id)}">\n`
      + `<div class="chead"><code class="cid">${esc(id)}</code>`
      + `<span class="mode">${modeText}</span></div>\n`
      + `<div class="q">${inline(d.q)}</div>${tbds}\n`
      + `${optsHtml}\n`
      + `<button type="button" class="more-toggle" data-did="${esc(id)}" aria-expanded="false">展开细节</button>\n`
      + `<div class="more" hidden>\n`
      + impact
      + `<div class="src">来源：${esc('待拍板清单 · ' + id)}</div>\n`
      + `<label class="nl">备注<textarea class="note" data-did="${esc(id)}" rows="2" spellcheck="false">${esc(d.note || '')}</textarea></label>\n`
      + `<button type="button" class="clr" data-did="${esc(id)}">清除本题选择</button>\n`
      + `</div>\n`
      + `</article>`;
  }).join('\n');

  return `<section class="blk dec">\n${capLine(b)}\n${cards}\n${srcLine(b)}</section>`;
}

/* ---------------- 头部 / 收集区 ---------------- */

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s).trim());
  if (!m) { return null; }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
}

function readPrevGen(file) {
  try {
    const html = fs.readFileSync(file, 'utf8');
    const m = /<!--dsh-doc-gen:([^>]+?)-->/.exec(html);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

const RE_RENDER_CMD = `node ${SCRIPT_ABS} "${dataPath}"`;

function buildHeader(doc, genText, staleFuture, prevGenNote) {
  const warn = staleFuture
    ? `<div class="warn">⚠ 本页已过期：数据更新于 <b>${esc(doc.updated)}</b>，晚于本页生成时刻 <b>${esc(genText)}</b>，请重新渲染。</div>`
    : '';
  const prev = prevGenNote ? `<div class="warn">⚠ ${prevGenNote}</div>` : '';
  const selfNote = doc.selfNote
    ? `<div class="selfnote">\n${mdToHtml(doc.selfNote)}\n</div>`
    : '';
  return `<header class="hd">
<h1>${esc(doc.title)}</h1>
${doc.subtitle ? `<p class="sub">${inline(doc.subtitle)}</p>` : ''}
<div class="meta">数据更新于 <b>${esc(doc.updated)}</b> ｜ 页面生成于 <b>${esc(genText)}</b> ｜ 数据源：<code>${esc(dataPath)}</code></div>
${warn}
${doc.blocks.some((x) => x.k === 'decisions') ? `<div class="btns"><button type="button" class="ghost" id="btn-expand-all">全部展开</button><span class="hint">明细默认收起：点题卡上的「展开细节」看影响面 / 备注 / 来源。</span></div>` : ''}
<div class="banner"><b>本页是给人看的渲染成品，不是真值。</b>真值在数据文件 <code>${esc(path.basename(dataPath))}</code> 里；数据改了要重新渲染：<code>${esc(RE_RENDER_CMD)}</code></div>
${prev}
${selfNote}
<!--dsh-doc-gen:${genText}-->
<!--dsh-doc-data:${String(doc.updated).replace(/--/g, '- -')}-->
</header>`;
}

function buildFooter() {
  return `<section class="collect" id="collect">
<h2>拍板回读 · 收集区</h2>
<p class="hint">在每张题卡上勾选选项、填写备注；下方 JSON 会实时刷新，<b>只包含你动过的题</b>。把它复制给 AI，就是一份可回读的拍板结果。<b>撤回也算动过</b>（2026-10-15 E04 选 A）：「清除本题选择」记 <code>clearedChoice:true</code>、「删除待确认标记」记进 <code>tbdRemoved</code>，保存时按它们<b>真删</b>对应 id／标记。</p>
<textarea id="export" readonly rows="10" spellcheck="false" aria-label="拍板结果 JSON"></textarea>
<div class="btns">
<button type="button" class="primary" id="btn-copy">复制 JSON</button>
<button type="button" class="ghost" id="btn-save">保存到文件 decisions.json</button>
<span class="fb" id="fb" role="status" aria-live="polite"></span>
</div>
<p class="inline-warn">「保存到文件」只在真浏览器里可用（直接双击打开本页）。在 DSH GUI 右侧栏的沙箱 iframe 里没有同源权限、这个按钮不会生效，<b>侧栏里请用「复制」</b>。</p>
<p class="inline-warn">保存逻辑：写入所选目录下的 <code>decisions.json</code>；文件已存在则合并——顶层按页面标题分组，本页的题按 id 覆盖、新的 id 追加，<b>不会覆盖别的页</b>。本题没勾、没备注、也没删标记（＝撤回）时，保存会把这个 id <b>真删掉</b>，而不是留一条空壳。</p>
</section>`;
}

/* ---------------- 组装 ---------------- */

function readTemplate(name) {
  const p = path.join(TPL_DIR, name);
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { die(`读不到模板 ${p}\n  原因：${e.message}`); }
}

function fillOnce(html, placeholder, value, where) {
  const parts = html.split(placeholder);
  if (parts.length !== 2) {
    die(`模板占位符异常：${placeholder} 在 ${where} 中出现了 ${parts.length - 1} 次（期望 1 次）；模板可能被改坏了。`);
  }
  return parts[0] + value + parts[1];
}

function build(doc, genText, staleFuture, prevGenNote) {
  const skeleton = readTemplate('doc.html');
  const css = readTemplate('view.css');
  const js = readTemplate('view.js').replace(/<\/script/gi, '<\\/script');

  const docJson = JSON.stringify(doc)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  const header = buildHeader(doc, genText, staleFuture, prevGenNote);
  const body = doc.blocks.map(renderBlock).join('\n');
  const footer = buildFooter();

  let html = skeleton;
  html = fillOnce(html, '<!--{{TITLE}}-->', esc(doc.title), 'doc.html');
  html = fillOnce(html, '<!--{{STYLE}}-->', css.trimEnd(), 'doc.html');
  html = fillOnce(html, '<!--{{HEADER}}-->', header, 'doc.html');
  html = fillOnce(html, '<!--{{BODY}}-->', body, 'doc.html');
  html = fillOnce(html, '<!--{{FOOTER}}-->', footer, 'doc.html');
  html = fillOnce(html, '<!--{{SCRIPT}}-->', js.trimEnd(), 'doc.html');
  html = fillOnce(html, '/*{{DOC_JSON}}*/ null', docJson, 'doc.html');
  return html;
}

/* ---------------- 主流程 ---------------- */

const doc = loadDoc(dataPath);

const errs = validate(doc);
if (errs.length) {
  process.stderr.write(`[错误] 数据不合法：${dataPath}\n`);
  errs.forEach((e, i) => process.stderr.write(`  ${i + 1}) ${e}\n`));
  process.stderr.write(`  共 ${errs.length} 处问题；没有写出任何文件。\n`);
  process.exit(1);
}

const now = new Date();
const genText = fmtLocal(now);

if (checkOnly) {
  const ds = fs.statSync(dataPath);
  const hasPage = fs.existsSync(outPath);
  const ps = hasPage ? fs.statSync(outPath) : null;
  const pageGen = hasPage ? readPrevGen(outPath) : null;
  const dataTs = parseLocal(doc.updated);
  const pageTs = pageGen ? parseLocal(pageGen) : null;
  const byMtime = hasPage && ds.mtimeMs > ps.mtimeMs + 1000;
  const byStamp = hasPage && dataTs && pageTs && dataTs > pageTs;

  process.stdout.write(`[check] 数据文件：${dataPath}\n`);
  process.stdout.write(`[check]   修改时间 ${fmtLocal(ds.mtime)}　数据声明 updated=${doc.updated}\n`);
  process.stdout.write(`[check] 页面文件：${outPath}\n`);
  if (hasPage) {
    process.stdout.write(`[check]   修改时间 ${fmtLocal(ps.mtime)}　页内生成于=${pageGen || '(未记录)'}\n`);
  } else {
    process.stdout.write('[check]   不存在\n');
  }
  if (!hasPage) { process.stdout.write('[check] 结论：页面尚未生成，需要渲染。\n'); process.exit(0); }
  if (byMtime || byStamp) {
    process.stdout.write('[check] 结论：⚠ 页面已过期'
      + `（${byMtime ? '数据文件比页面新' : ''}${byMtime && byStamp ? '，且 ' : ''}${byStamp ? '数据 updated 晚于页内生成时刻' : ''}）。\n`);
  } else {
    process.stdout.write('[check] 结论：页面是最新的（数据不比页面新）。\n');
  }
  process.exit(0);
}

const prevGen = fs.existsSync(outPath) ? readPrevGen(outPath) : null;
const dataTs = parseLocal(doc.updated);
const staleFuture = !!(dataTs && dataTs > now);
let prevGenNote = null;
if (prevGen && dataTs) {
  const pTs = parseLocal(prevGen);
  if (pTs && dataTs > pTs) {
    prevGenNote = `上一版页面已过期（数据更新于 ${doc.updated}，上一版生成于 ${prevGen}），本页已刷新。`;
  }
}

const html = build(doc, genText, staleFuture, null); // 上一版提示只打屏，不写进页面（保证重复渲染逐字节一致）

if (dryRun) {
  process.stdout.write(html);
  process.stderr.write(`[${TRACE_ID}] dry-run：已渲染但未写盘（${html.length} 字节）-> ${outPath}\n`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
process.stdout.write(`已写出：${outPath}（${html.length} 字节）\n`);
if (prevGenNote) { process.stdout.write(`提示：${prevGenNote}（上一版生成于 ${prevGen}）\n`); }
process.stdout.write(`[${TRACE_ID}] 渲染成功：blocks=${doc.blocks.length} 数据更新于 ${doc.updated} 页面生成于 ${genText}\n`);
