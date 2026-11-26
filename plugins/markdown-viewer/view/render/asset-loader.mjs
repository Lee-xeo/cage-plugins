const MAX_CACHE_ENTRIES = 40;

/**
 * Offline project image loader with LRU data URL cache.
 * SVG assets are always mounted inside <img> so scripts inside SVGs never execute.
 */
export function createAssetLoader(requestFn, getScopeFn = null) {
  const cache = new Map();

  function touchCache(key, entry) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  async function loadAsset(docPath, assetHref) {
    const scope = typeof getScopeFn === "function" ? getScopeFn() : "project";
    const docDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
    const key = `${scope}::${docDir}::${assetHref}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      touchCache(key, hit);
      return hit;
    }

    let result;
    if (scope === "all") {
      result = await requestFn("tools/call", {
        name: "read_markdown_asset",
        arguments: { docPath, assetHref, scope: "all" },
      });
    } else {
      result = await requestFn("tools/call", {
        name: "read_markdown_asset",
        arguments: { docPath, assetHref },
      });
    }
    if (result.isError) {
      throw new Error(result.content?.[0]?.text || "无法加载图片");
    }
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    const dataUrl = `data:${data.mimeType || "application/octet-stream"};base64,${data.data}`;
    const entry = { dataUrl, resolvedPath: data.resolvedPath, bytes: data.bytes };
    touchCache(key, entry);
    return entry;
  }

  async function mountProjectImage(figureEl, docPath, assetHref, altText, onZoom = null) {
    if (!docPath) {
      renderFallback(figureEl, altText, assetHref, "短文预览模式无法读取项目图片");
      return;
    }
    try {
      const entry = await loadAsset(docPath, assetHref);
      while (figureEl.firstChild) figureEl.removeChild(figureEl.firstChild);
      const img = document.createElement("img");
      img.className = "md-img";
      img.src = entry.dataUrl;
      img.alt = altText || "";
      img.title = entry.resolvedPath ? `${entry.resolvedPath}（点击放大）` : assetHref;
      if (typeof onZoom === "function") {
        img.classList.add("zoomable");
        img.addEventListener("click", () => onZoom(entry.dataUrl, altText || entry.resolvedPath || assetHref, entry.resolvedPath || assetHref));
      }
      figureEl.appendChild(img);
      const cap = document.createElement("figcaption");
      cap.className = "md-img-caption";
      const left = document.createElement("span");
      left.textContent = altText || entry.resolvedPath || assetHref;
      const right = document.createElement("span");
      right.textContent = `离线项目资源 · ${entry.resolvedPath || assetHref}`;
      cap.append(left, right);
      figureEl.appendChild(cap);
    } catch (err) {
      renderFallback(figureEl, altText, assetHref, err.message);
    }
  }

  function renderFallback(figureEl, altText, assetHref, reason) {
    while (figureEl.firstChild) figureEl.removeChild(figureEl.firstChild);
    figureEl.className = "md-img-fallback";
    const icon = document.createElement("span");
    icon.className = "md-img-fallback-icon";
    icon.textContent = "🛡";
    figureEl.appendChild(icon);

    const body = document.createElement("div");
    body.className = "md-img-fallback-body";
    const title = document.createElement("div");
    title.className = "md-img-fallback-title";
    title.textContent = altText ? `图片不可用：${altText}` : "图片不可用";
    body.appendChild(title);

    const detail = document.createElement("div");
    detail.className = "md-img-fallback-detail";
    detail.textContent = `${assetHref} — ${reason}`;
    body.appendChild(detail);
    figureEl.appendChild(body);
  }

  function clear() {
    cache.clear();
  }

  return { mountProjectImage, clear };
}
