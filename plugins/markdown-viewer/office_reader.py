"""Pure Python standard-library offline reader for Excel, Word, PowerPoint, PDF, and CSV files."""

import base64
import csv
import io
import os
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
import zlib

OFFICE_EXTENSIONS = {".xlsx", ".xlsm", ".csv", ".tsv", ".docx", ".pptx", ".pdf"}
MAX_OFFICE_BYTES = 16 * 1024 * 1024
MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024
MAX_EMBED_IMAGE_BYTES = 4 * 1024 * 1024
MAX_EMBED_IMAGES = 24
MAX_XLSX_SHEETS = 20
MAX_XLSX_ROWS = 300
MAX_XLSX_COLS = 50
MAX_PDF_DECOMP_BYTES = 2 * 1024 * 1024

IMAGE_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
}


def doc_type_for_path(rel_path: str) -> str:
    ext = os.path.splitext(rel_path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".csv", ".tsv"):
        return "excel"
    if ext == ".docx":
        return "word"
    if ext == ".pptx":
        return "ppt"
    if ext == ".pdf":
        return "pdf"
    return "markdown"


def _local_tag(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _safe_read_zip_bytes(zf: zipfile.ZipFile, member: str, limit: int = MAX_ZIP_ENTRY_BYTES) -> bytes:
    with zf.open(member, "r") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError(f"Embedded entry '{member}' exceeds maximum safe size.")
    return raw


def _decode_xml_for_scan(raw: bytes) -> str:
    if raw.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        return raw.decode("utf-32", errors="ignore")
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="ignore")
    if b"\x00" in raw[:64]:
        encoding = "utf-16-le" if raw[1:2] == b"\x00" else "utf-16-be"
        try:
            return raw.decode(encoding, errors="ignore")
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="ignore")


def _parse_xml(raw: bytes) -> ET.Element:
    decoded = _decode_xml_for_scan(raw)
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", decoded, flags=re.IGNORECASE):
        raise ValueError("Unsafe XML DOCTYPE or ENTITY declaration rejected.")
    return ET.fromstring(raw)


def _col_letters_to_index(col_str: str) -> int:
    idx = 0
    for ch in col_str:
        if "A" <= ch <= "Z":
            idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return max(0, idx - 1)


def _cell_ref_to_col(ref: str) -> int:
    letters = []
    for ch in ref:
        if ch.isalpha():
            letters.append(ch.upper())
        else:
            break
    return _col_letters_to_index("".join(letters)) if letters else -1


def _parse_rels(zf: zipfile.ZipFile, rels_path: str) -> dict[str, tuple[str, str]]:
    """Return mapping rId -> (type_suffix, target)."""
    if rels_path not in zf.namelist():
        return {}
    root = _parse_xml(_safe_read_zip_bytes(zf, rels_path))
    out: dict[str, tuple[str, str]] = {}
    for rel in root:
        if _local_tag(rel.tag) != "Relationship":
            continue
        rid = rel.attrib.get("Id", "")
        rtype = rel.attrib.get("Type", "").rsplit("/", 1)[-1]
        target = rel.attrib.get("Target", "")
        if rid and target:
            out[rid] = (rtype, target)
    return out


def _resolve_zip_target(base_dir: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    joined = posixpath.normpath(posixpath.join(base_dir, target))
    return joined.lstrip("/")


def _read_delimited(file_path: str, ext: str) -> dict:
    with open(file_path, "rb") as handle:
        raw = handle.read(MAX_OFFICE_BYTES + 1)
    if len(raw) > MAX_OFFICE_BYTES:
        raise ValueError("Spreadsheet file exceeds maximum size of 16 MiB.")
    if b"\x00" in raw:
        raise ValueError("Spreadsheet file appears to contain binary NUL bytes.")
    text = raw.decode("utf-8", errors="replace")
    delimiter = "\t" if ext == ".tsv" else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = []
    truncated = False
    for r_idx, row in enumerate(reader):
        if r_idx >= MAX_XLSX_ROWS:
            truncated = True
            break
        rows.append([str(c) for c in row[:MAX_XLSX_COLS]])
        if len(row) > MAX_XLSX_COLS:
            truncated = True
    sheet_name = "TSV" if ext == ".tsv" else "CSV"
    md_lines = _rows_to_markdown_table(rows[:30])
    return {
        "docType": "excel",
        "format": ext.lstrip("."),
        "sheets": [{
            "name": sheet_name,
            "rows": rows,
            "rowCount": len(rows),
            "colCount": max((len(r) for r in rows), default=0),
            "truncated": truncated,
        }],
        "markdown": f"# {os.path.basename(file_path)}\n\n" + "\n".join(md_lines) + "\n",
    }


def _rows_to_markdown_table(rows: list[list[str]]) -> list[str]:
    if not rows:
        return ["_（空工作表）_"]
    cols = max((len(r) for r in rows), default=0)
    if cols == 0:
        return ["_（空工作表）_"]
    norm = [r + [""] * (cols - len(r)) for r in rows]
    esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
    out = [
        "| " + " | ".join(esc(c) for c in norm[0]) + " |",
        "| " + " | ".join("---" for _ in range(cols)) + " |",
    ]
    for r in norm[1:]:
        out.append("| " + " | ".join(esc(c) for c in r) + " |")
    return out


def _read_xlsx(file_path: str, ext: str) -> dict:
    if ext in (".csv", ".tsv"):
        return _read_delimited(file_path, ext)

    with zipfile.ZipFile(file_path, "r") as zf:
        names = set(zf.namelist())
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in names:
            ss_root = _parse_xml(_safe_read_zip_bytes(zf, "xl/sharedStrings.xml"))
            for si in ss_root:
                if _local_tag(si.tag) != "si":
                    continue
                parts = [el.text or "" for el in si.iter() if _local_tag(el.tag) == "t"]
                shared_strings.append("".join(parts))

        sheet_targets: list[tuple[str, str]] = []
        if "xl/workbook.xml" in names:
            wb_root = _parse_xml(_safe_read_zip_bytes(zf, "xl/workbook.xml"))
            rels = _parse_rels(zf, "xl/_rels/workbook.xml.rels")
            for elem in wb_root.iter():
                if _local_tag(elem.tag) == "sheet":
                    sname = elem.attrib.get("name") or "Sheet"
                    rid = ""
                    for k, v in elem.attrib.items():
                        if k == "id" or k.endswith("}id"):
                            rid = v
                            break
                    target = ""
                    if rid and rid in rels:
                        target = _resolve_zip_target("xl", rels[rid][1])
                    if target and target in names:
                        sheet_targets.append((sname, target))

        if not sheet_targets:
            for nm in sorted(names):
                if nm.startswith("xl/worksheets/sheet") and nm.endswith(".xml"):
                    sheet_targets.append((posixpath.basename(nm).replace(".xml", ""), nm))

        sheets = []
        md_sections = [f"# {os.path.basename(file_path)}", ""]
        for sname, spath in sheet_targets[:MAX_XLSX_SHEETS]:
            s_root = _parse_xml(_safe_read_zip_bytes(zf, spath))
            parsed_rows: list[list[str]] = []
            truncated = False
            sheet_data = None
            for child in s_root:
                if _local_tag(child.tag) == "sheetData":
                    sheet_data = child
                    break
            if sheet_data is not None:
                for row_el in sheet_data:
                    if _local_tag(row_el.tag) != "row":
                        continue
                    if len(parsed_rows) >= MAX_XLSX_ROWS:
                        truncated = True
                        break
                    row_cells: dict[int, str] = {}
                    seq_col = 0
                    for c_el in row_el:
                        if _local_tag(c_el.tag) != "c":
                            continue
                        ref = c_el.attrib.get("r", "")
                        col_idx = _cell_ref_to_col(ref)
                        if col_idx < 0:
                            col_idx = seq_col
                        seq_col = col_idx + 1
                        if col_idx >= MAX_XLSX_COLS:
                            truncated = True
                            continue

                        ctype = c_el.attrib.get("t", "")
                        val_text = ""
                        v_el = None
                        is_el = None
                        for sub in c_el:
                            lt = _local_tag(sub.tag)
                            if lt == "v":
                                v_el = sub
                            elif lt == "is":
                                is_el = sub

                        if ctype == "s" and v_el is not None and v_el.text:
                            try:
                                ss_idx = int(v_el.text.strip())
                                val_text = shared_strings[ss_idx] if 0 <= ss_idx < len(shared_strings) else ""
                            except ValueError:
                                val_text = v_el.text or ""
                        elif ctype == "inlineStr" and is_el is not None:
                            val_text = "".join(t.text or "" for t in is_el.iter() if _local_tag(t.tag) == "t")
                        elif ctype == "b" and v_el is not None:
                            val_text = "TRUE" if (v_el.text or "").strip() == "1" else "FALSE"
                        elif v_el is not None and v_el.text is not None:
                            val_text = v_el.text
                        row_cells[col_idx] = val_text

                    if row_cells:
                        max_c = min(MAX_XLSX_COLS - 1, max(row_cells.keys()))
                        row_arr = [row_cells.get(i, "") for i in range(max_c + 1)]
                        parsed_rows.append(row_arr)
                    else:
                        parsed_rows.append([])

            col_count = max((len(r) for r in parsed_rows), default=0)
            norm_rows = [r + [""] * (col_count - len(r)) for r in parsed_rows]
            sheets.append({
                "name": sname,
                "rows": norm_rows,
                "rowCount": len(norm_rows),
                "colCount": col_count,
                "truncated": truncated,
            })
            md_sections.append(f"## {sname}")
            md_sections.append("")
            md_sections.extend(_rows_to_markdown_table(norm_rows[:30]))
            md_sections.append("")

        return {
            "docType": "excel",
            "format": ext.lstrip("."),
            "sheets": sheets,
            "markdown": "\n".join(md_sections).strip() + "\n",
        }


def _collect_docx_paragraph(p_el: ET.Element, rels: dict[str, tuple[str, str]]) -> dict:
    style_val = ""
    is_list = False
    list_level = 0
    runs: list[dict] = []
    image_rids: list[str] = []

    ppr = None
    for child in p_el:
        if _local_tag(child.tag) == "pPr":
            ppr = child
            break
    if ppr is not None:
        for sub in ppr:
            lt = _local_tag(sub.tag)
            if lt == "pStyle":
                for k, v in sub.attrib.items():
                    if k == "val" or k.endswith("}val"):
                        style_val = v
            elif lt == "numPr":
                is_list = True
                for nsub in sub:
                    if _local_tag(nsub.tag) == "ilvl":
                        for k, v in nsub.attrib.items():
                            if k == "val" or k.endswith("}val"):
                                try:
                                    list_level = max(0, min(5, int(v)))
                                except ValueError:
                                    pass

    def extract_run(r_el: ET.Element, href: str = ""):
        bold = False
        italic = False
        strike = False
        code = False
        for sub in r_el:
            lt = _local_tag(sub.tag)
            if lt == "rPr":
                for prop in sub:
                    pt = _local_tag(prop.tag)
                    if pt == "b":
                        bold = True
                    elif pt == "i":
                        italic = True
                    elif pt == "strike":
                        strike = True
                    elif pt == "rFonts":
                        font_str = " ".join(prop.attrib.values()).lower()
                        if any(k in font_str for k in ("consolas", "courier", "mono", "menlo")):
                            code = True
            elif lt in ("drawing", "pict"):
                for blip in sub.iter():
                    bt = _local_tag(blip.tag)
                    if bt in ("blip", "imagedata"):
                        for k, v in blip.attrib.items():
                            if k.endswith("}embed") or k.endswith("}id") or k == "id":
                                if v:
                                    image_rids.append(v)

        text_parts = []
        for sub in r_el:
            lt = _local_tag(sub.tag)
            if lt == "t":
                text_parts.append(sub.text or "")
            elif lt == "tab":
                text_parts.append("\t")
            elif lt == "br":
                text_parts.append("\n")
        txt = "".join(text_parts)
        if txt:
            runs.append({
                "text": txt,
                "bold": bold,
                "italic": italic,
                "strike": strike,
                "code": code,
                "href": href,
            })

    for child in p_el:
        lt = _local_tag(child.tag)
        if lt == "r":
            extract_run(child)
        elif lt == "hyperlink":
            rid = ""
            for k, v in child.attrib.items():
                if k == "id" or k.endswith("}id"):
                    rid = v
                    break
            href = ""
            if rid and rid in rels and rels[rid][0] == "hyperlink":
                href = rels[rid][1]
            for sub in child:
                if _local_tag(sub.tag) == "r":
                    extract_run(sub, href=href)

    heading_level = 0
    low_style = style_val.lower()
    if low_style == "title":
        heading_level = 1
    elif low_style == "subtitle":
        heading_level = 2
    else:
        m = re.match(r"heading\s*([1-6])", low_style)
        if m:
            heading_level = int(m.group(1))

    plain_text = "".join(r["text"] for r in runs).strip()
    return {
        "kind": "heading" if heading_level > 0 else ("listItem" if is_list else "paragraph"),
        "level": heading_level if heading_level > 0 else list_level,
        "text": plain_text,
        "runs": runs,
        "imageRids": image_rids,
    }


def _extract_zip_images(zf: zipfile.ZipFile, base_dir: str, rels: dict[str, tuple[str, str]]) -> dict[str, dict]:
    images: dict[str, dict] = {}
    names = set(zf.namelist())
    for rid, (rtype, target) in rels.items():
        if len(images) >= MAX_EMBED_IMAGES:
            break
        if rtype != "image" or target.startswith(("http://", "https://")):
            continue
        zip_path = _resolve_zip_target(base_dir, target)
        if zip_path not in names:
            continue
        ext = os.path.splitext(zip_path)[1].lower()
        mime = IMAGE_MIME_BY_EXT.get(ext)
        if not mime:
            continue
        try:
            raw = _safe_read_zip_bytes(zf, zip_path, limit=MAX_EMBED_IMAGE_BYTES)
        except ValueError:
            continue
        images[rid] = {
            "name": posixpath.basename(zip_path),
            "mimeType": mime,
            "data": base64.b64encode(raw).decode("ascii"),
        }
    return images


def _read_docx(file_path: str) -> dict:
    with zipfile.ZipFile(file_path, "r") as zf:
        names = set(zf.namelist())
        if "word/document.xml" not in names:
            raise ValueError("Invalid DOCX archive: word/document.xml is missing.")
        rels = _parse_rels(zf, "word/_rels/document.xml.rels")
        images = _extract_zip_images(zf, "word", rels)
        doc_root = _parse_xml(_safe_read_zip_bytes(zf, "word/document.xml"))

        body = None
        for child in doc_root:
            if _local_tag(child.tag) == "body":
                body = child
                break
        if body is None:
            raise ValueError("Invalid DOCX document: body element is missing.")

        blocks: list[dict] = []
        md_lines: list[str] = []

        for child in body:
            lt = _local_tag(child.tag)
            if lt == "p":
                p = _collect_docx_paragraph(child, rels)
                if p["text"] or p["imageRids"]:
                    blocks.append(p)
                    if p["kind"] == "heading":
                        md_lines.append("#" * p["level"] + " " + p["text"])
                        md_lines.append("")
                    elif p["kind"] == "listItem":
                        indent = "  " * p["level"]
                        md_lines.append(f"{indent}- {p['text']}")
                    elif p["text"]:
                        md_lines.append(p["text"])
                        md_lines.append("")
            elif lt == "tbl":
                rows: list[list[str]] = []
                for tr in child:
                    if _local_tag(tr.tag) != "tr":
                        continue
                    row_vals: list[str] = []
                    for tc in tr:
                        if _local_tag(tc.tag) != "tc":
                            continue
                        cell_texts = []
                        for p_el in tc:
                            if _local_tag(p_el.tag) == "p":
                                cell_p = _collect_docx_paragraph(p_el, rels)
                                if cell_p["text"]:
                                    cell_texts.append(cell_p["text"])
                        row_vals.append(" / ".join(cell_texts))
                    if row_vals:
                        rows.append(row_vals)
                if rows:
                    blocks.append({"kind": "table", "rows": rows})
                    md_lines.extend(_rows_to_markdown_table(rows))
                    md_lines.append("")

        return {
            "docType": "word",
            "format": "docx",
            "blocks": blocks,
            "images": images,
            "markdown": "\n".join(md_lines).strip() + "\n",
        }


def _extract_ppt_text_paras(tx_body: ET.Element) -> list[dict]:
    paras: list[dict] = []
    for p_el in tx_body:
        if _local_tag(p_el.tag) != "p":
            continue
        lvl = 0
        for sub in p_el:
            if _local_tag(sub.tag) == "pPr":
                try:
                    lvl = max(0, min(5, int(sub.attrib.get("lvl", "0"))))
                except ValueError:
                    lvl = 0
                break
        texts = []
        for sub in p_el:
            lt = _local_tag(sub.tag)
            if lt in ("r", "fld"):
                for t_el in sub:
                    if _local_tag(t_el.tag) == "t":
                        texts.append(t_el.text or "")
            elif lt == "br":
                texts.append("\n")
        joined = "".join(texts).strip()
        if joined:
            paras.append({"text": joined, "level": lvl})
    return paras


def _read_pptx(file_path: str) -> dict:
    with zipfile.ZipFile(file_path, "r") as zf:
        names = set(zf.namelist())
        slide_paths: list[str] = []

        if "ppt/presentation.xml" in names:
            pres_root = _parse_xml(_safe_read_zip_bytes(zf, "ppt/presentation.xml"))
            pres_rels = _parse_rels(zf, "ppt/_rels/presentation.xml.rels")
            for el in pres_root.iter():
                if _local_tag(el.tag) == "sldId":
                    rid = ""
                    for k, v in el.attrib.items():
                        if k == "id" or k.endswith("}id"):
                            rid = v
                            break
                    if rid and rid in pres_rels:
                        target = _resolve_zip_target("ppt", pres_rels[rid][1])
                        if target in names:
                            slide_paths.append(target)

        if not slide_paths:
            candidates = [
                nm for nm in names if re.match(r"^ppt/slides/slide\d+\.xml$", nm)
            ]
            candidates.sort(key=lambda s: int(re.search(r"(\d+)\.xml$", s).group(1)))
            slide_paths = candidates

        slides: list[dict] = []
        md_lines: list[str] = [f"# {os.path.basename(file_path)}", ""]

        for idx, spath in enumerate(slide_paths[:100], start=1):
            s_root = _parse_xml(_safe_read_zip_bytes(zf, spath))
            rels_name = f"ppt/slides/_rels/{posixpath.basename(spath)}.rels"
            s_rels = _parse_rels(zf, rels_name)
            slide_images = _extract_zip_images(zf, "ppt/slides", s_rels)

            title = ""
            bullets: list[dict] = []
            tables: list[list[list[str]]] = []

            for elem in s_root.iter():
                lt = _local_tag(elem.tag)
                if lt == "sp":
                    ph_type = ""
                    for ph in elem.iter():
                        if _local_tag(ph.tag) == "ph":
                            ph_type = ph.attrib.get("type", "")
                            break
                    tx_body = None
                    for sub in elem:
                        if _local_tag(sub.tag) == "txBody":
                            tx_body = sub
                            break
                    if tx_body is None:
                        continue
                    paras = _extract_ppt_text_paras(tx_body)
                    if not paras:
                        continue
                    if ph_type in ("title", "ctrTitle") and not title:
                        title = " ".join(p["text"] for p in paras)
                    else:
                        bullets.extend(paras)
                elif lt == "tbl":
                    t_rows: list[list[str]] = []
                    for tr in elem:
                        if _local_tag(tr.tag) != "tr":
                            continue
                        row_vals: list[str] = []
                        for tc in tr:
                            if _local_tag(tc.tag) != "tc":
                                continue
                            tx = None
                            for sub in tc:
                                if _local_tag(sub.tag) == "txBody":
                                    tx = sub
                                    break
                            if tx is not None:
                                ps = _extract_ppt_text_paras(tx)
                                row_vals.append(" / ".join(p["text"] for p in ps))
                            else:
                                row_vals.append("")
                        if row_vals:
                            t_rows.append(row_vals)
                    if t_rows:
                        tables.append(t_rows)

            notes_text = ""
            for _, (rtype, target) in s_rels.items():
                if rtype == "notesSlide":
                    npath = _resolve_zip_target("ppt/slides", target)
                    if npath in names:
                        n_root = _parse_xml(_safe_read_zip_bytes(zf, npath))
                        note_parts = []
                        for sp in n_root.iter():
                            if _local_tag(sp.tag) == "sp":
                                is_body = False
                                for ph in sp.iter():
                                    if _local_tag(ph.tag) == "ph" and ph.attrib.get("type") == "body":
                                        is_body = True
                                        break
                                if is_body:
                                    for sub in sp:
                                        if _local_tag(sub.tag) == "txBody":
                                            for p in _extract_ppt_text_paras(sub):
                                                note_parts.append(p["text"])
                        notes_text = "\n".join(note_parts).strip()
                    break

            slides.append({
                "index": idx,
                "title": title or f"幻灯片 {idx}",
                "bullets": bullets,
                "tables": tables,
                "images": list(slide_images.values()),
                "notes": notes_text,
            })

            md_lines.append(f"## 第 {idx} 页：{title or '无标题'}")
            md_lines.append("")
            for b in bullets:
                md_lines.append(("  " * b["level"]) + "- " + b["text"])
            if bullets:
                md_lines.append("")
            for tbl in tables:
                md_lines.extend(_rows_to_markdown_table(tbl))
                md_lines.append("")
            if notes_text:
                md_lines.append(f"> 演讲备注：{notes_text}")
                md_lines.append("")

        return {
            "docType": "ppt",
            "format": "pptx",
            "slides": slides,
            "markdown": "\n".join(md_lines).strip() + "\n",
        }


def _decode_pdf_literal(raw_bytes: bytes) -> str:
    out = bytearray()
    i = 0
    n = len(raw_bytes)
    while i < n:
        b = raw_bytes[i]
        if b == 0x5C and i + 1 < n:  # backslash escape
            nxt = raw_bytes[i + 1]
            if nxt in (0x6E, 0x72, 0x74, 0x62, 0x66):
                out.append({0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}[nxt])
                i += 2
                continue
            if nxt in (0x28, 0x29, 0x5C):
                out.append(nxt)
                i += 2
                continue
            if 0x30 <= nxt <= 0x37:
                oct_digits = bytes([nxt])
                j = i + 2
                while j < n and len(oct_digits) < 3 and 0x30 <= raw_bytes[j] <= 0x37:
                    oct_digits += bytes([raw_bytes[j]])
                    j += 1
                out.append(int(oct_digits, 8) & 0xFF)
                i = j
                continue
            i += 2
            continue
        out.append(b)
        i += 1
    data = bytes(out)
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", errors="replace")
    return data.decode("utf-8", errors="replace")


def _extract_pdf_text_from_stream(stream_bytes: bytes) -> list[str]:
    lines: list[str] = []
    for bt_match in re.finditer(rb"BT(.*?)ET", stream_bytes, flags=re.DOTALL):
        block = bt_match.group(1)
        pieces: list[str] = []
        for tok in re.finditer(rb"\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|\"|\s)|\[(.*?)\]\s*TJ", block, flags=re.DOTALL):
            if tok.group(1) is not None:
                s = _decode_pdf_literal(tok.group(1))
                if s:
                    pieces.append(s)
            elif tok.group(2) is not None:
                arr = tok.group(2)
                for sub in re.finditer(rb"\(([^()\\]*(?:\\.[^()\\]*)*)\)", arr):
                    s = _decode_pdf_literal(sub.group(1))
                    if s:
                        pieces.append(s)
        joined = "".join(pieces).strip()
        if joined:
            lines.append(joined)
    return lines


def _read_pdf(file_path: str) -> dict:
    with open(file_path, "rb") as handle:
        raw = handle.read(MAX_OFFICE_BYTES + 1)
    if len(raw) > MAX_OFFICE_BYTES:
        raise ValueError("PDF file exceeds maximum safe preview size of 16 MiB.")
    if not raw.lstrip().startswith(b"%PDF-"):
        raise ValueError("File is not a valid PDF document.")

    page_count = len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", raw))
    title_m = re.search(rb"/Title\s*\(([^()\\]*(?:\\.[^()\\]*)*)\)", raw)
    title = _decode_pdf_literal(title_m.group(1)).strip() if title_m else ""

    extracted_lines: list[str] = []
    for sm in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", raw, flags=re.DOTALL):
        chunk = sm.group(1)
        text_stream = chunk
        header = raw[max(0, sm.start() - 180) : sm.start()]
        if b"/FlateDecode" in header:
            try:
                decomp = zlib.decompressobj()
                text_stream = decomp.decompress(chunk, MAX_PDF_DECOMP_BYTES)
            except zlib.error:
                continue
        if b"BT" in text_stream and b"ET" in text_stream:
            extracted_lines.extend(_extract_pdf_text_from_stream(text_stream))
        if len(extracted_lines) >= 1200:
            break

    extracted_text = "\n".join(extracted_lines).strip()
    md_text = f"# {title or os.path.basename(file_path)}\n\n" + (
        extracted_text if extracted_text else "_（此 PDF 为扫描图片或自定义字体编码，未能提取出纯文本）_"
    )
    return {
        "docType": "pdf",
        "format": "pdf",
        "title": title or os.path.basename(file_path),
        "pageCount": max(1, page_count) if page_count else 0,
        "bytes": len(raw),
        "mimeType": "application/pdf",
        "extractedText": extracted_text,
        "markdown": md_text + "\n",
    }


def read_office_file(file_path: str) -> dict:
    """Parse an Excel, Word, PowerPoint, PDF, or CSV/TSV file safely offline."""
    if not os.path.isfile(file_path):
        raise ValueError("Document file not found.")
    size = os.path.getsize(file_path)
    if size > MAX_OFFICE_BYTES:
        raise ValueError("Document exceeds maximum preview size of 16 MiB.")
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in OFFICE_EXTENSIONS:
        raise ValueError(f"Unsupported document extension: {ext}")

    try:
        if ext in (".xlsx", ".xlsm", ".csv", ".tsv"):
            result = _read_xlsx(file_path, ext)
        elif ext == ".docx":
            result = _read_docx(file_path)
        elif ext == ".pptx":
            result = _read_pptx(file_path)
        elif ext == ".pdf":
            result = _read_pdf(file_path)
        else:
            raise ValueError(f"Unsupported document extension: {ext}")
    except (zipfile.BadZipFile, zlib.error, RuntimeError, EOFError) as exc:
        raise ValueError("Document archive is corrupted, encrypted, or not a valid OOXML file.") from exc
    except ET.ParseError as exc:
        raise ValueError("Document XML content could not be parsed.") from exc

    result["bytes"] = size
    return result
