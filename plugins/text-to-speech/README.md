# Text to Speech (`text-to-speech`)

Protocol-oriented, multi-provider Text-to-Speech (TTS) MCP host plugin built for speech synthesis and video voiceover workflows. Runs with Python 3's standard library only (no third-party packages or platform binaries required).

## Supported Protocols

| Protocol | Covers | Default Endpoint |
| --- | --- | --- |
| `openai` | OpenAI TTS (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`), SiliconFlow, StepFun, Fish Audio gateways, OneAPI/NewAPI, local CosyVoice / GPT-SoVITS / IndexTTS / Kokoro-FastAPI / Speaches | `https://api.openai.com/v1/audio/speech` |
| `volcengine-v3` | Volcengine / BytePlus Doubao Seed TTS 1.0 & 2.0 (`seed-tts-1.0`, `seed-tts-2.0`, `volc.service_type.10029`, ICL voice cloning) | `https://openspeech.bytedance.com/api/v3/tts/unidirectional` |
| `volcengine-v1` | Volcengine Openspeech V1 HTTP (`volcano_tts`, `volcano_mega`, `volcano_icl`) | `https://openspeech.bytedance.com/api/v1/tts` |
| `minimax` | MiniMax T2A v2 (`speech-02-hd`, `speech-02-turbo`, etc., domestic `api.minimaxi.com` or global `api.minimax.io`) | `https://api.minimaxi.com/v1/t2a_v2` |
| `elevenlabs` | ElevenLabs TTS and compatible endpoints | `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` |
| `azure` | Microsoft Azure Speech Neural & Custom Voices (SSML) | `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` |
| `dashscope` | Alibaba Cloud DashScope MultiModal / Qwen-TTS (`qwen-tts`, `qwen3-tts-flash`) | `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| `http-generic` | Any custom or new HTTP TTS API configured via JSON request/response templates | User-defined per profile |

## Quick Setup Examples

Configure the default profile in the plugin's **Settings** tab (secrets are encrypted and stay on your computer):

### 1. Volcengine Seed TTS V3 (Recommended for Doubao 1.0/2.0 voices)

- **TTS Protocol**: `volcengine-v3`
- **API Key / Access Token**: Your Volcengine `X-Api-Key` (or Access Key if using App ID + Access Key)
- **App ID / Group ID**: Leave blank for single `X-Api-Key` auth, or fill your `App ID` to use `X-Api-App-Id` + `X-Api-Access-Key` auth
- **Model / Resource ID / Cluster**: e.g. `seed-tts-2.0` (or `seed-tts-1.0` / `volc.service_type.10029` / `seed-icl-2.0`)
- **Default Voice / Speaker**: e.g. `zh_female_vv_uranus_bigtts` (or your cloned speaker ID `S_...`)

### 2. Volcengine Openspeech V1

- **TTS Protocol**: `volcengine-v1`
- **API Key / Access Token**: Your Volcengine Access Token
- **App ID / Group ID**: Your Volcengine App ID
- **Model / Resource ID / Cluster**: e.g. `volcano_tts`
- **Default Voice / Speaker**: e.g. `zh_female_shuangkuaisisi_moon_bigtts`

### 3. OpenAI or Local OpenAI-Compatible TTS Server

- **TTS Protocol**: `openai`
- **API Endpoint or Base URL**: Leave blank for OpenAI, or enter e.g. `https://api.siliconflow.cn/v1` or `http://127.0.0.1:8880/v1`
- **API Key / Access Token**: Provider API key (optional for unauthenticated local servers)
- **Model / Resource ID / Cluster**: e.g. `gpt-4o-mini-tts`, `FunAudioLLM/CosyVoice2-0.5B`, or `kokoro`
- **Default Voice / Speaker**: e.g. `alloy`, `nova`, or your gateway's voice ID

## Multi-Provider Profiles (`TTS_PROFILES_PATH`)

To switch between multiple providers, voices, or custom `http-generic` endpoints in the same project, point **Profiles Config File** to a JSON file (e.g. `~/.config/tts-profiles.json`):

```json
{
  "profiles": {
    "narrator_zh": {
      "protocol": "volcengine-v3",
      "resource_id": "seed-tts-2.0",
      "voice": "zh_female_vv_uranus_bigtts",
      "format": "mp3",
      "sample_rate": 24000
    },
    "narrator_en": {
      "protocol": "openai",
      "endpoint": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY",
      "model": "gpt-4o-mini-tts",
      "voice": "nova"
    },
    "custom_vendor": {
      "protocol": "http-generic",
      "endpoint": "https://tts.example.com/v1/synthesize",
      "headers": {
        "Authorization": "Bearer {{api_key}}"
      },
      "body_template": {
        "text": "{{text}}",
        "speaker": "{{voice}}",
        "speed": "{{speed}}",
        "format": "{{format}}"
      },
      "response_mode": "json_base64",
      "response_path": "data.audio",
      "success_code_path": "code",
      "success_codes": [0, 200]
    }
  }
}
```

> Note: Never put secrets in a shared Git repository. Store secrets in the plugin's encrypted **API Key / Access Token** setting or reference host environment variables via `api_key_env`.

## Video Voiceover Workflow

1. **Single clip**: Call `tts_synthesize` with `output_path` and either short single-line `text` or a project file `text_file` (recommended for long or multi-line narration). The tool returns `bytes` and measured `duration_seconds`.
2. **Batch scenes (JSON)** or **Subtitle dubbing (SRT)**: Write a script file in your project folder and call `tts_synthesize_batch`.
   - For **JSON scripts**:
     ```json
     {
       "defaults": { "profile": "narrator_zh", "format": "mp3", "speed": 1.0 },
       "segments": [
         { "id": "01_intro", "text": "欢迎来到本期视频。", "emotion": "happy" },
         { "id": "02_demo", "text": "接下来看看实际演示效果。", "speed": 1.05 }
       ]
     }
     ```
   - For **SRT subtitles**: Each cue is synthesized individually, and the returned `manifest.json` includes `start_seconds`, `end_seconds`, `target_duration_seconds`, `duration_seconds`, and `overflow_seconds` so timing mismatches can be spotted and adjusted immediately.

## Permissions, Runtime & Data Flow

- **Runtime**: Python 3 standard library only (`python3`); works on macOS, Windows, and Linux.
- **Permissions**:
  - `files`: Reads text/JSON/SRT scripts and writes audio and timing manifests strictly inside the active project directory (`${PROJECT_DIR}`), plus reads the optional user-configured `TTS_PROFILES_PATH` file.
  - `network`: Sends synthesis text and audio parameters only to the TTS API endpoints configured by the user.
- **Security**: API keys stored in plugin settings remain encrypted on the host and are redacted from tool outputs and error messages.
