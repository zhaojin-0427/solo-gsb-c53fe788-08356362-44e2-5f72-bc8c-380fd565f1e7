/* 多标注语料冲突裁决台 —— 原生 JS 前端 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data.detail === "string"
      ? data.detail
      : JSON.stringify(data.detail || data);
    throw new Error(msg);
  }
  return data;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  projectId: null,
  docId: null,
  revision: null,        // 当前查看的修订（可为历史版）
  latestRevision: null,  // 该文档最新修订号
  docList: [],
  content: "",
  tokenBounds: [],
  labels: [],
  nesting: [],
  mutex: [],
  annotators: [],
  annotations: [],
  consensus: null,
};

const readOnly = () =>
  state.docId != null && state.latestRevision != null &&
  state.revision !== state.latestRevision;

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

function labelById(id) {
  return state.labels.find((l) => l.id === id) || { name: `#${id}`, color: "#94a3b8" };
}
function annotatorById(id) {
  return state.annotators.find((a) => a.id === id) || { name: `#${id}`, weight: "?" };
}

// 在文本上叠加多层（可嵌套）标注高亮，按长度从外到内用栈渲染
function renderHighlighted(hostEl, text, spans) {
  if (!text) {
    hostEl.innerHTML = "<em class='hint'>（未选择文档）</em>";
    return;
  }
  const events = [];
  spans.forEach((sp, i) => {
    if (sp.start < 0 || sp.end > text.length || sp.start >= sp.end) return;
    events.push([sp.start, 0, i]);   // 起点优先
    events.push([sp.end, 1, i]);     // 终点先于同位置起点闭合
  });
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let html = "";
  let pos = 0;
  const open = new Set();
  for (const [at, kind, idx] of events) {
    if (at > pos) html += esc(text.slice(pos, at));
    const sp = spans[idx];
    if (kind === 0) {
      html += `<span class="mark${sp.rejected ? " rejected" : ""}" ` +
        `style="background:${sp.color}33;box-shadow:inset 0 -2px 0 ${sp.color}">` +
        `<span class="mark-label" style="color:${sp.color}">${esc(sp.label)}</span>`;
      open.add(idx);
    } else if (open.has(idx)) {
      html += "</span>";
      open.delete(idx);
    }
    pos = at;
  }
  html += esc(text.slice(pos));
  hostEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------
async function loadProjects(preferId) {
  const projects = await api("/api/projects");
  const sel = $("#projectSelect");
  sel.innerHTML = projects.map((p) =>
    `<option value="${p.id}"${p.id === preferId ? " selected" : ""}>${esc(p.name)}</option>`
  ).join("");
  if (!state.projectId || preferId) state.projectId = preferId || projects[0]?.id || null;
  sel.value = state.projectId || "";
  if (state.projectId) await refreshAll();
}

$("#projectSelect").addEventListener("change", async (e) => {
  state.projectId = Number(e.target.value) || null;
  await refreshAll();
});

$("#newProjectBtn").addEventListener("click", async () => {
  const name = prompt("新项目名称");
  if (!name) return;
  try {
    const p = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await loadProjects(p.id);
    toast(`项目「${name}」已创建`);
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------------------
// 1. 文档
// ---------------------------------------------------------------------------
$("#importDocBtn").addEventListener("click", async () => {
  const doc_id = $("#docId").value.trim();
  const content = $("#docContent").value;
  if (!doc_id || !content) return toast("请填写文档 ID 和内容", true);
  let token_bounds = null;
  const raw = $("#tokenBounds").value.trim();
  if (raw) {
    try {
      token_bounds = JSON.parse(raw);
      if (!Array.isArray(token_bounds)) throw new Error();
    } catch {
      return toast("词元边界必须是 [[start,end],…] 形式的 JSON", true);
    }
  }
  try {
    const r = await api(`/api/projects/${state.projectId}/documents`, {
      method: "POST",
      body: JSON.stringify({ doc_id, content, token_bounds }),
    });
    toast(r.notice || `文档已导入（revision ${r.revision}）`);
    await refreshDocuments(doc_id);
    await updateRevisionOptions(r.revision);
  } catch (e) { toast(e.message, true); }
});

async function refreshDocuments(selectDocId) {
  const docs = await api(`/api/projects/${state.projectId}/documents`);
  state.docList = docs;
  const sel = $("#docSelect");
  sel.innerHTML = docs.map((d) =>
    `<option value="${esc(d.doc_id)}">${esc(d.doc_id)} · 最新 v${d.revision} (${d.char_count}字)</option>`
  ).join("");
  if (selectDocId && docs.some((d) => d.doc_id === selectDocId)) {
    state.docId = selectDocId;
  } else if (!state.docId || !docs.some((d) => d.docId === state.docId)) {
    state.docId = sel.value || null;
  }
  sel.value = state.docId || "";
  await updateRevisionOptions();
  if (!state.docId) {
    state.content = "";
    state.tokenBounds = [];
    state.annotations = [];
    renderAnnotations();
  }
}

// 根据所选文档刷新「修订版本」下拉；preferRev 缺省时选最新版
async function updateRevisionOptions(preferRev) {
  const sel = $("#revSelect");
  const doc = state.docList.find((d) => d.doc_id === state.docId);
  if (!doc) {
    sel.innerHTML = "";
    state.revision = null;
    state.latestRevision = null;
    await loadDocumentView();
    return;
  }
  sel.innerHTML = doc.revisions.map((r) =>
    `<option value="${r.revision}">revision ${r.revision}` +
    (r.revision === doc.revision ? "（最新）" : "（历史只读）") +
    ` · ${r.char_count}字</option>`
  ).join("");
  const wanted = preferRev != null && doc.revisions.some((r) => r.revision === preferRev)
    ? preferRev
    : doc.revision;
  sel.value = String(wanted);
  state.revision = wanted;
  state.latestRevision = doc.revision;
  await loadDocumentView();
}

$("#docSelect").addEventListener("change", async (e) => {
  state.docId = e.target.value || null;
  await updateRevisionOptions();
});

$("#revSelect").addEventListener("change", async () => {
  const rev = Number($("#revSelect").value);
  if (!rev) return;
  state.revision = rev;
  await loadDocumentView();
});

$("#backToLatestBtn").addEventListener("click", async () => {
  await updateRevisionOptions(state.latestRevision);
  toast("已切回最新版，可继续提交标注与求共识");
});

async function loadDocumentView() {
  if (!state.docId || !state.revision) {
    state.content = "";
    state.tokenBounds = [];
    state.annotations = [];
    renderAnnotations();
    applyReadOnlyUi();
    return;
  }
  const d = await api(
    `/api/projects/${state.projectId}/documents/${encodeURIComponent(state.docId)}` +
    `?revision=${state.revision}`
  );
  state.revision = d.revision;
  state.latestRevision = d.latest_revision;
  state.content = d.content;
  state.tokenBounds = d.token_bounds;
  $("#docMeta").textContent =
    `当前版本 revision=${d.revision}（最新 revision=${d.latest_revision}），` +
    `${d.char_count} 个字符，${d.token_bounds.length} 个词元` +
    (readOnly() ? " —— 历史版本只读" : "");
  $("#docPreview").textContent =
    d.content.length > 600 ? d.content.slice(0, 600) + " …" : d.content;
  renderSelectableText();
  await refreshAnnotations();
  state.consensus = null;
  renderConsensus();
  applyReadOnlyUi();
  await refreshConsensusHistory();
}

// 历史版本：禁用会把（旧）坐标写入或作用到最新版的入口；
// 标签/标注者是项目级实体，覆盖/报告基于所选共识快照，均不触碰最新版。
function applyReadOnlyUi() {
  const ro = readOnly();
  $("#readonlyBanner").classList.toggle("hidden", !ro);
  if (ro) $("#readonlyRev").textContent = `${state.docId} v${state.revision}`;
  for (const id of ["addAnnBtn", "useSelectionBtn", "solveBtn"]) {
    $(`#${id}`).disabled = ro;
  }
  const solveHint = $("#solveHint");
  if (solveHint) solveHint.classList.toggle("hidden", !ro);
}

function renderSelectableText() {
  $("#selectableText").textContent = state.content || "（请先导入文档）";
}

// 文本拖选 → 填充区间
$("#useSelectionBtn").addEventListener("click", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const host = $("#selectableText");
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
    return toast("请先在文档区域内拖选文字", true);
  }
  const pre = host;
  const rangeStart = range.cloneRange();
  rangeStart.selectNodeContents(pre);
  rangeStart.setEnd(range.startContainer, range.startOffset);
  const start = rangeStart.toString().length;
  const end = start + range.toString().length;
  $("#annStart").value = start;
  $("#annEnd").value = end;
  $("#selInfo").textContent =
    `选区 [${start},${end})：${state.content.slice(start, end).slice(0, 30)}`;
});

// ---------------------------------------------------------------------------
// 2. 标签与规则
// ---------------------------------------------------------------------------
$("#addLabelBtn").addEventListener("click", async () => {
  const name = $("#labelName").value.trim();
  if (!name) return;
  try {
    await api(`/api/projects/${state.projectId}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, color: $("#labelColor").value }),
    });
    $("#labelName").value = "";
    await refreshLabels();
  } catch (e) { toast(e.message, true); }
});

async function refreshLabels() {
  const data = await api(`/api/projects/${state.projectId}/labels`);
  state.labels = data.labels;
  state.nesting = data.nesting;
  state.mutex = data.mutex;

  $("#labelList").innerHTML = data.labels.map((l) =>
    `<span class="chip" style="background:${l.color}">${esc(l.name)} (id=${l.id})</span>`
  ).join("") || "<span class='hint'>尚无标签</span>";

  const opts = data.labels.map((l) =>
    `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  $("#ruleA").innerHTML = opts;
  $("#ruleB").innerHTML = opts;
  $("#annLabel").innerHTML = opts;
  $("#ovLabel").innerHTML = opts;

  $("#ruleList").innerHTML =
    data.nesting.map((n) => {
      const o = labelById(n.outer_label_id), i = labelById(n.inner_label_id);
      return `<li>嵌套：<span><span class="tag-dot" style="background:${o.color}"></span>${esc(o.name)}</span>
        ⊃ <span><span class="tag-dot" style="background:${i.color}"></span>${esc(i.name)}</span>
        <button data-kind="nesting" data-a="${n.outer_label_id}" data-b="${n.inner_label_id}">删除</button></li>`;
    }).join("") +
    data.mutex.map((m) => {
      const a = labelById(m.label_a_id), b = labelById(m.label_b_id);
      return `<li>互斥：<span><span class="tag-dot" style="background:${a.color}"></span>${esc(a.name)}</span>
        ✕ <span><span class="tag-dot" style="background:${b.color}"></span>${esc(b.name)}</span>
        <button data-kind="mutex" data-a="${m.label_a_id}" data-b="${m.label_b_id}">删除</button></li>`;
    }).join("");
  $("#ruleList").querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const { kind, a, b } = btn.dataset;
      await api(`/api/projects/${state.projectId}/label-rules?kind=${kind}&a=${a}&b=${b}`,
        { method: "DELETE" });
      await refreshLabels();
    }));
}

$("#ruleKind").addEventListener("change", (e) => {
  $("#ruleArrow").textContent = e.target.value === "nesting" ? "⊃" : "✕";
});

$("#addRuleBtn").addEventListener("click", async () => {
  const kind = $("#ruleKind").value;
  const label_a_id = Number($("#ruleA").value);
  const label_b_id = Number($("#ruleB").value);
  try {
    await api(`/api/projects/${state.projectId}/label-rules`, {
      method: "POST",
      body: JSON.stringify({ kind, label_a_id, label_b_id }),
    });
    await refreshLabels();
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------------------
// 3. 标注者
// ---------------------------------------------------------------------------
$("#addAnnotatorBtn").addEventListener("click", async () => {
  const name = $("#annotatorName").value.trim();
  const weight = Number($("#annotatorWeight").value);
  if (!name) return;
  try {
    await api(`/api/projects/${state.projectId}/annotators`, {
      method: "POST",
      body: JSON.stringify({ name, weight }),
    });
    $("#annotatorName").value = "";
    await refreshAnnotators();
  } catch (e) { toast(e.message, true); }
});

async function refreshAnnotators() {
  state.annotators = await api(`/api/projects/${state.projectId}/annotators`);
  const tbody = $("#annotatorTable").querySelector("tbody");
  tbody.innerHTML = state.annotators.map((a) => `
    <tr>
      <td>${a.id}</td><td>${esc(a.name)}</td>
      <td><input type="number" min="1" max="10" value="${a.weight}" data-id="${a.id}"
          class="weight-input" style="width:70px"></td>
      <td><button class="del" data-id="${a.id}">删除</button></td>
    </tr>`).join("");
  tbody.querySelectorAll(".weight-input").forEach((inp) =>
    inp.addEventListener("change", async () => {
      try {
        await api(`/api/projects/${state.projectId}/annotators/${inp.dataset.id}?weight=${Number(inp.value)}`,
          { method: "PATCH" });
        toast("权重已更新（仅影响此后的求解，旧报告不变）");
        await refreshAnnotators();
      } catch (e) { toast(e.message, true); }
    }));
  tbody.querySelectorAll(".del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("删除标注者及其全部标注？")) return;
      await api(`/api/projects/${state.projectId}/annotators/${btn.dataset.id}`,
        { method: "DELETE" });
      await Promise.all([refreshAnnotators(), refreshAnnotations()]);
    }));
  $("#annAnnotator").innerHTML = state.annotators.map((a) =>
    `<option value="${a.id}">${esc(a.name)}（权重 ${a.weight}）</option>`).join("");
}

// ---------------------------------------------------------------------------
// 4. 标注
// ---------------------------------------------------------------------------
$("#addAnnBtn").addEventListener("click", async () => {
  if (readOnly()) return toast("历史版本只读：请切回最新版后再提交标注", true);
  const body = {
    annotator_id: Number($("#annAnnotator").value),
    label_id: Number($("#annLabel").value),
    start: Number($("#annStart").value),
    end: Number($("#annEnd").value),
  };
  try {
    await api(
      `/api/projects/${state.projectId}/documents/${encodeURIComponent(state.docId)}/annotations`,
      { method: "POST", body: JSON.stringify(body) });
    $("#annStart").value = $("#annEnd").value = "";
    $("#selInfo").textContent = "";
    await refreshAnnotations();
  } catch (e) { toast(e.message, true); }
});

async function refreshAnnotations() {
  if (!state.docId) {
    state.annotations = [];
    renderAnnotations();
    return;
  }
  const data = await api(
    `/api/projects/${state.projectId}/documents/${encodeURIComponent(state.docId)}` +
    `/annotations?revision=${state.revision}`
  );
  state.annotations = data.annotations;
  renderAnnotations();
}

function renderAnnotations() {
  const ro = readOnly();
  const tbody = $("#annotationTable").querySelector("tbody");
  tbody.innerHTML = state.annotations.map((a) => `
    <tr>
      <td>${a.id}</td>
      <td>${esc(a.annotator_name)}（w=${a.weight}）</td>
      <td><span class="tag-dot" style="background:${a.color}"></span>${esc(a.label_name)}</td>
      <td>[${a.start},${a.end})</td>
      <td>${esc((state.content || "").slice(a.start, a.end))}</td>
      <td>${ro ? '<span class="hint">历史只读</span>'
        : `<button class="del" data-id="${a.id}">删除</button>`}</td>
    </tr>`).join("");
  tbody.querySelectorAll(".del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/projects/${state.projectId}/annotations/${btn.dataset.id}`,
        { method: "DELETE" });
      await refreshAnnotations();
    }));

  // 当前修订的文本 + 绑定当前修订的标注（历史坐标不与新版文字串版）
  renderHighlighted($("#selectableText"), state.content, state.annotations.map((a) => ({
    start: a.start, end: a.end, label: a.label_name, color: a.color,
  })));
}

// ---------------------------------------------------------------------------
// 5. 共识 / 覆盖 / 报告
// ---------------------------------------------------------------------------
$("#solveBtn").addEventListener("click", async () => {
  if (readOnly()) {
    return toast("历史版本只读：请先切回最新版再求共识", true);
  }
  try {
    const c = await api(
      `/api/projects/${state.projectId}/documents/${encodeURIComponent(state.docId)}/consensus`,
      { method: "POST", body: "{}" });
    state.consensus = c;
    renderConsensus();
    await refreshConsensusHistory(c.id);
    toast(`求解完成：${c.solver_status === "OPTIMAL" ? "已证明最优" : "仅可行、未证明最优"}（${c.solver_status}），总分 ${c.raw_total_score}`);
  } catch (e) { toast(e.message, true); }
});

async function refreshConsensusHistory(pickId) {
  const sel = $("#consensusHistory");
  if (!state.docId) { sel.innerHTML = ""; return; }
  const list = await api(
    `/api/projects/${state.projectId}/documents/${encodeURIComponent(state.docId)}/consensuses`);
  sel.innerHTML =
    `<option value="">— 选择历史共识（只读，按各自快照渲染）—</option>` +
    list.map((c) =>
      `<option value="${c.id}">#${c.id} · v${c.revision} · ${c.solver_status} · 总分${c.raw_total_score} · ${c.created_at}</option>`
    ).join("");
  sel.value = pickId && list.some((c) => c.id === pickId) ? String(pickId) : "";
}

$("#consensusHistory").addEventListener("change", async (e) => {
  const id = Number(e.target.value);
  if (!id) {
    state.consensus = null;
    renderConsensus();
    return;
  }
  try {
    const c = await api(`/api/projects/${state.projectId}/consensuses/${id}`);
    // 共识坐标属于其输入快照：当前修订与快照不同时，先切换到快照修订再渲染，
    // 整个过程只读，绝不重新求解最新版。
    if (state.revision !== c.revision) {
      await updateRevisionOptions(c.revision); // 内部会重载并把下拉重置为占位项
    }
    state.consensus = c;
    await refreshConsensusHistory(c.id);
    renderConsensus();
    toast(`已按 #${c.id} 的输入快照（revision ${c.revision}）渲染，未触发任何重新求解`);
  } catch (err) { toast(err.message, true); }
});

function supporterLine(s) {
  return `<span class="supporter">· <b>${esc(s.annotator_name)}</b>（权重${s.weight}）` +
    ` 提交[${s.start},${s.end}) 重叠比${(s.overlap_ratio * 100).toFixed(0)}%` +
    ` 贡献${s.contribution}</span>`;
}

function renderConsensus() {
  const c = state.consensus;
  $("#openReportLink").classList.add("hidden");
  if (!c) {
    $("#solveParams").classList.add("hidden");
    return;
  }
  // 文字与高亮一律取自该共识保存时的输入快照，绝不按当前文本解释旧坐标
  const snap = c.snapshot || {};
  const cText = snap.content || "";
  const cColor = (id) =>
    ((snap.labels || []).find((l) => l.id === id) || {}).color || "#94a3b8";
  const cLabelName = (id) =>
    ((snap.labels || []).find((l) => l.id === id) || {}).name || `#${id}`;
  const snapshotMismatch = state.revision !== c.revision;

  $("#solveMeta").textContent =
    `共识 #${c.id} · 快照 revision=${c.revision}` +
    (snapshotMismatch ? "（与当前修订不同，已单独按快照渲染）" : "") +
    ` · 算法 ${c.algorithm_name} v${c.algorithm_version} · ` +
    `${c.solver_status} · 总分 ${c.raw_total_score} · ${c.created_at}` +
    (c.solver_status === "OPTIMAL"
      ? ""
      : `　⚠️ 仅为已验证可行解（${c.solver_status}），求解器未证明其总分最高，不应当作最优结果`);
  $("#solveParams").classList.remove("hidden");
  $("#solveParamsJson").textContent = JSON.stringify({
    algorithm: `${c.algorithm_name} v${c.algorithm_version}`,
    ...c.params,
  }, null, 2);

  const adopted = c.items.filter((i) => i.adopted);
  const rejected = c.items.filter((i) => !i.adopted);

  renderHighlighted($("#adoptedText"), cText, adopted.map((i) => ({
    start: i.start, end: i.end, label: i.label_name,
    color: cColor(i.label_id),
  })));

  $("#adoptedTable").querySelector("tbody").innerHTML = adopted.map((i) => `
    <tr>
      <td>[${i.start},${i.end})<br><span class="hint">${esc(cText.slice(i.start, i.end))}</span></td>
      <td><span class="tag-dot" style="background:${cColor(i.label_id)}"></span>${esc(i.label_name)}</td>
      <td>${i.raw_score}</td>
      <td>${i.supporters.map(supporterLine).join("")}</td>
      <td>${i.forced ? '<span class="badge forced">裁决覆盖</span>' : '<span class="badge">算法</span>'}</td>
    </tr>`).join("") ||
    '<tr><td colspan="5" class="hint">（空共识）</td></tr>';

  $("#rejectedTable").querySelector("tbody").innerHTML = rejected.map((i) => `
    <tr>
      <td>[${i.start},${i.end})<br><span class="hint">${esc(cText.slice(i.start, i.end))}</span></td>
      <td><span class="tag-dot" style="background:${cColor(i.label_id)}"></span>${esc(i.label_name)}</td>
      <td>${i.raw_score}</td>
      <td>${i.supporters.map(supporterLine).join("")}</td>
      <td>
        <button class="btn small" data-act="select" data-s="${i.start}" data-e="${i.end}" data-l="${i.label_id}">
          强制采纳
        </button>
      </td>
    </tr>`).join("") ||
    '<tr><td colspan="5" class="hint">全部候选均被采纳 🎉</td></tr>';

  $("#rejectedTable").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      $("#ovAction").value = b.dataset.act;
      $("#ovStart").value = b.dataset.s;
      $("#ovEnd").value = b.dataset.e;
      $("#ovLabel").value = b.dataset.l;
      $("#ovReason").focus();
      window.scrollTo({ top: $("#overrideBtn").offsetTop - 80, behavior: "smooth" });
    }));

  // 覆盖表单的标签下拉使用快照内标签，保证覆盖校验的是快照坐标
  $("#ovLabel").innerHTML = (snap.labels || []).map((l) =>
    `<option value="${l.id}">${esc(l.name)}</option>`).join("");

  $("#overrideList").innerHTML = c.overrides.map((o) => {
    const color = cColor(o.label_id);
    return `<li>${o.action === "select" ? "✅强制采纳" : "⛔强制否决"}
      [${o.start},${o.end}) <span class="tag-dot" style="background:${color}"></span>${esc(cLabelName(o.label_id))}
      —— ${esc(o.reason)}</li>`;
  }).join("");
}

$("#overrideBtn").addEventListener("click", async () => {
  const reason = $("#ovReason").value.trim();
  if (!reason) return toast("裁决理由为必填项", true);
  const body = {
    action: $("#ovAction").value,
    start: Number($("#ovStart").value),
    end: Number($("#ovEnd").value),
    label_id: Number($("#ovLabel").value),
    reason,
  };
  try {
    const c = await api(
      `/api/projects/${state.projectId}/consensuses/${state.consensus.id}/override`,
      { method: "POST", body: JSON.stringify(body) });
    state.consensus = c;
    renderConsensus();
    await refreshConsensusHistory(c.id);
    $("#ovReason").value = "";
    toast("覆盖已应用：基于同一输入快照生成了新共识版本（旧版本保留）");
  } catch (e) { toast(e.message, true); }
});

$("#reportBtn").addEventListener("click", async () => {
  if (!state.consensus) return toast("请先求共识", true);
  try {
    const r = await api(
      `/api/projects/${state.projectId}/consensuses/${state.consensus.id}/report`,
      { method: "POST", body: "{}" });
    $("#openReportLink").classList.remove("hidden");
    $("#openReportLink").href =
      `/static/report.html?project=${state.projectId}&version=${encodeURIComponent(r.report_version)}`;
    toast(`不可变报告已生成：${r.report_version}`);
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------------------
// 内置示例（一键载入：含嵌套、互斥、交叉冲突）
// ---------------------------------------------------------------------------
$("#loadDemoBtn").addEventListener("click", async () => {
  try {
    let p = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "示例-裁决演练-" + Date.now().toString(36) }),
    }).catch(() => null);
    if (!p) {
      const projects = await api("/api/projects");
      p = projects[0];
    }
    state.projectId = p.id;
    $("#projectSelect").value = p.id;

    const content =
      "张伟说李娜在2024年在北京的会议上发布了新模型，该模型由华科团队训练。";
    // 词元：按词给出边界（演示不切开词元）
    const words = ["张伟", "说", "李娜", "在", "2024年", "在", "北京", "的",
      "会议", "上", "发布", "了", "新", "模型", "，", "该", "模型", "由",
      "华科", "团队", "训练", "。"];
    const token_bounds = [];
    let at = 0;
    for (const w of words) {
      token_bounds.push([at, at + w.length]);
      at += w.length;
    }

    await api(`/api/projects/${p.id}/documents`, {
      method: "POST",
      body: JSON.stringify({ doc_id: "demo-doc", content, token_bounds }),
    });

    const mk = async (name, color) =>
      (await api(`/api/projects/${p.id}/labels`,
        { method: "POST", body: JSON.stringify({ name, color }) })).id;
    const person = await mk("PERSON", "#2563eb");
    const org = await mk("ORG", "#db2777");
    const time = await mk("TIME", "#0891b2");
    const event = await mk("EVENT", "#16a34a");

    // EVENT 可嵌套 PERSON / TIME（长区间套小区间）；PERSON 与 ORG 互斥
    for (const [a, b] of [[event, person], [event, time]]) {
      await api(`/api/projects/${p.id}/label-rules`, {
        method: "POST",
        body: JSON.stringify({ kind: "nesting", label_a_id: a, label_b_id: b }),
      });
    }
    await api(`/api/projects/${p.id}/label-rules`, {
      method: "POST",
      body: JSON.stringify({ kind: "mutex", label_a_id: person, label_b_id: org }),
    });

    const mkA = async (name, w) =>
      (await api(`/api/projects/${p.id}/annotators`,
        { method: "POST", body: JSON.stringify({ name, weight: w }) })).id;
    const a1 = await mkA("标注者甲", 8);
    const a2 = await mkA("标注者乙", 5);
    const a3 = await mkA("标注者丙", 3);

    // 计算便捷偏移
    const off = {};
    let o = 0;
    for (const w of words) { off[w] === undefined && (off[w] = o); o += w.length; }
    const rng = (s, len) => [off[s], off[s] + len];

    const ann = (annotator_id, label_id, word, len) => {
      const [s, e] = rng(word, len ?? word.length);
      return { annotator_id, label_id, start: s, end: e };
    };
    const batch = [
      ann(a1, person, "张伟"),
      ann(a2, person, "张伟"),
      ann(a3, org, "张伟"),                 // 与前两人冲突：PERSON/ORG 互斥
      ann(a1, person, "李娜"),
      ann(a2, person, "李娜"),
      ann(a1, time, "2024年"),
      ann(a3, person, "北京"),              // 北京被甲/乙标 ORG，丙标 PERSON（互斥）
      ann(a1, org, "北京"),
      ann(a2, org, "北京"),
      ann(a1, org, "华科"),
      ann(a2, org, "华科"),
      ann(a3, org, "华科团队", 4),          // 与华科[18,20) 交叉（无嵌套规则）
    ];
    // 两条 EVENT：合法长区间，内部严格包含 PERSON 与 TIME（演示嵌套共存）
    const span = (w, len) => [off[w], off[w] + (len ?? w.length)];
    let s, e;
    [s, e] = span("张伟");
    const evEnd = span("2024年")[1];           // 截止「2024年」，内部含 李娜/2024年
    batch.push({ annotator_id: a1, label_id: event, start: s, end: evEnd });
    [s, e] = span("李娜");
    batch.push({ annotator_id: a2, label_id: event, start: s, end: evEnd });

    await api(`/api/projects/${p.id}/documents/demo-doc/annotations/batch`, {
      method: "POST",
      body: JSON.stringify({ annotations: batch }),
    });

    await loadProjects(p.id);
    // loadProjects 已按最新版载入 demo-doc 视图
    toast("示例已载入：可直接点击「求最大得分共识」查看冲突裁决");
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function refreshAll() {
  if (!state.projectId) {
    toast("请先点击「新建项目」或「载入示例」");
    return;
  }
  await Promise.all([
    refreshDocuments(),   // 内部 updateRevisionOptions → loadDocumentView 已刷新共识历史
    refreshLabels(),
    refreshAnnotators(),
  ]);
  state.consensus = null;
  renderConsensus();
}

(async function init() {
  try {
    await loadProjects();
    if (!state.projectId) toast("欢迎：请「新建项目」或点击「载入示例」");
  } catch (e) { toast(e.message, true); }
})();
