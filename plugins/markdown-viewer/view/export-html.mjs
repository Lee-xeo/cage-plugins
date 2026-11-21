function collectInlineStyles() {
  const chunks = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        chunks.push(rule.cssText);
      }
    } catch {
      // Ignore inaccessible stylesheets
    }
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const vars = [
    "paper", "ink", "strong", "muted", "line", "chrome", "hover",
    "selected", "accent", "link", "success", "danger",
  ]
    .map((k) => `--${k}: ${rootStyle.getPropertyValue(`--${k}`).trim()};`)
    .join(" ");
  return `:root { ${vars} }\n` + chunks.join("\n");
}

function inlineBlobImages(rootClone) {
  const imgs = rootClone.querySelectorAll("img");
  for (const img of imgs) {
    const src = img.getAttribute("src") || "";
    if (!src.startsWith("blob:")) continue;
    try {
      const orig = [...document.querySelectorAll("#doc-content img")].find((el) => el.getAttribute("src") === src);
      if (orig && orig.complete && orig.naturalWidth > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = orig.naturalWidth;
        canvas.height = orig.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(orig, 0, 0);
          img.setAttribute("src", canvas.toDataURL("image/png"));
        }
      }
    } catch {
      // Keep original src if conversion fails
    }
  }
}

/**
 * Export the rendered Markdown article as a self-contained offline HTML file.
 */
export function exportStandaloneHtml(filePath, contentEl) {
  const doc = document.implementation.createHTMLDocument(filePath || "Markdown Export");
  const metaCharset = doc.createElement("meta");
  metaCharset.setAttribute("charset", "utf-8");
  doc.head.appendChild(metaCharset);

  const styleEl = doc.createElement("style");
  styleEl.textContent = collectInlineStyles() + "\nbody { max-width: 860px; margin: 28px auto; padding: 0 20px; }";
  doc.head.appendChild(styleEl);

  const clone = contentEl.cloneNode(true);
  for (const btn of clone.querySelectorAll(".md-copy-btn, .md-mermaid-actions, button.md-tag")) {
    if (btn.classList.contains("md-tag")) continue;
    btn.remove();
  }
  inlineBlobImages(clone);
  doc.body.appendChild(clone);

  const serialized = "<!doctype html>\n" + new XMLSerializer().serializeToString(doc.documentElement);
  const blob = new Blob([serialized], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const baseName = (filePath || "document").split("/").pop().replace(/\.(md|markdown|mdx)$/i, "") || "document";

  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
