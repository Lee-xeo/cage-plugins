"""Batch video voiceover synthesis for JSON scripts and SRT subtitle files."""

from __future__ import annotations

import concurrent.futures
import json
import pathlib
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from audio_info import measure_duration_seconds
from protocols import (
    EXTENSION_FORMATS,
    FORMAT_EXTENSIONS,
    HttpTransport,
    SynthesisRequest,
    TTSError,
    default_http_transport,
    synthesize,
)

_SRT_TIME_RE = re.compile(
    r"^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _hms_ms_to_seconds(h: str, m: str, s: str, ms: str) -> float:
    ms_val = int(ms.ljust(3, "0")[:3])
    return round(int(h) * 3600 + int(m) * 60 + int(s) + ms_val / 1000.0, 3)


def parse_srt(content: str) -> List[Dict[str, Any]]:
    """Parse an SRT subtitle file into normalized batch segment dictionaries."""
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    blocks = re.split(r"\n{2,}", normalized.strip())
    segments: List[Dict[str, Any]] = []
    seq = 0
    for block in blocks:
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        time_idx = -1
        match = None
        for idx, line in enumerate(lines):
            m = _SRT_TIME_RE.match(line)
            if m:
                time_idx = idx
                match = m
                break
        if match is None or time_idx < 0:
            continue
        text_lines = lines[time_idx + 1:]
        text = " ".join(text_lines).strip()
        if not text:
            continue
        seq += 1
        cue_id = lines[0] if time_idx > 0 and lines[0].isdigit() else f"{seq:04d}"
        start_sec = _hms_ms_to_seconds(*match.groups()[:4])
        end_sec = _hms_ms_to_seconds(*match.groups()[4:])
        target_dur = round(max(0.0, end_sec - start_sec), 3)
        segments.append({
            "id": f"{int(cue_id):04d}" if cue_id.isdigit() else cue_id,
            "text": text,
            "start_seconds": start_sec,
            "end_seconds": end_sec,
            "target_duration_seconds": target_dur,
        })
    return segments


def parse_script_file(path: pathlib.Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]], str]:
    """Load either an SRT subtitle file or a JSON voiceover script."""
    content = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    if suffix == ".srt":
        segments = parse_srt(content)
        if not segments:
            raise TTSError(f"No valid subtitle cues found in {path.name}")
        return {}, segments, "srt"

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        # Fall back to SRT parsing if someone saved subtitles with a .txt extension.
        if _SRT_TIME_RE.search(content):
            segments = parse_srt(content)
            if segments:
                return {}, segments, "srt"
        raise TTSError(f"Failed to parse script JSON ({path.name}): {exc}") from exc

    defaults: Dict[str, Any] = {}
    if isinstance(parsed, list):
        raw_segments = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("segments"), list):
        raw_segments = parsed["segments"]
        if isinstance(parsed.get("defaults"), dict):
            defaults = parsed["defaults"]
    else:
        raise TTSError("JSON script must be a list of segments or an object with a 'segments' array.")

    segments = []
    for idx, item in enumerate(raw_segments, start=1):
        if isinstance(item, str):
            text = item.strip()
            if not text:
                continue
            segments.append({"id": f"{idx:04d}", "text": text})
            continue
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        seg = dict(item)
        seg["id"] = str(seg.get("id") or f"{idx:04d}")
        seg["text"] = text
        segments.append(seg)

    if not segments:
        raise TTSError(f"No valid voiceover segments found in {path.name}")
    return defaults, segments, "json"


def _sanitize_stem(raw_id: str, index: int) -> str:
    cleaned = _SAFE_ID_RE.sub("_", raw_id.strip()).strip("._")
    return cleaned or f"{index + 1:04d}"


def run_batch(
    script_path: pathlib.Path,
    output_dir: pathlib.Path,
    project_dir: pathlib.Path,
    profiles: Dict[str, Dict[str, Any]],
    resolve_output_file: Callable[[str], pathlib.Path],
    *,
    manifest_path: Optional[pathlib.Path] = None,
    profile_override: Optional[str] = None,
    voice_override: Optional[str] = None,
    format_override: Optional[str] = None,
    speed_override: Optional[float] = None,
    start_index: int = 0,
    limit: int = 20,
    concurrency: int = 3,
    skip_existing: bool = False,
    continue_on_error: bool = True,
    transport: HttpTransport = default_http_transport,
) -> Dict[str, Any]:
    """Synthesize a slice of segments concurrently and write a timing manifest."""
    defaults, all_segments, script_kind = parse_script_file(script_path)
    total_segments = len(all_segments)

    start = max(0, int(start_index))
    batch_limit = max(1, min(50, int(limit)))
    workers = max(1, min(5, int(concurrency)))
    sliced = all_segments[start:start + batch_limit]

    output_dir.mkdir(parents=True, exist_ok=True)
    rel_out_dir = output_dir.relative_to(project_dir).as_posix()

    def process_one(offset: int, seg: Dict[str, Any]) -> Dict[str, Any]:
        seg_index = start + offset
        seg_id = str(seg.get("id") or f"{seg_index + 1:04d}")
        prof_name = str(seg.get("profile") or profile_override or defaults.get("profile") or "default").strip()
        if prof_name not in profiles:
            raise TTSError(f"Unknown TTS profile '{prof_name}'. Available: {', '.join(sorted(profiles))}")
        prof = profiles[prof_name]

        custom_output = str(seg.get("output") or seg.get("output_path") or "").strip()
        raw_fmt = str(seg.get("format") or format_override or defaults.get("format") or "").strip().lower()
        if not raw_fmt and custom_output:
            raw_fmt = EXTENSION_FORMATS.get(pathlib.Path(custom_output).suffix.lower(), "")
        fmt = raw_fmt or str(prof.get("format") or "mp3").lower()
        ext = FORMAT_EXTENSIONS.get(fmt, ".mp3")

        if custom_output:
            rel_file = custom_output if "/" in custom_output else f"{rel_out_dir}/{custom_output}"
        else:
            rel_file = f"{rel_out_dir}/{_sanitize_stem(seg_id, seg_index)}{ext}"

        target_file = resolve_output_file(rel_file)
        rel_result_path = target_file.relative_to(project_dir).as_posix()

        entry: Dict[str, Any] = {
            "index": seg_index,
            "id": seg_id,
            "output_path": rel_result_path,
            "profile": prof_name,
            "text": seg["text"],
        }
        for timing_key in ("start_seconds", "end_seconds", "target_duration_seconds"):
            if timing_key in seg:
                entry[timing_key] = seg[timing_key]

        if skip_existing and target_file.is_file() and target_file.stat().st_size > 0:
            existing_bytes = target_file.read_bytes()
            sr = int(seg.get("sample_rate") or defaults.get("sample_rate") or prof.get("sample_rate") or 24000)
            dur = measure_duration_seconds(existing_bytes, fmt, sr)
            entry.update({
                "status": "skipped",
                "bytes": len(existing_bytes),
                "format": fmt,
                "duration_seconds": dur,
            })
            if dur is not None and "target_duration_seconds" in entry:
                entry["overflow_seconds"] = round(dur - float(entry["target_duration_seconds"]), 3)
            return entry

        req = SynthesisRequest(
            text=seg["text"],
            voice=seg.get("voice") or voice_override or defaults.get("voice"),
            model=seg.get("model") or defaults.get("model"),
            format=fmt,
            sample_rate=seg.get("sample_rate") or defaults.get("sample_rate"),
            speed=seg.get("speed") if seg.get("speed") is not None else (speed_override if speed_override is not None else defaults.get("speed")),
            volume=seg.get("volume") if seg.get("volume") is not None else defaults.get("volume"),
            pitch=seg.get("pitch") if seg.get("pitch") is not None else defaults.get("pitch"),
            emotion=seg.get("emotion") or defaults.get("emotion"),
            emotion_scale=seg.get("emotion_scale") if seg.get("emotion_scale") is not None else defaults.get("emotion_scale"),
            language=seg.get("language") or defaults.get("language"),
            instructions=seg.get("instructions") or defaults.get("instructions"),
        )
        res = synthesize(
            prof,
            req,
            protocol_override=seg.get("protocol") or defaults.get("protocol"),
            transport=transport,
        )
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_bytes(res.audio_bytes)

        entry.update({
            "status": "ok",
            "bytes": len(res.audio_bytes),
            "format": res.audio_format,
            "protocol": res.protocol,
            "voice": res.voice,
            "sample_rate": res.sample_rate,
            "duration_seconds": res.duration_seconds,
        })
        if res.duration_seconds is not None and "target_duration_seconds" in entry:
            entry["overflow_seconds"] = round(res.duration_seconds - float(entry["target_duration_seconds"]), 3)
        return entry

    results: List[Optional[Dict[str, Any]]] = [None] * len(sliced)
    succeeded = 0
    skipped = 0
    failed = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(process_one, i, seg): (i, seg)
            for i, seg in enumerate(sliced)
        }
        for future in concurrent.futures.as_completed(future_map):
            i, seg = future_map[future]
            try:
                item = future.result()
                results[i] = item
                if item["status"] == "skipped":
                    skipped += 1
                else:
                    succeeded += 1
            except Exception as exc:
                failed += 1
                if not continue_on_error:
                    raise
                results[i] = {
                    "index": start + i,
                    "id": str(seg.get("id") or f"{start + i + 1:04d}"),
                    "status": "error",
                    "error": str(exc),
                    "text": seg.get("text", ""),
                }

    final_items = [r for r in results if r is not None]
    total_duration = round(
        sum(float(item["duration_seconds"]) for item in final_items if isinstance(item.get("duration_seconds"), (int, float))),
        3,
    )
    overflow_count = sum(
        1 for item in final_items
        if isinstance(item.get("overflow_seconds"), (int, float)) and item["overflow_seconds"] > 0.05
    )

    manifest_file = manifest_path or (output_dir / "manifest.json")
    manifest_payload = {
        "script_path": script_path.relative_to(project_dir).as_posix(),
        "script_type": script_kind,
        "output_dir": rel_out_dir,
        "total_segments_in_script": total_segments,
        "processed_range": {"start_index": start, "count": len(final_items)},
        "next_start_index": (start + len(final_items)) if (start + len(final_items) < total_segments) else None,
        "summary": {
            "succeeded": succeeded,
            "skipped": skipped,
            "failed": failed,
            "total_audio_duration_seconds": total_duration,
            "subtitle_overflow_count": overflow_count,
        },
        "segments": final_items,
    }
    manifest_file.parent.mkdir(parents=True, exist_ok=True)
    manifest_file.write_text(json.dumps(manifest_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest_payload["manifest_path"] = manifest_file.relative_to(project_dir).as_posix()
    return manifest_payload
