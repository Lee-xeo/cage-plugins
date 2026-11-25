"""Pure-Python audio metadata utilities (duration inspection and PCM-to-WAV wrapping)."""

from __future__ import annotations

import io
import struct
import wave
from typing import Optional

_MPEG_V1_BITRATES_L3 = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0
]
_MPEG_V2_BITRATES_L3 = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0
]
_MPEG_SAMPLERATES = {
    3: [44100, 48000, 32000],  # MPEG 1
    2: [22050, 24000, 16000],  # MPEG 2
    0: [11025, 12000, 8000],   # MPEG 2.5
}


def pcm_to_wav(
    pcm_bytes: bytes,
    sample_rate: int = 24000,
    channels: int = 1,
    sample_width: int = 2,
) -> bytes:
    """Wrap raw signed little-endian PCM bytes in a standard RIFF WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _wav_duration(data: bytes) -> Optional[float]:
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            rate = wf.getframerate()
            frames = wf.getnframes()
            if rate > 0:
                return frames / float(rate)
    except Exception:
        return None
    return None


def _flac_duration(data: bytes) -> Optional[float]:
    # fLaC marker (4 bytes) + METADATA_BLOCK_HEADER (4 bytes) + STREAMINFO (34 bytes)
    if len(data) < 42 or data[:4] != b"fLaC":
        return None
    block_type = data[4] & 0x7F
    block_len = int.from_bytes(data[5:8], "big")
    if block_type != 0 or block_len < 34:
        return None
    # Bytes 18..25 inside STREAMINFO (offset 8 + 10 = 18):
    # 20 bits sample rate | 3 bits channels | 5 bits bps | 36 bits total samples
    bits = int.from_bytes(data[18:26], "big")
    sample_rate = (bits >> 44) & 0xFFFFF
    total_samples = bits & 0xFFFFFFFFF
    if sample_rate > 0 and total_samples > 0:
        return total_samples / float(sample_rate)
    return None


def _ogg_opus_duration(data: bytes) -> Optional[float]:
    if len(data) < 47 or data[:4] != b"OggS":
        return None
    pre_skip = 0
    opus_head = data.find(b"OpusHead")
    if opus_head >= 0 and opus_head + 12 <= len(data):
        pre_skip = struct.unpack_from("<H", data, opus_head + 10)[0]

    # Scan backwards for the last OggS page to read its granule position.
    pos = data.rfind(b"OggS")
    while pos >= 0:
        if pos + 27 <= len(data):
            granule = struct.unpack_from("<q", data, pos + 6)[0]
            if granule > 0:
                samples = max(0, granule - pre_skip)
                return samples / 48000.0
        pos = data.rfind(b"OggS", 0, pos)
    return None


def _skip_id3v2(data: bytes) -> int:
    if len(data) >= 10 and data[:3] == b"ID3":
        b0, b1, b2, b3 = data[6], data[7], data[8], data[9]
        size = ((b0 & 0x7F) << 21) | ((b1 & 0x7F) << 14) | ((b2 & 0x7F) << 7) | (b3 & 0x7F)
        flags = data[5]
        footer = 10 if (flags & 0x10) else 0
        return min(len(data), 10 + size + footer)
    return 0


def _parse_mp3_frame_header(header: int):
    if (header & 0xFFE00000) != 0xFFE00000:
        return None
    version_id = (header >> 19) & 0x3
    layer_id = (header >> 17) & 0x3
    bitrate_idx = (header >> 12) & 0xF
    sr_idx = (header >> 10) & 0x3
    padding = (header >> 9) & 0x1
    channel_mode = (header >> 6) & 0x3

    if version_id == 1 or layer_id != 1:  # Layer III only
        return None
    if bitrate_idx in (0, 15) or sr_idx == 3:
        return None

    rates = _MPEG_SAMPLERATES.get(version_id)
    if not rates:
        return None
    sample_rate = rates[sr_idx]
    bitrate = (_MPEG_V1_BITRATES_L3 if version_id == 3 else _MPEG_V2_BITRATES_L3)[bitrate_idx] * 1000
    if bitrate <= 0:
        return None
    samples_per_frame = 1152 if version_id == 3 else 576
    coeff = 144 if version_id == 3 else 72
    frame_len = (coeff * bitrate) // sample_rate + padding
    if frame_len < 4:
        return None
    return version_id, sample_rate, bitrate, samples_per_frame, frame_len, channel_mode


def _mp3_duration(data: bytes) -> Optional[float]:
    end = len(data)
    if end >= 128 and data[-128:-125] == b"TAG":
        end -= 128
    offset = _skip_id3v2(data)

    # Locate the first valid MPEG Layer III frame header.
    first_frame = None
    scan_limit = min(end - 4, offset + 65536)
    pos = offset
    while pos <= scan_limit:
        if data[pos] == 0xFF and (data[pos + 1] & 0xE0) == 0xE0:
            header = struct.unpack_from(">I", data, pos)[0]
            parsed = _parse_mp3_frame_header(header)
            if parsed:
                first_frame = (pos, parsed)
                break
        pos += 1

    if not first_frame:
        return None

    pos, (version_id, sample_rate, _bitrate, samples_per_frame, frame_len, channel_mode) = first_frame

    # Check Xing / Info VBR header inside the first frame.
    if version_id == 3:
        side_info = 17 if channel_mode == 3 else 32
    else:
        side_info = 9 if channel_mode == 3 else 17
    xing_pos = pos + 4 + side_info
    if xing_pos + 12 <= end and data[xing_pos:xing_pos + 4] in (b"Xing", b"Info"):
        flags = struct.unpack_from(">I", data, xing_pos + 4)[0]
        if flags & 0x1:
            total_frames = struct.unpack_from(">I", data, xing_pos + 8)[0]
            if total_frames > 0:
                return (total_frames * samples_per_frame) / float(sample_rate)

    # Check VBRI header.
    vbri_pos = pos + 36
    if vbri_pos + 18 <= end and data[vbri_pos:vbri_pos + 4] == b"VBRI":
        total_frames = struct.unpack_from(">I", data, vbri_pos + 14)[0]
        if total_frames > 0:
            return (total_frames * samples_per_frame) / float(sample_rate)

    # Walk frames to compute exact duration for both CBR and unindexed VBR.
    total_seconds = 0.0
    frames_seen = 0
    cur = pos
    while cur + 4 <= end:
        if data[cur] != 0xFF or (data[cur + 1] & 0xE0) != 0xE0:
            cur += 1
            continue
        header = struct.unpack_from(">I", data, cur)[0]
        parsed = _parse_mp3_frame_header(header)
        if not parsed:
            cur += 1
            continue
        _v, sr, _br, spf, flen, _cm = parsed
        if cur + flen > end + 1:
            break
        total_seconds += spf / float(sr)
        frames_seen += 1
        cur += flen

    if frames_seen > 0:
        return total_seconds
    return None


def measure_duration_seconds(
    data: bytes,
    audio_format: str = "mp3",
    sample_rate: int = 24000,
) -> Optional[float]:
    """Measure audio duration in seconds using only Python's standard library."""
    if not data:
        return None
    fmt = (audio_format or "").lower().strip()
    if fmt == "wav" or data[:4] == b"RIFF":
        dur = _wav_duration(data)
        if dur is not None:
            return round(dur, 3)
    if fmt == "flac" or data[:4] == b"fLaC":
        dur = _flac_duration(data)
        if dur is not None:
            return round(dur, 3)
    if fmt in ("ogg", "opus", "ogg_opus") or data[:4] == b"OggS":
        dur = _ogg_opus_duration(data)
        if dur is not None:
            return round(dur, 3)
    if fmt == "pcm":
        if sample_rate > 0:
            return round(len(data) / float(sample_rate * 2), 3)
        return None
    if fmt == "mp3" or data[:3] == b"ID3" or (len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        dur = _mp3_duration(data)
        if dur is not None:
            return round(dur, 3)
    return None
