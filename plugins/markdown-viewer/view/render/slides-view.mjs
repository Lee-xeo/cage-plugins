import { parseFrontmatter, renderMarkdown } from "../renderer.mjs";

const SLIDE_THEMES = [
  { id: "light", label: "☀ 简约白" },
  { id: "dark", label: "☾ 暗夜剧场" },
  { id: "ocean", label: "📘 商务深蓝" },
];

/**
 * Parse a Markdown document into slide objects split by standalone `---` outside code fences.
 * Supports speaker notes written as `<!-- note: ... -->` or `<!-- notes: ... -->`.
 */
export function parseMarkdownSlides(markdownText) {
  const normalized = String(markdownText || "").replace(/\r\n?/g, "\n");
  const { frontmatter, body } = parseFrontmatter(normalized);

  let deckTitle = "";
  let defaultTheme = "light";
  if (Array.isArray(frontmatter)) {
    for (const entry of frontmatter) {
      if (entry.key === "title" && typeof entry.value === "string") deckTitle = entry.value;
      if (entry.key === "theme" && ["light", "dark", "ocean"].includes(String(entry.value))) {
        defaultTheme = String(entry.value);
      }
    }
  }

  const lines = body.split("\n");
  const rawChunks = [];
  let buf = [];
  let activeFence = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!activeFence) {
      const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (m) {
        activeFence = { ch: m[1][0], len: m[1].length };
        buf.push(line);
        continue;
      }
      if (/^\s{0,3}---\s*$/.test(line)) {
        rawChunks.push(buf.join("\n"));
        buf = [];
        continue;
      }
    } else {
      if (
        trimmed.length >= activeFence.len &&
        trimmed.split("").every((c) => c === activeFence.ch)
      ) {
        activeFence = null;
      }
    }
    buf.push(line);
  }
  rawChunks.push(buf.join("\n"));

  const slides = [];
  rawChunks.forEach((chunk, idx) => {
    const notesList = [];
    const cleaned = chunk.replace(/<!--\s*notes?\s*:\s*([\s\S]*?)-->/gi, (_m, noteBody) => {
      const t = String(noteBody || "").trim();
      if (t) notesList.push(t);
      return "";
    }).trim();

    if (!cleaned && rawChunks.length > 1) return;

    const hMatch = cleaned.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m);
    const title = hMatch ? hMatch[1].trim() : `幻灯片 ${slides.length + 1}`;
    slides.push({
      index: slides.length + 1,
      title,
      markdown: cleaned || `# ${title}`,
      notes: notesList.join("\n\n"),
    });
  });

  if (slides.length === 0) {
    slides.push({
      index: 1,
      title: deckTitle || "幻灯片 1",
      markdown: "# 空白演示文稿",
      notes: "",
    });
  }

  return {
    title: deckTitle || slides[0].title,
    defaultTheme,
    slides,
  };
}

/**
 * Render an interactive widescreen Markdown slide deck into `containerEl`.
 */
export function renderSlidesDeck(containerEl, markdownText, options = {}) {
  const doc = options.document || globalThis.document;
  const parsed = parseMarkdownSlides(markdownText);
  const slides = parsed.slides;

  let currentIdx = Math.max(0, Math.min(slides.length - 1, Number(options.initialSlide) || 0));
  let activeTheme = parsed.defaultTheme || "light";
  let showNotes = Boolean(options.showNotes);
  let overviewMode = false;

  while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);

  const shell = doc.createElement("div");
  shell.className = `slides-shell theme-${activeTheme}`;

  const topbar = doc.createElement("div");
  topbar.className = "slides-topbar";

  const titleWrap = doc.createElement("div");
  titleWrap.className = "slides-deck-title";
  const badge = doc.createElement("span");
  badge.className = "office-type-pill type-ppt";
  badge.textContent = "📺 演示模式";
  const deckName = doc.createElement("strong");
  deckName.textContent = parsed.title;
  titleWrap.appendChild(badge);
  titleWrap.appendChild(deckName);

  const controls = doc.createElement("div");
  controls.className = "slides-controls";

  const themeGroup = doc.createElement("div");
  themeGroup.className = "mode-group";
  const themeButtons = SLIDE_THEMES.map((t) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "mode-btn" + (t.id === activeTheme ? " active" : "");
    b.textContent = t.label;
    b.addEventListener("click", () => {
      activeTheme = t.id;
      shell.className = `slides-shell theme-${activeTheme}`;
      themeButtons.forEach((btn, idx) => {
        btn.classList.toggle("active", SLIDE_THEMES[idx].id === activeTheme);
      });
    });
    themeGroup.appendChild(b);
    return b;
  });

  const prevBtn = doc.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "ghost-btn compact-btn";
  prevBtn.textContent = "◀ 上一页";

  const pageLabel = doc.createElement("span");
  pageLabel.className = "slides-counter";

  const nextBtn = doc.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "ghost-btn compact-btn";
  nextBtn.textContent = "下一页 ▶";

  const overviewBtn = doc.createElement("button");
  overviewBtn.type = "button";
  overviewBtn.className = "ghost-btn compact-btn";
  overviewBtn.textContent = "📑 总览";

  const notesBtn = doc.createElement("button");
  notesBtn.type = "button";
  notesBtn.className = "ghost-btn compact-btn";
  notesBtn.textContent = "🗒 备注";

  const exitBtn = doc.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "danger-btn compact-btn";
  exitBtn.textContent = "退出放映";
  exitBtn.addEventListener("click", () => {
    if (typeof options.onClose === "function") options.onClose();
  });

  controls.appendChild(themeGroup);
  controls.appendChild(prevBtn);
  controls.appendChild(pageLabel);
  controls.appendChild(nextBtn);
  controls.appendChild(overviewBtn);
  controls.appendChild(notesBtn);
  controls.appendChild(exitBtn);

  topbar.appendChild(titleWrap);
  topbar.appendChild(controls);
  shell.appendChild(topbar);

  const stageWrap = doc.createElement("div");
  stageWrap.className = "slides-stage-wrap";
  shell.appendChild(stageWrap);

  const progressTrack = doc.createElement("div");
  progressTrack.className = "slides-progress-track";
  const progressBar = doc.createElement("div");
  progressBar.className = "slides-progress-bar";
  progressTrack.appendChild(progressBar);
  shell.appendChild(progressTrack);

  containerEl.appendChild(shell);

  function draw() {
    while (stageWrap.firstChild) stageWrap.removeChild(stageWrap.firstChild);
    const slide = slides[currentIdx];
    pageLabel.textContent = `${currentIdx + 1} / ${slides.length}`;
    prevBtn.disabled = currentIdx <= 0;
    nextBtn.disabled = currentIdx >= slides.length - 1;
    notesBtn.classList.toggle("active", showNotes);
    overviewBtn.classList.toggle("active", overviewMode);
    progressBar.style.width = `${Math.round(((currentIdx + 1) / slides.length) * 100)}%`;

    if (overviewMode) {
      const grid = doc.createElement("div");
      grid.className = "slides-overview-grid";
      slides.forEach((s, idx) => {
        const card = doc.createElement("button");
        card.type = "button";
        card.className = "slides-overview-card" + (idx === currentIdx ? " active" : "");
        const num = doc.createElement("span");
        num.className = "slides-overview-num";
        num.textContent = `#${s.index}`;
        const t = doc.createElement("strong");
        t.textContent = s.title;
        card.appendChild(num);
        card.appendChild(t);
        card.addEventListener("click", () => {
          currentIdx = idx;
          overviewMode = false;
          draw();
        });
        grid.appendChild(card);
      });
      stageWrap.appendChild(grid);
      return;
    }

    const frame = doc.createElement("div");
    frame.className = "slides-canvas";
    const bodyEl = doc.createElement("article");
    bodyEl.className = "markdown-body slides-markdown-body";
    renderMarkdown(slide.markdown, bodyEl, {
      document: doc,
      onCopy: options.onCopy,
      onAssetMount: options.onAssetMount,
    });
    frame.appendChild(bodyEl);
    stageWrap.appendChild(frame);

    if (showNotes) {
      const notesBox = doc.createElement("div");
      notesBox.className = "slides-notes-drawer";
      const lbl = doc.createElement("strong");
      lbl.textContent = "演讲者备注：";
      notesBox.appendChild(lbl);
      notesBox.appendChild(
        doc.createTextNode(slide.notes || "（本页未编写备注，可通过 <!-- note: 内容 --> 添加）"),
      );
      stageWrap.appendChild(notesBox);
    }
  }

  function step(delta) {
    const next = Math.max(0, Math.min(slides.length - 1, currentIdx + delta));
    if (next !== currentIdx) {
      currentIdx = next;
      draw();
    }
  }

  prevBtn.addEventListener("click", () => {
    overviewMode = false;
    step(-1);
  });
  nextBtn.addEventListener("click", () => {
    overviewMode = false;
    step(1);
  });
  overviewBtn.addEventListener("click", () => {
    overviewMode = !overviewMode;
    draw();
  });
  notesBtn.addEventListener("click", () => {
    showNotes = !showNotes;
    draw();
  });

  const onKeyDown = (event) => {
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      overviewMode = false;
      step(1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      overviewMode = false;
      step(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (overviewMode) {
        overviewMode = false;
        draw();
      } else if (typeof options.onClose === "function") {
        options.onClose();
      }
    }
  };

  if (options.bindKeyboard !== false && typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("keydown", onKeyDown);
  }

  draw();
  return {
    total: slides.length,
    getCurrentIndex: () => currentIdx,
    step,
    destroy: () => {
      if (options.bindKeyboard !== false && typeof globalThis.removeEventListener === "function") {
        globalThis.removeEventListener("keydown", onKeyDown);
      }
    },
  };
}
