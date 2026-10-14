import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, orchestrate, sanitizePlan, parseJson, toRecording, sleep } from "../public/js/orchestrator.js";
import { replayDriver } from "../public/js/drivers.js";
import { DEFAULT_RECORDING } from "../public/js/recording.js";

const PLAN = {
  title: "Test mission", deliverable: "A test deliverable.",
  agents: [
    { id: "a", role: "Alpha", brief: "a", depends_on: [], tier: "quick" },
    { id: "b", role: "Beta", brief: "b", depends_on: [], tier: "default" },
    { id: "c", role: "Gamma", brief: "c", depends_on: ["a", "b"], tier: "default" }
  ]
};

// A scripted driver that records start order and concurrency.
function fakeDriver(answers, { delay = 5 } = {}) {
  const log = { started: [], peak: 0, active: 0, prompts: {} };
  return {
    log,
    mode: "fake",
    async ask({ key, prompt, signal, onText }) {
      log.started.push(key); log.prompts[key] = prompt;
      log.active++; log.peak = Math.max(log.peak, log.active);
      try {
        await sleep(delay, signal);
        const a = answers[key];
        if (a instanceof Error || a?.code) throw a;
        const text = typeof a === "function" ? a(prompt) : a ?? `output of ${key}`;
        onText(text);
        return { text, usage: { input_tokens: 10, output_tokens: 5 }, model: "fake-model" };
      } finally { log.active--; }
    }
  };
}

const reviews = list => JSON.stringify({ reviews: list });

test("parseJson reads bare, fenced and wrapped JSON", () => {
  assert.deepEqual(parseJson('{"x":1}'), { x: 1 });
  assert.deepEqual(parseJson('Here you go:\n```json\n{"x":2}\n```'), { x: 2 });
  assert.deepEqual(parseJson('Sure. {"x":3} Done.'), { x: 3 });
  assert.throws(() => parseJson("no json here"), e => e.code === "invalid_json");
});

test("sanitizePlan drops cycles, unknown deps and caps depth", () => {
  const p = sanitizePlan({
    agents: [
      { id: "one", role: "One", depends_on: ["two"] },       // forward ref: dropped
      { id: "two", role: "Two", depends_on: ["one", "ghost"] },
      { id: "three", role: "Three", depends_on: ["two"] },
      { id: "four", role: "Four", depends_on: ["three"] },    // depth 3 would exceed the cap
      { id: "planner", role: "Planner clash", depends_on: [] },
      { id: "six", role: "Too many" }
    ]
  });
  assert.equal(p.agents.length, 5);
  const by = Object.fromEntries(p.agents.map(a => [a.id, a]));
  assert.deepEqual(by.one.deps, []);
  assert.deepEqual(by.two.deps, ["one"]);
  assert.ok(Math.max(...p.agents.map(a => a.depth)) <= 2);
  assert.ok(!by.planner, "reserved ids are renamed");
});

test("agents wait for their inputs and run in parallel otherwise", async () => {
  const d = fakeDriver({
    planner: JSON.stringify(PLAN),
    critic: reviews([{ id: "a", score: 8 }, { id: "b", score: 9 }, { id: "c", score: 8 }]),
    synth: "final"
  });
  const run = createRun("goal", "fake");
  const out = await orchestrate(run, { driver: d });
  assert.equal(out, "final");
  const i = k => d.log.started.indexOf(k);
  assert.ok(i("c") > i("a") && i("c") > i("b"), "c starts after both inputs");
  assert.equal(d.log.peak, 2, "a and b ran at the same time");
  assert.match(d.log.prompts.c, /### Alpha\noutput of a/);
  assert.equal(run.m.tokens, 15 * run.m.calls);
  assert.equal(run.m.estimated, false);
});

test("concurrency limit holds", async () => {
  const wide = { ...PLAN, agents: ["p", "q", "r", "s", "t"].map(id => ({ id, role: id, brief: id, depends_on: [] })) };
  const d = fakeDriver({ planner: JSON.stringify(wide), critic: reviews([]), synth: "ok" }, { delay: 15 });
  await orchestrate(createRun("goal", "fake"), { driver: d, concurrency: 2 });
  assert.equal(d.log.peak, 2);
});

test("work scored under 7 is sent back exactly once", async () => {
  const d = fakeDriver({
    planner: JSON.stringify(PLAN),
    critic: reviews([{ id: "a", score: 5, verdict: "revise", note: "add numbers" }, { id: "b", score: 8 }, { id: "c", score: 9, verdict: "revise" }]),
    "a:rev": "better a",
    "c:rev": "better c",
    synth: p => (p.includes("better a") ? "used revision" : "missed revision")
  });
  const run = createRun("goal", "fake");
  const out = await orchestrate(run, { driver: d });
  assert.equal(out, "used revision");
  assert.equal(run.m.revisions, 2, "verdict revise counts even at score 9");
  assert.match(d.log.prompts["a:rev"], /add numbers/);
  assert.equal(d.log.started.filter(k => k === "a:rev").length, 1);
});

test("a rejected gate writes nothing", async () => {
  const d = fakeDriver({ planner: JSON.stringify(PLAN), critic: reviews([]) });
  const run = createRun("goal", "fake");
  await assert.rejects(orchestrate(run, { driver: d, gate: async () => "reject" }), e => e.code === "gate_rejected");
  assert.ok(!d.log.started.includes("synth"));
});

test("a failed agent does not stop its teammates; a fatal error stops the run", async () => {
  const soft = fakeDriver({ planner: JSON.stringify(PLAN), a: { code: "upstream_error" }, critic: reviews([]), synth: "ok" });
  const run = createRun("goal", "fake");
  assert.equal(await orchestrate(run, { driver: soft }), "ok");
  assert.equal(run.nodes.a.status, "error");
  assert.equal(run.nodes.c.status, "done", "c ran with the input it had");

  const hard = fakeDriver({ planner: JSON.stringify(PLAN), a: { code: "rate_limited" } });
  await assert.rejects(orchestrate(createRun("goal", "fake"), { driver: hard }), e => e.code === "rate_limited");
});

test("stop cancels in-flight work", async () => {
  const ctl = new AbortController();
  const d = fakeDriver({ planner: JSON.stringify(PLAN) }, { delay: 40 });
  const run = createRun("goal", "fake");
  setTimeout(() => ctl.abort(), 60);
  await assert.rejects(orchestrate(run, { driver: d, signal: ctl.signal }), e => e.code === "cancelled");
  assert.ok(Object.values(run.nodes).every(n => !["thinking", "streaming", "queued"].includes(n.status)));
});

test("the default recording replays end to end, and a run round-trips as a recording", async () => {
  const run = createRun(DEFAULT_RECORDING.goal, "instant");
  const out = await orchestrate(run, { driver: replayDriver(DEFAULT_RECORDING, 0), gate: async () => "auto" });
  assert.equal(out, DEFAULT_RECORDING.calls.synth);
  assert.equal(run.m.revisions, Object.keys(DEFAULT_RECORDING.calls).filter(k => k.endsWith(":rev")).length);
  const again = createRun(DEFAULT_RECORDING.goal, "instant");
  assert.equal(await orchestrate(again, { driver: replayDriver(toRecording(run), 0) }), out);
});

test("recordings carry real per-call timings for a faithful time-lapse", async () => {
  const d = fakeDriver({ planner: JSON.stringify(PLAN), critic: reviews([]), synth: "ok" }, { delay: 20 });
  const run = createRun("goal", "fake");
  await orchestrate(run, { driver: d });
  const rec = toRecording(run, "test");
  assert.equal(rec.via, "test");
  for (const key of Object.keys(rec.calls)) {
    const t = rec.timing[key];
    assert.ok(t && t.dur >= 15 && t.ttft <= t.dur && t.start >= 0, key);
  }
  assert.ok(rec.timing.c.start >= rec.timing.a.start + rec.timing.a.dur - 2, "c started after a finished");
});
