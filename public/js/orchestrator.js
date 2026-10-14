// Conductor's orchestrator. No DOM, no network: it runs the same way in the
// browser, in Node tests, and against any driver that can answer a prompt.
//
// Pipeline: plan -> fan out along a dependency graph -> review -> human gate -> synthesize.

const now = () => globalThis.performance.now();

export const STATE_LABEL = {
  idle: "waiting", queued: "queued", thinking: "thinking", streaming: "writing",
  done: "done", revise: "sent back", error: "failed", skipped: "skipped", waiting: "needs you"
};

// Errors that end the whole run instead of failing one agent.
export const FATAL = new Set([
  "cancelled", "not_granted", "sampling_disabled", "session_expired", "rate_limited",
  "not_declared", "capability_disabled", "capability_removed", "queue_overflow",
  "auth_error", "budget_exhausted", "no_driver"
]);

/* ---------- prompt contracts ---------- */
export const P = {
  planner: goal => `You are the planner in a multi-agent system. Design the smallest team of specialist agents that can deliver this goal well.

Goal: ${goal}

Reply with only JSON in this shape:
{"title": "mission name, max 6 words", "deliverable": "one sentence naming the final artifact", "agents": [{"id": "snake_case_id", "role": "2-3 word role", "brief": "what this agent must produce, 1-2 sentences, specific to the goal", "depends_on": ["ids of agents whose output it needs"], "tier": "quick or default"}]}

Rules:
- 3 to 5 agents. At least two have no dependencies, so they start in parallel.
- Dependencies form a DAG at most 3 levels deep, and only point to agents listed earlier.
- tier "quick" for listing, lookup or extraction work; "default" for judgment and design.
- Do not create a reviewer, critic, editor or final writer. Those roles already exist.`,

  worker: (goal, plan, a, inputs, rev) => `You are the ${a.role} on a team of AI agents.
Team goal: ${goal}
Team deliverable: ${plan.deliverable}
Your assignment: ${a.brief}
${inputs.length ? `
Work handed to you by teammates:
${inputs.map(i => `### ${i.role}\n${i.text}`).join("\n\n")}
` : ""}${rev ? `
The reviewer sent your first draft back with this note: ${rev.note}

Your first draft:
${rev.draft}

Write the improved version.
` : ""}
Write only your contribution. Be concrete: numbers, named steps, decisions with a reason. Where you assume a fact, say it is an assumption. Under 170 words. Markdown: one short heading, then bullets. No preamble, no sign-off.`,

  critic: (goal, items) => `You are the reviewer on a team of AI agents. You did not write any of this work.
Team goal: ${goal}

Score each contribution against its brief. Reply with only JSON:
{"reviews": [{"id": "agent id", "score": 1-10, "verdict": "pass or revise", "note": "one sentence: the single most important fix, or what makes it strong"}]}

Use "revise" only when the score is below 7. Be strict about vague claims, missing numbers, and contradictions between teammates.

${items.map(a => `## ${a.id} (${a.role})\nBrief: ${a.brief}\nOutput:\n${a.text}`).join("\n\n")}`,

  synth: (goal, plan, items) => `You are the lead who assembles a team's work into one deliverable.
Goal: ${goal}
Deliverable: ${plan.deliverable}

Team outputs, already reviewed:
${items.map(a => `### ${a.role}\n${a.text}`).join("\n\n")}

Write the deliverable in Markdown. Start with a one-sentence summary in bold. Then sections with short headings. Merge overlaps. Where teammates disagree, pick one and say why in a clause. End with a section "Next 3 moves" as a numbered list. Under 420 words. No preamble.`
};

/* ---------- helpers ---------- */
export function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
}

// Reads JSON the way a model tends to write it: bare, fenced, or with a sentence around it.
export function parseJson(text) {
  const t = String(text ?? "").trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const x of tries) { try { return JSON.parse(x); } catch { /* next */ } }
  throw { code: "invalid_json", message: "The reply was not valid JSON.", text: t };
}

// The planner is a model, so its plan is untrusted input: ids are normalized,
// dependencies may only point backwards (no cycles), and depth is capped at 3 levels.
export function sanitizePlan(p) {
  const raw = Array.isArray(p?.agents) ? p.agents.slice(0, 5) : [];
  const map = {}, seen = new Set(["planner", "critic", "gate", "synth", "team"]), agents = [];
  raw.forEach(a => {
    let id = slug(a?.id || a?.role) || "agent";
    while (seen.has(id)) id += "_2";
    seen.add(id);
    map[slug(a?.id)] ??= id;
    map[slug(a?.role)] ??= id;
    agents.push({
      id,
      role: String(a?.role || id).slice(0, 40),
      brief: String(a?.brief || "").slice(0, 420),
      tier: a?.tier === "quick" ? "quick" : "default",
      rawDeps: Array.isArray(a?.depends_on) ? a.depends_on : []
    });
  });
  const depth = {};
  agents.forEach((a, i) => {
    const earlier = new Set(agents.slice(0, i).map(x => x.id));
    a.deps = [...new Set(a.rawDeps.map(d => map[slug(d)]).filter(d => d && earlier.has(d)))];
    let d = a.deps.length ? 1 + Math.max(...a.deps.map(x => depth[x])) : 0;
    if (d > 2) {
      a.deps = a.deps.filter(x => depth[x] < 2);
      d = a.deps.length ? 1 + Math.max(...a.deps.map(x => depth[x])) : 0;
    }
    depth[a.id] = d; a.depth = d; delete a.rawDeps;
  });
  if (!agents.length) throw { code: "bad_plan", message: "The planner returned no agents." };
  return {
    title: String(p?.title || "Mission").slice(0, 60),
    deliverable: String(p?.deliverable || "The final deliverable for the goal.").slice(0, 240),
    agents
  };
}

export function limiter(n) {
  let active = 0; const q = [];
  return async fn => {
    if (active >= n) await new Promise(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; const next = q.shift(); if (next) next(); }
  };
}

export function sleep(ms, signal) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej({ code: "cancelled" });
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej({ code: "cancelled" }); }, { once: true });
  });
}

/* ---------- run state ---------- */
export function createRun(goal, mode) {
  const run = {
    goal, mode, plan: null, nodes: {}, order: [], edges: [], trace: [], calls: {}, timing: {}, gateInfo: null,
    t0: now(), tEnd: null, running: true,
    m: { calls: 0, tokens: 0, estimated: false, active: 0, peak: 0, revisions: 0, tiers: { quick: 0, default: 0, complex: 0 }, models: {} }
  };
  const add = n => { run.nodes[n.id] = { status: "idle", text: "", ...n }; run.order.push(n.id); };
  add({ id: "planner", kind: "planner", role: "Planner", tier: "default", brief: "Reads the goal and designs the team: who is needed, what each must produce, and which work depends on which." });
  add({ id: "team", kind: "ghost", role: "Team forms here", tier: null });
  add({ id: "critic", kind: "critic", role: "Reviewer", tier: "complex", brief: "Scores every contribution against its brief on the most capable tier, and sends anything below 7 back once." });
  add({ id: "gate", kind: "gate", role: "You", tier: "human", brief: "Nothing is synthesized until a person approves the reviewed work." });
  add({ id: "synth", kind: "synth", role: "Lead writer", tier: "default", brief: "Assembles the reviewed work into one deliverable, resolving overlaps and disagreements." });
  buildEdges(run);
  return run;
}

export function buildEdges(run) {
  const e = [];
  const workers = run.plan ? run.plan.agents : [];
  if (!workers.length) e.push(["planner", "team"], ["team", "critic"]);
  const feeds = new Set(workers.flatMap(a => a.deps));
  workers.forEach(a => {
    if (!a.deps.length) e.push(["planner", a.id]);
    a.deps.forEach(d => e.push([d, a.id]));
    if (!feeds.has(a.id)) e.push([a.id, "critic"]);
  });
  e.push(["critic", "gate"], ["gate", "synth"]);
  run.edges = e.map(([from, to]) => ({ from, to }));
}

export function columns(run) {
  const cols = [["planner"]];
  if (run.plan) {
    const maxD = Math.max(...run.plan.agents.map(a => a.depth));
    for (let d = 0; d <= maxD; d++) cols.push(run.plan.agents.filter(a => a.depth === d).map(a => a.id));
  } else cols.push(["team"]);
  cols.push(["critic"], ["gate"], ["synth"]);
  return cols;
}

// A finished run, in the format the replay driver reads back.
export function toRecording(run, via) {
  return { format: 1, goal: run.goal, recordedAt: new Date().toISOString(), mode: run.mode, via: via || null, models: run.m.models, calls: run.calls, timing: run.timing };
}

/* ---------- the orchestrator ---------- */
export async function orchestrate(run, { driver, signal, hooks = {}, gate, concurrency = 3, maxRevisions = 3 }) {
  if (!driver) throw { code: "no_driver", message: "No driver can answer prompts in this view." };
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (signal?.aborted) inner.abort(); else signal?.addEventListener("abort", onAbort, { once: true });
  const sig = inner.signal;
  const goal = run.goal;

  const setNode = (id, patch) => { const n = run.nodes[id]; if (!n) return; Object.assign(n, patch); hooks.node?.(id, patch); };
  const trace = (who, msg) => { const e = { t: (now() - run.t0) / 1000, who, msg }; run.trace.push(e); hooks.trace?.(e); };
  const metrics = () => hooks.metrics?.();

  const call = async (id, key, prompt, tier) => {
    if (sig.aborted) throw { code: "cancelled" };
    const n = run.nodes[id], t = now();
    let first = null;
    n.prompt = prompt;
    setNode(id, { status: "thinking", text: "" });
    run.m.calls++; run.m.tiers[tier]++; run.m.active++; run.m.peak = Math.max(run.m.peak, run.m.active); metrics();
    try {
      const res = await driver.ask({ key, prompt, tier, signal: sig, onText: text => { first ??= now(); setNode(id, { status: "streaming", text }); } });
      // Real timings, so a replay can be a faithful time-lapse of this run.
      run.timing[key] = { start: Math.round(t - run.t0), ttft: Math.round((first ?? now()) - t), dur: Math.round(now() - t) };
      const text = typeof res === "string" ? res : res.text;
      if (res?.usage) run.m.tokens += (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0);
      else { run.m.tokens += Math.round((prompt.length + text.length) / 4); run.m.estimated = true; }
      if (res?.model) { n.model = res.model; run.m.models[res.model] = (run.m.models[res.model] || 0) + 1; }
      n.dur = (now() - t) / 1000;
      run.calls[key] = text;
      return text;
    } catch (e) {
      if (sig.aborted && !FATAL.has(e?.code)) throw { code: "cancelled" };
      throw e;
    } finally { run.m.active--; metrics(); }
  };

  try {
    // 1. Plan
    trace("planner", "reading the goal, designing a team");
    const plan = sanitizePlan(parseJson(await call("planner", "planner", P.planner(goal), "default")));
    run.plan = plan;
    delete run.nodes.team; run.order = run.order.filter(x => x !== "team");
    plan.agents.forEach(a => { run.nodes[a.id] = { status: "idle", text: "", kind: "worker", id: a.id, role: a.role, tier: a.tier, brief: a.brief, deps: a.deps }; run.order.splice(run.order.indexOf("critic"), 0, a.id); });
    buildEdges(run);
    setNode("planner", { status: "done" });
    hooks.plan?.();
    const waves = Math.max(...plan.agents.map(a => a.depth)) + 1, roots = plan.agents.filter(a => !a.deps.length).length;
    trace("planner", `team of ${plan.agents.length}: ${plan.agents.map(a => a.role).join(", ")}`);
    trace("scheduler", `${waves} wave${waves > 1 ? "s" : ""}; ${roots} agents start in parallel`);

    // 2. Fan out: each agent starts the moment its inputs are done
    const lim = limiter(concurrency), started = {}, byId = Object.fromEntries(plan.agents.map(a => [a.id, a]));
    const inputsFor = a => a.deps.filter(d => run.nodes[d].status === "done").map(d => ({ role: run.nodes[d].role, text: run.nodes[d].text }));
    const runAgent = a => started[a.id] ??= (async () => {
      await Promise.all(a.deps.map(d => runAgent(byId[d])));
      if (sig.aborted) throw { code: "cancelled" };
      setNode(a.id, { status: "queued" });
      return lim(async () => {
        const ins = inputsFor(a);
        if (ins.length) trace(a.role, `received work from ${ins.map(i => i.role).join(" and ")}`);
        try {
          const txt = await call(a.id, a.id, P.worker(goal, plan, a, ins, null), a.tier);
          setNode(a.id, { status: "done", text: txt });
          trace(a.role, `done in ${run.nodes[a.id].dur.toFixed(1)}s, ${txt.split(/\s+/).length} words`);
        } catch (e) {
          if (FATAL.has(e?.code)) throw e;
          setNode(a.id, { status: "error", error: e?.message || e?.code || "failed" });
          trace(a.role, `failed (${e?.code || "error"}); dependents continue without it`);
        }
      });
    })();
    await Promise.all(plan.agents.map(runAgent));

    // 3. Review on a different, stronger tier; send weak work back once
    const ok = plan.agents.filter(a => run.nodes[a.id].status === "done");
    if (!ok.length) throw { code: "no_output", message: "No specialist finished, so there is nothing to review." };
    trace("reviewer", `scoring ${ok.length} contributions on the complex tier`);
    const crit = parseJson(await call("critic", "critic", P.critic(goal, ok.map(a => ({ ...a, text: run.nodes[a.id].text }))), "complex"));
    const reviews = (Array.isArray(crit?.reviews) ? crit.reviews : []).map(r => {
      const id = byId[r?.id] ? r.id : ok.find(a => slug(a.role) === slug(r?.id))?.id;
      if (!id) return null;
      const score = Math.max(1, Math.min(10, Math.round(Number(r.score) || 0)));
      return { id, score, verdict: score < 7 || r.verdict === "revise" ? "revise" : "pass", note: String(r.note || "").slice(0, 300) };
    }).filter(Boolean);
    setNode("critic", { status: "done", reviews });
    reviews.forEach(r => setNode(r.id, { score: r.score, verdict: r.verdict, note: r.note, status: r.verdict === "revise" ? "revise" : "done" }));
    const back = reviews.filter(r => r.verdict === "revise").map(r => byId[r.id]).slice(0, maxRevisions);
    trace("reviewer", back.length ? `sent back: ${back.map(a => a.role).join(", ")}` : "everything passed");

    await Promise.all(back.map(a => lim(async () => {
      const n = run.nodes[a.id], draft = n.text;
      try {
        const txt = await call(a.id, a.id + ":rev", P.worker(goal, plan, a, inputsFor(a), { note: n.note, draft }), a.tier);
        run.m.revisions++;
        setNode(a.id, { status: "done", text: txt, revised: true, draft });
        trace(a.role, "revised once against the reviewer's note");
      } catch (e) {
        if (FATAL.has(e?.code)) throw e;
        setNode(a.id, { status: "done", text: draft });
        trace(a.role, "revision failed; keeping the first draft");
      }
    })));

    // 4. Human gate
    run.gateInfo = { passed: reviews.filter(r => r.verdict === "pass").length, total: reviews.length, revised: run.m.revisions };
    setNode("gate", { status: "waiting" });
    trace("gate", "waiting for a human");
    const decision = await new Promise((res, rej) => {
      sig.addEventListener("abort", () => rej({ code: "cancelled" }), { once: true });
      Promise.resolve(gate ? gate(run.gateInfo) : "approve").then(res, rej);
    });
    if (decision === "reject") {
      setNode("gate", { status: "error" });
      trace("gate", "rejected; the run ends without a deliverable");
      throw { code: "gate_rejected", message: "Rejected at the gate." };
    }
    setNode("gate", { status: "done", auto: decision === "auto" });
    trace("gate", decision === "auto" ? "approved (replay)" : "approved by a human");

    // 5. Synthesize
    const items = plan.agents.filter(a => run.nodes[a.id].status === "done").map(a => ({ role: a.role, text: run.nodes[a.id].text }));
    const fin = await call("synth", "synth", P.synth(goal, plan, items), "default");
    setNode("synth", { status: "done", text: fin });
    trace("lead writer", `deliverable ready, ${fin.split(/\s+/).length} words`);
    return fin;
  } catch (e) {
    inner.abort();
    for (const id of run.order) {
      if (["thinking", "streaming", "queued", "waiting"].includes(run.nodes[id].status)) setNode(id, { status: e?.code === "gate_rejected" ? "idle" : "skipped" });
    }
    if (e?.code !== "gate_rejected") trace("system", e?.code === "cancelled" ? "stopped" : `stopped: ${e?.message || e?.code || "error"}`);
    throw e;
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    run.running = false; run.tEnd = now(); metrics();
  }
}
