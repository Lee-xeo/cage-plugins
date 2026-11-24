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


def aggregate_downloads(assets: list[dict[str, Any]], known_plugins: list[str]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = plugin_name_from_asset(str(asset.get("name") or ""), known_plugins)
        if not name:
            continue
        raw_count = asset.get("download_count", 0)
        if isinstance(raw_count, bool) or not isinstance(raw_count, int) or raw_count < 0:
            continue
        if raw_count > 0:
            totals[name] = totals.get(name, 0) + raw_count
    return dict(sorted(totals.items()))


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
    parser.add_argument("--output", default="stats.json", help="Output path for stats.json")
    parser.add_argument("--check", action="store_true", help="Validate an existing stats.json file and exit")
    args = parser.parse_args()

    out_path = pathlib.Path(args.output)
    if args.check:
        data = json.loads(out_path.read_text(encoding="utf-8"))
        validate_stats_payload(data)
        print(f"ok: stats.json ({len(data['downloads'])} plugins with downloads)")
        return

    known_plugins = load_known_plugins(pathlib.Path(args.authors))
    if args.assets_json:
        raw = json.loads(pathlib.Path(args.assets_json).read_text(encoding="utf-8"))
        assets = raw["assets"] if isinstance(raw, dict) and isinstance(raw.get("assets"), list) else raw
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
