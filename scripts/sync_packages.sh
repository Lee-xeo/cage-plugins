#!/usr/bin/env bash
set -euo pipefail

TAG="packages"
CREATE_RELEASE=false
ASSETS_JSON_ARG=""
DIST_DIR="dist"
DRY_RUN=false

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
    --assets-json)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --assets-json" >&2; exit 2; }
      ASSETS_JSON_ARG="$1"
      ;;
    --dist-dir)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --dist-dir" >&2; exit 2; }
      DIST_DIR="$1"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ -n "$ASSETS_JSON_ARG" ]; then
  ASSETS_FILE="$ASSETS_JSON_ARG"
else
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  if ! gh release view "$TAG" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
    if [ "$CREATE_RELEASE" = true ]; then
      if [ "$DRY_RUN" = true ]; then
        echo "Would create release '${TAG}'."
      else
        gh release create "$TAG" \
          --repo "${GITHUB_REPOSITORY}" \
          --title "Plugin Archives" \
          --notes "Mirrored immutable plugin archives for zero-telemetry download counts." \
          --latest=false
      fi
    else
      echo "Release '${TAG}' does not exist yet; skipping sync."
      exit 0
    fi
  fi

  ASSETS_FILE="$TMP_DIR/assets.json"
  RELEASE_ID=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${TAG}" --jq '.id')
  # Collect full asset objects (id, name, state, size) across all pages so we can
  # verify completeness (state == "uploaded" and size == local_size) without
  # clobbering healthy archives or leaving failed-upload "starter" placeholders stuck.
  gh api --paginate "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}/assets?per_page=100" > "$ASSETS_FILE"
fi

PLAN_OUT=$(python3 scripts/stats.py --plan-sync --assets-json "$ASSETS_FILE" --dist-dir "$DIST_DIR" --format lines)
PLAN_OUT=${PLAN_OUT//$'\r'/}

KEEP_COUNT=0
DELETE_LINES=()
UPLOAD_FILES=()
while IFS=$'\t' read -r action col1 col2 col3 col4 col5; do
  case "$action" in
    KEEP_COUNT)
      KEEP_COUNT="$col1"
      ;;
    DELETE)
      DELETE_LINES+=("$col1"$'\t'"$col2"$'\t'"$col3"$'\t'"$col4"$'\t'"$col5")
      ;;
    UPLOAD)
      UPLOAD_FILES+=("$col1")
      ;;
  esac
done <<< "$PLAN_OUT"

echo "Verified ${KEEP_COUNT} existing complete archive(s) on release '${TAG}' (untouched)."

if [ "${#DELETE_LINES[@]}" -gt 0 ]; then
  for entry in "${DELETE_LINES[@]}"; do
    IFS=$'\t' read -r asset_id asset_name asset_state asset_size expected_size <<< "$entry"
    echo "Cleaning incomplete asset '${asset_name}' (id=${asset_id}, state=${asset_state}, size=${asset_size}, expected=${expected_size})..."
    if [ "$DRY_RUN" != true ]; then
      : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
      gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" >/dev/null
    fi
  done
fi

if [ "${#UPLOAD_FILES[@]}" -gt 0 ]; then
  echo "Uploading ${#UPLOAD_FILES[@]} archive(s) to release '${TAG}': ${UPLOAD_FILES[*]}"
  if [ "$DRY_RUN" != true ]; then
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
    gh release upload "$TAG" "${UPLOAD_FILES[@]}" --repo "${GITHUB_REPOSITORY}"
  fi
else
  echo "All ${DIST_DIR}/*.tar.gz archives are already mirrored completely on release '${TAG}'."
fi

STATS_FILE="$TMP_DIR/stats.json"
if [ "$DRY_RUN" = true ]; then
  python3 scripts/stats.py --assets-json "$ASSETS_FILE" --output "$STATS_FILE"
  python3 scripts/stats.py --check --output "$STATS_FILE"
else
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  python3 scripts/stats.py --repo "${GITHUB_REPOSITORY}" --tag "$TAG" --output "$STATS_FILE"
  python3 scripts/stats.py --check --output "$STATS_FILE"
  gh release upload "$TAG" "$STATS_FILE" --repo "${GITHUB_REPOSITORY}" --clobber
fi
