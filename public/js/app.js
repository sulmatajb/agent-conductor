// The page: draws the run the orchestrator reports, and picks a driver for this view.

import { P, STATE_LABEL, createRun, orchestrate, columns, toRecording } from "./orchestrator.js";
import { replayDriver, serverDriver, artifactDriver } from "./drivers.js";
import { DEFAULT_RECORDING, PRESETS } from "./recording.js";
import { md, esc } from "./markdown.js";

const $ = (s, r = document) => r.querySelector(s);
const params = new URLSearchParams(location.search);
const SPEED = Math.min(4, Math.max(0.05, Number(params.get("speed")) || 1));
const MANUAL_GATE = params.get("gate") === "manual";

let run = null, ctl = null, recording = DEFAULT_RECORDING;
let selected = null, follow = true, gateResolve = null;
let live = null; // { driver, label, kind: "server" | "artifact" }

/* ---------- graph ---------- */
const graph = $("#graph"), inner = $("#graphInner"), svg = $("#edges");
const nodeEls = {};

function layout() {
  const cols = columns(run);
  const W = graph.clientWidth || 800;
  const vertical = W < 700;
  const pos = {};
  let IW, IH;
  if (!vertical) {
    const C = cols.length, gap = C > 6 ? 16 : 24, pad = 12;
    const nodeW = Math.max(92, Math.min(168, (W - pad * 2 - gap * (C - 1)) / C));
    const nodeH = 64, gapY = 14;
    const R = Math.max(...cols.map(c => c.length));
    IW = Math.max(W, pad * 2 + C * nodeW + (C - 1) * gap);
    IH = Math.max(230, pad * 2 + R * nodeH + (R - 1) * gapY);
    const step = C > 1 ? (IW - pad * 2 - nodeW) / (C - 1) : 0;
    cols.forEach((col, ci) => {
      const total = col.length * nodeH + (col.length - 1) * gapY, y0 = (IH - total) / 2;
      col.forEach((id, ri) => { pos[id] = { x: pad + ci * step, y: y0 + ri * (nodeH + gapY), w: nodeW, h: nodeH }; });
    });
  } else {
    const pad = 10, gapX = 8, gapY = 28, nodeH = 70;
    const maxN = Math.max(...cols.map(c => c.length));
    const nodeW = Math.max(92, Math.min(190, (W - pad * 2 - gapX * (maxN - 1)) / maxN));
    IW = Math.max(W, pad * 2 + maxN * nodeW + (maxN - 1) * gapX);
    IH = pad * 2 + cols.length * nodeH + (cols.length - 1) * gapY;
    cols.forEach((col, ci) => {
      const total = col.length * nodeW + (col.length - 1) * gapX, x0 = (IW - total) / 2;
      col.forEach((id, ri) => { pos[id] = { x: x0 + ri * (nodeW + gapX), y: pad + ci * (nodeH + gapY), w: nodeW, h: nodeH }; });
    });
  }
  return { pos, IW, IH, vertical };
}

function renderGraph() {
  if (!run) return;
  const { pos, IW, IH, vertical } = layout();
  inner.style.width = IW + "px"; inner.style.height = IH + "px";
  svg.setAttribute("viewBox", `0 0 ${IW} ${IH}`); svg.setAttribute("width", IW); svg.setAttribute("height", IH);
  const ids = new Set(Object.keys(pos));
  for (const id of Object.keys(nodeEls)) if (!ids.has(id)) { nodeEls[id].remove(); delete nodeEls[id]; }
  for (const id of ids) {
    let el = nodeEls[id];
    if (!el) {
      el = document.createElement("button"); el.type = "button"; el.className = "node";
      el.innerHTML = `<span class="n-role"></span><span class="n-meta"></span>`;
      el.addEventListener("click", () => { if (run.nodes[id]?.kind !== "ghost") { follow = false; select(id); } });
      inner.appendChild(el); nodeEls[id] = el;
    }
    const p = pos[id];
    Object.assign(el.style, { left: p.x + "px", top: p.y + "px", width: p.w + "px", height: p.h + "px" });
    el.classList.toggle("compact", p.w < 132);
    paintNode(id);
  }
  svg.innerHTML = "";
  for (const e of run.edges) {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue;
    let d;
    if (!vertical) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, c = Math.max(18, (x2 - x1) / 2);
      d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
    } else {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, c = Math.max(12, (y2 - y1) / 2);
      d = `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d); path.setAttribute("class", "edge");
    svg.appendChild(path); e.el = path;
  }
  paintEdges();
}

function paintNode(id) {
  const n = run?.nodes[id], el = nodeEls[id]; if (!n || !el) return;
  el.dataset.state = n.status; el.dataset.kind = n.kind; el.dataset.sel = selected === id ? "1" : "0";
  el.setAttribute("aria-label", `${n.role}: ${STATE_LABEL[n.status] || n.status}`);
  el.firstChild.textContent = n.role;
  if (n.kind === "ghost") { el.lastChild.innerHTML = `<span>${run.running ? "planner is deciding" : ""}</span>`; return; }
  const tier = n.tier ? `<i class="tier t-${n.tier}">${n.tier}</i>` : "";
  const label = n.status === "done" && n.revised ? "revised" : (STATE_LABEL[n.status] || n.status);
  const score = n.score != null ? `<b class="n-score" title="Reviewer score">${n.score}</b>` : "";
  el.lastChild.innerHTML = `${tier}<span class="n-state s-${n.status}">${label}</span>${score}`;
}

function paintEdges() {
  if (!run) return;
  for (const e of run.edges) {
    if (!e.el) continue;
    const s = run.nodes[e.from]?.status, t = run.nodes[e.to]?.status;
    const active = ["thinking", "streaming", "waiting"].includes(t);
    e.el.setAttribute("class", "edge" + (active && s === "done" ? " live" : (s === "done" && ["done", "revise"].includes(t) ? " done" : "")));
  }
}

let roPending = false;
new ResizeObserver(() => {
  if (roPending) return; roPending = true;
  requestAnimationFrame(() => { roPending = false; renderGraph(); });
}).observe(graph);

/* ---------- inspector ---------- */
const insp = $("#insp");
let inspPending = false;
function scheduleInspector() {
  if (inspPending) return; inspPending = true;
  requestAnimationFrame(() => { inspPending = false; paintInspector(); });
}
function select(id) {
  const prev = selected; selected = id;
  if (prev && nodeEls[prev]) nodeEls[prev].dataset.sel = "0";
  if (nodeEls[id]) nodeEls[id].dataset.sel = "1";
  scheduleInspector();
}
function paintInspector() {
  if (!run || !selected || !run.nodes[selected]) { insp.innerHTML = `<p class="empty">Select an agent to read its work.</p>`; return; }
  const n = run.nodes[selected];
  const prevOut = insp.querySelector(".out");
  const keepScroll = prevOut && prevOut.scrollTop > 0 && prevOut.scrollTop + prevOut.clientHeight < prevOut.scrollHeight - 30 ? prevOut.scrollTop : null;
  let body;
  if (n.kind === "planner") {
    body = run.plan
      ? `<ol class="agents">${run.plan.agents.map(a => `<li><b>${esc(a.role)}</b><span>${esc(a.brief)}</span><small>${a.tier} tier · ${a.deps.length ? "after " + a.deps.map(d => esc(run.nodes[d]?.role || d)).join(", ") : "starts at once"}</small></li>`).join("")}</ol>`
      : n.text ? `<pre>${esc(n.text)}</pre>` : `<p class="empty">${n.status === "thinking" ? "Thinking about who the goal needs..." : "Waiting for a goal."}</p>`;
  } else if (n.kind === "critic") {
    body = n.reviews
      ? n.reviews.map(r => `<div class="review ${r.verdict}"><b>${esc(run.nodes[r.id]?.role || r.id)} · ${r.score}/10 · ${r.verdict === "revise" ? "sent back" : "pass"}</b><span>${esc(r.note)}</span></div>`).join("")
      : n.text ? `<pre>${esc(n.text)}</pre>` : `<p class="empty">${n.status === "thinking" ? "Reading every contribution..." : "Reviews arrive after the team finishes."}</p>`;
    body = `<div style="display:grid;gap:8px">${body}</div>`;
  } else if (n.kind === "gate") {
    body = `<p class="empty">${n.status === "waiting" ? "The reviewed work is waiting for approval. Use the buttons under the graph." : n.status === "done" ? (n.auto ? "Approved automatically in the replay." : "Approved by a person.") : n.status === "error" ? "Rejected. Nothing was synthesized." : "The run pauses here for a person before anything final is written."}</p>`;
  } else if (n.kind === "ghost") {
    body = `<p class="empty">The planner decides the team for each goal.</p>`;
  } else {
    const rev = n.score != null ? `<div class="review ${n.verdict}"><b>Reviewer · ${n.score}/10 · ${n.verdict === "revise" ? (n.revised ? "sent back, revised" : "sent back") : "pass"}</b><span>${esc(n.note || "")}</span></div>` : "";
    const empty = n.status === "thinking" ? "Thinking..." : n.status === "queued" ? "Queued behind running agents." : n.status === "error" ? esc(n.error || "This call failed.") : "Waits for its inputs.";
    body = `${rev}<div class="md">${n.text ? md(n.text) : `<p class="empty">${empty}</p>`}</div>`;
  }
  const tier = n.tier ? `<i class="tier t-${n.tier}">${n.tier === "human" ? "human" : n.tier + " tier"}</i>` : "";
  insp.innerHTML = `
    <div class="insp-head"><div style="display:grid;gap:6px;min-width:0"><h3>${esc(n.role)}</h3><div class="insp-sub">${tier}<span class="s-${n.status}">${STATE_LABEL[n.status] || n.status}</span>${n.model ? `<span>${esc(n.model)}</span>` : ""}${n.dur ? `<span>${n.dur.toFixed(1)} s</span>` : ""}</div></div>
    <button class="follow" type="button" aria-pressed="${follow}" id="followBtn">${follow ? "Following" : "Follow live"}</button></div>
    ${n.brief ? `<p class="brief">${esc(n.brief)}</p>` : ""}
    <div class="out">${body}</div>
    ${n.prompt ? `<details class="prompt"><summary>Prompt sent (${n.prompt.length.toLocaleString()} chars)</summary><pre>${esc(n.prompt)}</pre></details>` : ""}`;
  const o = insp.querySelector(".out");
  if (keepScroll != null) o.scrollTop = keepScroll; else if (n.status === "streaming") o.scrollTop = o.scrollHeight;
  $("#followBtn").onclick = () => {
    follow = !follow;
    if (follow) { const act = run.order.find(id => ["thinking", "streaming", "waiting"].includes(run.nodes[id].status)); if (act) select(act); }
    scheduleInspector();
  };
}

/* ---------- telemetry, trace, deliverable ---------- */
const tele = $("#tele"), traceEl = $("#trace");
let telePending = false;
function paintTele() {
  if (telePending || !run) return; telePending = true;
  requestAnimationFrame(() => {
    telePending = false;
    const m = run.m, total = m.tiers.quick + m.tiers.default + m.tiers.complex || 1;
    const elapsed = run.mode === "instant" ? "replay" : (((run.tEnd ?? performance.now()) - run.t0) / 1000).toFixed(1) + "s";
    const tok = m.tokens >= 1000 ? (m.tokens / 1000).toFixed(1) + "k" : m.tokens;
    tele.innerHTML = `
      <div class="tile"><b>${m.calls}</b><span>model calls</span></div>
      <div class="tile"><b>${tok}</b><span>${m.estimated ? "≈ tokens" : "tokens"}</span></div>
      <div class="tile"><b>${m.peak}</b><span>peak parallel</span></div>
      <div class="tile"><b>${m.revisions}</b><span>sent back</span></div>
      <div class="tile"><b>${elapsed}</b><span>elapsed</span></div>
      <div class="mix"><div class="mixbar"><i style="width:${m.tiers.quick / total * 100}%;background:var(--quick)"></i><i style="width:${m.tiers.default / total * 100}%;background:var(--default)"></i><i style="width:${m.tiers.complex / total * 100}%;background:var(--complex)"></i></div>
      <div class="mixkey"><em class="t-quick">quick ${m.tiers.quick}</em><em class="t-default">default ${m.tiers.default}</em><em class="t-complex">complex ${m.tiers.complex}</em></div></div>`;
  });
}
function paintTrace() {
  if (!run) return;
  traceEl.innerHTML = run.trace.slice(-200).map(l => `<div><span class="tt">${run.mode === "instant" ? "·" : l.t.toFixed(1)}</span><span class="tw">${esc(l.who)}</span><span class="tm">${esc(l.msg)}</span></div>`).join("");
  traceEl.scrollTop = traceEl.scrollHeight;
}
setInterval(() => { if (run?.running && run.mode !== "instant") paintTele(); }, 200);

let finalPending = false;
function paintFinal() {
  if (finalPending || !run?.plan) return; finalPending = true;
  requestAnimationFrame(() => {
    finalPending = false;
    const s = run.nodes.synth;
    if (!["thinking", "streaming", "done"].includes(s.status)) return;
    $("#final").hidden = false;
    $("#finalTitle").textContent = run.plan.title;
    $("#finalEyebrow").textContent = run.mode === "live" ? "Deliverable · written live" : recording.mode === "live" ? "Deliverable · from a live run" : "Deliverable · recorded run";
    $("#finalBody").innerHTML = s.text ? md(s.text) : `<p class="empty">The lead writer is assembling the team's work...</p>`;
    $("#save").hidden = !(s.status === "done" && run.mode === "live" && live?.kind === "server");
    $("#copyRun").hidden = !(s.status === "done" && run.mode === "live" && live?.kind !== "server");
  });
}

const hooks = {
  node(id, patch) {
    if (patch.status && ["thinking", "streaming", "waiting"].includes(patch.status) && follow && selected !== id) select(id);
    paintNode(id); paintEdges();
    if (selected === id) scheduleInspector();
    if (id === "synth") paintFinal();
  },
  trace: paintTrace,
  metrics: paintTele,
  plan() {
    renderGraph();
    const waves = Math.max(...run.plan.agents.map(a => a.depth)) + 1, roots = run.plan.agents.filter(a => !a.deps.length).length;
    $("#missionTitle").textContent = run.plan.title;
    $("#graphMeta").textContent = `${run.plan.agents.length} agents · ${waves} wave${waves > 1 ? "s" : ""} · ${roots} start at once`;
  }
};

function gateFor(mode) {
  return info => new Promise(resolve => {
    if (mode === "instant") return resolve("auto");
    $("#gateText").innerHTML = `<b>Your call.</b> ${info.passed} of ${info.total} contributions passed review${info.revised ? `, ${info.revised} more after one revision` : ""}. Approve to write the deliverable.`;
    $("#gate").hidden = false;
    gateResolve = v => { $("#gate").hidden = true; gateResolve = null; resolve(v); };
    if (mode === "replay" && !MANUAL_GATE) setTimeout(() => gateResolve?.("auto"), 2600);
    else $("#approve").focus({ preventScroll: true });
  });
}

/* ---------- controls ---------- */
const goalEl = $("#goal"), runBtn = $("#runLive"), replayBtn = $("#replay"), stopBtn = $("#stop"), noteEl = $("#note"), pill = $("#pill"), pillText = $("#pillText");
goalEl.value = params.get("goal") || recording.goal;
$("#chips").innerHTML = PRESETS.map((p, i) => `<button class="chip" type="button" data-i="${i}">${esc(p)}</button>`).join("");
$("#chips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) { goalEl.value = PRESETS[+b.dataset.i]; goalEl.focus(); } });

function setRunning(on, mode) {
  runBtn.disabled = on || !live; replayBtn.disabled = on; stopBtn.hidden = !on;
  pill.dataset.mode = on ? "running" : (live ? "live" : "replay");
  const replayLabel = recording.mode === "live" ? "Replay of a live run" : "Replaying";
  pillText.textContent = on ? (mode === "live" ? "Running live" : replayLabel) : (live ? live.label : (recording.mode === "live" ? "Recorded live run" : "Recorded run"));
}

function errorCopy(e) {
  return ({
    not_granted: "Claude access was not allowed for this page, so live runs are off for this visit.",
    sampling_disabled: "Claude is not available on this account.",
    rate_limited: "Too many calls right now. Try again in a minute.",
    session_expired: "Your Claude session expired. Sign in again and reload.",
    refused: "The model declined this goal. Try a different one.",
    invalid_json: "The planner's reply could not be read as a plan. Try again.",
    bad_plan: "The planner returned an empty team. Try again or rephrase the goal.",
    no_output: "No specialist finished, so there was nothing to review.",
    upstream_error: "A connection problem interrupted the run. Try again."
  })[e?.code] || e?.message || "Something went wrong.";
}

async function start(mode) {
  if (run?.running) return;
  const isLive = mode === "live";
  const goal = isLive ? goalEl.value.trim() : recording.goal;
  if (isLive && goal.length < 8) { noteEl.textContent = "Write a goal of at least a few words first."; goalEl.focus(); return; }
  if (isLive && !live) { noteEl.textContent = "No live driver here. Start the local runner with an API key, or open the page in Claude."; return; }
  if (!isLive) goalEl.value = recording.goal;

  ctl = new AbortController();
  run = createRun(goal, isLive ? "live" : mode === "instant" ? "instant" : "replay");
  selected = "planner"; follow = true;
  for (const id of Object.keys(nodeEls)) { nodeEls[id].remove(); delete nodeEls[id]; }
  $("#missionTitle").textContent = "Mission"; $("#graphMeta").textContent = "";
  if (mode !== "instant") $("#final").hidden = true;
  renderGraph(); paintInspector(); paintTele(); paintTrace();

  const driver = isLive ? live.driver : replayDriver(recording, mode === "instant" ? 0 : SPEED);
  setRunning(mode !== "instant", isLive ? "live" : "replay");
  if (isLive) noteEl.textContent = live.kind === "server" ? "Running on your API key through the local runner." : "Running on your Claude account. The first call may ask you to allow it.";
  try {
    await orchestrate(run, { driver, signal: ctl.signal, hooks, gate: gateFor(run.mode) });
    if (isLive) noteEl.textContent = "Done. Change the goal and run it again, or open any agent to read its work and prompt.";
    else if (mode !== "instant") noteEl.textContent = "That was a recorded run, replayed. Run your own goal live to see it plan a different team.";
  } catch (e) {
    noteEl.textContent = e?.code === "cancelled" ? "Stopped. Everything finished before the stop stays readable."
      : e?.code === "gate_rejected" ? "Rejected at the gate. Nothing was written." : errorCopy(e);
    if (live?.kind === "artifact" && ["not_granted", "sampling_disabled"].includes(e?.code)) live = null;
  } finally {
    $("#gate").hidden = true; gateResolve = null;
    setRunning(false); paintNode("team");
  }
}

$("#composer").addEventListener("submit", e => { e.preventDefault(); start("live"); });
replayBtn.addEventListener("click", () => start("replay"));
stopBtn.addEventListener("click", () => ctl?.abort());
$("#approve").addEventListener("click", () => gateResolve?.("approve"));
$("#reject").addEventListener("click", () => gateResolve?.("reject"));
$("#copy").addEventListener("click", async () => {
  const text = run?.nodes.synth?.text || "", b = $("#copy");
  try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; }
  catch { const r = document.createRange(); r.selectNodeContents($("#finalBody")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "Selected, press copy"; }
  setTimeout(() => { b.textContent = "Copy as Markdown"; }, 1800);
});
$("#save").addEventListener("click", async () => {
  const b = $("#save");
  try {
    const res = await fetch("/api/recordings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toRecording(run, live?.kind)) });
    const j = await res.json();
    if (!res.ok) throw j.error;
    b.textContent = "Saved"; noteEl.textContent = `Saved to ${j.path}. Replay it with ?replay=${j.path}`;
  } catch (e) { b.textContent = "Save failed"; noteEl.textContent = e?.message || "Could not save the run."; }
  setTimeout(() => { b.textContent = "Save run"; }, 2400);
});

$("#copyRun").addEventListener("click", async () => {
  const b = $("#copyRun"), json = JSON.stringify(toRecording(run, live?.kind));
  try { await navigator.clipboard.writeText(json); b.textContent = "Run copied"; noteEl.textContent = "The run is on your clipboard as JSON. Save it under recordings/ to replay it."; }
  catch {
    const ta = $("#runJson"); ta.hidden = false; ta.value = json; ta.select();
    b.textContent = "Select and copy below";
  }
  setTimeout(() => { b.textContent = "Copy run"; }, 2400);
});

/* ---------- how it works ---------- */
const ex = { deliverable: "{deliverable}" }, exA = { id: "{id}", role: "{role}", brief: "{brief}", text: "{output}" };
const STEPS = [
  ["Plan", "default tier", "The planner reads the goal and returns a team as JSON: roles, briefs, a model tier per agent and a dependency graph. The page validates it, drops cycles and caps depth.", P.planner("{goal}")],
  ["Fan out", "quick + default", "A scheduler starts every agent whose inputs are ready, three at a time. Each one receives its teammates' finished work as context.", P.worker("{goal}", ex, exA, [{ role: "{teammate}", text: "{teammate output}" }], null)],
  ["Review", "complex tier", "A reviewer that wrote none of the work scores each piece against its brief on the strongest tier. Anything under 7 goes back once with one specific note.", P.critic("{goal}", [exA])],
  ["Gate", "human", "The run stops. A person approves or rejects the reviewed work before anything final is written. In the replay it approves itself after a pause.", "No model call. The run waits on a promise that only the Approve or Reject button resolves."],
  ["Synthesize", "default tier", "The lead writer merges the reviewed work, resolves disagreements in a clause, and ends on the next three moves.", P.synth("{goal}", ex, [exA])]
];
$("#steps").innerHTML = STEPS.map(([h, k, p, prompt], i) => `<div class="step"><span class="k">${i + 1} · ${k}</span><h3>${h}</h3><p>${p}</p><details class="prompt"><summary>${i === 3 ? "How it waits" : "Prompt contract"}</summary><pre>${esc(prompt)}</pre></details></div>`).join("");

/* ---------- boot ---------- */
async function detectLive() {
  if (window.claude?.use) {
    const sample = await window.claude.use("sample").catch(() => null);
    if (sample) return { driver: artifactDriver(sample), label: "Live in Claude", kind: "artifact" };
  }
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (res.ok) {
      const c = await res.json();
      if (c.live) return { driver: serverDriver(""), label: "Live · local runner", kind: "server", models: c.models };
    }
  } catch { /* static hosting: replay only */ }
  return null;
}

// Read-only handle for scripted video capture (scripts/record.mjs); absent unless ?capture=1.
if (params.get("capture") === "1") window.__conductor = { get run() { return run; }, start: mode => start(mode) };

async function boot() {
  const rp = params.get("replay");
  if (rp && /^recordings\/[\w.-]+\.json$/.test(rp)) {
    try { recording = await (await fetch("/" + rp)).json(); goalEl.value = recording.goal; } catch { noteEl.textContent = `Could not load ${rp}; showing the sample run.`; }
  }
  await start("instant");
  const firstWorker = run.order.find(id => run.nodes[id].revised) || "synth";
  follow = true; select(firstWorker);
  live = await detectLive();
  setRunning(false);
  noteEl.textContent = live
    ? (live.kind === "server" ? `Live runs use your API key: ${live.models.quick}, ${live.models.default} and ${live.models.complex}. About ten calls a run.` : "Live runs use your own Claude account: about ten calls, usually two to four minutes.")
    : "Showing a recorded run. Start the local runner with an API key to run your own goal live.";
  if (live && params.get("autorun") === "1") start("live");
}
boot();
