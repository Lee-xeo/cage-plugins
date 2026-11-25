"""Protocol-oriented multi-provider TTS client using only the Python standard library."""

from __future__ import annotations

import base64
import copy
import json
import os
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple
from xml.sax.saxutils import escape as xml_escape

from audio_info import measure_duration_seconds, pcm_to_wav

SUPPORTED_FORMATS = ("mp3", "wav", "ogg_opus", "pcm", "flac")

FORMAT_EXTENSIONS = {
    "mp3": ".mp3",
    "wav": ".wav",
    "ogg_opus": ".ogg",
    "pcm": ".pcm",
    "flac": ".flac",
}

EXTENSION_FORMATS = {
    ".mp3": "mp3",
    ".wav": "wav",
    ".ogg": "ogg_opus",
    ".opus": "ogg_opus",
    ".pcm": "pcm",
    ".flac": "flac",
}

PROTOCOL_CATALOG: List[Dict[str, Any]] = [
    {
        "protocol": "openai",
        "name": "OpenAI Audio Speech Protocol",
        "default_endpoint": "https://api.openai.com/v1/audio/speech",
        "auth": "Authorization: Bearer <api_key> (optional for local self-hosted gateways)",
        "covers": [
            "OpenAI TTS (gpt-4o-mini-tts, tts-1, tts-1-hd)",
            "OpenAI-compatible cloud gateways (SiliconFlow, StepFun, Fish Audio gateways, OneAPI/NewAPI)",
            "Local OpenAI-compatible servers (CosyVoice, GPT-SoVITS, IndexTTS, Kokoro-FastAPI, Speaches)",
        ],
        "fields": ["endpoint", "api_key", "model/resource_id", "voice", "format", "speed", "instructions"],
    },
    {
        "protocol": "volcengine-v3",
        "name": "Volcengine / BytePlus Seed TTS V3 Unidirectional HTTP",
        "default_endpoint": "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
        "auth": "X-Api-Key + X-Api-Resource-Id (or X-Api-App-Id + X-Api-Access-Key + X-Api-Resource-Id when app_id is set)",
        "covers": [
            "Doubao / Volcengine Seed TTS 1.0 & 2.0 (seed-tts-1.0, seed-tts-2.0, volc.service_type.10029)",
            "Volcengine ICL voice cloning (seed-icl-1.0, seed-icl-2.0)",
            "BytePlus regional V3 unidirectional endpoints",
        ],
        "fields": ["endpoint", "api_key", "app_id", "resource_id", "voice", "format", "sample_rate", "speed", "volume", "emotion", "emotion_scale"],
    },
    {
        "protocol": "volcengine-v1",
        "name": "Volcengine Openspeech V1 HTTP",
        "default_endpoint": "https://openspeech.bytedance.com/api/v1/tts",
        "auth": "Authorization: Bearer;<api_key> plus app.appid and app.cluster",
        "covers": [
            "Volcengine classic TTS & Doubao clusters (volcano_tts, volcano_mega, volcano_icl)",
        ],
        "fields": ["endpoint", "api_key", "app_id", "resource_id(cluster)", "voice", "format", "sample_rate", "speed", "volume", "pitch", "emotion", "emotion_scale"],
    },
    {
        "protocol": "minimax",
        "name": "MiniMax T2A v2 HTTP",
        "default_endpoint": "https://api.minimaxi.com/v1/t2a_v2",
        "auth": "Authorization: Bearer <api_key> (optional ?GroupId=<app_id>)",
        "covers": [
            "MiniMax Speech-02 / Speech-2.5 / Speech-01 (api.minimaxi.com or api.minimax.io)",
        ],
        "fields": ["endpoint", "api_key", "app_id(group_id)", "model/resource_id", "voice", "format", "sample_rate", "speed", "volume", "pitch", "emotion"],
    },
    {
        "protocol": "elevenlabs",
        "name": "ElevenLabs TTS HTTP",
        "default_endpoint": "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        "auth": "xi-api-key: <api_key>",
        "covers": [
            "ElevenLabs TTS and compatible endpoints",
        ],
        "fields": ["endpoint", "api_key", "model/resource_id", "voice", "format", "sample_rate", "speed"],
    },
    {
        "protocol": "azure",
        "name": "Azure Speech SSML HTTP",
        "default_endpoint": "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        "auth": "Ocp-Apim-Subscription-Key: <api_key>",
        "covers": [
            "Microsoft Azure Cognitive Services Speech Neural & Custom Voices",
        ],
        "fields": ["endpoint(region or URL)", "api_key", "app_id(region)", "voice", "format", "sample_rate", "speed", "volume", "pitch", "emotion", "language"],
    },
    {
        "protocol": "dashscope",
        "name": "Alibaba Cloud DashScope MultiModal TTS HTTP",
        "default_endpoint": "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        "auth": "Authorization: Bearer <api_key>",
        "covers": [
            "Alibaba Cloud DashScope Qwen-TTS (qwen-tts, qwen3-tts-flash) in Beijing or Singapore regions",
        ],
        "fields": ["endpoint", "api_key", "model/resource_id", "voice", "language"],
    },
    {
        "protocol": "http-generic",
        "name": "Generic Configurable HTTP JSON Template",
        "default_endpoint": "Configured per profile via endpoint + body_template + response_mode",
        "auth": "Configured via profile headers template (for example {{api_key}})",
        "covers": [
            "Any custom, self-hosted, or new vendor HTTP TTS API via JSON profile templates",
        ],
        "fields": ["endpoint", "method", "headers", "body_template", "response_mode", "response_path", "success_code_path", "success_codes"],
    },
]

SUPPORTED_PROTOCOLS = tuple(item["protocol"] for item in PROTOCOL_CATALOG)


class TTSError(RuntimeError):
    """Structured error raised during profile resolution or speech synthesis."""


@dataclass
class SynthesisRequest:
    text: str
    voice: Optional[str] = None
    model: Optional[str] = None
    format: Optional[str] = None
    sample_rate: Optional[int] = None
    speed: Optional[float] = None
    volume: Optional[float] = None
    pitch: Optional[float] = None
    emotion: Optional[str] = None
    emotion_scale: Optional[float] = None
    language: Optional[str] = None
    instructions: Optional[str] = None


@dataclass
class SynthesisResult:
    audio_bytes: bytes
    audio_format: str
    protocol: str
    voice: str
    sample_rate: int
    duration_seconds: Optional[float] = None
    request_id: Optional[str] = None
    model: Optional[str] = None


# Signature for pluggable HTTP transport (allows clean unit testing without network).
HttpTransport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Tuple[int, Dict[str, str], bytes]]


def default_http_transport(
    url: str,
    method: str,
    headers: Dict[str, str],
    body: Optional[bytes],
    timeout: float,
) -> Tuple[int, Dict[str, str], bytes]:
    req = urllib.request.Request(url=url, data=body, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = getattr(resp, "status", 200)
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            data = resp.read()
            return status, resp_headers, data
    except urllib.error.HTTPError as exc:
        err_body = b""
        try:
            err_body = exc.read()
        except Exception:
            pass
        resp_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
        return exc.code, resp_headers, err_body
    except urllib.error.URLError as exc:
        raise TTSError(f"Network request failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise TTSError(f"Request timed out after {timeout:.0f}s") from exc


def _redact_secrets(text: str, secrets: List[str]) -> str:
    out = text
    for secret in secrets:
        if secret and len(secret) >= 4:
            out = out.replace(secret, "[REDACTED]")
    return out


def _safe_error_snippet(body: bytes, secrets: List[str], limit: int = 400) -> str:
    raw = body.decode("utf-8", errors="replace").strip()
    if len(raw) > limit:
        raw = raw[:limit] + "..."
    return _redact_secrets(raw, secrets)


def _clamp_timeout(raw: Any, default: float = 45.0) -> float:
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return max(5.0, min(120.0, value))


def _resolve_int(value: Any, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _extract_dotted_path(obj: Any, path: str) -> Any:
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
        if cur is None:
            return None
    return cur


def _render_template(node: Any, variables: Dict[str, Any]) -> Any:
    if isinstance(node, dict):
        return {k: _render_template(v, variables) for k, v in node.items()}
    if isinstance(node, list):
        return [_render_template(item, variables) for item in node]
    if isinstance(node, str):
        exact = re.fullmatch(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", node)
        if exact:
            key = exact.group(1)
            return variables.get(key, "")
        def repl(match: re.Match) -> str:
            key = match.group(1)
            val = variables.get(key, "")
            return "" if val is None else str(val)
        return re.sub(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", repl, node)
    return node


def load_profiles(
    env: Dict[str, str],
    project_dir: Optional[pathlib.Path] = None,
) -> Dict[str, Dict[str, Any]]:
    """Build the default profile from environment variables and merge optional JSON profiles."""
    default_profile: Dict[str, Any] = {
        "protocol": (env.get("TTS_PROTOCOL") or "volcengine-v3").strip().lower(),
        "api_key": env.get("TTS_API_KEY", "").strip(),
        "endpoint": env.get("TTS_ENDPOINT", "").strip(),
        "app_id": env.get("TTS_APP_ID", "").strip(),
        "resource_id": env.get("TTS_RESOURCE_ID", "").strip(),
        "voice": env.get("TTS_VOICE", "").strip(),
        "format": (env.get("TTS_FORMAT") or "mp3").strip().lower(),
        "sample_rate": _resolve_int(env.get("TTS_SAMPLE_RATE"), 24000),
        "timeout": _clamp_timeout(env.get("TTS_TIMEOUT"), 45.0),
    }
    profiles: Dict[str, Dict[str, Any]] = {"default": default_profile}

    raw_path = env.get("TTS_PROFILES_PATH", "").strip()
    if not raw_path:
        return profiles

    cfg_path = pathlib.Path(raw_path).expanduser()
    if not cfg_path.is_absolute() and project_dir is not None:
        cfg_path = project_dir / cfg_path
    if not cfg_path.is_file():
        raise TTSError(f"Profiles config file not found: {cfg_path}")

    try:
        parsed = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise TTSError(f"Failed to parse profiles config JSON: {exc}") from exc

    raw_profiles = parsed.get("profiles") if isinstance(parsed, dict) and isinstance(parsed.get("profiles"), dict) else parsed
    if not isinstance(raw_profiles, dict):
        raise TTSError("Profiles config JSON must be an object mapping profile names to settings")

    for name, item in raw_profiles.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(item, dict):
            continue
        merged = copy.deepcopy(default_profile) if name == "default" else {
            "protocol": default_profile["protocol"],
            "format": default_profile["format"],
            "sample_rate": default_profile["sample_rate"],
            "timeout": default_profile["timeout"],
        }
        merged.update(item)
        # Resolve api_key from a named environment variable if requested.
        key_env = str(merged.get("api_key_env", "")).strip()
        if key_env and not merged.get("api_key"):
            merged["api_key"] = env.get(key_env, "").strip()
        elif not merged.get("api_key") and name != "default" and merged.get("protocol") == default_profile["protocol"]:
            # Conveniently share the plugin's encrypted API key when the profile uses the same protocol.
            merged["api_key"] = default_profile["api_key"]
            if not merged.get("app_id"):
                merged["app_id"] = default_profile["app_id"]
        merged["protocol"] = str(merged.get("protocol") or "openai").strip().lower()
        merged["format"] = str(merged.get("format") or "mp3").strip().lower()
        merged["sample_rate"] = _resolve_int(merged.get("sample_rate"), 24000)
        merged["timeout"] = _clamp_timeout(merged.get("timeout"), default_profile["timeout"])
        profiles[name.strip()] = merged

    return profiles


def summarize_profiles(profiles: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return a non-secret summary of all configured profiles."""
    summary = []
    for name, prof in profiles.items():
        summary.append({
            "name": name,
            "protocol": prof.get("protocol", ""),
            "endpoint": prof.get("endpoint") or _default_endpoint_for(prof.get("protocol", "")),
            "app_id_configured": bool(prof.get("app_id")),
            "api_key_configured": bool(prof.get("api_key")),
            "model_or_resource": prof.get("model") or prof.get("resource_id") or "",
            "voice": prof.get("voice") or "",
            "format": prof.get("format") or "mp3",
            "sample_rate": prof.get("sample_rate") or 24000,
        })
    return summary


def _default_endpoint_for(protocol: str) -> str:
    for item in PROTOCOL_CATALOG:
        if item["protocol"] == protocol:
            return item["default_endpoint"]
    return ""


def _normalize_openai_endpoint(endpoint: str) -> str:
    if not endpoint:
        return "https://api.openai.com/v1/audio/speech"
    url = endpoint.rstrip("/")
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.rstrip("/")
    if path.endswith("/audio/speech") or path.endswith("/speech"):
        return url
    if path == "" or path.endswith("/v1"):
        return url + "/audio/speech"
    return url


def _synthesize_openai(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    url = _normalize_openai_endpoint(str(profile.get("endpoint", "")).strip())
    api_key = str(profile.get("api_key", "")).strip()
    model = req.model or profile.get("model") or profile.get("resource_id") or "gpt-4o-mini-tts"
    voice = req.voice or profile.get("voice") or "alloy"
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 24000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    openai_fmt = "opus" if fmt == "ogg_opus" else fmt
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    payload: Dict[str, Any] = {
        "model": model,
        "input": req.text,
        "voice": voice,
        "response_format": openai_fmt,
    }
    speed = req.speed if req.speed is not None else profile.get("speed")
    if speed is not None:
        payload["speed"] = float(speed)
    instructions = req.instructions or profile.get("instructions")
    if instructions:
        payload["instructions"] = str(instructions)
    if isinstance(profile.get("extra_params"), dict):
        payload.update(profile["extra_params"])

    status, resp_headers, data = transport(url, "POST", headers, json.dumps(payload).encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"OpenAI-compatible TTS error (HTTP {status}): {_safe_error_snippet(data, [api_key])}")
    if "application/json" in resp_headers.get("content-type", ""):
        raise TTSError(f"Unexpected JSON response from OpenAI-compatible endpoint: {_safe_error_snippet(data, [api_key])}")
    if not data:
        raise TTSError("Empty audio response from OpenAI-compatible endpoint")

    dur = measure_duration_seconds(data, fmt, sample_rate)
    return SynthesisResult(
        audio_bytes=data,
        audio_format=fmt,
        protocol="openai",
        voice=str(voice),
        sample_rate=sample_rate,
        duration_seconds=dur,
        model=str(model),
    )


def _synthesize_volcengine_v3(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    url = str(profile.get("endpoint", "")).strip() or "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
    api_key = str(profile.get("api_key", "")).strip()
    app_id = str(profile.get("app_id", "")).strip()
    resource_id = str(req.model or profile.get("resource_id") or profile.get("model") or "seed-tts-2.0").strip()
    voice = str(req.voice or profile.get("voice") or "").strip()
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 24000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    if not api_key:
        raise TTSError("Volcengine V3 requires API Key / Access Key (configure 'API Key / Access Token' in plugin settings).")
    if not voice:
        raise TTSError("Volcengine V3 requires a speaker/voice ID (e.g. zh_female_vv_uranus_bigtts).")

    reqid = str(uuid.uuid4())
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "X-Api-Resource-Id": resource_id,
        "X-Api-Request-Id": reqid,
    }
    if app_id:
        headers["X-Api-App-Id"] = app_id
        headers["X-Api-Access-Key"] = api_key
    else:
        headers["X-Api-Key"] = api_key
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    wrap_wav = fmt == "wav"
    v3_format = "pcm" if wrap_wav else ("mp3" if fmt == "flac" else fmt)
    actual_fmt = "wav" if wrap_wav else v3_format

    audio_params: Dict[str, Any] = {
        "format": v3_format,
        "sample_rate": sample_rate,
    }
    speed = req.speed if req.speed is not None else profile.get("speed")
    if speed is not None and float(speed) != 1.0:
        audio_params["speech_rate"] = max(-50, min(100, int(round((float(speed) - 1.0) * 100))))
    volume = req.volume if req.volume is not None else profile.get("volume")
    if volume is not None and float(volume) != 1.0:
        audio_params["loudness_rate"] = max(-50, min(100, int(round((float(volume) - 1.0) * 100))))
    emotion = req.emotion or profile.get("emotion")
    if emotion:
        audio_params["emotion"] = str(emotion)
        scale = req.emotion_scale if req.emotion_scale is not None else profile.get("emotion_scale")
        if scale is not None:
            audio_params["emotion_scale"] = max(1, min(5, int(round(float(scale)))))

    req_params: Dict[str, Any] = {
        "text": req.text,
        "speaker": voice,
        "audio_params": audio_params,
    }
    if isinstance(profile.get("extra_params"), dict):
        req_params.update(profile["extra_params"])

    payload = {
        "user": {"uid": str(profile.get("uid") or "tts-client")},
        "req_params": req_params,
    }

    status, _resp_headers, raw = transport(url, "POST", headers, json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"Volcengine V3 HTTP {status}: {_safe_error_snippet(raw, [api_key])}")

    chunks = bytearray()
    text_body = raw.decode("utf-8", errors="replace")
    parsed_any = False
    for raw_line in text_body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
            if not line or line == "[DONE]":
                continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        parsed_any = True
        code = obj.get("code")
        if code not in (None, 0, 3000, 20000000):
            msg = obj.get("message") or obj.get("error") or "unknown error"
            raise TTSError(f"Volcengine V3 error (code {code}): {_redact_secrets(str(msg), [api_key])}")
        b64_audio = obj.get("data")
        if isinstance(b64_audio, str) and b64_audio:
            chunks.extend(base64.b64decode(b64_audio))

    if not parsed_any:
        raise TTSError(f"Volcengine V3 returned non-JSON response: {_safe_error_snippet(raw, [api_key])}")
    if not chunks:
        raise TTSError("Volcengine V3 returned no audio data (check voice/speaker ID and resource ID compatibility).")

    audio_bytes = pcm_to_wav(bytes(chunks), sample_rate=sample_rate) if wrap_wav else bytes(chunks)
    dur = measure_duration_seconds(audio_bytes, actual_fmt, sample_rate)
    return SynthesisResult(
        audio_bytes=audio_bytes,
        audio_format=actual_fmt,
        protocol="volcengine-v3",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
        request_id=reqid,
        model=resource_id,
    )


def _synthesize_volcengine_v1(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    url = str(profile.get("endpoint", "")).strip() or "https://openspeech.bytedance.com/api/v1/tts"
    api_key = str(profile.get("api_key", "")).strip()
    app_id = str(profile.get("app_id", "")).strip()
    cluster = str(req.model or profile.get("resource_id") or profile.get("model") or "volcano_tts").strip()
    voice = str(req.voice or profile.get("voice") or "").strip()
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 24000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    if not app_id or not api_key:
        raise TTSError("Volcengine V1 requires both App ID ('App ID / Group ID') and Access Token ('API Key / Access Token').")
    if not voice:
        raise TTSError("Volcengine V1 requires a voice_type ID (e.g. zh_female_shuangkuaisisi_moon_bigtts).")

    reqid = str(uuid.uuid4())
    # Volcengine V1 requires a semicolon separator after Bearer.
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer;{api_key}",
    }
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    v1_encoding = "mp3" if fmt == "flac" else fmt
    audio: Dict[str, Any] = {
        "voice_type": voice,
        "encoding": v1_encoding,
        "rate": sample_rate,
        "speed_ratio": float(req.speed if req.speed is not None else profile.get("speed", 1.0)),
        "volume_ratio": float(req.volume if req.volume is not None else profile.get("volume", 1.0)),
        "pitch_ratio": float(req.pitch if req.pitch is not None else profile.get("pitch", 1.0)),
    }
    emotion = req.emotion or profile.get("emotion")
    if emotion:
        audio["emotion"] = str(emotion)
        audio["enable_emotion"] = True
        scale = req.emotion_scale if req.emotion_scale is not None else profile.get("emotion_scale")
        if scale is not None:
            audio["emotion_scale"] = max(1, min(5, int(round(float(scale)))))

    payload: Dict[str, Any] = {
        "app": {"appid": app_id, "token": api_key, "cluster": cluster},
        "user": {"uid": str(profile.get("uid") or "tts-client")},
        "audio": audio,
        "request": {
            "reqid": reqid,
            "text": req.text,
            "text_type": "plain",
            "operation": "query",
        },
    }
    if isinstance(profile.get("extra_params"), dict):
        payload["request"].update(profile["extra_params"])

    status, _resp_headers, raw = transport(url, "POST", headers, json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"Volcengine V1 HTTP {status}: {_safe_error_snippet(raw, [api_key])}")
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise TTSError(f"Volcengine V1 returned invalid JSON: {_safe_error_snippet(raw, [api_key])}") from exc

    code = obj.get("code")
    if code != 3000:
        raise TTSError(f"Volcengine V1 error (code {code}): {_redact_secrets(str(obj.get('message', '')), [api_key])}")
    b64_audio = obj.get("data")
    if not isinstance(b64_audio, str) or not b64_audio:
        raise TTSError("Volcengine V1 returned empty audio data")

    audio_bytes = base64.b64decode(b64_audio)
    dur = measure_duration_seconds(audio_bytes, v1_encoding, sample_rate)
    if dur is None and isinstance(obj.get("addition"), dict):
        try:
            dur = round(float(obj["addition"]["duration"]) / 1000.0, 3)
        except Exception:
            pass

    return SynthesisResult(
        audio_bytes=audio_bytes,
        audio_format=v1_encoding,
        protocol="volcengine-v1",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
        request_id=reqid,
        model=cluster,
    )


def _synthesize_minimax(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    url = str(profile.get("endpoint", "")).strip() or "https://api.minimaxi.com/v1/t2a_v2"
    api_key = str(profile.get("api_key", "")).strip()
    group_id = str(profile.get("app_id", "")).strip()
    model = str(req.model or profile.get("model") or profile.get("resource_id") or "speech-02-hd").strip()
    voice = str(req.voice or profile.get("voice") or "male-qn-qingse").strip()
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 32000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    if not api_key:
        raise TTSError("MiniMax requires an API Key.")
    if group_id and "GroupId=" not in url:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}GroupId={urllib.parse.quote(group_id)}"

    mm_fmt = "mp3" if fmt == "ogg_opus" else fmt
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    voice_setting: Dict[str, Any] = {
        "voice_id": voice,
        "speed": float(req.speed if req.speed is not None else profile.get("speed", 1.0)),
        "vol": float(req.volume if req.volume is not None else profile.get("volume", 1.0)),
        "pitch": int(round(float(req.pitch if req.pitch is not None else profile.get("pitch", 0)))),
    }
    emotion = req.emotion or profile.get("emotion")
    if emotion:
        voice_setting["emotion"] = str(emotion)

    payload: Dict[str, Any] = {
        "model": model,
        "text": req.text,
        "stream": False,
        "output_format": "hex",
        "voice_setting": voice_setting,
        "audio_setting": {
            "sample_rate": sample_rate,
            "bitrate": 128000,
            "format": mm_fmt,
            "channel": 1,
        },
    }
    if isinstance(profile.get("extra_params"), dict):
        payload.update(profile["extra_params"])

    status, _resp_headers, raw = transport(url, "POST", headers, json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"MiniMax HTTP {status}: {_safe_error_snippet(raw, [api_key])}")
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise TTSError(f"MiniMax returned invalid JSON: {_safe_error_snippet(raw, [api_key])}") from exc

    base_resp = obj.get("base_resp") or {}
    if base_resp.get("status_code", 0) != 0:
        raise TTSError(f"MiniMax error ({base_resp.get('status_code')}): {_redact_secrets(str(base_resp.get('status_msg', '')), [api_key])}")

    audio_hex = (obj.get("data") or {}).get("audio")
    if not isinstance(audio_hex, str) or not audio_hex:
        raise TTSError("MiniMax returned empty audio payload")
    audio_bytes = bytes.fromhex(audio_hex)

    dur = measure_duration_seconds(audio_bytes, mm_fmt, sample_rate)
    if dur is None and isinstance(obj.get("extra_info"), dict):
        try:
            dur = round(float(obj["extra_info"]["audio_length"]) / 1000.0, 3)
        except Exception:
            pass

    return SynthesisResult(
        audio_bytes=audio_bytes,
        audio_format=mm_fmt,
        protocol="minimax",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
        request_id=obj.get("trace_id"),
        model=model,
    )


def _synthesize_elevenlabs(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    api_key = str(profile.get("api_key", "")).strip()
    voice = str(req.voice or profile.get("voice") or "").strip()
    model = str(req.model or profile.get("model") or profile.get("resource_id") or "eleven_multilingual_v2").strip()
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 44100)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    if not api_key:
        raise TTSError("ElevenLabs requires an API Key.")
    if not voice:
        raise TTSError("ElevenLabs requires a voice_id.")

    raw_endpoint = str(profile.get("endpoint", "")).strip()
    if not raw_endpoint:
        base_url = f"https://api.elevenlabs.io/v1/text-to-speech/{urllib.parse.quote(voice)}"
    elif "{voice_id}" in raw_endpoint or "{voice}" in raw_endpoint:
        base_url = raw_endpoint.replace("{voice_id}", urllib.parse.quote(voice)).replace("{voice}", urllib.parse.quote(voice))
    elif "/text-to-speech/" in raw_endpoint:
        base_url = raw_endpoint
    else:
        base_url = raw_endpoint.rstrip("/") + f"/text-to-speech/{urllib.parse.quote(voice)}"

    wrap_wav = fmt == "wav"
    if fmt in ("pcm", "wav"):
        sr = sample_rate if sample_rate in (16000, 22050, 24000, 44100) else 24000
        el_format = f"pcm_{sr}"
        sample_rate = sr
        actual_fmt = "wav" if wrap_wav else "pcm"
    else:
        el_format = "mp3_44100_128"
        actual_fmt = "mp3"

    sep = "&" if "?" in base_url else "?"
    url = f"{base_url}{sep}output_format={el_format}"

    headers = {
        "Content-Type": "application/json",
        "xi-api-key": api_key,
    }
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    payload: Dict[str, Any] = {
        "text": req.text,
        "model_id": model,
    }
    speed = req.speed if req.speed is not None else profile.get("speed")
    if speed is not None:
        payload["voice_settings"] = {"speed": max(0.7, min(1.2, float(speed)))}
    if isinstance(profile.get("extra_params"), dict):
        payload.update(profile["extra_params"])

    status, _resp_headers, raw = transport(url, "POST", headers, json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"ElevenLabs HTTP {status}: {_safe_error_snippet(raw, [api_key])}")
    if not raw:
        raise TTSError("ElevenLabs returned empty audio response")

    audio_bytes = pcm_to_wav(raw, sample_rate=sample_rate) if wrap_wav else raw
    dur = measure_duration_seconds(audio_bytes, actual_fmt, sample_rate)
    return SynthesisResult(
        audio_bytes=audio_bytes,
        audio_format=actual_fmt,
        protocol="elevenlabs",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
        model=model,
    )


def _azure_output_format(fmt: str, sample_rate: int) -> Tuple[str, str]:
    if fmt == "wav":
        if sample_rate >= 48000:
            return "riff-48khz-16bit-mono-pcm", "wav"
        if sample_rate >= 24000:
            return "riff-24khz-16bit-mono-pcm", "wav"
        return "riff-16khz-16bit-mono-pcm", "wav"
    if fmt == "ogg_opus":
        return "ogg-24khz-16bit-mono-opus", "ogg_opus"
    if fmt == "pcm":
        return ("raw-24khz-16bit-mono-pcm" if sample_rate >= 24000 else "raw-16khz-16bit-mono-pcm"), "pcm"
    if sample_rate >= 48000:
        return "audio-48khz-192kbitrate-mono-mp3", "mp3"
    if sample_rate >= 24000:
        return "audio-24khz-96kbitrate-mono-mp3", "mp3"
    return "audio-16khz-64kbitrate-mono-mp3", "mp3"


def _synthesize_azure(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    api_key = str(profile.get("api_key", "")).strip()
    voice = str(req.voice or profile.get("voice") or "zh-CN-XiaoxiaoNeural").strip()
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 24000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    if not api_key:
        raise TTSError("Azure Speech requires a subscription key ('API Key / Access Token').")

    raw_endpoint = str(profile.get("endpoint", "")).strip()
    region = str(profile.get("app_id", "")).strip()
    if raw_endpoint.startswith("http://") or raw_endpoint.startswith("https://"):
        url = raw_endpoint.rstrip("/")
        if not url.endswith("/cognitiveservices/v1"):
            url += "/cognitiveservices/v1"
    else:
        chosen_region = raw_endpoint or region
        if not chosen_region:
            raise TTSError("Azure Speech requires a region (e.g. eastasia) or full endpoint URL in 'API Endpoint' or 'App ID'.")
        url = f"https://{chosen_region}.tts.speech.microsoft.com/cognitiveservices/v1"

    lang = str(req.language or profile.get("language") or "").strip()
    if not lang:
        parts = voice.split("-")
        lang = f"{parts[0]}-{parts[1]}" if len(parts) >= 2 else "en-US"

    output_header, actual_fmt = _azure_output_format(fmt, sample_rate)
    body_text = xml_escape(req.text)

    prosody_attrs = []
    speed = req.speed if req.speed is not None else profile.get("speed")
    if speed is not None and float(speed) != 1.0:
        pct = int(round((float(speed) - 1.0) * 100))
        prosody_attrs.append(f"rate='{pct:+d}%'")
    volume = req.volume if req.volume is not None else profile.get("volume")
    if volume is not None and float(volume) != 1.0:
        pct = int(round((float(volume) - 1.0) * 100))
        prosody_attrs.append(f"volume='{pct:+d}%'")
    pitch = req.pitch if req.pitch is not None else profile.get("pitch")
    if pitch is not None and float(pitch) != 1.0 and float(pitch) != 0.0:
        pct = int(round((float(pitch) - 1.0) * 100))
        prosody_attrs.append(f"pitch='{pct:+d}%'")

    inner = f"<prosody {' '.join(prosody_attrs)}>{body_text}</prosody>" if prosody_attrs else body_text
    emotion = req.emotion or profile.get("emotion")
    if emotion:
        inner = f"<mstts:express-as style='{xml_escape(str(emotion))}'>{inner}</mstts:express-as>"

    ssml = (
        f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' "
        f"xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='{xml_escape(lang)}'>"
        f"<voice name='{xml_escape(voice)}'>{inner}</voice></speak>"
    )

    headers = {
        "Ocp-Apim-Subscription-Key": api_key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": output_header,
        "User-Agent": "text-to-speech-mcp",
    }
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    status, _resp_headers, raw = transport(url, "POST", headers, ssml.encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"Azure Speech HTTP {status}: {_safe_error_snippet(raw, [api_key])}")
    if not raw:
        raise TTSError("Azure Speech returned empty audio response")

    dur = measure_duration_seconds(raw, actual_fmt, sample_rate)
    return SynthesisResult(
        audio_bytes=raw,
        audio_format=actual_fmt,
        protocol="azure",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
    )


def _synthesize_dashscope(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    url = str(profile.get("endpoint", "")).strip() or "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
    api_key = str(profile.get("api_key", "")).strip()
    model = str(req.model or profile.get("model") or profile.get("resource_id") or "qwen-tts").strip()
    voice = str(req.voice or profile.get("voice") or "Cherry").strip()
    language = str(req.language or profile.get("language") or "Auto").strip()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 24000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)

    if not api_key:
        raise TTSError("DashScope requires an API Key.")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(v)

    input_obj: Dict[str, Any] = {
        "text": req.text,
        "voice": voice,
        "language_type": language,
    }
    if isinstance(profile.get("extra_params"), dict):
        input_obj.update(profile["extra_params"])

    payload = {
        "model": model,
        "input": input_obj,
    }
    status, _resp_headers, raw = transport(url, "POST", headers, json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"DashScope HTTP {status}: {_safe_error_snippet(raw, [api_key])}")
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise TTSError(f"DashScope returned invalid JSON: {_safe_error_snippet(raw, [api_key])}") from exc

    if obj.get("code"):
        raise TTSError(f"DashScope error ({obj.get('code')}): {_redact_secrets(str(obj.get('message', '')), [api_key])}")

    audio_info = (obj.get("output") or {}).get("audio") or {}
    audio_bytes: Optional[bytes] = None
    if isinstance(audio_info.get("data"), str) and audio_info["data"]:
        audio_bytes = base64.b64decode(audio_info["data"])
    elif isinstance(audio_info.get("url"), str) and audio_info["url"]:
        dl_status, _dl_headers, dl_raw = transport(audio_info["url"], "GET", {}, None, timeout)
        if dl_status < 200 or dl_status >= 300 or not dl_raw:
            raise TTSError(f"Failed to download DashScope audio URL (HTTP {dl_status})")
        audio_bytes = dl_raw
    if not audio_bytes:
        raise TTSError("DashScope response did not include audio data or URL")

    actual_fmt = "wav" if audio_bytes[:4] == b"RIFF" else ("mp3" if audio_bytes[:3] == b"ID3" else (req.format or "wav"))
    dur = measure_duration_seconds(audio_bytes, actual_fmt, sample_rate)
    return SynthesisResult(
        audio_bytes=audio_bytes,
        audio_format=actual_fmt,
        protocol="dashscope",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
        request_id=obj.get("request_id"),
        model=model,
    )


def _synthesize_http_generic(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    transport: HttpTransport,
) -> SynthesisResult:
    url = str(profile.get("endpoint", "")).strip()
    if not url:
        raise TTSError("http-generic protocol requires 'endpoint' in profile settings.")
    api_key = str(profile.get("api_key", "")).strip()
    app_id = str(profile.get("app_id", "")).strip()
    model = str(req.model or profile.get("model") or profile.get("resource_id") or "").strip()
    voice = str(req.voice or profile.get("voice") or "").strip()
    fmt = (req.format or profile.get("format") or "mp3").lower()
    sample_rate = req.sample_rate or _resolve_int(profile.get("sample_rate"), 24000)
    timeout = _clamp_timeout(profile.get("timeout"), 45.0)
    reqid = str(uuid.uuid4())

    variables: Dict[str, Any] = {
        "text": req.text,
        "voice": voice,
        "model": model,
        "resource_id": model,
        "format": fmt,
        "sample_rate": sample_rate,
        "speed": float(req.speed if req.speed is not None else profile.get("speed", 1.0)),
        "volume": float(req.volume if req.volume is not None else profile.get("volume", 1.0)),
        "pitch": float(req.pitch if req.pitch is not None else profile.get("pitch", 1.0)),
        "emotion": str(req.emotion or profile.get("emotion") or ""),
        "language": str(req.language or profile.get("language") or ""),
        "instructions": str(req.instructions or profile.get("instructions") or ""),
        "reqid": reqid,
        "api_key": api_key,
        "app_id": app_id,
    }

    rendered_url = str(_render_template(url, variables))
    method = str(profile.get("method") or "POST").upper()
    headers = {"Content-Type": "application/json"}
    if isinstance(profile.get("headers"), dict):
        for k, v in profile["headers"].items():
            headers[str(k)] = str(_render_template(str(v), variables))
    elif api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body_template = profile.get("body_template")
    if body_template is None:
        body_obj = {"text": req.text, "voice": voice, "model": model, "format": fmt}
    else:
        body_obj = _render_template(body_template, variables)

    body_bytes = None if method == "GET" else (
        body_obj.encode("utf-8") if isinstance(body_obj, str) else json.dumps(body_obj, ensure_ascii=False).encode("utf-8")
    )

    status, _resp_headers, raw = transport(rendered_url, method, headers, body_bytes, timeout)
    if status < 200 or status >= 300:
        raise TTSError(f"Generic HTTP TTS error (HTTP {status}): {_safe_error_snippet(raw, [api_key])}")

    response_mode = str(profile.get("response_mode") or "binary").strip().lower()
    response_path = str(profile.get("response_path") or "data").strip()
    success_code_path = str(profile.get("success_code_path") or "").strip()
    success_codes = profile.get("success_codes")

    audio_bytes: bytes
    if response_mode == "binary":
        audio_bytes = raw
    elif response_mode == "ndjson_base64":
        chunks = bytearray()
        for raw_line in raw.decode("utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("data:"):
                line = line[5:].strip()
                if not line or line == "[DONE]":
                    continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if success_code_path and isinstance(success_codes, list):
                code = _extract_dotted_path(obj, success_code_path)
                if code is not None and code not in success_codes:
                    raise TTSError(f"Generic HTTP TTS error (code {code})")
            val = _extract_dotted_path(obj, response_path)
            if isinstance(val, str) and val:
                chunks.extend(base64.b64decode(val))
        audio_bytes = bytes(chunks)
    else:
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise TTSError(f"Generic HTTP TTS returned invalid JSON: {_safe_error_snippet(raw, [api_key])}") from exc
        if success_code_path and isinstance(success_codes, list):
            code = _extract_dotted_path(obj, success_code_path)
            if code is not None and code not in success_codes:
                raise TTSError(f"Generic HTTP TTS error (code {code})")
        val = _extract_dotted_path(obj, response_path)
        if not isinstance(val, str) or not val:
            raise TTSError(f"Generic HTTP TTS response missing field '{response_path}'")
        if response_mode == "json_base64":
            audio_bytes = base64.b64decode(val)
        elif response_mode == "json_hex":
            audio_bytes = bytes.fromhex(val)
        elif response_mode == "json_url":
            dl_status, _dl_headers, dl_raw = transport(val, "GET", {}, None, timeout)
            if dl_status < 200 or dl_status >= 300 or not dl_raw:
                raise TTSError(f"Failed to download audio from URL returned by generic endpoint (HTTP {dl_status})")
            audio_bytes = dl_raw
        else:
            raise TTSError(f"Unsupported response_mode: {response_mode}")

    if not audio_bytes:
        raise TTSError("Generic HTTP TTS returned empty audio data")

    dur = measure_duration_seconds(audio_bytes, fmt, sample_rate)
    return SynthesisResult(
        audio_bytes=audio_bytes,
        audio_format=fmt,
        protocol="http-generic",
        voice=voice,
        sample_rate=sample_rate,
        duration_seconds=dur,
        request_id=reqid,
        model=model or None,
    )


_DISPATCH = {
    "openai": _synthesize_openai,
    "volcengine-v3": _synthesize_volcengine_v3,
    "volcengine-v1": _synthesize_volcengine_v1,
    "minimax": _synthesize_minimax,
    "elevenlabs": _synthesize_elevenlabs,
    "azure": _synthesize_azure,
    "dashscope": _synthesize_dashscope,
    "http-generic": _synthesize_http_generic,
}


def synthesize(
    profile: Dict[str, Any],
    req: SynthesisRequest,
    protocol_override: Optional[str] = None,
    transport: HttpTransport = default_http_transport,
) -> SynthesisResult:
    """Synthesize speech using the resolved profile and protocol adapter."""
    text = (req.text or "").strip()
    if not text:
        raise TTSError("Text to synthesize must not be empty.")
    protocol = (protocol_override or profile.get("protocol") or "openai").strip().lower()
    handler = _DISPATCH.get(protocol)
    if not handler:
        raise TTSError(f"Unsupported TTS protocol '{protocol}'. Choose from: {', '.join(SUPPORTED_PROTOCOLS)}")
    return handler(profile, SynthesisRequest(
        text=text,
        voice=req.voice,
        model=req.model,
        format=req.format,
        sample_rate=req.sample_rate,
        speed=req.speed,
        volume=req.volume,
        pitch=req.pitch,
        emotion=req.emotion,
        emotion_scale=req.emotion_scale,
        language=req.language,
        instructions=req.instructions,
    ), transport)
