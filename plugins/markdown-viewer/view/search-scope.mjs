/**
 * Build shared query-scope and match-option arguments for full-text search
 * and batch replace so both operations always target the exact same file subset.
 */
export function buildSearchScopeArgs({
  caseSensitive = false,
  wholeWord = false,
  regex = false,
  pathPrefix = "",
  tags = [],
} = {}) {
  const args = {
    caseSensitive: Boolean(caseSensitive),
    wholeWord: Boolean(wholeWord),
    regex: Boolean(regex),
    pathPrefix: typeof pathPrefix === "string" ? pathPrefix : "",
  };
  const cleanTags = Array.isArray(tags)
    ? [...new Set(tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))]
    : [];
  if (cleanTags.length > 0) {
    args.tags = cleanTags;
  }
  return args;
}

export function buildBatchReplaceArgs({
  query = "",
  replacement = "",
  paths,
  caseSensitive = false,
  wholeWord = false,
  regex = false,
  pathPrefix = "",
  tags = [],
} = {}) {
  const args = {
    query,
    replacement,
    ...buildSearchScopeArgs({ caseSensitive, wholeWord, regex, pathPrefix, tags }),
  };
  if (Array.isArray(paths)) {
    args.paths = paths;
  }
  return args;
}
