const LANG_ALIASES = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  golang: "go",
  rs: "rust",
};

const KEYWORDS = {
  javascript: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "export", "extends", "false", "finally", "for",
    "from", "function", "if", "import", "in", "instanceof", "let", "new", "null", "of",
    "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
    "undefined", "var", "void", "while", "with", "yield",
  ]),
  typescript: new Set([
    "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
    "const", "continue", "declare", "default", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "from", "function", "if", "implements", "import", "in",
    "interface", "is", "keyof", "let", "module", "namespace", "never", "new", "null",
    "number", "of", "private", "protected", "public", "readonly", "return", "static",
    "string", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
    "undefined", "unknown", "var", "void", "while",
  ]),
  python: new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
    "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import",
    "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
    "True", "try", "while", "with", "yield",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
    "false", "for", "func", "go", "goto", "if", "import", "interface", "map", "nil",
    "package", "range", "return", "select", "struct", "switch", "true", "type", "var",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
    "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
    "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
    "trait", "true", "type", "unsafe", "use", "where", "while",
  ]),
  bash: new Set([
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function",
    "if", "in", "local", "return", "select", "then", "until", "while",
  ]),
  sql: new Set([
    "AND", "AS", "ASC", "BY", "CREATE", "DELETE", "DESC", "DISTINCT", "DROP", "FROM",
    "GROUP", "HAVING", "IN", "INDEX", "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIMIT",
    "NOT", "NULL", "ON", "OR", "ORDER", "PRIMARY", "SELECT", "SET", "TABLE", "UPDATE",
    "VALUES", "WHERE",
    "and", "as", "asc", "by", "create", "delete", "desc", "distinct", "drop", "from",
    "group", "having", "in", "index", "insert", "into", "is", "join", "left", "limit",
    "not", "null", "on", "or", "order", "primary", "select", "set", "table", "update",
    "values", "where",
  ]),
  json: new Set(["true", "false", "null"]),
  yaml: new Set(["true", "false", "null", "yes", "no"]),
};

const HASH_COMMENT_LANGS = new Set(["python", "bash", "yaml"]);
const SLASH_COMMENT_LANGS = new Set(["javascript", "typescript", "go", "rust", "css"]);

function appendToken(doc, parent, cls, text) {
  if (!text) return;
  if (!cls) {
    parent.appendChild(doc.createTextNode(text));
    return;
  }
  const span = doc.createElement("span");
  span.className = cls;
  span.textContent = text;
  parent.appendChild(span);
}

function highlightDiff(doc, codeEl, codeText) {
  const lines = codeText.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let cls = "";
    if (line.startsWith("+")) cls = "tok-str";
    else if (line.startsWith("-")) cls = "tok-kw";
    else if (line.startsWith("@@")) cls = "tok-fn";
    else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "tok-com";
    appendToken(doc, codeEl, cls, line + (idx < lines.length - 1 ? "\n" : ""));
  }
}

/**
 * Pure DOM lexical syntax highlighter (zero innerHTML, zero external dependencies).
 */
export function highlightCode(doc, codeEl, codeText, rawLang) {
  const lang = LANG_ALIASES[String(rawLang || "").toLowerCase()] || String(rawLang || "").toLowerCase();
  if (!lang || (!KEYWORDS[lang] && lang !== "diff" && lang !== "css" && lang !== "html")) {
    codeEl.textContent = codeText;
    return;
  }
  if (lang === "diff") {
    highlightDiff(doc, codeEl, codeText);
    return;
  }

  const kwSet = KEYWORDS[lang] || new Set();
  const hasHashCom = HASH_COMMENT_LANGS.has(lang);
  const hasSlashCom = SLASH_COMMENT_LANGS.has(lang);
  const hasDashCom = lang === "sql";

  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      appendToken(doc, codeEl, "", plain);
      plain = "";
    }
  };

  while (i < codeText.length) {
    const ch = codeText[i];

    // Comments
    if ((hasHashCom && ch === "#") || (hasSlashCom && ch === "/" && codeText[i + 1] === "/") || (hasDashCom && ch === "-" && codeText[i + 1] === "-")) {
      flushPlain();
      const nl = codeText.indexOf("\n", i);
      const end = nl === -1 ? codeText.length : nl;
      appendToken(doc, codeEl, "tok-com", codeText.slice(i, end));
      i = end;
      continue;
    }
    if (hasSlashCom && ch === "/" && codeText[i + 1] === "*") {
      flushPlain();
      const close = codeText.indexOf("*/", i + 2);
      const end = close === -1 ? codeText.length : close + 2;
      appendToken(doc, codeEl, "tok-com", codeText.slice(i, end));
      i = end;
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'" || ch === "`") {
      flushPlain();
      const quote = ch;
      let j = i + 1;
      while (j < codeText.length) {
        if (codeText[j] === "\\" && j + 1 < codeText.length) {
          j += 2;
          continue;
        }
        if (codeText[j] === quote) {
          j++;
          break;
        }
        if (codeText[j] === "\n" && quote !== "`") break;
        j++;
      }
      appendToken(doc, codeEl, "tok-str", codeText.slice(i, j));
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$]/.test(codeText[i - 1]))) {
      const numMatch = codeText.slice(i).match(/^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/);
      if (numMatch) {
        flushPlain();
        appendToken(doc, codeEl, "tok-num", numMatch[0]);
        i += numMatch[0].length;
        continue;
      }
    }

    // Identifiers & keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      const idMatch = codeText.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
      if (idMatch) {
        const word = idMatch[0];
        const nextChar = codeText[i + word.length];
        if (kwSet.has(word)) {
          flushPlain();
          appendToken(doc, codeEl, "tok-kw", word);
        } else if (nextChar === "(") {
          flushPlain();
          appendToken(doc, codeEl, "tok-fn", word);
        } else {
          plain += word;
        }
        i += word.length;
        continue;
      }
    }

    plain += ch;
    i++;
  }
  flushPlain();
}
