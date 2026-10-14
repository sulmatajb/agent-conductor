// Conductor's local runner: serves the page and streams Claude calls with your own API key.
// It binds to 127.0.0.1, answers only same-origin requests, and stops after a call budget.
//
//   npm install && cp .env.example .env   (add ANTHROPIC_API_KEY)
//   npm start                              -> http://127.0.0.1:4317

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader, so the runner has no dependency besides the SDK.
try {
  for (const line of fs.readFileSync(path.join(here, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch { /* no .env: replay only */ }

const env = process.env;
const HOST = env.HOST || "127.0.0.1";
const PORT = Number(env.PORT || 4317);
const MAX_CALLS = Number(env.CONDUCTOR_MAX_CALLS || 300);
const MAX_PER_MINUTE = Number(env.CONDUCTOR_MAX_PER_MINUTE || 40);
const MAX_PROMPT = 120_000;

// Each tier the planner can assign maps to one model and one effort level.
// The reviewer runs on "complex", so maker and checker are never the same model.
const TIERS = {
  quick: { model: env.CONDUCTOR_MODEL_QUICK || "claude-haiku-5-5", effort: "low" },
  default: { model: env.CONDUCTOR_MODEL_DEFAULT || "claude-sonnet-5-5", effort: "medium" },
  complex: { model: env.CONDUCTOR_MODEL_COMPLEX || "claude-opus-5-5", effort: "medium" }
};
// Server-side refusal fallback is opt-in and supported on the Sonnet and Opus lines.
const FALLBACK_OK = m => /^claude-(opus|sonnet)-/.test(m);

const live = Boolean(env.ANTHROPIC_API_KEY);
const client = live ? new Anthropic() : null;
let callsUsed = 0;
const recent = [];

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".mp4": "video/mp4", ".gif": "image/gif" };

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject({ code: "too_large" }); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function serveFile(res, root, rel) {
  const file = path.resolve(root, "." + decodeURIComponent(rel));
  if (!file.startsWith(root + path.sep) && file !== root) return sendJson(res, 403, { error: { code: "forbidden" } });
  fs.stat(file, (err, st) => {
    const target = !err && st.isDirectory() ? path.join(file, "index.html") : file;
    fs.readFile(target, (e, buf) => {
      if (e) return sendJson(res, 404, { error: { code: "not_found" } });
      res.writeHead(200, { "content-type": TYPES[path.extname(target)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(buf);
    });
  });
}

function errorFor(e) {
  if (e instanceof Anthropic.AuthenticationError) return { code: "auth_error", message: "The API key was rejected. Check ANTHROPIC_API_KEY in .env." };
  if (e instanceof Anthropic.RateLimitError) return { code: "rate_limited", message: "The Anthropic API rate limit was reached. Wait a minute and run again." };
  if (e instanceof Anthropic.BadRequestError) return { code: "bad_request", message: e.message };
  if (e instanceof Anthropic.APIConnectionError) return { code: "upstream_error", message: "Could not reach the Anthropic API." };
  if (e instanceof Anthropic.APIError) return { code: "upstream_error", message: `Anthropic API error ${e.status ?? ""}`.trim() };
  return { code: "upstream_error", message: String(e?.message || e) };
}

async function ask(req, res) {
  if (!live) return sendJson(res, 503, { error: { code: "no_driver", message: "No ANTHROPIC_API_KEY in .env, so live runs are off. Replay still works." } });
  if (!sameOrigin(req) || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    return sendJson(res, 403, { error: { code: "forbidden", message: "Only the Conductor page on this host may call the runner." } });
  }
  let body;
  try { body = JSON.parse(await readBody(req, MAX_PROMPT * 2)); } catch { return sendJson(res, 400, { error: { code: "bad_request", message: "Send JSON: {prompt, tier}." } }); }
  const tier = TIERS[body?.tier];
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!tier || !prompt.trim() || prompt.length > MAX_PROMPT) return sendJson(res, 400, { error: { code: "bad_request", message: "Unknown tier or empty or oversized prompt." } });

  const t = Date.now();
  while (recent.length && t - recent[0] > 60_000) recent.shift();
  if (callsUsed >= MAX_CALLS) return sendJson(res, 429, { error: { code: "budget_exhausted", message: `This runner reached its limit of ${MAX_CALLS} calls. Restart it to reset, or raise CONDUCTOR_MAX_CALLS.` } });
  if (recent.length >= MAX_PER_MINUTE) return sendJson(res, 429, { error: { code: "rate_limited", message: "Too many calls this minute. Try again shortly." } });
  callsUsed++; recent.push(t);

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const params = {
    model: tier.model,
    max_tokens: 16000,
    output_config: { effort: tier.effort },
    messages: [{ role: "user", content: prompt }]
  };
  if (FALLBACK_OK(tier.model)) Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });

  const stream = client.beta.messages.stream(params);
  res.on("close", () => { if (!res.writableEnded) stream.abort(); });
  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") send({ delta: event.delta.text });
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      send({ error: { code: "refused", message: "The model declined this request. Try a different goal." } });
    } else {
      send({ done: true, model: msg.model, stop: msg.stop_reason, usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens } });
    }
    console.log(`  ${tier.model.padEnd(18)} ${String(msg.usage.input_tokens).padStart(6)} in ${String(msg.usage.output_tokens).padStart(6)} out  ${((Date.now() - t) / 1000).toFixed(1)}s  [${callsUsed}/${MAX_CALLS}]`);
  } catch (e) {
    if (!res.writableEnded && !res.destroyed) send({ error: errorFor(e) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function saveRecording(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: { code: "forbidden" } });
  try {
    const rec = JSON.parse(await readBody(req, 2_000_000));
    if (rec?.format !== 1 || typeof rec.calls !== "object") throw new Error("not a recording");
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const name = `${stamp}-${String(rec.goal || "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-+$/, "")}.json`;
    fs.mkdirSync(path.join(here, "recordings"), { recursive: true });
    fs.writeFileSync(path.join(here, "recordings", name), JSON.stringify(rec, null, 2));
    sendJson(res, 200, { path: `recordings/${name}` });
  } catch (e) {
    sendJson(res, 400, { error: { code: "bad_request", message: "That is not a Conductor recording." } });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, { live, models: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, v.model])), callsLeft: MAX_CALLS - callsUsed });
  }
  if (url.pathname === "/api/ask" && req.method === "POST") return void ask(req, res);
  if (url.pathname === "/api/recordings" && req.method === "POST") return void saveRecording(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: { code: "method_not_allowed" } });
  if (url.pathname.startsWith("/recordings/")) return serveFile(res, path.join(here, "recordings"), url.pathname.slice("/recordings".length));
  serveFile(res, path.join(here, "public"), url.pathname === "/" ? "/index.html" : url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`\nConductor  http://${HOST}:${PORT}`);
  console.log(live
    ? `Live runs on: ${TIERS.quick.model} (quick), ${TIERS.default.model} (default), ${TIERS.complex.model} (complex). Budget ${MAX_CALLS} calls.`
    : "No ANTHROPIC_API_KEY found. Replay works; add a key to .env for live runs.");
  if (HOST !== "127.0.0.1" && HOST !== "localhost") console.warn("Warning: listening beyond localhost. Anyone who can reach this port can spend your API key.");
});
