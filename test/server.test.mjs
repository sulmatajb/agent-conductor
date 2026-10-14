// End to end through the real runner and the real SDK, against a mock Anthropic API.
// Proves streaming, tier-to-model routing, fallbacks, and the runner's guards without spending tokens.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRun, orchestrate } from "../public/js/orchestrator.js";
import { serverDriver } from "../public/js/drivers.js";
import { startMockAnthropic } from "../scripts/mock-anthropic.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let mock, seen, runner, base;

before(async () => {
  const m = startMockAnthropic();
  await m.ready;
  mock = m.server; seen = m.seen;

  const port = 4300 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  runner = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`, CONDUCTOR_MAX_CALLS: "12" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    runner.stdout.on("data", d => { if (String(d).includes("Conductor")) resolve(); });
    runner.on("exit", c => reject(new Error("runner exited " + c)));
  });
});

after(() => { runner?.kill(); mock?.close(); });

test("a full run streams through the runner with real token usage", async () => {
  const run = createRun("Test the runner", "live");
  const out = await orchestrate(run, { driver: serverDriver(base), gate: async () => "approve" });
  assert.match(out, /mock deliverable/);
  assert.equal(run.m.revisions, 1);
  assert.equal(run.m.estimated, false);
  assert.equal(run.m.tokens, run.m.calls * 150);
  assert.equal(run.nodes.critic.model, "claude-opus-5-5");
});

test("tiers route to the right models, with fallback only where supported", () => {
  const byModel = m => seen.filter(s => s.body.model === m);
  assert.ok(byModel("claude-haiku-5-5").length >= 1, "quick tier on Haiku");
  assert.ok(byModel("claude-sonnet-5-5").length >= 3, "default tier on Sonnet");
  assert.equal(byModel("claude-opus-5-5").length, 1, "one review on Opus");
  for (const s of seen) {
    const wantsFallback = !s.body.model.startsWith("claude-haiku");
    assert.equal(s.body.fallbacks === "default", wantsFallback, s.body.model);
    assert.equal(s.beta.includes("server-side-fallback-2026-07-01"), wantsFallback);
    assert.ok(s.body.output_config?.effort);
    assert.equal(s.body.stream, true);
  }
});

test("the runner refuses cross-origin calls, unknown tiers, and runs past its budget", async () => {
  const post = (body, headers = {}) => fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ prompt: "hi", tier: "default" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ prompt: "hi", tier: "fable" })).status, 400);
  const { callsLeft } = await (await fetch(`${base}/api/config`)).json();
  assert.ok(callsLeft > 0 && callsLeft < 12, "the run above spent part of the budget of 12");
  for (let i = 0; i < callsLeft; i++) await (await post({ prompt: "hi", tier: "quick" })).text();
  const over = await post({ prompt: "hi", tier: "quick" });
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error.code, "budget_exhausted");
});

test("static files are served and paths cannot escape public/", async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.match(await (await fetch(`${base}/js/orchestrator.js`)).text(), /export async function orchestrate/);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.live, true);
  assert.notEqual((await fetch(`${base}/..%2fserver.mjs`)).status, 200);
});
