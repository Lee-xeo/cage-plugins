#!/usr/bin/env bash
set -euo pipefail

TAG="packages"
CREATE_RELEASE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --create)
      CREATE_RELEASE=true
      ;;
    --tag)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --tag" >&2; exit 2; }
      TAG="$1"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

if ! gh release view "$TAG" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
  if [ "$CREATE_RELEASE" = true ]; then
    gh release create "$TAG" \
      --repo "${GITHUB_REPOSITORY}" \
      --title "Plugin Archives" \
      --notes "Mirrored immutable plugin archives for zero-telemetry download counts." \
      --latest=false
  else
    echo "Release '${TAG}' does not exist yet; skipping sync."
    exit 0
  fi
fi

# Collect all already-uploaded asset filenames (paginated) so we NEVER
# clobber existing archives (re-uploading resets download_count).
RELEASE_ID=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${TAG}" --jq '.id')
EXISTING=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}/assets?per_page=100" --jq '.[].name')

NEW_FILES=()
for f in dist/*.tar.gz; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if ! printf '%s\n' "$EXISTING" | grep -Fxq "$base"; then
    NEW_FILES+=("$f")
  fi
done

if [ "${#NEW_FILES[@]}" -gt 0 ]; then
  echo "Uploading ${#NEW_FILES[@]} new archive(s) to release '${TAG}'..."
  gh release upload "$TAG" "${NEW_FILES[@]}" --repo "${GITHUB_REPOSITORY}"
else
  echo "All dist/*.tar.gz archives are already mirrored on release '${TAG}'."
fi

python3 scripts/stats.py --repo "${GITHUB_REPOSITORY}" --tag "$TAG" --output /tmp/stats.json
python3 scripts/stats.py --check --output /tmp/stats.json
gh release upload "$TAG" /tmp/stats.json --repo "${GITHUB_REPOSITORY}" --clobber
