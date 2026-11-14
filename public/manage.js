// Painel de gestão de uma issue (ou de uma execução avulsa, como um chat):
// dados, status, prioridade, responsável, comentários, execuções com os passos,
// linha do tempo e consumo — e as ações (comentar chamando o agente, rodar de
// novo, cancelar execução, concluir/cancelar a issue).

import { api } from "./agent-panel.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TZ = { timeZone: "America/Sao_Paulo" };
const when = (d) => (d ? new Date(d).toLocaleString("zh-CN", { ...TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const dur = (a, b) => {
  if (!a || !b) return "";
  const s = Math.max(0, (new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};
const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n ?? 0));
export const STATUS = { backlog: "待安排", todo: "待办", in_progress: "进行中", in_review: "待审核", blocked: "受阻", done: "已完成", cancelled: "已取消" };
const PRIORITY = { none: "无优先级", low: "低", medium: "中", high: "高", urgent: "紧急" };
const LIVE = new Set(["queued", "dispatched", "running", "waiting_local_directory", "pending"]);
const RUN_LABEL = { completed: "✅ 已完成", failed: "❌ 失败", cancelled: "⏹ 已取消", running: "⏳ 运行中", dispatched: "⏳ 正在启动", queued: "🕓 排队中" };
const ACTION = { created: "创建了任务", status_changed: "修改了状态", assignee_changed: "修改了负责人", priority_changed: "修改了优先级", title_changed: "修改了标题", description_changed: "编辑了描述" };

export function createIssueDrawer(el, { getData, toast, onAgent, onChanged = () => {} }) {
  let ref = null; // id ou identificador da issue aberta
  let run = null; // execução avulsa aberta (sem issue)
  let detail = null;
  let tab = "comments";
  const openSteps = new Map(); // runId → passos

  const agents = () => (getData()?.agents ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const agentOf = (id) => getData()?.agents.find((a) => a.id === id);
  const agentName = (id) => {
    const a = agentOf(id);
    return a ? `${a.emoji} ${a.name}` : "智能体";
  };

  async function open(issueRef) {
    ref = issueRef;
    run = null;
    detail = null;
    openSteps.clear();
    el.hidden = false;
    render();
    let d;
    try {
      d = await api(`/api/manage/issues/${encodeURIComponent(issueRef)}`);
    } catch (e) {
      d = { error: e.message };
    }
    if (ref !== issueRef || el.hidden) return; // outra issue foi aberta (ou o painel fechou) enquanto carregava
    detail = d;
    render();
  }

  /** Execução sem issue (ex.: chat): mostra os passos direto. */
  async function openRun(r) {
    ref = null;
    run = r;
    detail = null;
    el.hidden = false;
    render();
    await loadSteps(r.id);
    if (run === r) render();
  }

  function close() {
    el.hidden = true;
    ref = run = detail = null;
  }

  async function loadSteps(runId) {
    try {
      openSteps.set(runId, (await api(`/api/runs/${encodeURIComponent(runId)}/messages`)).messages ?? []);
    } catch (e) {
      openSteps.set(runId, [{ type: "error", text: e.message }]);
    }
  }

  const steps = (runId) => {
    const list = openSteps.get(runId);
    if (!list) return `<p class="muted">⏳ 正在加载步骤…</p>`;
    if (!list.length) return `<p class="muted">暂无执行步骤。</p>`;
    return `<div class="m-steps">${list
      .map((m) =>
        m.type === "text" ? `<div class="m-step text">${esc(m.text)}</div>`
        : m.type === "tool" ? `<div class="m-step tool">🔧 <b>${esc(m.tool)}</b> <code>${esc(m.text)}</code></div>`
        : m.type === "result" ? `<div class="m-step result">${esc(m.text)}</div>`
        : m.type === "error" ? `<div class="m-step err">${esc(m.text)}</div>` : "")
      .join("")}</div>`;
  };

  function render() {
    if (run) {
      el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="关闭">✕</button>
        <div class="m-head"><h2>${run.kind === "chat" ? "💬 Chat" : "▶️ 运行"} · ${esc(agentName(run.agentId))}</h2>
          <div class="muted">${esc(when(run.createdAt))}${run.by ? ` · 发起人：${ esc(run.by)}` : ""} · ${esc(RUN_LABEL[run.status] ?? run.status)}</div>
          ${run.about ? `<div class="m-ctx"><b>📝 任务说明</b>${esc(run.about)}</div>` : ""}
          ${run.now ? `<div class="m-ctx"><b>✍️ 现在</b>${esc(run.now)}</div>` : ""}
          <p class="muted small">此处可查看 Multica 对话。要发送消息，请使用智能体面板的「对话」。</p>
          <div class="m-actions">${LIVE.has(run.status) ? `<button type="button" class="danger" data-m="cancel-run" data-run="${esc(run.id)}">⏹ 取消运行</button>` : ""}
            <button type="button" data-m="agent" data-agent="${esc(run.agentId)}">打开智能体</button>
            <button type="button" data-m="run-reload">↻ 刷新执行步骤</button></div></div>
        <div class="m-body">${steps(run.id)}</div>`;
      return;
    }
    if (!detail) {
      el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="关闭">✕</button><p class="muted">⏳ 正在加载 ${esc(ref)}…</p>`;
      return;
    }
    if (detail.error) {
      el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="关闭">✕</button><p class="error">打开失败: ${esc(detail.error)}</p>`;
      return;
    }
    const { issue: i, comments, runs, timeline, usage } = detail;
    const live = runs.find((r) => LIVE.has(r.status));
    const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    const assigneeOpts =
      `<option value="">— 未分配 —</option>` +
      (i.assigneeType && i.assigneeType !== "agent" ? `<option value="__keep" selected>👤 当前成员或小队</option>` : "") +
      agents().map((a) => `<option value="${esc(a.id)}" ${a.id === i.assignee ? "selected" : ""}>${esc(a.emoji)} ${esc(a.name)}</option>`).join("");
    const tabs = [["comments", `💬 评论 (${comments.length})`], ["runs", `⏱️ 运行记录 (${runs.length})`], ["timeline", "🕓 时间线"], ["desc", "📄 描述"]];
    let body = "";
    if (tab === "comments") {
      body = (comments.length
        ? comments.map((c) => `<div class="m-comment ${c.authorType === "agent" ? "agent" : "member"}"><div class="m-meta">${c.authorType === "agent" ? esc(agentName(c.author)) : "👤 成员"} · ${esc(when(c.at))}</div><div class="m-text">${esc(c.text)}</div></div>`).join("")
        : `<p class="muted">暂无评论。</p>`) +
        `<div class="m-reply"><textarea name="text" rows="3" placeholder="输入评论或指令…"></textarea>
          <label class="m-check"><input type="checkbox" name="wake" ${i.assignee ? "checked" : ""} ${i.assignee ? "" : "disabled"} /> 提及并启动 ${i.assignee ? esc(agentName(i.assignee)) : "负责人"}</label>
          <button type="button" class="primary" data-m="comment">💬 发表评论</button></div>`;
    } else if (tab === "runs") {
      body = runs.length
        ? runs.map((r) => `<div class="m-run"><div class="m-run-head">
            <span>${esc(RUN_LABEL[r.status] ?? r.status)}</span><b>${esc(agentName(r.agentId))}</b>
            <small class="muted">${esc(when(r.createdAt))}${r.completedAt ? ` · ${dur(r.startedAt ?? r.createdAt, r.completedAt)}` : ""}</small></div>
            ${r.trigger ? `<small class="muted">${esc(r.trigger)}</small>` : ""}
            ${r.error ? `<small class="h-err">${esc(r.error)}</small>` : ""}
            <div class="m-actions"><button type="button" data-m="steps" data-run="${esc(r.id)}">${openSteps.has(r.id) ? "▲ 收起步骤" : "▼ 查看步骤"}</button>
              ${LIVE.has(r.status) ? `<button type="button" class="danger" data-m="cancel-run" data-run="${esc(r.id)}">⏹ 取消</button>` : ""}</div>
            ${openSteps.has(r.id) ? steps(r.id) : ""}</div>`).join("")
        : `<p class="muted">暂无运行记录。</p>`;
    } else if (tab === "timeline") {
      body = timeline.length
        ? `<ul class="m-timeline">${timeline.map((e) => `<li><small>${esc(when(e.at))}</small> <b>${esc(e.actor)}</b> ${esc(ACTION[e.action] ?? e.action)}${e.to ? ` → ${esc(STATUS[e.to] ?? e.to)}` : ""}</li>`).join("")}</ul>`
        : `<p class="muted">暂无事件。</p>`;
    } else body = `<div class="m-desc">${esc(i.description) || '<span class="muted">暂无描述。</span>'}</div>`;

    el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="关闭">✕</button>
      <div class="m-head">
        <h2><span class="m-id">${esc(i.identifier)}</span> ${esc(i.title)} <button type="button" class="m-edit" data-m="title" title="编辑标题">✏️</button></h2>
        <div class="muted small">criada ${esc(when(i.createdAt))} · atualizada ${esc(when(i.updatedAt))}${usage ? ` · ${usage.runs} 次运行 · ${fmtK(usage.input + usage.cacheRead)} tokens lidos, ${fmtK(usage.output)} escritos` : ""}</div>
        <div class="m-fields">
          <label>状态<select data-m="status">${opts(STATUS, i.status)}</select></label>
          <label>优先级<select data-m="priority">${opts(PRIORITY, i.priority)}</select></label>
          <label>负责人<select data-m="assign">${assigneeOpts}</select></label>
          <label>截止日期<input type="date" data-m="due" value="${esc((i.dueDate ?? "").slice(0, 10))}" /></label>
        </div>
        <div class="m-actions">
          ${i.assigneeType === "agent" ? `<button type="button" data-m="rerun">🔁 重新运行</button>` : ""}
          ${live ? `<button type="button" class="danger" data-m="cancel-run" data-run="${esc(live.id)}">⏹ 取消当前运行</button>` : ""}
          ${i.status !== "done" ? `<button type="button" class="primary" data-m="set" data-status="done">✅ 完成</button>` : ""}
          ${i.status !== "cancelled" ? `<button type="button" class="danger" data-m="set" data-status="cancelled">🚫 取消任务</button>` : ""}
          ${i.assignee && agentOf(i.assignee) ? `<button type="button" data-m="agent" data-agent="${esc(i.assignee)}">打开智能体</button>` : ""}
          <button type="button" data-m="reload">↻</button>
        </div>
      </div>
      <div class="m-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
      <div class="m-body">${body}</div>`;
  }

  /** Executa uma ação, avisa e recarrega o detalhe. */
  async function act(fn, ok) {
    try {
      await fn();
      toast(ok);
      onChanged();
      if (ref && !el.hidden) await open(ref);
    } catch (e) {
      toast(`操作失败： ${e.message}`, false);
      if (ref) render();
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.m === "close") return close();
    if (d.tab) return (tab = d.tab), render();
    if (d.m === "reload") return ref && open(ref);
    if (d.m === "run-reload" && run) {
      openSteps.delete(run.id);
      render();
      await loadSteps(run.id);
      return render();
    }
    if (d.m === "comment") return comment();
    if (d.m === "title") {
      const t = prompt("新标题：", detail.issue.title);
      if (t == null || !t.trim() || t.trim() === detail.issue.title) return;
      return act(() => api(`/api/manage/issues/${detail.issue.id}/edit`, { title: t.trim() }), "标题 atualizado.");
    }
    if (d.m === "agent") return onAgent(d.agent);
    if (d.m === "steps") {
      if (openSteps.has(d.run)) openSteps.delete(d.run);
      else {
        openSteps.set(d.run, undefined); // aberto, carregando
        render();
        await loadSteps(d.run);
      }
      return render();
    }
    const id = detail?.issue?.id;
    if (d.m === "cancel-run" && confirm("取消这次运行？智能体将停止。")) {
      return act(() => api(`/api/runs/${encodeURIComponent(d.run)}/cancel`, {}), "运行已取消。").then(() => run && openRun({ ...run, status: "cancelled" }));
    }
    if (d.m === "rerun" && confirm(`让 ${agentName(detail.issue.assignee)} 重新运行 ${detail.issue.identifier}？`)) {
      return act(() => api(`/api/issues/${id}/rerun`, {}), "Reenfileirada.");
    }
    if (d.m === "set" && confirm(`${d.status === "done" ? "完成" : "取消"} ${detail.issue.identifier}?`)) {
      return act(() => api(`/api/issues/${id}/status`, { status: d.status }), d.status === "done" ? "Issue 已完成." : "Issue 已取消.");
    }
  });

  el.addEventListener("change", (e) => {
    const s = e.target.closest("select[data-m], input[data-m]");
    if (!s || !detail?.issue) return;
    if (s.dataset.m === "due" && !s.value) return toast("请在 Multica 中清除截止日期。", false), render();
    if (s.dataset.m === "due") return act(() => api(`/api/manage/issues/${detail.issue.id}/edit`, { dueDate: s.value }), s.value ? `Prazo: ${s.value.split("-").reverse().join("/")}.` : "Prazo removido.");
    const id = detail.issue.id;
    if (s.dataset.m === "status") {
      if (["done", "cancelled"].includes(s.value) && !confirm(`将 ${detail.issue.identifier} 改为「${STATUS[s.value]}」？`)) return render();
      return act(() => api(`/api/issues/${id}/status`, { status: s.value }), `状态: ${STATUS[s.value]}.`);
    }
    if (s.dataset.m === "priority") return act(() => api(`/api/manage/issues/${id}/priority`, { priority: s.value }), `优先级: ${PRIORITY[s.value]}.`);
    if (s.dataset.m === "assign" && s.value !== "__keep") {
      const label = s.value ? agentName(s.value) : "未分配";
      if (!confirm(`将 ${detail.issue.identifier} 的负责人设为「${label}」？${s.value ? "这可能会启动一次运行。" : ""}`)) return render();
      return act(() => api(`/api/manage/issues/${id}/assign`, { agentId: s.value || null }), `负责人已设为「${label}」。`);
    }
  });

  function comment() {
    const box = el.querySelector(".m-reply textarea");
    const text = box.value.trim();
    if (!text) return box.focus();
    const i = detail.issue;
    const wake = el.querySelector(".m-reply [name=wake]")?.checked && i.assignee;
    act(() => api(`/api/issues/${i.id}/comment`, { text, ...(wake ? { agentId: i.assignee, agentName: agentOf(i.assignee)?.name ?? "智能体" } : {}) }), wake ? "评论已发送，智能体已启动。" : "评论已发送。");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.hidden && !e.target.closest?.("textarea, input")) close();
  });

  return { open, openRun, close };
}
