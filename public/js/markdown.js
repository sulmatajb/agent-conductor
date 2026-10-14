// Just enough Markdown for agent output: headings, lists, bold, italics, inline code.
// Escapes first, so model text can never inject HTML.

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function md(src) {
  const lines = esc(src || "").split("\n");
  let html = "", list = null;
  const inline = t => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd(); let m;
    if (!l.trim()) { close(); continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); const lv = Math.min(6, m[1].length + 2); html += `<h${lv}>${inline(m[2])}</h${lv}>`; continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; continue; }
    close(); html += `<p>${inline(l)}</p>`;
  }
  close();
  return html;
}
