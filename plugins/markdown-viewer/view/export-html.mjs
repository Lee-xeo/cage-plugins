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

/**
 * Build a self-contained offline HTML document string from the rendered Markdown article.
 */
export function buildStandaloneHtml(filePath, contentEl) {
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
  doc.body.appendChild(clone);

  const serialized = "<!doctype html>\n" + new XMLSerializer().serializeToString(doc.documentElement);
  const baseName = (filePath || "document").split("/").pop().replace(/\.(md|markdown|mdx)$/i, "") || "document";
  return {
    filename: `${baseName}.html`,
    html: serialized,
  };
}
