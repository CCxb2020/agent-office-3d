// Abas extras do painel do agente (com login): Conversa, Chats e Configurar.
// Cada render devolve uma função de limpeza (timers, etc.).

import { HAIRS, OUTFITS, SKINS, hex } from "./looks.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TZ = "America/Sao_Paulo";
const when = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const THINKING = [["", "运行时默认值"], ["off", "关闭"], ["minimal", "最低"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "很高"], ["max", "最高"]];

/** Markdown mínimo e seguro: escapa tudo e só então aplica negrito, código e quebras. */
function md(text) {
  return esc(text)
    .replace(/```([\s\S]*?)```/g, "<pre>$1</pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
}

// ---------- Conversa pelo painel ----------

export function renderConversation(tb, { agent, api, flash }) {
  let timer = null;
  let alive = true;
  tb.innerHTML = `<p class="muted small">在这里与 <b>${esc(agent.name)}</b> 对话。消息会作为任务评论保存在 Multica，并触发智能体回复。</p>
    <div class="chat-log"><p class="muted">正在加载…</p></div>
    <form class="chat-send">
      <textarea rows="3" required placeholder="输入给智能体的消息…（Ctrl+Enter 发送）"></textarea>
      <div class="row"><span class="muted small chat-state"></span><button type="submit" class="primary">发送</button></div>
    </form>`;
  const log = tb.querySelector(".chat-log");
  const state = tb.querySelector(".chat-state");
  const form = tb.querySelector("form");
  const ta = form.querySelector("textarea");

  async function load() {
    try {
      const c = await api(`/api/agents/${agent.id}/conversation`);
      if (!alive) return;
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
      log.innerHTML = c.messages.length
        ? c.messages.map((m) => `<div class="msg ${m.role}"><div class="who">${m.role === "agent" ? `${esc(agent.emoji)} ${esc(agent.name)}` : "你"} · ${when(m.at)}</div><div class="txt">${md(m.text)}</div></div>`).join("")
        : `<p class="muted">暂无消息。发送第一条消息即可开始对话。</p>`;
      state.textContent = c.issue ? `${c.issue.identifier}${c.working ? " · ✍️ 智能体正在工作…" : ""}` : "";
      if (atBottom || !log.dataset.seen) log.scrollTop = log.scrollHeight;
      log.dataset.seen = "1";
    } catch (e) {
      log.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await api(`/api/agents/${agent.id}/conversation`, { text: ta.value, agentName: agent.name });
      ta.value = "";
      flash("消息已发送，智能体已启动。");
      await load();
    } catch (err) {
      flash(err.message, false);
    } finally {
      btn.disabled = false;
    }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
  load();
  timer = setInterval(load, 8000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

// ---------- Chats do Multica (leitura) ----------

export function renderChats(tb, { agent, api }) {
  let alive = true;
  tb.innerHTML = `<p class="muted small">查看此智能体在 Multica 中的对话、回复和执行步骤。要发送消息，请打开「对话」。</p><div class="chat-sessions"><p class="muted">正在加载…</p></div>`;
  const box = tb.querySelector(".chat-sessions");
  api(`/api/agents/${agent.id}/chats`)
    .then(({ sessions }) => {
      if (!alive) return;
      box.innerHTML = sessions.length
        ? sessions
            .map(
              (s) => `<div class="run"><div class="run-top"><b>💬 Chat${s.by ? ` com ${esc(s.by)}` : ""}</b><small class="muted">${s.runs.length} 轮 · ${when(s.runs[0]?.at)}</small></div>
                ${s.runs.map((r) => `<div class="chat-turn"><button type="button" data-run="${r.id}">▼ ${when(r.at)} · ${esc(r.status)}</button><div class="turn-body" hidden></div></div>`).join("")}</div>`,
            )
            .join("")
        : `<p class="muted">暂无近期对话。</p>`;
    })
    .catch((e) => (box.innerHTML = `<p class="error">${esc(e.message)}</p>`));
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-run]");
    if (!b) return;
    const out = b.nextElementSibling;
    out.hidden = !out.hidden;
    if (out.hidden || out.dataset.loaded) return;
    out.innerHTML = `<p class="muted">正在加载…</p>`;
    try {
      const { messages } = await api(`/api/runs/${b.dataset.run}/messages`);
      out.dataset.loaded = "1";
      // Respostas em destaque; os passos de ferramenta entre elas ficam recolhidos.
      const parts = [];
      let tools = [];
      const flush = () => {
        if (tools.length) parts.push(`<details class="tools"><summary>🔧 ${tools.length} 个步骤</summary>${tools.join("")}</details>`);
        tools = [];
      };
      for (const m of messages) {
        if (m.type === "text") {
          flush();
          parts.push(`<div class="msg agent"><div class="txt">${md(m.text)}</div></div>`);
        } else if (m.type === "tool") tools.push(`<div class="step tool">🔧 <b>${esc(m.tool)}</b> <code>${esc(m.text)}</code></div>`);
      }
      flush();
      out.innerHTML = parts.length ? parts.join("") : `<p class="muted">暂无消息。</p>`;
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
  return () => (alive = false);
}

// ---------- Configurar ----------

export function renderConfig(tb, { agent, api, flash, onChanged }) {
  let alive = true;
  tb.innerHTML = `<p class="muted">正在加载配置…</p>`;
  api(`/api/agents/${agent.id}/details`)
    .then((d) => alive && draw(d))
    .catch((e) => (tb.innerHTML = `<p class="error">${esc(e.message)}</p>`));

  function draw({ agent: a, runtimes, workspaceSkills }) {
    const rtOpts = (sel) =>
      runtimes
        .sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name))
        .map((r) => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${r.online ? "🟢" : "⚫"} ${esc(r.name)}</option>`)
        .join("");
    const assigned = new Set(a.skills.map((s) => s.id));
    tb.innerHTML = `
      <form class="cfg">
        <div class="section-title">基本信息</div>
        <label>名称<input name="name" maxlength="120" value="${esc(a.name)}" required /></label>
        <label>描述<textarea name="description" rows="2" maxlength="2000">${esc(a.description)}</textarea></label>
        <label>指令 <small class="muted">(智能体的系统提示词)</small><textarea name="instructions" rows="12" class="mono">${esc(a.instructions)}</textarea></label>
        <div class="section-title">运行</div>
        <div class="grid2">
          <label>运行时 / 机器<select name="runtimeId">${rtOpts(a.runtimeId)}</select></label>
          <label>模型<input name="model" value="${esc(a.model)}" placeholder="运行时默认设置" /></label>
          <label>推理强度<select name="thinkingLevel">${THINKING.map(([v, l]) => `<option value="${v}" ${v === a.thinkingLevel ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>同时运行数<input name="maxConcurrent" type="number" min="1" max="50" value="${a.maxConcurrent ?? 1}" /></label>
          <label>谁可以启动<select name="permission">
            <option value="workspace" ${a.permissionMode !== "private" ? "selected" : ""}>工作区所有成员</option>
            <option value="private" ${a.permissionMode === "private" ? "selected" : ""}>仅所有者</option></select></label>
        </div>
        <button type="submit" class="primary wide">💾 保存更改</button>
      </form>
      <form class="cfg-skills">
        <div class="section-title">工作区技能 (${workspaceSkills.length})</div>
        ${workspaceSkills.length
          ? workspaceSkills.map((s) => `<label class="check"><input type="checkbox" value="${s.id}" ${assigned.has(s.id) ? "checked" : ""}/> <b>${esc(s.name)}</b><small class="muted">${esc(s.description)}</small></label>`).join("")
          : `<p class="muted">工作区暂无技能。</p>`}
        ${workspaceSkills.length ? `<button type="submit">保存技能</button>` : ""}
      </form>
      <div class="section-title">机密配置</div>
      <p class="muted small">环境变量： ${a.envKeys} · MCP: ${a.hasMcp ? "已配置" : "无"}. 请在 Multica 中编辑机密配置。</p>
      <div class="section-title">复制智能体</div>
      <form class="cfg-copy grid2">
        <label>副本名称<input name="name" value="${esc(a.name)} （副本）" maxlength="120" /></label>
        <label>选择运行时<select name="runtimeId">${rtOpts(a.runtimeId)}</select></label>
        <button type="submit">📄 创建副本</button>
      </form>
      <div class="section-title danger-title">危险操作</div>
      <button type="button" class="danger" data-act="archive">🗄️ 归档智能体</button>
      <p class="muted small">创建于 ${when(a.createdAt)} · 更新于 ${when(a.updatedAt)}</p>`;

    const form = tb.querySelector("form.cfg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const next = {
        name: f.name.value, description: f.description.value, instructions: f.instructions.value, model: f.model.value,
        thinkingLevel: f.thinkingLevel.value, maxConcurrent: Number(f.maxConcurrent.value), runtimeId: f.runtimeId.value, permission: f.permission.value,
      };
      const prev = {
        name: a.name, description: a.description, instructions: a.instructions, model: a.model, thinkingLevel: a.thinkingLevel,
        maxConcurrent: a.maxConcurrent, runtimeId: a.runtimeId, permission: a.permissionMode === "private" ? "private" : "workspace",
      };
      const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== prev[k]));
      if (!Object.keys(diff).length) return flash("没有更改。");
      if (diff.runtimeId && !confirm("更换运行时会改变智能体使用的机器。继续吗？")) return;
      try {
        await api(`/api/agents/${a.id}/update`, diff);
        Object.assign(a, diff, diff.permission ? { permissionMode: diff.permission === "private" ? "private" : "public_to" } : {});
        flash("智能体 atualizado.");
        onChanged();
      } catch (err) {
        flash(err.message, false);
      }
    });
    tb.querySelector("form.cfg-skills")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ids = [...e.target.querySelectorAll("input:checked")].map((i) => i.value);
      try {
        await api(`/api/agents/${a.id}/skills`, { skillIds: ids });
        flash("Skills atualizadas.");
      } catch (err) {
        flash(err.message, false);
      }
    });
    tb.querySelector("form.cfg-copy").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      if (!confirm(`创建「${a.name}」的副本？`)) return;
      try {
        const c = await api(`/api/agents/${a.id}/copy`, { name: f.name.value, runtimeId: f.runtimeId.value === a.runtimeId ? "" : f.runtimeId.value });
        flash(`已创建副本： ${c.name}`);
        onChanged();
      } catch (err) {
        flash(err.message, false);
      }
    });
    tb.querySelector('[data-act="archive"]').addEventListener("click", async () => {
      const typed = prompt(`归档会停用「${a.name}」。请输入智能体名称以确认。`);
      if (typed !== a.name) return typed !== null && flash("名称不匹配，归档已取消。", false);
      try {
        await api(`/api/agents/${a.id}/archive`, {});
        flash("智能体 arquivado.");
        onChanged({ archived: true });
      } catch (err) {
        flash(err.message, false);
      }
    });
  }
  return () => (alive = false);
}


// ---------- Visual (uniforme, pele, cabelo) ----------

const SWATCH = {
  liso: "linear-gradient(135deg,#8d9bb5,#c4cee0)", hotel: "#1b5fd1", social: "linear-gradient(90deg,#f4f6fb 45%,#1e3a8a 45% 55%,#f4f6fb 55%)",
  terno: "linear-gradient(90deg,#1f2430 40%,#f4f6fb 40% 60%,#1f2430 60%)", recepcao: "linear-gradient(#0b3d5c 30%,#f6b94a 30% 36%,#0b3d5c 36%)",
  chef: "#fafafa", esporte: "#6b7280", verao: "radial-gradient(circle at 30% 30%,#ef4444 12%,transparent 13%),radial-gradient(circle at 70% 60%,#22c55e 12%,transparent 13%),#fbbf24",
  flamengo: "repeating-linear-gradient(#c8102e 0 8px,#111 8px 16px)",
};

export function renderLook(tb, { agent, api, flash, onChanged }) {
  const cur = agent.look ?? {};
  let sel = { outfit: cur.outfit ?? "liso", skin: cur.skin, hair: cur.hair };
  const draw = () => {
    tb.innerHTML = `
      <div class="section-title">服装</div>
      <div class="looks">${Object.entries(OUTFITS)
        .map(([k, o]) => `<button type="button" class="look ${sel.outfit === k ? "on" : ""}" data-outfit="${k}" title="${esc(o.label)}"><i style="background:${SWATCH[k]}"></i><span>${esc(o.label)}</span></button>`)
        .join("")}</div>
      <div class="section-title">肤色</div>
      <div class="dots">${SKINS.map((c) => `<button type="button" class="dotpick ${sel.skin === c ? "on" : ""}" data-skin="${c}" style="background:${hex(c)}" aria-label="肤色"></button>`).join("")}<button type="button" class="dotpick auto ${sel.skin == null ? "on" : ""}" data-skin="" title="自动">A</button></div>
      <div class="section-title">发色</div>
      <div class="dots">${HAIRS.map((c) => `<button type="button" class="dotpick ${sel.hair === c ? "on" : ""}" data-hair="${c}" style="background:${hex(c)}" aria-label="发色"></button>`).join("")}<button type="button" class="dotpick auto ${sel.hair == null ? "on" : ""}" data-hair="" title="自动">A</button></div>
      <div class="row" style="margin-top:12px"><button type="button" data-reset>↺ 恢复默认</button><button type="button" class="primary" data-save>💾 保存外观</button></div>
      <p class="muted small">外观对所有访问者生效，几秒后在办公室更新。</p>`;
  };
  tb.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.outfit) sel.outfit = b.dataset.outfit;
    else if ("skin" in b.dataset) sel.skin = b.dataset.skin ? Number(b.dataset.skin) : undefined;
    else if ("hair" in b.dataset) sel.hair = b.dataset.hair ? Number(b.dataset.hair) : undefined;
    else if ("save" in b.dataset || "reset" in b.dataset) {
      try {
        await api(`/api/agents/${agent.id}/look`, "reset" in b.dataset ? { reset: true } : sel);
        flash("reset" in b.dataset ? "已恢复默认外观。" : "外观已保存。");
        onChanged();
      } catch (err) {
        flash(err.message, false);
      }
      return;
    } else return;
    draw();
  });
  draw();
  return () => {};
}
