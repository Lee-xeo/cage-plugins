const SYMBOLS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
  sum: "∑", prod: "∏", int: "∫", infty: "∞", partial: "∂", nabla: "∇",
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", ast: "∗",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
  forall: "∀", exists: "∃", therefore: "∴", because: "∵", ldots: "…", cdots: "⋯",
};

function readGroup(src, idx) {
  while (idx < src.length && /\s/.test(src[idx])) idx++;
  if (idx >= src.length) return { content: "", next: idx, ok: false };
  if (src[idx] !== "{") {
    return { content: src[idx], next: idx + 1, ok: true };
  }
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        return { content: src.slice(idx + 1, i), next: i + 1, ok: true };
      }
    }
  }
  return { content: "", next: src.length, ok: false };
}

function renderTokens(doc, parent, src) {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const cmdMatch = src.slice(i + 1).match(/^([a-zA-Z]+|[{}\\])/);
      if (cmdMatch) {
        const cmd = cmdMatch[1];
        i += 1 + cmd.length;
        if (cmd === "frac") {
          const num = readGroup(src, i);
          const den = readGroup(src, num.next);
          if (!num.ok || !den.ok) return false;
          const frac = doc.createElement("span");
          frac.className = "md-math-frac";
          const top = doc.createElement("span");
          top.className = "md-math-num";
          if (!renderTokens(doc, top, num.content)) return false;
          const bot = doc.createElement("span");
          bot.className = "md-math-den";
          if (!renderTokens(doc, bot, den.content)) return false;
          frac.appendChild(top);
          frac.appendChild(bot);
          parent.appendChild(frac);
          i = den.next;
          continue;
        }
        if (cmd === "sqrt") {
          const body = readGroup(src, i);
          if (!body.ok) return false;
          const wrap = doc.createElement("span");
          wrap.className = "md-math-sqrt";
          wrap.appendChild(doc.createTextNode("√"));
          const inner = doc.createElement("span");
          inner.className = "md-math-sqrt-body";
          if (!renderTokens(doc, inner, body.content)) return false;
          wrap.appendChild(inner);
          parent.appendChild(wrap);
          i = body.next;
          continue;
        }
        if (cmd === "text" || cmd === "mathrm" || cmd === "mathbf") {
          const body = readGroup(src, i);
          if (!body.ok) return false;
          const span = doc.createElement("span");
          span.className = cmd === "mathbf" ? "md-math-bf" : "md-math-text";
          span.textContent = body.content;
          parent.appendChild(span);
          i = body.next;
          continue;
        }
        if (SYMBOLS[cmd]) {
          parent.appendChild(doc.createTextNode(SYMBOLS[cmd]));
          continue;
        }
        parent.appendChild(doc.createTextNode(cmd));
        continue;
      }
    }

    if (ch === "^" || ch === "_") {
      const grp = readGroup(src, i + 1);
      if (!grp.ok) return false;
      const el = doc.createElement(ch === "^" ? "sup" : "sub");
      if (!renderTokens(doc, el, grp.content)) return false;
      parent.appendChild(el);
      i = grp.next;
      continue;
    }

    if (ch === "{" || ch === "}") {
      i++;
      continue;
    }

    parent.appendChild(doc.createTextNode(ch));
    i++;
  }
  return true;
}

/**
 * Pure DOM offline math renderer; falls back to raw LaTeX text on unbalanced syntax.
 */
export function renderMath(doc, latex, displayMode = false) {
  const el = doc.createElement(displayMode ? "div" : "span");
  el.className = displayMode ? "md-math-block" : "md-math";
  const raw = String(latex || "").trim();
  if (!raw || !renderTokens(doc, el, raw)) {
    while (el.firstChild) el.removeChild(el.firstChild);
    el.textContent = displayMode ? `$$${raw}$$` : `$${raw}$`;
    el.classList.add("md-math-fallback");
  }
  return el;
}
