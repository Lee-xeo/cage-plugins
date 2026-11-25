#!/usr/bin/env python3
"""Unit and stdio MCP smoke tests for the text-to-speech plugin."""

from __future__ import annotations

import base64
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional, Tuple

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from audio_info import measure_duration_seconds, pcm_to_wav
from batch import parse_srt
from protocols import SynthesisRequest, TTSError, load_profiles, summarize_profiles, synthesize
from server import TTSServer, resolve_project_path


def make_wav_bytes(seconds: float = 0.5, sample_rate: int = 24000) -> bytes:
    frames = int(round(seconds * sample_rate))
    return pcm_to_wav(b"\x00\x00" * frames, sample_rate=sample_rate, channels=1, sample_width=2)


def make_mp3_cbr_bytes(frames: int = 10) -> bytes:
    # MPEG 1 Layer III, 128 kbps (index 9), 44100 Hz (index 0), no padding -> 417 bytes per frame.
    # Header bytes: 0xFF 0xFB 0x90 0x00
    frame = b"\xff\xfb\x90\x00" + (b"\x00" * 413)
    return frame * frames


class AudioInfoTests(unittest.TestCase):
    def test_wav_and_pcm_duration(self):
        pcm = b"\x00\x00" * 12000  # 0.5s at 24kHz 16-bit mono
        self.assertEqual(measure_duration_seconds(pcm, "pcm", 24000), 0.5)
        wav = pcm_to_wav(pcm, sample_rate=24000)
        self.assertEqual(wav[:4], b"RIFF")
        self.assertEqual(measure_duration_seconds(wav, "wav", 24000), 0.5)

    def test_mp3_cbr_duration(self):
        mp3 = make_mp3_cbr_bytes(frames=38)  # 38 * 1152 / 44100 = 0.99265s
        dur = measure_duration_seconds(mp3, "mp3")
        self.assertIsNotNone(dur)
        self.assertAlmostEqual(dur, 0.993, places=2)


class ProtocolAdapterTests(unittest.TestCase):
    def test_openai_protocol_and_url_normalization(self):
        captured: Dict[str, Any] = {}
        wav_data = make_wav_bytes(0.25)

        def fake_transport(url, method, headers, body, timeout):
            captured.update(url=url, method=method, headers=headers, body=json.loads(body.decode("utf-8")))
            return 200, {"content-type": "audio/wav"}, wav_data

        res = synthesize(
            {"protocol": "openai", "endpoint": "https://api.siliconflow.cn/v1", "api_key": "sk-test", "voice": "alloy"},
            SynthesisRequest(text="Hello world", format="wav", speed=1.1, instructions="Speak warmly"),
            transport=fake_transport,
        )
        self.assertEqual(captured["url"], "https://api.siliconflow.cn/v1/audio/speech")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer sk-test")
        self.assertEqual(captured["body"]["speed"], 1.1)
        self.assertEqual(captured["body"]["instructions"], "Speak warmly")
        self.assertEqual(res.duration_seconds, 0.25)

    def test_volcengine_v3_api_key_and_app_id_modes_and_wav_wrap(self):
        calls: List[Dict[str, Any]] = []
        pcm_chunk_1 = b"\x01\x00" * 6000  # 0.25s
        pcm_chunk_2 = b"\x02\x00" * 6000  # 0.25s
        ndjson = "\n".join([
            json.dumps({"code": 0, "message": "", "data": base64.b64encode(pcm_chunk_1).decode("ascii")}),
            "data: " + json.dumps({"code": 0, "message": "", "data": base64.b64encode(pcm_chunk_2).decode("ascii")}),
            json.dumps({"code": 20000000, "message": "OK", "data": None}),
        ]).encode("utf-8")

        def fake_transport(url, method, headers, body, timeout):
            calls.append({"url": url, "headers": headers, "body": json.loads(body.decode("utf-8"))})
            return 200, {"content-type": "application/json"}, ndjson

        # 1) Single X-Api-Key auth + WAV wrapping from PCM
        res = synthesize(
            {"protocol": "volcengine-v3", "api_key": "volc-secret-key", "resource_id": "seed-tts-2.0", "voice": "zh_female_vv_uranus_bigtts"},
            SynthesisRequest(text="火山引擎测试", format="wav", sample_rate=24000, speed=1.2, emotion="happy", emotion_scale=4),
            transport=fake_transport,
        )
        self.assertEqual(calls[0]["headers"]["X-Api-Key"], "volc-secret-key")
        self.assertNotIn("X-Api-App-Id", calls[0]["headers"])
        self.assertEqual(calls[0]["headers"]["X-Api-Resource-Id"], "seed-tts-2.0")
        self.assertEqual(calls[0]["body"]["req_params"]["audio_params"]["format"], "pcm")
        self.assertEqual(calls[0]["body"]["req_params"]["audio_params"]["speech_rate"], 20)
        self.assertEqual(calls[0]["body"]["req_params"]["audio_params"]["emotion"], "happy")
        self.assertEqual(res.audio_format, "wav")
        self.assertEqual(res.audio_bytes[:4], b"RIFF")
        self.assertEqual(res.duration_seconds, 0.5)

        # 2) AppID + AccessKey auth
        synthesize(
            {"protocol": "volcengine-v3", "app_id": "123456", "api_key": "access-key-abc", "resource_id": "volc.service_type.10029", "voice": "zh_female_vv_uranus_bigtts"},
            SynthesisRequest(text="测试鉴权", format="mp3"),
            transport=fake_transport,
        )
        self.assertEqual(calls[1]["headers"]["X-Api-App-Id"], "123456")
        self.assertEqual(calls[1]["headers"]["X-Api-Access-Key"], "access-key-abc")
        self.assertNotIn("X-Api-Key", calls[1]["headers"])

    def test_volcengine_v3_error_redacts_secret(self):
        def fake_transport(url, method, headers, body, timeout):
            err = json.dumps({"code": 40100001, "message": "invalid key super-secret-token"}).encode("utf-8")
            return 200, {}, err

        with self.assertRaises(TTSError) as ctx:
            synthesize(
                {"protocol": "volcengine-v3", "api_key": "super-secret-token", "voice": "v1"},
                SynthesisRequest(text="hi"),
                transport=fake_transport,
            )
        self.assertNotIn("super-secret-token", str(ctx.exception))
        self.assertIn("[REDACTED]", str(ctx.exception))

    def test_volcengine_v1_protocol(self):
        captured: Dict[str, Any] = {}
        mp3 = make_mp3_cbr_bytes(frames=10)

        def fake_transport(url, method, headers, body, timeout):
            captured.update(headers=headers, body=json.loads(body.decode("utf-8")))
            resp = {"reqid": "r1", "code": 3000, "message": "Success", "data": base64.b64encode(mp3).decode("ascii"), "addition": {"duration": "261"}}
            return 200, {}, json.dumps(resp).encode("utf-8")

        res = synthesize(
            {"protocol": "volcengine-v1", "app_id": "app1", "api_key": "tok1", "resource_id": "volcano_tts", "voice": "zh_male_zhixing"},
            SynthesisRequest(text="你好", emotion="excited", speed=1.1),
            transport=fake_transport,
        )
        self.assertEqual(captured["headers"]["Authorization"], "Bearer;tok1")
        self.assertEqual(captured["body"]["app"]["cluster"], "volcano_tts")
        self.assertTrue(captured["body"]["audio"]["enable_emotion"])
        self.assertEqual(res.audio_bytes, mp3)

    def test_minimax_protocol(self):
        captured: Dict[str, Any] = {}
        wav = make_wav_bytes(0.4, 32000)

        def fake_transport(url, method, headers, body, timeout):
            captured.update(url=url, body=json.loads(body.decode("utf-8")))
            resp = {"base_resp": {"status_code": 0}, "data": {"audio": wav.hex()}, "extra_info": {"audio_length": 400}}
            return 200, {}, json.dumps(resp).encode("utf-8")

        res = synthesize(
            {"protocol": "minimax", "api_key": "mm-key", "app_id": "grp-9", "voice": "male-qn-qingse"},
            SynthesisRequest(text="测试", format="wav", sample_rate=32000),
            transport=fake_transport,
        )
        self.assertIn("GroupId=grp-9", captured["url"])
        self.assertEqual(res.duration_seconds, 0.4)

    def test_elevenlabs_protocol(self):
        captured: Dict[str, Any] = {}
        pcm = b"\x00\x00" * 4800  # 0.2s at 24kHz

        def fake_transport(url, method, headers, body, timeout):
            captured.update(url=url, headers=headers, body=json.loads(body.decode("utf-8")))
            return 200, {}, pcm

        res = synthesize(
            {"protocol": "elevenlabs", "api_key": "el-key", "voice": "voice123"},
            SynthesisRequest(text="Hello", format="wav", sample_rate=24000, speed=1.05),
            transport=fake_transport,
        )
        self.assertIn("/text-to-speech/voice123", captured["url"])
        self.assertIn("output_format=pcm_24000", captured["url"])
        self.assertEqual(captured["headers"]["xi-api-key"], "el-key")
        self.assertEqual(res.audio_bytes[:4], b"RIFF")
        self.assertEqual(res.duration_seconds, 0.2)

    def test_azure_ssml_protocol(self):
        captured: Dict[str, Any] = {}
        wav = make_wav_bytes(0.3, 24000)

        def fake_transport(url, method, headers, body, timeout):
            captured.update(url=url, headers=headers, body=body.decode("utf-8"))
            return 200, {}, wav

        res = synthesize(
            {"protocol": "azure", "api_key": "az-key", "endpoint": "eastasia", "voice": "zh-CN-XiaoxiaoNeural"},
            SynthesisRequest(text="Tom & Jerry <1>", format="wav", speed=1.15, emotion="cheerful"),
            transport=fake_transport,
        )
        self.assertEqual(captured["url"], "https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1")
        self.assertIn("Tom &amp; Jerry &lt;1&gt;", captured["body"])
        self.assertIn("rate='+15%'", captured["body"])
        self.assertIn("style='cheerful'", captured["body"])
        self.assertEqual(res.duration_seconds, 0.3)

    def test_dashscope_url_download(self):
        wav = make_wav_bytes(0.2, 24000)

        def fake_transport(url, method, headers, body, timeout):
            if method == "POST":
                return 200, {}, json.dumps({"request_id": "req-1", "output": {"audio": {"url": "https://cdn.example.com/a.wav"}}}).encode("utf-8")
            return 200, {}, wav

        res = synthesize(
            {"protocol": "dashscope", "api_key": "ds-key", "voice": "Cherry"},
            SynthesisRequest(text="你好通义"),
            transport=fake_transport,
        )
        self.assertEqual(res.audio_bytes, wav)
        self.assertEqual(res.duration_seconds, 0.2)

    def test_http_generic_template(self):
        captured: Dict[str, Any] = {}
        wav = make_wav_bytes(0.25, 24000)

        def fake_transport(url, method, headers, body, timeout):
            captured.update(url=url, headers=headers, body=json.loads(body.decode("utf-8")))
            resp = {"status": 0, "payload": {"audio_b64": base64.b64encode(wav).decode("ascii")}}
            return 200, {}, json.dumps(resp).encode("utf-8")

        profile = {
            "protocol": "http-generic",
            "endpoint": "https://custom.tts.local/synth",
            "api_key": "my-tok",
            "headers": {"X-Token": "{{api_key}}"},
            "body_template": {"content": "{{text}}", "sr": "{{sample_rate}}", "spk": "{{voice}}"},
            "response_mode": "json_base64",
            "response_path": "payload.audio_b64",
            "success_code_path": "status",
            "success_codes": [0],
            "voice": "custom_v1",
        }
        res = synthesize(profile, SynthesisRequest(text="Custom engine", format="wav", sample_rate=24000), transport=fake_transport)
        self.assertEqual(captured["headers"]["X-Token"], "my-tok")
        self.assertEqual(captured["body"]["sr"], 24000)
        self.assertEqual(res.duration_seconds, 0.25)


class ServerAndBatchTests(unittest.TestCase):
    def test_path_sandbox_blocks_escapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "proj"
            root.mkdir()
            outside = pathlib.Path(tmp) / "outside.txt"
            outside.write_text("secret", encoding="utf-8")
            link = root / "link"
            link.symlink_to(outside)

            with self.assertRaises(TTSError):
                resolve_project_path(root, "../outside.txt")
            with self.assertRaises(TTSError):
                resolve_project_path(root, str(outside))
            with self.assertRaises(TTSError):
                resolve_project_path(root, "link")

            valid = resolve_project_path(root, "audio/clip01.mp3")
            self.assertEqual(valid, (root / "audio" / "clip01.mp3").resolve())

    def test_srt_batch_and_timing_overflow(self):
        wav = make_wav_bytes(1.5, 24000)

        def fake_transport(url, method, headers, body, timeout):
            return 200, {"content-type": "audio/wav"}, wav

        with tempfile.TemporaryDirectory() as tmp:
            proj = pathlib.Path(tmp)
            srt = proj / "subtitles.srt"
            srt.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\nFirst line\n\n"
                "2\n00:00:01,500 --> 00:00:04,000\nSecond line\ncontinued\n",
                encoding="utf-8",
            )
            server = TTSServer(
                project_dir=proj,
                env={"TTS_PROTOCOL": "openai", "TTS_API_KEY": "sk-1", "TTS_FORMAT": "wav"},
                transport=fake_transport,
            )
            resp = server.call_tool("tts_synthesize_batch", {
                "script_path": "subtitles.srt",
                "output_dir": "audio/dub",
                "format": "wav",
            })
            self.assertFalse(resp.get("isError"))
            data = json.loads(resp["content"][0]["text"])
            self.assertEqual(data["summary"]["succeeded"], 2)
            self.assertEqual(data["summary"]["subtitle_overflow_count"], 1)
            self.assertEqual(data["segments"][0]["overflow_seconds"], 0.5)
            self.assertEqual(data["segments"][1]["overflow_seconds"], -1.0)
            self.assertTrue((proj / "audio" / "dub" / "manifest.json").is_file())

            # Re-run with skip_existing=True
            resp2 = server.call_tool("tts_synthesize_batch", {
                "script_path": "subtitles.srt",
                "output_dir": "audio/dub",
                "format": "wav",
                "skip_existing": True,
            })
            data2 = json.loads(resp2["content"][0]["text"])
            self.assertEqual(data2["summary"]["skipped"], 2)

    def test_profiles_file_and_secret_redaction(self):
        with tempfile.TemporaryDirectory() as tmp:
            proj = pathlib.Path(tmp)
            prof_file = proj / "profiles.json"
            prof_file.write_text(json.dumps({
                "profiles": {
                    "host_zh": {"protocol": "volcengine-v3", "voice": "zh_female_vv_uranus_bigtts"},
                    "en_voice": {"protocol": "openai", "api_key_env": "CUSTOM_OPENAI_KEY", "voice": "nova"},
                }
            }), encoding="utf-8")
            profiles = load_profiles(
                {
                    "TTS_PROTOCOL": "volcengine-v3",
                    "TTS_API_KEY": "volc-secret",
                    "CUSTOM_OPENAI_KEY": "openai-secret",
                    "TTS_PROFILES_PATH": "profiles.json",
                },
                proj,
            )
            self.assertEqual(profiles["host_zh"]["api_key"], "volc-secret")
            self.assertEqual(profiles["en_voice"]["api_key"], "openai-secret")
            summary_json = json.dumps(summarize_profiles(profiles))
            self.assertNotIn("volc-secret", summary_json)
            self.assertNotIn("openai-secret", summary_json)

    def test_stdio_mcp_subprocess_smoke(self):
        wav = make_wav_bytes(0.2, 24000)

        class MockTTSHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                chunk = json.dumps({"code": 0, "data": base64.b64encode(wav[44:]).decode("ascii")})
                done = json.dumps({"code": 20000000, "message": "OK", "data": None})
                body = (chunk + "\n" + done + "\n").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        httpd = HTTPServer(("127.0.0.1", 0), MockTTSHandler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                proj = pathlib.Path(tmp)
                (proj / "line.txt").write_text("多行配音脚本\n第二行测试", encoding="utf-8")
                env = {
                    "PATH": "",
                    "TTS_PROTOCOL": "volcengine-v3",
                    "TTS_ENDPOINT": f"http://127.0.0.1:{port}/api/v3/tts/unidirectional",
                    "TTS_API_KEY": "test-volc-key",
                    "TTS_RESOURCE_ID": "seed-tts-2.0",
                    "TTS_VOICE": "zh_female_vv_uranus_bigtts",
                }
                requests = "\n".join([
                    json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
                    json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                    json.dumps({
                        "jsonrpc": "2.0",
                        "id": 3,
                        "method": "tools/call",
                        "params": {"name": "tts_synthesize", "arguments": {"text_file": "line.txt", "output_path": "out/demo.wav"}},
                    }),
                ]) + "\n"
                proc = subprocess.run(
                    [sys.executable, str(HERE / "server.py"), str(proj)],
                    input=requests,
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=15,
                    check=True,
                )
                lines = [json.loads(line) for line in proc.stdout.strip().splitlines()]
                self.assertEqual(len(lines), 3)
                self.assertEqual(lines[0]["result"]["serverInfo"]["name"], "text-to-speech")
                tool_names = [t["name"] for t in lines[1]["result"]["tools"]]
                self.assertEqual(tool_names, ["tts_list_protocols", "tts_list_profiles", "tts_synthesize", "tts_synthesize_batch"])
                synth = json.loads(lines[2]["result"]["content"][0]["text"])
                self.assertEqual(synth["output_path"], "out/demo.wav")
                self.assertEqual(synth["duration_seconds"], 0.2)
                self.assertTrue((proj / "out" / "demo.wav").is_file())
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
