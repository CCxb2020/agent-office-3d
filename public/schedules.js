// Tarefas agendadas (autopilots do Multica): lista lateral, agenda das
// próximas 24 h e painel de cada tarefa com histórico e ações.
import { api } from "./agent-panel.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TZ = "America/Sao_Paulo";
const TZ_OFFSET_MIN = { "America/Sao_Paulo": -180, UTC: 0, "Etc/UTC": 0 }; // Brasil sem horário de verão desde 2019
const DOW = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const RUN_STATUS = { issue_created: "📝 issue criada", completed: "✅ 已完成", failed: "❌ 失败", running: "▶️ 运行中", queued: "⏳ 排队中", skipped: "⏭ pulada", cancelled: "⏹ 已取消" };

// ---------- cron ----------

function parseField(field, min, max) {
  const out = new Set();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = Number(stepStr ?? 1);
    let [a, b] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (b === undefined) b = stepStr ? max : a;
    for (let v = a; v <= b; v += step) out.add(v === 7 && max === 6 ? 0 : v);
  }
  return out;
}

/** Aceita o prefixo "TZ=America/Sao_Paulo 0 18 * * 1,5". */
function splitTz(expr) {
  const m = /^(?:CRON_)?TZ=(\S+)\s+(.*)$/.exec(String(expr ?? "").trim());
  return m ? { tz: m[1], cron: m[2] } : { tz: null, cron: String(expr ?? "").trim() };
}

function parseCron(expr) {
  const f = splitTz(expr).cron.split(/\s+/);
  if (f.length !== 5) return null;
  try {
    return { min: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), mon: parseField(f[3], 1, 12), dow: parseField(f[4], 0, 6), raw: f };
  } catch {
    return null;
  }
}

const two = (n) => String(n).padStart(2, "0");

/** "0 9 * * 1-5" → "Dias úteis às 09:00". */
export function cronText(expr) {
  const c = parseCron(expr);
  if (!c) return expr ?? "";
  const [m, h, dom, , dow] = c.raw;
  if (m.startsWith("*/") && h === "*") return `每 ${m.slice(2)} 分钟`;
  if (m.startsWith("*/")) return `${two(Math.min(...c.hour))} 点至 ${two(Math.max(...c.hour))} 点，每 ${m.slice(2)} 分钟`;
  if (h === "*") return m === "0" ? "每小时" : `每小时第 ${two(m)} 分钟`;
  if (h.startsWith("*/")) return `每 ${h.slice(2)} 小时`;
  const hours = [...c.hour].sort((a, b) => a - b);
  const mins = [...c.min].sort((a, b) => a - b);
  const times = hours.length > 4 ? `${two(hours[0])} 点至 ${two(hours.at(-1))} 点 (${hours.length}×)` : hours.flatMap((hh) => mins.map((mm) => `${two(hh)}:${two(mm)}`)).join("、");
  let days = "每天";
  if (dom !== "*") days = c.dom.size > 1 ? `每月 ${[...c.dom].sort((a, b) => a - b).join("、")} 日` : `每月 ${dom} 日`;
  else if (dow === "1-5") days = "工作日";
  else if (dow !== "*") days = [...c.dow].sort().map((d) => DOW[d]).join(", ").replace(/^./, (s) => s.toUpperCase());
  return `${days} ${times}`;
}

/** Execuções do cron entre agora e +horas (em instantes UTC). */
export function occurrences(expr, tz, fromMs, hours) {
  const c = parseCron(expr);
  if (!c) return [];
  const off = (TZ_OFFSET_MIN[splitTz(expr).tz ?? tz ?? TZ] ?? -180) * 60_000;
  const out = [];
  const start = Math.ceil(fromMs / 60_000) * 60_000;
  for (let t = start; t < fromMs + hours * 3600_000 && out.length < 200; t += 60_000) {
    const d = new Date(t + off); // campos em hora local via getUTC*
    if (!c.min.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours())) continue;
    if (!c.mon.has(d.getUTCMonth() + 1)) continue;
    const domOk = c.dom.has(d.getUTCDate()), dowOk = c.dow.has(d.getUTCDay());
    const domAny = c.raw[2] === "*", dowAny = c.raw[4] === "*";
    if (domAny && dowAny ? true : domAny ? dowOk : dowAny ? domOk : domOk || dowOk) out.push(t);
  }
  return out;
}

function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const fmt = (o) => d.toLocaleString("zh-CN", { timeZone: TZ, ...o });
  const day = (x) => x.toLocaleDateString("zh-CN", { timeZone: TZ });
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  const hm = fmt({ hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(today)) return `今天 ${hm}`;
  if (day(d) === day(tomorrow)) return `明天 ${hm}`;
  if (d < today && day(d) === day(new Date(Date.now() - 86400_000))) return `昨天 ${hm}`;
  return `${fmt({ day: "2-digit", month: "2-digit" })} ${hm}`;
}

function cadence(s) {
  const t = s.triggers.filter((x) => x.kind === "schedule" && x.cron);
  if (t.length) return t.map((x) => cronText(x.cron)).join(" + ");
  return s.triggers.some((x) => x.kind === "webhook") ? "由 Webhook 触发" : "手动";
}

// ---------- lista lateral ----------

export function renderScheduleList(el, { data, query, filter, selectedId }) {
  const agents = new Map(data.agents.map((a) => [a.id, a]));
  const list = data.schedules.filter((s) => {
    if (filter !== "all" && s.status !== filter) return false;
    if (!query) return true;
    return [s.title, agents.get(s.agentId)?.name, cadence(s)].join(" ").toLowerCase().includes(query);
  });
  el.innerHTML = list.length
    ? list
        .map((s) => {
          const a = agents.get(s.agentId);
          return `<li class="sched ${s.id === selectedId ? "selected" : ""} ${s.status}" data-sched="${s.id}">
            <span class="when">${s.status === "paused" ? "⏸ 已暂停" : esc(when(s.nextRunAt))}</span>
            <span class="name">${s.lastRun?.status === "failed" && !s.lastRun.acked ? `<i class="fail-dot" title="上次运行失败"></i>` : ""}${esc(s.title)}<small>${a ? `${esc(a.emoji)} ${esc(a.name)} · ` : ""}${esc(cadence(s))}</small></span></li>`;
        })
        .join("")
    : `<li class="empty">没有找到匹配的任务。</li>`;
}

// ---------- agenda (visão principal) ----------

export function renderAgenda(el, { data, selectedId }) {
  const agents = new Map(data.agents.map((a) => [a.id, a]));
  const now = Date.now();
  const H = 24;
  const rows = data.schedules.map((s) => {
    const occ = s.status === "active"
      ? s.triggers.filter((t) => t.cron).flatMap((t) => occurrences(t.cron, t.tz, now, H))
      : [];
    return { s, occ: occ.sort((a, b) => a - b) };
  });
  const active = data.schedules.filter((s) => s.status === "active");
  const fails = data.schedules.filter((s) => s.lastRun?.status === "failed" && !s.lastRun.acked).length;
  const in24 = rows.reduce((n, r) => n + r.occ.length, 0);
  const next = rows.filter((r) => r.occ.length).sort((a, b) => a.occ[0] - b.occ[0])[0];
  const startHour = new Date(now).toLocaleString("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const hourMarks = Array.from({ length: H / 3 + 1 }, (_, i) => {
    const t = now + i * 3 * 3600_000;
    return `<span style="left:${(i * 3 * 100) / H}%">${new Date(t).toLocaleTimeString("zh-CN", { timeZone: TZ, hour: "2-digit" })}</span>`;
  }).join("");

  const row = ({ s, occ }) => {
    const a = agents.get(s.agentId);
    const ticks = occ
      .map((t) => `<i style="left:${((t - now) / (H * 3600_000)) * 100}%" title="${new Date(t).toLocaleString("zh-CN", { timeZone: TZ })}"></i>`)
      .join("");
    return `<div class="arow ${s.status} ${s.id === selectedId ? "selected" : ""}" data-sched="${s.id}">
      <div class="atitle"><b>${s.lastRun?.status === "failed" && !s.lastRun.acked ? `<i class="fail-dot" title="上次运行失败"></i>` : ""}${esc(s.title)}</b><small>${a ? `${esc(a.emoji)} ${esc(a.name)}` : "—"} · ${esc(cadence(s))}</small></div>
      <div class="anext">${s.status === "paused" ? `<span class="badge paused">已暂停</span>` : esc(when(s.nextRunAt))}</div>
      <div class="atrack">${ticks}</div>
    </div>`;
  };
  const sorted = rows.sort((a, b) => (a.s.status === b.s.status ? (a.occ[0] ?? 9e15) - (b.occ[0] ?? 9e15) : a.s.status === "active" ? -1 : 1));
  el.innerHTML = `
    <div class="agenda-top"><h2>📅 未来 24 小时日程</h2><div class="row">${fails ? `<button type="button" data-ack-all>📦 归档所有失败记录 (${fails})</button>` : ""}<button type="button" class="primary" data-new-sched>➕ 新建定时任务</button></div></div>
    <div class="agenda-head">
      <div class="kpi"><b>${active.length}</b><span>已启用的任务</span></div>
      <div class="kpi"><b>${data.schedules.length - active.length}</b><span>已暂停</span></div>
      <div class="kpi ${fails ? "bad" : ""}"><b>${fails}</b><span>待处理的失败</span></div>
      <div class="kpi"><b>${in24}</b><span>未来 24 小时的运行次数</span></div>
      <div class="kpi wide"><b>${next ? new Date(next.occ[0]).toLocaleTimeString("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "—"}</b><span>${next ? `下次运行： ${esc(next.s.title)}` : "未来 24 小时无运行"}</span></div>
    </div>
    <div class="agenda-grid">
      <div class="arow header"><div class="atitle">任务 · 智能体 · 频率</div><div class="anext">下次运行</div><div class="atrack scale">${hourMarks}<em style="left:0" title="现在 (${startHour})"></em></div></div>
      ${sorted.map(row).join("")}
    </div>
    <p class="muted small">时间以里约当地时间显示。每条刻线代表未来 24 小时内的一次计划运行。</p>`;
}

// ---------- painel da tarefa ----------

export function createScheduleDrawer(el, { getData, getAuth, login, onClose, onAgent, toast, onChanged = () => {} }) {
  let id = null; // id da tarefa, ou "new" para criar
  let detail = null;
  let editing = false;
  let triggers = null;

  const agentOptions = (sel) =>
    (getData()?.agents ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.emoji)} ${esc(a.name)} · ${esc(a.machine)}</option>`)
      .join("");
  const CRON_HELP = `<small class="muted">Cron 使用里约当地时间，共 5 个字段。例如 <code>0 9 * * 1-5</code>（工作日 9 点）、<code>*/30 7-23 * * *</code>（7 至 23 点，每 30 分钟一次）、<code>0 8 1 * *</code>（每月 1 日 8 点）。</small>`;

  function renderCreate() {
    el.hidden = false;
    el.innerHTML = `<button class="close" type="button" aria-label="关闭">✕</button>
      <div class="eyebrow">⏰ 新建定时任务</div><h2>创建定时任务</h2>
      <form class="sched-form">
        <label>标题<input name="title" required maxlength="200" placeholder="例如：每周线索报告" /></label>
        <label>负责的智能体<select name="agentId" required>${agentOptions()}</select></label>
        <label>智能体指令<textarea name="description" rows="7" required placeholder="描述每次运行要做的事"></textarea></label>
        <div class="grid2">
          <label>模式<select name="mode"><option value="create_issue">每次运行创建一个任务</option><option value="run_only">仅运行（不创建任务）</option></select></label>
          <label>任务标题<input name="titleTemplate" placeholder="报告 {{date}}" /></label>
        </div>
        <label>运行时间（cron）<input name="cron" class="mono" placeholder="0 9 * * 1-5" /></label>
        <div class="cron-preview muted small"></div>
        ${CRON_HELP}
        <button type="submit" class="primary wide">⏰ 创建定时任务</button>
      </form>`;
    el.querySelector(".close").onclick = onClose;
    const form = el.querySelector("form");
    const preview = el.querySelector(".cron-preview");
    form.elements.cron.addEventListener("input", (e) => (preview.textContent = e.target.value.trim() ? `→ ${cronText(e.target.value)}` : ""));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const out = await api("/api/schedules", {
          title: f.title.value, agentId: f.agentId.value, description: f.description.value, mode: f.mode.value,
          titleTemplate: f.titleTemplate.value, cron: f.cron.value.trim(), tz: TZ,
        });
        toast("已创建定时任务。");
        onChanged();
        id = out.id;
        detail = null;
        editing = false;
        render();
        load();
      } catch (err) {
        toast(err.message, false);
        btn.disabled = false;
      }
    });
  }

  function renderEdit(s) {
    const trig = triggers
      ? triggers.length
        ? triggers
            .map((t) => `<form class="trig" data-trig="${t.id}">
              ${t.kind === "schedule"
                ? `<input name="cron" class="mono" value="${esc(t.cron ?? "")}" /><span class="muted small">${esc(cronText(t.cron))}</span>`
                : `<span>${esc(t.kind)}</span>`}
              <label class="check inline"><input type="checkbox" name="enabled" ${t.enabled ? "checked" : ""}/> 已启用</label>
              <button type="submit">保存</button><button type="button" class="danger" data-act="trig-del">删除</button></form>`)
            .join("")
        : `<p class="muted">没有配置时间，只能手动运行。</p>`
      : `<p class="muted">正在加载运行时间…</p>`;
    return `
      <form class="sched-form sched-edit">
        <label>标题<input name="title" required maxlength="200" value="${esc(s.title)}" /></label>
        <label>负责的智能体<select name="agentId">${agentOptions(s.agentId)}</select></label>
        <label>智能体指令<textarea name="description" rows="8">${esc(detail?.description ?? "")}</textarea></label>
        <div class="grid2">
          <label>模式<select name="mode"><option value="create_issue" ${s.mode === "create_issue" ? "selected" : ""}>每次运行创建一个任务</option><option value="run_only" ${s.mode === "run_only" ? "selected" : ""}>仅运行（不创建任务）</option></select></label>
          <label>任务标题<input name="titleTemplate" value="${esc(detail?.titleTemplate ?? "")}" /></label>
        </div>
        <div class="row"><button type="button" data-act="cancel-edit">取消</button><button type="submit" class="primary">💾 保存</button></div>
      </form>
      <div class="section-title">运行时间</div>
      ${trig}
      <form class="trig-add"><input name="cron" class="mono" placeholder="新 Cron 表达式，例如 0 9 * * 1-5" required /><button type="submit">➕ 添加时间</button></form>
      ${CRON_HELP}
      <div class="section-title danger-title">危险操作</div>
      <button type="button" class="danger" data-act="delete">🗑️ 删除 定时任务</button>`;
  }

  function render() {
    if (id === "new") return renderCreate();
    const data = getData();
    const s = data?.schedules.find((x) => x.id === id);
    if (!s) return void (el.hidden = true);
    el.hidden = false;
    const a = data.agents.find((x) => x.id === s.agentId);
    const auth = getAuth();
    const trig = s.triggers.map((t) => (t.cron ? `<code>${esc(t.cron)}</code> ${esc(t.tz ?? "")}` : esc(t.kind))).join("<br>");
    let body;
    if (!auth.enabled) body = `<p class="muted">当前为只读模式，无法在此查看运行历史或执行操作。</p>`;
    else if (!auth.auth) body = `<button type="button" class="primary wide" data-act="login">🔐 登录查看运行历史和操作</button>`;
    else if (!detail) body = `<p class="muted">正在加载…</p>`;
    else if (detail.error) body = `<p class="error">${esc(detail.error)}</p>`;
    else if (editing) body = renderEdit(s);
    else
      body = `
        <div class="run-actions">
          <button type="button" class="primary" data-act="trigger">▶ 立即运行</button>
          ${s.status === "active" ? `<button type="button" data-act="pause">⏸ 暂停</button>` : `<button type="button" data-act="resume">▶ 恢复</button>`}
          <button type="button" data-act="edit">✏️ 编辑</button>
        </div>
        ${detail.description ? `<div class="section-title">指令</div><div class="desc-box">${esc(detail.description)}</div>` : ""}
        <div class="section-title">运行历史</div>
        ${detail.runs.length
          ? detail.runs
              .map((r) => `<div class="run ${r.status === "failed" ? (r.acked ? "acked" : "failed") : ""}"><div class="run-top"><span class="pill">${RUN_STATUS[r.status] ?? esc(r.status)}${r.status === "failed" && r.acked ? " · 📦 已归档" : ""}</span><small class="muted">${esc(when(r.at))} · ${esc(r.source)}</small></div>
                ${r.issue ? `<div class="run-what"><b>${esc(r.issue.identifier)}</b> ${esc(r.issue.title)} <span class="muted small">(${esc(r.issue.status)})</span></div>` : ""}
                ${r.failure ? `<div class="error small">${esc(r.failure)}</div>` : ""}
                ${r.status === "failed" ? `<div class="run-actions">
                  <button type="button" data-act="trigger">🔁 重新运行</button>
                  ${r.issue && !["done", "cancelled"].includes(r.issue.status) ? `<button type="button" class="primary" data-act="issue-done" data-issue="${r.issue.id}" data-label="${esc(r.issue.identifier)}">✅ 完成任务</button>
                  <button type="button" class="danger" data-act="issue-cancel" data-issue="${r.issue.id}" data-label="${esc(r.issue.identifier)}">🚫 取消任务</button>` : ""}
                  <button type="button" data-act="ack" data-run="${r.id}" data-ack="${r.acked ? "0" : "1"}">${r.acked ? "↩️ 取消归档" : "📦 归档失败记录"}</button>
                </div>` : ""}</div>`)
              .join("")
          : `<p class="muted">尚未运行。</p>`}`;
    el.innerHTML = `<button class="close" type="button" aria-label="关闭">✕</button>
      <div class="eyebrow">⏰ 定时任务</div>
      <h2>${esc(s.title)}</h2>
      <div class="meta"><span class="badge ${s.status}">${s.status === "active" ? "已启用" : "已暂停"}</span> · ${s.mode === "create_issue" ? "每次运行创建一个任务" : "仅运行（不创建任务）"}</div>
      <dl class="facts">
        <dt>负责人</dt><dd>${a ? `<a href="#" data-act="agent">${esc(a.emoji)} ${esc(a.name)}</a> <small class="muted">💻 ${esc(a.machine)}</small>` : "—"}</dd>
        <dt>频率</dt><dd>${esc(cadence(s))}<br><small class="muted">${trig}</small></dd>
        <dt>下次运行</dt><dd>${s.status === "active" ? esc(when(s.nextRunAt)) : "—"}</dd>
        <dt>上次运行</dt><dd>${esc(when(s.lastRunAt))}${s.lastRun ? ` · ${RUN_STATUS[s.lastRun.status] ?? esc(s.lastRun.status)}` : ""}</dd>
      </dl>
      ${body}`;
    el.querySelector(".close").onclick = onClose;
  }

  async function load() {
    const want = id;
    try {
      const d = await api(`/api/schedules/${want}`);
      if (want === id) detail = d;
    } catch (e) {
      if (want === id) detail = { error: e.message };
    }
    render();
  }

  async function loadTriggers() {
    try {
      triggers = (await api(`/api/schedules/${id}/triggers`)).triggers;
    } catch (e) {
      triggers = [];
      toast(e.message, false);
    }
    render();
  }

  async function run(fn, msg) {
    try {
      await fn();
      toast(msg);
      onChanged();
      return true;
    } catch (err) {
      toast(err.message, false);
      return false;
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || id === "new") return;
    e.preventDefault();
    const s = getData()?.schedules.find((x) => x.id === id);
    const act = b.dataset.act;
    if (act === "login") return login();
    if (act === "agent") return onAgent(s.agentId);
    if (act === "edit") {
      editing = true;
      triggers = null;
      render();
      return loadTriggers();
    }
    if (act === "cancel-edit") {
      editing = false;
      return render();
    }
    if (act === "ack") {
      const on = b.dataset.ack === "1";
      if (await run(() => api("/api/acks", { id: b.dataset.run, ack: on }), on ? "失败记录已归档。" : "已取消归档。")) {
        detail = null;
        render();
        load();
      }
      return;
    }
    if (act === "issue-done" || act === "issue-cancel") {
      const status = act === "issue-done" ? "done" : "cancelled";
      if (!confirm(`${status === "done" ? "完成" : "取消"} ${b.dataset.label}?`)) return;
      if (await run(() => api(`/api/issues/${b.dataset.issue}/status`, { status }), `${b.dataset.label} ${status === "done" ? "已完成" : "已取消"}.`)) {
        detail = null;
        render();
        load();
      }
      return;
    }
    if (act === "trig-del") {
      const tid = b.closest("form").dataset.trig;
      if (!confirm("删除这个运行时间？")) return;
      if (await run(() => api(`/api/schedules/${id}/triggers/${tid}/delete`, {}), "已删除运行时间。")) loadTriggers();
      return;
    }
    if (act === "delete") {
      const typed = prompt(`删除「${s.title}」及其运行时间。请输入「删除」确认。`);
      if (typed !== "删除") return typed !== null && toast("确认文字不匹配，删除已取消。", false);
      if (await run(() => api(`/api/schedules/${id}/delete`, {}), "定时任务已删除。")) onClose();
      return;
    }
    const ask = { trigger: `立即运行「${s.title}」？`, pause: `暂停「${s.title}」？恢复后才会继续运行。`, resume: `恢复「${s.title}」？` }[act];
    if (!ask || !confirm(ask)) return;
    b.disabled = true;
    const okRun = await run(
      () => (act === "trigger" ? api(`/api/schedules/${id}/trigger`, {}) : api(`/api/schedules/${id}/status`, { status: act === "pause" ? "paused" : "active" })),
      act === "trigger" ? "已触发运行，智能体即将启动。" : act === "pause" ? "任务已暂停。" : "任务已恢复。",
    );
    if (okRun && act !== "trigger") s.status = act === "pause" ? "paused" : "active";
    detail = null;
    render();
    load();
  });

  el.addEventListener("submit", async (e) => {
    if (id === "new") return;
    e.preventDefault();
    const f = e.target;
    if (f.classList.contains("sched-edit")) {
      const s = getData()?.schedules.find((x) => x.id === id);
      const v = f.elements;
      const body = {};
      if (v.title.value !== s.title) body.title = v.title.value;
      if (v.agentId.value !== s.agentId) body.agentId = v.agentId.value;
      if (v.mode.value !== s.mode) body.mode = v.mode.value;
      if (v.description.value !== (detail?.description ?? "")) body.description = v.description.value;
      if (v.titleTemplate.value !== (detail?.titleTemplate ?? "")) body.titleTemplate = v.titleTemplate.value;
      if (!Object.keys(body).length) return toast("没有更改。");
      if (await run(() => api(`/api/schedules/${id}/update`, body), "任务已更新。")) {
        Object.assign(s, body.title ? { title: body.title } : {}, body.agentId ? { agentId: body.agentId } : {}, body.mode ? { mode: body.mode } : {});
        editing = false;
        detail = null;
        render();
        load();
      }
    } else if (f.classList.contains("trig")) {
      const body = { enabled: f.elements.enabled.checked };
      if (f.elements.cron) body.cron = f.elements.cron.value.trim();
      if (await run(() => api(`/api/schedules/${id}/triggers/${f.dataset.trig}`, { ...body, tz: TZ }), "运行时间已保存。")) loadTriggers();
    } else if (f.classList.contains("trig-add")) {
      if (await run(() => api(`/api/schedules/${id}/triggers`, { cron: f.elements.cron.value.trim(), tz: TZ }), "已添加运行时间。")) loadTriggers();
    }
  });

  return {
    show(next) {
      if (next !== id) {
        detail = null;
        editing = false;
        triggers = null;
      }
      id = next;
      if (!id) return void (el.hidden = true);
      render();
      if (id !== "new" && getAuth().auth && !detail) load();
    },
    create() {
      this.show("new");
    },
    refresh() {
      if (id && id !== "new" && !editing) render();
    },
    authChanged() {
      detail = null;
      if (id && id !== "new") {
        render();
        if (getAuth().auth) load();
      }
    },
    get id() {
      return id;
    },
  };
}
