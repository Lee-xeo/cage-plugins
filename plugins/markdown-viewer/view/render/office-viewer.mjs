/**
 * Pure DOM offline viewer for Excel (.xlsx/.xlsm/.csv/.tsv), Word (.docx),
 * PowerPoint (.pptx), and PDF (.pdf) documents. Zero innerHTML, zero network calls.
 */

function colIndexToLetters(idx) {
  let n = idx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

function base64ToDataUrl(b64, mimeType) {
  if (!b64) return "";
  return `data:${mimeType || "application/octet-stream"};base64,${b64}`;
}

function renderExcelViewer(doc, rootEl, data, helpers) {
  const sheets = Array.isArray(data.sheets) ? data.sheets : [];
  if (sheets.length === 0) {
    const p = doc.createElement("p");
    p.className = "muted";
    p.textContent = "该电子表格中没有可展示的工作表。";
    rootEl.appendChild(p);
    return;
  }

  let activeSheetIdx = 0;
  const bar = doc.createElement("div");
  bar.className = "office-subbar";

  const tabs = doc.createElement("div");
  tabs.className = "office-sheet-tabs";
  const stage = doc.createElement("div");
  stage.className = "office-sheet-stage";

  function drawSheet(idx) {
    activeSheetIdx = idx;
    tabs.querySelectorAll("button.office-sheet-tab").forEach((b, i) => {
      b.classList.toggle("active", i === idx);
    });
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    const sheet = sheets[idx];
    if (!sheet) return;

    const info = doc.createElement("div");
    info.className = "office-sheet-meta muted";
    info.textContent = `工作表：${sheet.name} · ${sheet.rowCount} 行 × ${sheet.colCount} 列${sheet.truncated ? "（已截断展示前 300 行 × 50 列）" : ""}`;
    stage.appendChild(info);

    if (!sheet.rows || sheet.rows.length === 0) {
      const emp = doc.createElement("p");
      emp.className = "muted";
      emp.textContent = "当前工作表为空。";
      stage.appendChild(emp);
      return;
    }

    const wrap = doc.createElement("div");
    wrap.className = "office-table-wrap";
    const table = doc.createElement("table");
    table.className = "office-excel-table";

    const thead = doc.createElement("thead");
    const hr = doc.createElement("tr");
    const corner = doc.createElement("th");
    corner.className = "excel-row-num";
    corner.textContent = "#";
    hr.appendChild(corner);
    const cols = Math.max(1, sheet.colCount || 0);
    for (let c = 0; c < cols; c++) {
      const th = doc.createElement("th");
      th.textContent = colIndexToLetters(c);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    sheet.rows.forEach((row, rIdx) => {
      const tr = doc.createElement("tr");
      const rnum = doc.createElement("td");
      rnum.className = "excel-row-num";
      rnum.textContent = String(rIdx + 1);
      tr.appendChild(rnum);
      for (let c = 0; c < cols; c++) {
        const td = doc.createElement("td");
        td.textContent = row[c] !== undefined ? String(row[c]) : "";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    stage.appendChild(wrap);
  }

  sheets.forEach((s, idx) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "office-sheet-tab" + (idx === 0 ? " active" : "");
    btn.textContent = s.name;
    btn.addEventListener("click", () => drawSheet(idx));
    tabs.appendChild(btn);
  });
  bar.appendChild(tabs);

  if (helpers.onCopyMarkdown && data.markdown) {
    const cpBtn = doc.createElement("button");
    cpBtn.type = "button";
    cpBtn.className = "ghost-btn compact-btn";
    cpBtn.textContent = "复制 Markdown 表格";
    cpBtn.addEventListener("click", () => helpers.onCopyMarkdown(data.markdown));
    bar.appendChild(cpBtn);
  }

  rootEl.appendChild(bar);
  rootEl.appendChild(stage);
  drawSheet(0);
}

function renderWordViewer(doc, rootEl, data, createdUrls) {
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const images = data.images && typeof data.images === "object" ? data.images : {};
  const headings = [];

  if (blocks.length === 0) {
    const p = doc.createElement("p");
    p.className = "muted";
    p.textContent = "未在 Word 文档中解析到正文文本。";
    rootEl.appendChild(p);
    return { headings };
  }

  const page = doc.createElement("div");
  page.className = "office-word-page";

  for (const blk of blocks) {
    if (blk.kind === "table") {
      const table = doc.createElement("table");
      table.className = "office-word-table";
      const rows = Array.isArray(blk.rows) ? blk.rows : [];
      rows.forEach((row, rIdx) => {
        const tr = doc.createElement("tr");
        row.forEach((cell) => {
          const cellEl = doc.createElement(rIdx === 0 ? "th" : "td");
          cellEl.textContent = String(cell || "");
          tr.appendChild(cellEl);
        });
        table.appendChild(tr);
      });
      page.appendChild(table);
      continue;
    }

    const isHeading = blk.kind === "heading";
    const lvl = Math.max(1, Math.min(6, Number(blk.level) || 1));
    const el = isHeading
      ? doc.createElement(`h${lvl}`)
      : (blk.kind === "listItem" ? doc.createElement("div") : doc.createElement("p"));

    if (blk.kind === "listItem") {
      el.className = "office-word-listitem";
      el.style.paddingLeft = `${(Number(blk.level) || 0) * 18 + 14}px`;
      const bullet = doc.createElement("span");
      bullet.className = "office-word-bullet";
      bullet.textContent = "•";
      el.appendChild(bullet);
    }

    if (isHeading && blk.text) {
      const hid = `word-h-${headings.length + 1}`;
      el.id = hid;
      headings.push({ level: lvl, text: blk.text, id: hid, key: "" });
    }

    for (const run of blk.runs || []) {
      let node = doc.createTextNode(run.text || "");
      if (run.code) {
        const c = doc.createElement("code");
        c.appendChild(node);
        node = c;
      }
      if (run.strike) {
        const s = doc.createElement("del");
        s.appendChild(node);
        node = s;
      }
      if (run.italic) {
        const em = doc.createElement("em");
        em.appendChild(node);
        node = em;
      }
      if (run.bold) {
        const st = doc.createElement("strong");
        st.appendChild(node);
        node = st;
      }
      if (run.href && /^https?:\/\//i.test(run.href)) {
        const a = doc.createElement("a");
        a.href = run.href;
        a.dataset.mdHref = run.href;
        a.appendChild(node);
        node = a;
      }
      el.appendChild(node);
    }
    if ((blk.runs || []).length > 0) {
      page.appendChild(el);
    }

    for (const rid of blk.imageRids || []) {
      const imgData = images[rid];
      if (!imgData || !imgData.data) continue;
      const fig = doc.createElement("figure");
      fig.className = "md-img-frame";
      const img = doc.createElement("img");
      img.className = "md-img";
      img.src = base64ToDataUrl(imgData.data, imgData.mimeType);
      img.alt = imgData.name || "Word 内嵌图片";
      fig.appendChild(img);
      page.appendChild(fig);
    }
  }

  rootEl.appendChild(page);
  return { headings };
}

function renderPptViewer(doc, rootEl, data) {
  const slides = Array.isArray(data.slides) ? data.slides : [];
  if (slides.length === 0) {
    const p = doc.createElement("p");
    p.className = "muted";
    p.textContent = "未在 PowerPoint 演示文稿中发现幻灯片。";
    rootEl.appendChild(p);
    return { headings: [] };
  }

  let currentIdx = 0;
  let viewMode = "deck"; // "deck" | "all"
  const headings = slides.map((s) => ({
    level: 2,
    text: `${s.index}. ${s.title}`,
    id: `ppt-slide-${s.index}`,
    key: "",
  }));

  const bar = doc.createElement("div");
  bar.className = "office-subbar";
  const leftCtrl = doc.createElement("div");
  leftCtrl.className = "office-ppt-nav";
  const prevBtn = doc.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "ghost-btn compact-btn";
  prevBtn.textContent = "◀ 上一页";
  const pageLabel = doc.createElement("span");
  pageLabel.className = "count";
  const nextBtn = doc.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "ghost-btn compact-btn";
  nextBtn.textContent = "下一页 ▶";
  leftCtrl.appendChild(prevBtn);
  leftCtrl.appendChild(pageLabel);
  leftCtrl.appendChild(nextBtn);

  const rightCtrl = doc.createElement("div");
  rightCtrl.className = "mode-group";
  const deckBtn = doc.createElement("button");
  deckBtn.type = "button";
  deckBtn.className = "mode-btn active";
  deckBtn.textContent = "📺 逐页演示";
  const allBtn = doc.createElement("button");
  allBtn.type = "button";
  allBtn.className = "mode-btn";
  allBtn.textContent = "📑 全页纵览";
  rightCtrl.appendChild(deckBtn);
  rightCtrl.appendChild(allBtn);

  bar.appendChild(leftCtrl);
  bar.appendChild(rightCtrl);
  rootEl.appendChild(bar);

  const stage = doc.createElement("div");
  stage.className = "office-ppt-stage";
  rootEl.appendChild(stage);

  function buildSlideCard(slide) {
    const card = doc.createElement("section");
    card.className = "office-ppt-card";
    card.id = `ppt-slide-${slide.index}`;

    const header = doc.createElement("div");
    header.className = "office-ppt-card-head";
    const num = doc.createElement("span");
    num.className = "office-ppt-num";
    num.textContent = `Slide ${slide.index}`;
    const title = doc.createElement("h2");
    title.className = "office-ppt-title";
    title.textContent = slide.title || `幻灯片 ${slide.index}`;
    header.appendChild(num);
    header.appendChild(title);
    card.appendChild(header);

    const body = doc.createElement("div");
    body.className = "office-ppt-body";
    if (slide.bullets && slide.bullets.length > 0) {
      const ul = doc.createElement("ul");
      ul.className = "office-ppt-bullets";
      for (const b of slide.bullets) {
        const li = doc.createElement("li");
        li.style.marginLeft = `${(Number(b.level) || 0) * 18}px`;
        li.textContent = b.text;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    for (const tbl of slide.tables || []) {
      const table = doc.createElement("table");
      table.className = "office-word-table";
      tbl.forEach((row, rIdx) => {
        const tr = doc.createElement("tr");
        row.forEach((cell) => {
          const td = doc.createElement(rIdx === 0 ? "th" : "td");
          td.textContent = String(cell || "");
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      body.appendChild(table);
    }

    if (slide.images && slide.images.length > 0) {
      const imgGrid = doc.createElement("div");
      imgGrid.className = "office-ppt-imgs";
      for (const im of slide.images) {
        const img = doc.createElement("img");
        img.className = "md-img";
        img.src = base64ToDataUrl(im.data, im.mimeType);
        img.alt = im.name || `Slide ${slide.index} 图片`;
        imgGrid.appendChild(img);
      }
      body.appendChild(imgGrid);
    }

    if (
      (!slide.bullets || slide.bullets.length === 0) &&
      (!slide.tables || slide.tables.length === 0) &&
      (!slide.images || slide.images.length === 0)
    ) {
      const empty = doc.createElement("p");
      empty.className = "muted";
      empty.textContent = "（本页仅含版式或图形元素）";
      body.appendChild(empty);
    }
    card.appendChild(body);

    if (slide.notes) {
      const notes = doc.createElement("div");
      notes.className = "office-ppt-notes";
      const lbl = doc.createElement("strong");
      lbl.textContent = "演讲者备注：";
      notes.appendChild(lbl);
      notes.appendChild(doc.createTextNode(slide.notes));
      card.appendChild(notes);
    }

    return card;
  }

  function renderView() {
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    leftCtrl.hidden = viewMode !== "deck";
    pageLabel.textContent = `第 ${currentIdx + 1} / ${slides.length} 页`;
    prevBtn.disabled = currentIdx <= 0;
    nextBtn.disabled = currentIdx >= slides.length - 1;

    if (viewMode === "deck") {
      stage.appendChild(buildSlideCard(slides[currentIdx]));
      const strip = doc.createElement("div");
      strip.className = "office-ppt-strip";
      slides.forEach((s, idx) => {
        const pill = doc.createElement("button");
        pill.type = "button";
        pill.className = "office-ppt-thumb" + (idx === currentIdx ? " active" : "");
        pill.textContent = `${s.index}. ${s.title}`;
        pill.title = s.title;
        pill.addEventListener("click", () => {
          currentIdx = idx;
          renderView();
        });
        strip.appendChild(pill);
      });
      stage.appendChild(strip);
    } else {
      for (const s of slides) {
        stage.appendChild(buildSlideCard(s));
      }
    }
  }

  prevBtn.addEventListener("click", () => {
    if (currentIdx > 0) {
      currentIdx -= 1;
      renderView();
    }
  });
  nextBtn.addEventListener("click", () => {
    if (currentIdx < slides.length - 1) {
      currentIdx += 1;
      renderView();
    }
  });
  deckBtn.addEventListener("click", () => {
    viewMode = "deck";
    deckBtn.classList.add("active");
    allBtn.classList.remove("active");
    renderView();
  });
  allBtn.addEventListener("click", () => {
    viewMode = "all";
    allBtn.classList.add("active");
    deckBtn.classList.remove("active");
    renderView();
  });

  renderView();
  return { headings };
}

function renderPdfViewer(doc, rootEl, data) {
  const bar = doc.createElement("div");
  bar.className = "office-subbar";

  const info = doc.createElement("span");
  info.className = "count";
  info.textContent = `${data.title || "PDF 文档"}${data.pageCount ? ` · 约 ${data.pageCount} 页` : ""}`;

  const modePill = doc.createElement("span");
  modePill.className = "office-sheet-meta muted";
  modePill.textContent = "📝 提取文本视图";

  bar.appendChild(info);
  bar.appendChild(modePill);
  rootEl.appendChild(bar);

  const stage = doc.createElement("div");
  stage.className = "office-pdf-stage";
  const pre = doc.createElement("pre");
  pre.className = "office-pdf-text";
  pre.textContent = data.extractedText || "（未能从该 PDF 流中提取出纯文本，可能是扫描图片型或自定义字库编码 PDF）";
  stage.appendChild(pre);
  rootEl.appendChild(stage);
}

export function renderOfficeDocument(containerEl, data, options = {}) {
  const doc = options.document || globalThis.document;
  while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);

  const banner = doc.createElement("div");
  banner.className = "office-header-card";

  const left = doc.createElement("div");
  left.className = "office-header-info";
  const badge = doc.createElement("span");
  badge.className = `office-type-pill type-${data.docType || "office"}`;
  const labels = {
    excel: "📊 Excel 表格",
    word: "📝 Word 文档",
    ppt: "📽 PPT 演示文稿",
    pdf: "📕 PDF 文档",
  };
  badge.textContent = labels[data.docType] || (data.format || "OFFICE").toUpperCase();
  const title = doc.createElement("strong");
  title.textContent = data.path || "文档预览";
  left.appendChild(badge);
  left.appendChild(title);

  const actions = doc.createElement("div");
  actions.className = "office-header-actions";
  if (typeof options.onConvertToMarkdown === "function" && data.markdown) {
    const convBtn = doc.createElement("button");
    convBtn.type = "button";
    convBtn.className = "primary-btn compact-btn";
    convBtn.textContent = "转为 Markdown 笔记";
    convBtn.title = "提取内容并在同目录生成可编辑的 .md 笔记";
    convBtn.addEventListener("click", () => options.onConvertToMarkdown(data));
    actions.appendChild(convBtn);
  }
  banner.appendChild(left);
  banner.appendChild(actions);
  containerEl.appendChild(banner);

  const bodyWrap = doc.createElement("div");
  bodyWrap.className = "office-viewer-body";
  containerEl.appendChild(bodyWrap);

  let headings = [];
  if (data.docType === "excel") {
    renderExcelViewer(doc, bodyWrap, data, { onCopyMarkdown: options.onCopyMarkdown });
  } else if (data.docType === "word") {
    headings = renderWordViewer(doc, bodyWrap, data).headings;
  } else if (data.docType === "ppt") {
    headings = renderPptViewer(doc, bodyWrap, data).headings;
  } else if (data.docType === "pdf") {
    renderPdfViewer(doc, bodyWrap, data);
  } else {
    const p = doc.createElement("p");
    p.className = "muted";
    p.textContent = "暂不支持预览此文件格式。";
    bodyWrap.appendChild(p);
  }

  return {
    headings,
    destroy: () => {},
  };
}
