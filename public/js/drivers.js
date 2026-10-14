// Drivers answer one prompt at a time: ask({ key, prompt, tier, signal, onText }) -> { text, usage?, model? }.
// The orchestrator never knows which one it is talking to.

import { sleep } from "./orchestrator.js";

// Plays back a recorded run. speed 0 renders instantly; 1 simulates thinking and streaming.
export function replayDriver(recording, speed = 1) {
  return {
    mode: speed ? "replay" : "instant",
    async ask({ key, tier, signal, onText }) {
      const text = recording.calls?.[key];
      if (text == null) throw { code: "upstream_error", message: `The recording has no answer for "${key}".` };
      if (!speed) { await Promise.resolve(); onText(text); return { text }; }
      await sleep(({ quick: 650, default: 1500, complex: 2400 }[tier] || 1200) * (0.7 + Math.random() * 0.6) * speed, signal);
      let i = 0;
      while (i < text.length) {
        i = Math.min(text.length, i + 16 + Math.floor(Math.random() * 22));
        onText(text.slice(0, i));
        await sleep(26 * speed, signal);
      }
      return { text };
    }
  };
}

// Talks to the local runner (server.mjs), which holds the API key and streams Server-Sent Events.
export function serverDriver(base = "") {
  return {
    mode: "live",
    async ask({ prompt, tier, signal, onText }) {
      let res;
      try {
        res = await fetch(`${base}/api/ask`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, tier }), signal
        });
      } catch (e) {
        throw signal?.aborted ? { code: "cancelled" } : { code: "upstream_error", message: "The local runner did not answer." };
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw j.error || { code: "upstream_error", message: `HTTP ${res.status}` };
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", text = "", usage = null, model = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, cut); buf = buf.slice(cut + 2);
            const line = chunk.split("\n").find(l => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            if (ev.delta) { text += ev.delta; onText(text); }
            if (ev.error) throw ev.error;
            if (ev.done) { usage = ev.usage; model = ev.model; }
          }
        }
      } catch (e) {
        if (signal?.aborted) throw { code: "cancelled", text };
        throw e?.code ? e : { code: "upstream_error", message: String(e?.message || e), text };
      }
      if (!text.trim()) throw { code: "empty_completion", message: "The model returned no text." };
      return { text, usage, model };
    }
  };
}

// Runs inside a claude.ai artifact, on the viewer's own Claude account.
export function artifactDriver(sample) {
  return {
    mode: "live",
    async ask({ prompt, tier, signal, onText }) {
      const r = await sample(prompt, { modelTier: tier, signal, onText: ({ text }) => onText(text) });
      return { text: r.text };
    }
  };
}
