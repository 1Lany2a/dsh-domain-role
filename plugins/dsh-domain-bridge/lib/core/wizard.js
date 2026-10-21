/**
 * dsh-domain-bridge — v0.8.7 handoff wizard (「分步设置交接参数」的本地页面).
 *
 * Why this file exists: the Host popup shell (`popupSelect`) **always closes after one selection**
 * and consumes the command token (ui-commands `PopupSelectController.settle`), so a "multi-level"
 * popup cannot be chained. The user wants to set the handoff parameters by hand — permission,
 * model, preset, title, startup task, and whether the outgoing session retires — so the multi-level
 * surface lives here: one local page, opened from `/handoff wizard`, that posts back to the plugin.
 *
 * Contract (frozen on purpose):
 *   · GET  <prefix>/handoff-wizard          -> the page (local-only, sessionId in the query)
 *   · GET  <prefix>/handoff-wizard/data     -> {ok, layers, presets, models, permissions, defaults}
 *   · POST <prefix>/handoff-wizard/run      -> runs the SAME /handoff definition with params
 * The page never invents state: every default comes from the registration book, the deployment
 * config and the Host model catalog, and the run path calls the command definition itself.
 */

import { VERSION, textOf } from './shared.js'
import { readRegistrations, identityOf, projectOfCwd } from './registrations.js'
import { catalogFromController, catalogFromLlm } from './session-factory.js'
import { defaultHandoffTask } from './commands.js'

const PERMISSION_CHOICES = [
  { value: '', label: '部署默认（config.domainSessionPreset）', detail: '不覆盖，交给部署配置；本机缺省 workspace-write' },
  { value: 'workspace-write', label: 'workspace-write', detail: '只能写工作区，审批仍会问' },
  { value: 'read-only', label: 'read-only', detail: '只读：不让写任何文件' },
  { value: 'danger-full-access', label: 'danger-full-access', detail: '全盘写：后台无人值守要写工作区外时才用' },
]

const LAYER_WORDS = { system: '体系主会话', project: '项目主会话', domain: '域会话' }

function layerLabel(layer) {
  return LAYER_WORDS[layer] || layer
}

/** 一次模型目录读取：控制器优先、llm 兜底（与 list_models 同一个来源顺序）。 */
async function readCatalog(ctx) {
  const attempts = []
  const primary = await catalogFromController(ctx, attempts)
  if (primary && primary.empty !== true) return { ...primary, attempts }
  const fallback = await catalogFromLlm(ctx, attempts)
  const picked = fallback && fallback.empty !== true ? fallback : primary || fallback || null
  return picked ? { ...picked, attempts } : { source: 'empty', groups: [], default: null, attempts }
}

/**
 * The page's data contract. Everything is derived from real state; a missing service degrades to
 * an empty list with an honest `notes` line instead of a fabricated option.
 */
export async function wizardData(ctx, deps, { sessionId, cwd }) {
  const config = deps.config || {}
  const read = readRegistrations(config.domainsFile)
  const doc = read.doc || { registrations: {}, owners: {} }
  const identity = identityOf(doc, sessionId)
  const project = projectOfCwd(cwd)
  const projectName = project && project.project ? project.project : null

  const layers = identity.roles.map((role) => ({
    key: role.key,
    layer: role.layer,
    label: layerLabel(role.layer),
    detail: `${role.key}${role.domain ? ` · ${role.domain}` : ''}`,
  }))
  if (layers.length === 0) {
    layers.push({
      key: `${projectName || 'unknown'}:main`,
      layer: 'project',
      label: '项目主会话',
      detail: '你还没有注册身份 ⇒ 这是按 cwd 推出来的默认键',
    })
  }

  const current = identity.roles.length ? identity.roles[0] : { layer: 'project', key: layers[0].key }
  const layer = current.layer
  const key = current.key

  let catalog = { source: 'empty', groups: [], default: null, attempts: [] }
  try {
    catalog = await readCatalog(ctx)
  } catch {
    /* catalog unavailable: the form still allows typing provider/model by hand */
  }

  const configuredModel = config.domainSessionModel || null
  return {
    ok: true,
    version: VERSION,
    sessionId,
    cwd: cwd || null,
    project: projectName,
    generatedAt: new Date().toISOString(),
    layers,
    defaultLayer: { layer, key },
    presets: ['standard', 'cordis'],
    defaultPreset: layer === 'system' ? 'cordis' : 'standard',
    models: {
      source: catalog.source,
      groups: Array.isArray(catalog.groups) ? catalog.groups : [],
      default: catalog.default || null,
      empty: !catalog.groups || catalog.groups.length === 0,
    },
    permissions: PERMISSION_CHOICES,
    defaults: {
      // 权限档默认＝部署配置（空串表示"不覆盖"，回执里会写清楚）
      permission: typeof config.domainSessionPreset === 'string' ? config.domainSessionPreset : '',
      model: configuredModel ? `${configuredModel.provider}/${configuredModel.model}` : '',
      title: `【${layer === 'system' ? '体系' : layer === 'project' ? '项目' : '域'}】${key} 接任`,
      task: defaultHandoffTask({ layer, key, cwd }),
    },
    notes: [
      ...(read.error ? [`注册册读不懂（${read.error}）⇒ 层级只能按 cwd 推。`] : []),
      ...(catalog.empty ? ['宿主没有给出可路由的模型目录 ⇒ 模型可以手填 provider/model。'] : []),
      ...(configuredModel ? [] : ['部署配置没有 domainSessionModel ⇒ 不填模型时新会话跟随宿主全局默认。']),
    ],
  }
}

/** Escape a JSON payload for an inline <script> (never let `</script>` through). */
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/**
 * The page itself: no network, no CDN, no framework. Steps are sections; the last step is a
 * summary you must confirm before anything is created.
 */
export function wizardHtml(data) {
  const title = escapeHtml(`换届向导 · ${data.defaultLayer.key}`)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1f24; --dim:#5b6672; --line:#d8dee6; --bg:#f7f8fa; --card:#fff; --accent:#2f6fed; --warn:#b25b00; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6e9ee; --dim:#9aa4b0; --line:#333a44; --bg:#14171b; --card:#1b1f24; --accent:#6d9bff; --warn:#e0a04a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 18px; }
  .dots { display:flex; gap:8px; margin: 18px 0 22px; flex-wrap: wrap; }
  .dot { font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); color:var(--dim); background:var(--card); }
  .dot.on { border-color: var(--accent); color: var(--accent); }
  .dot.done { background: var(--accent); border-color: var(--accent); color:#fff; }
  section { display:none; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  section.on { display:block; }
  section h2 { font-size:16px; margin:0 0 12px; }
  .row { display:block; padding:10px 12px; border:1px solid var(--line); border-radius:10px; margin-bottom:8px; cursor:pointer; }
  .row:hover { border-color: var(--accent); }
  .row input { margin-right:8px; }
  .row .d { color: var(--dim); font-size:12.5px; margin-top:2px; }
  .row.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .muted { color: var(--dim); font-size: 13px; }
  input[type=text], textarea, select { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font: inherit; }
  textarea { min-height: 120px; resize: vertical; }
  .field { margin: 10px 0 16px; }
  .field label { display:block; font-size:13px; color:var(--dim); margin-bottom:4px; }
  .nav { display:flex; gap:10px; justify-content:space-between; margin-top:18px; }
  button { font: inherit; padding:9px 18px; border-radius:9px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  table.sum { width:100%; border-collapse: collapse; font-size:14px; }
  table.sum th, table.sum td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align: top; }
  table.sum th { width: 32%; color:var(--dim); font-weight:500; }
  pre.receipt { white-space: pre-wrap; word-break: break-word; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:14px; font-size:13px; }
  .note { color: var(--warn); font-size:13px; }
  .hint { color: var(--dim); font-size:12.5px; margin-top:6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>换届向导 · ${escapeHtml(data.defaultLayer.key)}</h1>
  <div class="sub">当前会话 <code>${escapeHtml(data.sessionId)}</code> · 插件 v${escapeHtml(data.version)} · 数据生成于 ${escapeHtml(data.generatedAt)}</div>
  <div class="dots" id="dots"></div>

  <form id="form" autocomplete="off">
    <section data-step="0" class="on">
      <h2>1. 交接哪个身份</h2>
      <div id="layers"></div>
      <div class="hint">只能在你**真持有**的身份里选；没列出来的键不能拿去交接。</div>
    </section>

    <section data-step="1">
      <h2>2. 模式（agentPreset）</h2>
      <div id="presets"></div>
      <div class="field">
        <label>自定义 preset id（留空则用上面选的那个）</label>
        <input type="text" id="presetCustom" placeholder="例如 standard / cordis">
      </div>
    </section>

    <section data-step="2">
      <h2>3. 模型</h2>
      <div id="models"></div>
      <div class="field">
        <label>或者手填 provider/model</label>
        <input type="text" id="modelCustom" placeholder="例如 commandcode/deepseek/deepseek-v4.1-flash">
        <div class="hint" id="modelSource"></div>
      </div>
    </section>

    <section data-step="3">
      <h2>4. 权限档</h2>
      <div id="perms"></div>
    </section>

    <section data-step="4">
      <h2>5. 标题与开工任务</h2>
      <div class="field">
        <label>接任者标题（≤80 字节，超出会被裁）</label>
        <input type="text" id="title" value="${escapeHtml(data.defaults.title)}">
      </div>
      <div class="field">
        <label>排给接任者的第一条任务（原文投递，可改）</label>
        <textarea id="task">${escapeHtml(data.defaults.task)}</textarea>
      </div>
      <label class="row"><input type="checkbox" id="retireNow"> 建完立刻退役我（建失败则什么都不动）</label>
    </section>

    <section data-step="5">
      <h2>6. 确认</h2>
      <table class="sum" id="summary"></table>
      <div class="note" id="warn"></div>
      <div class="nav">
        <button type="button" id="back4">上一步</button>
        <button type="button" class="primary" id="submit">确认并建会话</button>
      </div>
    </section>

    <section data-step="6">
      <h2>结果</h2>
      <pre class="receipt" id="receipt">（还没有执行）</pre>
      <div class="nav"><button type="button" onclick="location.reload()">再来一次</button></div>
    </section>
  </form>

  <div class="nav" id="nav">
    <button type="button" id="prev" disabled>上一步</button>
    <button type="button" class="primary" id="next">下一步</button>
  </div>
</div>
<script>
const DATA = ${inlineJson(data)};
const state = { step: 0, layer: DATA.defaultLayer.key, preset: DATA.defaultPreset, presetCustom: '', model: '', modelCustom: '', perm: DATA.defaults.permission, title: DATA.defaults.title, task: DATA.defaults.task, retireNow: false };
const STEP_TITLES = ['身份','模式','模型','权限','收尾','确认','结果'];
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) { const node = document.createElement(tag); Object.assign(node, props); for (const child of children) node.append(child); return node; }

function renderDots() {
  const dots = $('dots'); dots.textContent = '';
  STEP_TITLES.forEach((label, index) => {
    const dot = el('span', { className: 'dot' + (index === state.step ? ' on' : index < state.step ? ' done' : ''), textContent: (index + 1) + '· ' + label });
    dots.append(dot);
  });
}

function radioRows(container, rows, current, onPick) {
  container.textContent = '';
  for (const row of rows) {
    const input = el('input', { type: 'radio', name: container.id, value: row.value });
    input.checked = String(row.value) === String(current);
    const wrap = el('label', { className: 'row' + (input.checked ? ' sel' : '') });
    wrap.append(input, el('strong', { textContent: row.label }));
    if (row.detail) wrap.append(el('div', { className: 'd', textContent: row.detail }));
    input.addEventListener('change', () => { onPick(row.value); radioRows(container, rows, row.value, onPick); });
    container.append(wrap);
  }
}

function renderLayers() {
  radioRows($('layers'), DATA.layers.map((row) => ({ value: row.key, label: row.label, detail: row.detail })), state.layer, (value) => { state.layer = value; const hit = DATA.layers.find((row) => row.key === value); state.preset = hit && hit.layer === 'system' ? 'cordis' : 'standard'; renderPresets(); });
}
function renderPresets() {
  radioRows($('presets'), DATA.presets.map((id) => ({ value: id, label: id, detail: id === 'cordis' ? '创造模式：复杂/创造类交接' : '标准模式：日常执行' })), state.preset, (value) => { state.preset = value; });
}
function renderModels() {
  const rows = [{ value: '', label: '不指定（跟随宿主全局默认）', detail: '不给新会话铺模型' }];
  if (DATA.defaults.model) rows.push({ value: DATA.defaults.model, label: '部署配置 domainSessionModel', detail: DATA.defaults.model });
  for (const group of DATA.models.groups) {
    for (const model of group.models) rows.push({ value: group.provider + '/' + model.id, label: model.name || model.id, detail: group.name + ' · ' + group.provider });
  }
  radioRows($('models'), rows, state.model, (value) => { state.model = value; });
  $('modelSource').textContent = DATA.models.empty ? '宿主没有可路由的模型目录，手填 provider/model 即可' : '目录来源：' + DATA.models.source;
}
function renderPerms() {
  radioRows($('perms'), DATA.permissions.map((row) => ({ value: row.value, label: row.label, detail: row.detail })), state.perm, (value) => { state.perm = value; });
}

function summaryRows() {
  const model = state.modelCustom.trim() || state.model;

  return [
    ['身份', state.layer],
    ['模式', state.presetCustom.trim() || state.preset],
    ['模型', model || '（跟随宿主全局默认）'],
    ['权限档', state.perm || '（部署默认）'],
    ['标题', state.title],
    ['开工任务', state.task.length > 160 ? state.task.slice(0, 160) + '…' : state.task],
    ['建完退役我', state.retireNow ? '是' : '否'],
  ];
}

function renderSummary() {
  const table = $('summary'); table.textContent = '';
  for (const [name, value] of summaryRows()) {
    const tr = el('tr'); tr.append(el('th', { textContent: name }), el('td', { textContent: value })); table.append(tr);
  }
  $('warn').textContent = state.retireNow ? '建成功后本会话会立刻退役（撤注册 + session 暂停 + 标题加「（已退役）」）。' : '';
}

function show(step) {
  state.step = step;
  document.querySelectorAll('section').forEach((node) => node.classList.toggle('on', Number(node.dataset.step) === step));
  renderDots();
  const last = STEP_TITLES.length - 1;
  $('prev').disabled = step === 0 || step >= 5;
  $('next').style.display = step >= 5 ? 'none' : '';
  $('nav').style.display = step >= 6 ? 'none' : 'flex';
  if (step === 5) renderSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('prev').onclick = () => show(Math.max(0, state.step - 1));
$('next').onclick = () => {
  if (state.step === 4) { state.title = $('title').value; state.task = $('task').value; state.retireNow = $('retireNow').checked; }
  if (state.step === 1) state.presetCustom = $('presetCustom').value;
  if (state.step === 2) state.modelCustom = $('modelCustom').value;
  show(Math.min(5, state.step + 1));
};
$('back4').onclick = () => show(4);
$('submit').onclick = async () => {
  const button = $('submit'); button.disabled = true; button.textContent = '正在建…';
  const payload = {
    sessionId: DATA.sessionId,
    key: state.layer,
    preset: (state.presetCustom.trim() || state.preset),
    model: (state.modelCustom.trim() || state.model),
    perm: state.perm,
    title: state.title,
    task: state.task,
    retireNow: Boolean(state.retireNow),
  };
  try {
    const response = await fetch(location.pathname.replace(/\\/handoff-wizard$/, '/handoff-wizard/run'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const outcome = await response.json();
    $('receipt').textContent = (outcome && (outcome.text || outcome.error)) || JSON.stringify(outcome, null, 2);
    show(6);
  } catch (error) {
    $('receipt').textContent = '请求失败：' + (error && error.message ? error.message : String(error));
    show(6);
  } finally {
    button.disabled = false; button.textContent = '确认并建会话';
  }
};

renderLayers(); renderPresets(); renderModels(); renderPerms();
if (DATA.notes && DATA.notes.length) $('modelSource').textContent += ' · ' + DATA.notes.join(' / ');
show(0);
</script>
</body>
</html>`
}

/**
 * Run one wizard submission through the **same** `/handoff` command definition.
 * `params` is accepted by the definition directly (see handoffCommand: `invocation.params`),
 * so the wizard cannot drift from the typed command.
 */
export async function runWizard(ctx, deps, { sessionId, params }) {
  const agent = (() => {
    try {
      const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx && ctx.agents
      return agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
    } catch {
      return null
    }
  })()
  if (!agent) {
    return { ok: false, text: '这条会话现在没有活 Agent（窗口已关或刚重启过）⇒ 不能从表单建会话。请在自己的窗口里执行 `/handoff`。' }
  }
  const definition = (deps.commandDefs || []).find((row) => row && row.name === 'handoff')
  if (!definition) return { ok: false, text: '交接命令不可用（插件未完整加载）⇒ 请手动 `/handoff`。' }

  const model = textOf(params && params.model)
  const permission = textOf(params && params.perm)
  const retireNow = Boolean(params && params.retireNow)
  try {
    const result = await definition.handler({
      agent,
      rawInput: '',
      commandId: 'handoff-wizard',
      params: {
        key: textOf(params && params.key),
        preset: textOf(params && params.preset),
        ...(model ? { model } : {}),
        ...(permission ? { perm: permission } : {}),
        title: textOf(params && params.title),
        ...(textOf(params && params.task) ? { task: textOf(params && params.task) } : {}),
        target: 'new',
        ...(retireNow ? { retire: 'now' } : {}),
      },
    })
    return { ok: result && result.kind === 'success', kind: result && result.kind, text: (result && result.text) || '' }
  } catch (error) {
    return { ok: false, text: `表单执行失败：${error?.message || String(error)}` }
  }
}
