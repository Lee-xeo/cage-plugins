#!/usr/bin/env python3
"""Aggregate per-plugin download counts from a GitHub Release into stats.json.

Reads release asset metadata from the GitHub REST API (or a local JSON fixture
via --assets-json for testing), maps each `<name>-<version>[-<target>].tar.gz`
asset back to its canonical plugin name from authors.json, sums counts across
versions and platform targets, and writes stats.json with LF line endings.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
AUTHORS_PATH = ROOT / "authors.json"
DEFAULT_REPO = "Lee-xeo/cage-plugins"
DEFAULT_TAG = "packages"
API_BASE = "https://api.github.com"

VERSION_START = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}(?:[-+.][0-9A-Za-z.-]+)?\.tar\.gz$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAG_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def load_known_plugins(authors_path: pathlib.Path = AUTHORS_PATH) -> list[str]:
    data = json.loads(authors_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("authors.json must be a JSON object")
    # Sort longest-first so hyphenated names (e.g. "documents-to-markdown") match before any shorter prefix.
    return sorted((str(k) for k in data.keys()), key=len, reverse=True)


def plugin_name_from_asset(asset_name: str, known_plugins: list[str]) -> str | None:
    if not isinstance(asset_name, str) or not asset_name.endswith(".tar.gz"):
        return None
    for name in known_plugins:
        prefix = name + "-"
        if asset_name.startswith(prefix):
            rest = asset_name[len(prefix) :]
            if VERSION_START.match(rest):
                return name
    return None


def _non_negative_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return default
    return value


def aggregate_downloads(assets: list[dict[str, Any]], known_plugins: list[str]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        state = asset.get("state")
        if state is not None and state != "uploaded":
            continue
        name = plugin_name_from_asset(str(asset.get("name") or ""), known_plugins)
        if not name:
            continue
        count = _non_negative_int(asset.get("download_count", 0))
        if count > 0:
            totals[name] = totals.get(name, 0) + count
    return dict(sorted(totals.items()))


def load_assets_payload(raw_text: str) -> list[dict[str, Any]]:
    """Parse release asset JSON from an object, array, or concatenated paginated arrays."""
    decoder = json.JSONDecoder()
    items: list[dict[str, Any]] = []
    idx = 0
    length = len(raw_text)
    while idx < length:
        while idx < length and raw_text[idx].isspace():
            idx += 1
        if idx >= length:
            break
        parsed, idx = decoder.raw_decode(raw_text, idx)
        if isinstance(parsed, dict) and isinstance(parsed.get("assets"), list):
            items.extend(x for x in parsed["assets"] if isinstance(x, dict))
        elif isinstance(parsed, list):
            items.extend(x for x in parsed if isinstance(x, dict))
        else:
            raise ValueError("Assets JSON must contain a list of asset objects or a release object")
    return items


def _is_valid_uploaded_asset(asset: dict[str, Any], expected_size: int) -> bool:
    size = asset.get("size")
    return (
        asset.get("state") == "uploaded"
        and not isinstance(size, bool)
        and isinstance(size, int)
        and expected_size > 0
        and size == expected_size
    )


def _is_empty_starter_asset(asset: dict[str, Any]) -> bool:
    size = asset.get("size")
    return asset.get("state") == "starter" and not isinstance(size, bool) and size == 0


def _require_asset_id(asset: dict[str, Any], name: str) -> int:
    asset_id = asset.get("id")
    if not isinstance(asset_id, int) or isinstance(asset_id, bool):
        raise ValueError(f"Empty starter remote asset {name!r} is missing a numeric id")
    return asset_id


def _mismatch_entry(
    asset: dict[str, Any], name: str, expected_size: int, reason: str | None = None
) -> dict[str, Any]:
    resolved_reason = reason or (
        "uploaded-size-mismatch" if asset.get("state") == "uploaded" else "non-empty-incomplete-asset"
    )
    return {
        "id": asset.get("id"),
        "name": name,
        "state": asset.get("state"),
        "size": asset.get("size"),
        "expectedSize": expected_size,
        "downloadCount": _non_negative_int(asset.get("download_count", 0)),
        "reason": resolved_reason,
    }


def plan_package_sync(assets: list[dict[str, Any]], dist_dir: pathlib.Path) -> dict[str, Any]:
    """Classify local dist/*.tar.gz archives into keep, delete, upload, and mismatch.

    Only confirmed 0-byte GitHub ``starter`` placeholders are auto-deleted. Any
    already-``uploaded`` (or other non-placeholder) asset whose size differs from
    the local archive is preserved untouched and reported in ``mismatch`` so
    existing download counts are never reset.
    """
    by_name: dict[str, list[dict[str, Any]]] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name") or "")
        if name:
            by_name.setdefault(name, []).append(asset)

    keep: list[str] = []
    delete: list[dict[str, Any]] = []
    upload: list[str] = []
    mismatch: list[dict[str, Any]] = []

    archives = sorted(p for p in dist_dir.glob("*.tar.gz") if p.is_file() and not p.is_symlink())
    for archive_path in archives:
        name = archive_path.name
        expected_size = archive_path.stat().st_size
        if expected_size <= 0:
            raise ValueError(f"Local archive is empty: {archive_path}")

        matches = by_name.get(name, [])
        healthy: list[dict[str, Any]] = []
        empty_starters: list[dict[str, Any]] = []
        other_assets: list[dict[str, Any]] = []
        for asset in matches:
            if _is_valid_uploaded_asset(asset, expected_size):
                healthy.append(asset)
            elif _is_empty_starter_asset(asset):
                empty_starters.append(asset)
            else:
                other_assets.append(asset)

        for asset in empty_starters:
            delete.append({
                "id": _require_asset_id(asset, name),
                "name": name,
                "state": asset.get("state"),
                "size": asset.get("size"),
                "expectedSize": expected_size,
                "reason": "empty-starter-placeholder",
            })

        if healthy:
            # Keep the healthiest asset (highest download_count) so download metrics are never reset.
            chosen = max(
                healthy,
                key=lambda a: _non_negative_int(a.get("download_count", 0)),
            )
            keep.append(name)
            for asset in healthy:
                if asset is not chosen:
                    mismatch.append(_mismatch_entry(asset, name, expected_size, "duplicate-uploaded-asset"))
            for asset in other_assets:
                mismatch.append(_mismatch_entry(asset, name, expected_size))
            continue

        if other_assets:
            # Never auto-delete or overwrite an existing uploaded / non-placeholder asset.
            for asset in other_assets:
                mismatch.append(_mismatch_entry(asset, name, expected_size))
            continue

        upload.append(archive_path.as_posix())

    return {"keep": keep, "delete": delete, "upload": upload, "mismatch": mismatch}


def _api_get_json(url: str, token: str | None) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "cage-plugins-stats/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_release_assets(repo: str, tag: str, token: str | None) -> list[dict[str, Any]]:
    if not REPO_RE.fullmatch(repo):
        raise ValueError(f"Invalid repository format: {repo!r}")
    if not TAG_RE.fullmatch(tag):
        raise ValueError(f"Invalid release tag: {tag!r}")
    try:
        release = _api_get_json(f"{API_BASE}/repos/{repo}/releases/tags/{tag}", token)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return []
        raise
    release_id = release.get("id")
    if not isinstance(release_id, int):
        return list(release.get("assets") or [])

    assets: list[dict[str, Any]] = []
    page = 1
    while True:
        batch = _api_get_json(
            f"{API_BASE}/repos/{repo}/releases/{release_id}/assets?per_page=100&page={page}",
            token,
        )
        if not isinstance(batch, list) or not batch:
            break
        assets.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return assets


def build_stats_payload(downloads: dict[str, int], updated_at: str | None = None) -> dict[str, Any]:
    ts = updated_at or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "version": 1,
        "updatedAt": ts,
        "downloads": dict(sorted(downloads.items())),
    }


def validate_stats_payload(data: Any) -> None:
    if not isinstance(data, dict):
        raise ValueError("stats.json must be a JSON object")
    if data.get("version") != 1:
        raise ValueError("stats.json version must be 1")
    updated = data.get("updatedAt")
    if not isinstance(updated, str) or not updated.strip():
        raise ValueError("stats.json updatedAt must be a non-empty ISO timestamp")
    downloads = data.get("downloads")
    if not isinstance(downloads, dict):
        raise ValueError("stats.json downloads must be an object")
    for key, val in downloads.items():
        if not isinstance(key, str) or not key:
            raise ValueError(f"Invalid plugin key in downloads: {key!r}")
        if isinstance(val, bool) or not isinstance(val, int) or val < 0:
            raise ValueError(f"Invalid download count for {key!r}: {val!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate stats.json from GitHub Release asset download counts.")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub owner/repo (default: Lee-xeo/cage-plugins)")
    parser.add_argument("--tag", default=DEFAULT_TAG, help="GitHub Release tag (default: packages)")
    parser.add_argument("--assets-json", default="", help="Optional local JSON file of release assets (for testing)")
    parser.add_argument("--authors", default=str(AUTHORS_PATH), help="Path to authors.json")
    parser.add_argument("--dist-dir", default=str(ROOT / "dist"), help="Directory containing *.tar.gz archives (for --plan-sync)")
    parser.add_argument("--plan-sync", action="store_true", help="Plan archive keep/delete/upload actions from assets JSON")
    parser.add_argument("--format", choices=("json", "lines"), default="json", help="Output format for --plan-sync")
    parser.add_argument("--output", default="stats.json", help="Output path for stats.json")
    parser.add_argument("--check", action="store_true", help="Validate an existing stats.json file and exit")
    args = parser.parse_args()

    out_path = pathlib.Path(args.output)
    if args.check:
        data = json.loads(out_path.read_text(encoding="utf-8"))
        validate_stats_payload(data)
        print(f"ok: stats.json ({len(data['downloads'])} plugins with downloads)")
        return

    if args.plan_sync:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(newline="\n")
        if args.assets_json:
            assets = load_assets_payload(pathlib.Path(args.assets_json).read_text(encoding="utf-8"))
        else:
            token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None
            assets = fetch_release_assets(args.repo, args.tag, token)
        plan = plan_package_sync(assets, pathlib.Path(args.dist_dir))
        if args.format == "lines":
            print(f"KEEP_COUNT\t{len(plan['keep'])}")
            for item in plan["delete"]:
                print(
                    f"DELETE\t{item['id']}\t{item['name']}\t{item.get('state')}\t{item.get('size')}\t{item['expectedSize']}"
                )
            for item in plan["mismatch"]:
                asset_id = item.get("id")
                id_str = str(asset_id) if asset_id is not None else "unknown"
                state_str = str(item.get("state") if item.get("state") is not None else "unknown")
                size_str = str(item.get("size") if item.get("size") is not None else "unknown")
                print(
                    f"MISMATCH\t{id_str}\t{item['name']}\t{state_str}\t{size_str}\t{item['expectedSize']}\t{item.get('downloadCount', 0)}\t{item['reason']}"
                )
            for path in plan["upload"]:
                print(f"UPLOAD\t{path}")
        else:
            print(json.dumps(plan, ensure_ascii=False, indent=2))
        return

    known_plugins = load_known_plugins(pathlib.Path(args.authors))
    if args.assets_json:
        assets = load_assets_payload(pathlib.Path(args.assets_json).read_text(encoding="utf-8"))
    else:
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None
        assets = fetch_release_assets(args.repo, args.tag, token)

    downloads = aggregate_downloads(assets, known_plugins)
    payload = build_stats_payload(downloads)
    validate_stats_payload(payload)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(f"wrote {out_path} ({len(downloads)} plugins, total={sum(downloads.values())})")


if __name__ == "__main__":
    main()
