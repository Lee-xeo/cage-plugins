function clearMarks(container) {
  const marks = container.querySelectorAll("mark.md-find-hit");
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parent.normalize();
  }
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".md-code-header, .md-copy-btn, button")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}

export function highlightMatches(container, query, caseSensitive = false) {
  clearMarks(container);
  const term = String(query || "");
  if (!term) return [];

  const needle = caseSensitive ? term : term.toLowerCase();
  const textNodes = collectTextNodes(container);
  const hits = [];

  for (const node of textNodes) {
    const text = node.nodeValue;
    const hay = caseSensitive ? text : text.toLowerCase();
    let idx = hay.indexOf(needle);
    if (idx === -1) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    while (idx !== -1) {
      if (idx > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
      }
      const mark = document.createElement("mark");
      mark.className = "md-find-hit";
      mark.textContent = text.slice(idx, idx + term.length);
      frag.appendChild(mark);
      hits.push(mark);
      cursor = idx + term.length;
      idx = hay.indexOf(needle, cursor);
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }

  return hits;
}

export function locateSourceLine(container, targetLine) {
  if (!targetLine || targetLine < 1) return null;
  const candidates = [...container.querySelectorAll("[data-source-line]")];
  if (candidates.length === 0) return null;

  let best = null;
  let bestSpan = Infinity;
  let nearest = null;
  let nearestDist = Infinity;

  for (const el of candidates) {
    const start = Number.parseInt(el.dataset.sourceLine, 10);
    const end = Number.parseInt(el.dataset.sourceEndLine || el.dataset.sourceLine, 10);
    if (Number.isNaN(start)) continue;

    if (targetLine >= start && targetLine <= end) {
      const span = end - start;
      if (span <= bestSpan) {
        best = el;
        bestSpan = span;
      }
    }
    const dist = Math.abs(start - targetLine);
    if (dist < nearestDist) {
      nearest = el;
      nearestDist = dist;
    }
  }

  const chosen = best || nearest;
  if (!chosen) return null;

  chosen.scrollIntoView({ behavior: "smooth", block: "center" });
  chosen.classList.remove("md-line-pulse");
  void chosen.offsetWidth;
  chosen.classList.add("md-line-pulse");
  return chosen;
}

export function createFindBar({
  barEl,
  inputEl,
  countEl,
  prevBtn,
  nextBtn,
  caseBtn,
  closeBtn,
  containerEl,
}) {
  let hits = [];
  let activeIndex = -1;
  let caseSensitive = false;

  function updateCount() {
    if (!inputEl.value) {
      countEl.textContent = "0 / 0";
      return;
    }
    countEl.textContent = hits.length === 0 ? "0 / 0" : `${activeIndex + 1} / ${hits.length}`;
  }

  function focusHit(index) {
    if (hits.length === 0) {
      activeIndex = -1;
      updateCount();
      return;
    }
    if (activeIndex >= 0 && hits[activeIndex]) {
      hits[activeIndex].classList.remove("active");
    }
    activeIndex = ((index % hits.length) + hits.length) % hits.length;
    const target = hits[activeIndex];
    target.classList.add("active");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    updateCount();
  }

  function run(preferNearEl = null) {
    hits = highlightMatches(containerEl, inputEl.value, caseSensitive);
    if (hits.length === 0) {
      activeIndex = -1;
      updateCount();
      return;
    }
    let startIdx = 0;
    if (preferNearEl) {
      const idx = hits.findIndex((m) => preferNearEl.contains(m));
      if (idx !== -1) startIdx = idx;
    }
    focusHit(startIdx);
  }

  function open(initialQuery = "", preferNearEl = null, opts = {}) {
    barEl.hidden = false;
    if (typeof opts.caseSensitive === "boolean") {
      caseSensitive = opts.caseSensitive;
      caseBtn.classList.toggle("active", caseSensitive);
    }
    if (initialQuery) inputEl.value = initialQuery;
    run(preferNearEl);
    inputEl.focus();
    inputEl.select();
  }

  function close() {
    barEl.hidden = true;
    clearMarks(containerEl);
    hits = [];
    activeIndex = -1;
    updateCount();
  }

  inputEl.addEventListener("input", () => run());
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      focusHit(event.shiftKey ? activeIndex - 1 : activeIndex + 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  prevBtn.addEventListener("click", () => focusHit(activeIndex - 1));
  nextBtn.addEventListener("click", () => focusHit(activeIndex + 1));
  caseBtn.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseBtn.classList.toggle("active", caseSensitive);
    run();
  });
  closeBtn.addEventListener("click", () => close());

  return {
    open,
    close,
    refresh: () => {
      if (!barEl.hidden && inputEl.value) run();
    },
    isOpen: () => !barEl.hidden,
  };
}
