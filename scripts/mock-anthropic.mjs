// A stand-in for the Anthropic Messages API that streams scripted answers.
// Used by the tests, and by `npm run dev:mock` to try live mode without an API key.

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function scriptedAnswer(prompt) {
  if (prompt.includes("You are the planner")) return JSON.stringify({
    title: "Mock mission", deliverable: "A mock deliverable.",
    agents: [
      { id: "scout", role: "Scout", brief: "Find the facts the team needs.", depends_on: [], tier: "quick" },
      { id: "judge", role: "Judge", brief: "Decide what matters most.", depends_on: [], tier: "default" },
      { id: "writer", role: "Writer", brief: "Turn the facts and the decision into a plan.", depends_on: ["scout", "judge"], tier: "default" }
    ]
  });
  if (prompt.includes("You are the reviewer")) return '```json\n{"reviews":[{"id":"scout","score":6,"verdict":"revise","note":"Add numbers to every claim."},{"id":"judge","score":8,"note":"Clear call."},{"id":"writer","score":9,"note":"Concrete."}]}\n```';
  if (prompt.includes("You are the lead")) return "**This is a mock deliverable from the stand-in API.**\n\n## What happened\n- Three agents ran, one was sent back once.\n\n## Next 3 moves\n1. Add a real API key to .env\n2. Run npm start\n3. Run your own goal";
  return "### Mock contribution\n- A concrete point with 3 numbers\n- A decision with a reason";
}

export function startMockAnthropic({ port = 0, delayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c));
    req.on("end", async () => {
      const body = JSON.parse(b);
      seen.push({ body, beta: req.headers["anthropic-beta"] || "" });
      const text = scriptedAnswer(body.messages[0].content);
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const wait = ms => new Promise(r => setTimeout(r, ms));
      res.writeHead(200, { "content-type": "text/event-stream" });
      ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      if (delayMs) await wait(delayMs);
      for (let i = 0; i < text.length; i += 20) {
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 20) } });
        if (delayMs) await wait(delayMs / 20);
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } });
      ev("message_stop", {});
      res.end();
    });
  }).listen(port, "127.0.0.1");
  return { server, seen, ready: new Promise(r => server.once("listening", r)) };
}

// `npm run dev:mock`: the mock API plus the real runner pointed at it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = startMockAnthropic({ delayMs: 900 });
  await mock.ready;
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const runner = spawn(process.execPath, ["server.mjs"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, ANTHROPIC_API_KEY: "mock-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.server.address().port}` }
  });
  const stop = () => { runner.kill(); mock.server.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log("Mock Anthropic API running. Answers are scripted; no tokens are spent.");
}
