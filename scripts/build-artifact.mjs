// Bundles public/ into one HTML file for hosts that take a single page, such as a claude.ai artifact.
// There the page runs live on the viewer's own Claude account through window.claude.
//
//   node scripts/build-artifact.mjs   -> dist/conductor.html

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, "public", f), "utf8");

// Dependency order; imports are dropped and exports unwrapped, so all modules share one scope.
const order = ["js/markdown.js", "js/orchestrator.js", "js/drivers.js", "js/recording.js", "js/app.js"];
const code = order.map(f => `// ---- ${f}\n` + read(f)
  .replace(/^import[^;]+;\n/gm, "")
  .replace(/^export (async function|function|const|let|class)/gm, "$1")).join("\n");

let html = read("index.html");
html = html
  .replace(/<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, "")
  .replace(/<meta charset[^>]*>\s*/i, "")
  .replace(/<meta name="viewport"[^>]*>\s*/i, "")
  .replace(/<\/head>\s*<body>\s*/i, "")
  .replace(/\s*<\/body>\s*<\/html>\s*$/i, "\n")
  .replace('<script type="module" src="./js/app.js"></script>', () => `<script type="module">\n${code}\n</script>`);

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "conductor.html"), html);
console.log(`dist/conductor.html  ${(html.length / 1024).toFixed(0)} KB`);
