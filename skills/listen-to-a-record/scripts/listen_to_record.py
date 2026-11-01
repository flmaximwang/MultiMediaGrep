#!/usr/bin/env python3
"""Provider-switchable transcription entry point for listen-to-a-record."""
import argparse
import json
import mimetypes
import os
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def load_env_file():
    """Load profile secrets without overriding an already exported variable."""
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    candidates = [Path.cwd() / ".env", hermes_home / ".env"]
    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[7:].lstrip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            name = name.strip()
            if not name or name in os.environ:
                continue
            value = value.strip()
            if value and value[0] in "\"'" and value[-1:] == value[0]:
                value = shlex.split(value)[0]
            os.environ[name] = value


load_env_file()


class TranscriptionError(RuntimeError):
    pass


def multipart(fields, file_field, file_path):
    boundary = "----listen-to-a-record-" + uuid.uuid4().hex
    chunks = []
    for name, value in fields:
        chunks += [
            ("--" + boundary + "\r\n").encode(),
            ('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode(),
            str(value).encode(),
            b"\r\n",
        ]
    filename = Path(file_path).name
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    chunks += [
        ("--" + boundary + "\r\n").encode(),
        ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (file_field, filename)).encode(),
        ("Content-Type: %s\r\n\r\n" % content_type).encode(),
        Path(file_path).read_bytes(),
        b"\r\n--" + boundary.encode() + b"--\r\n",
    ]
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


def post_json(url, headers, body, timeout=900):
    request = Request(url, data=body, headers=headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise TranscriptionError("provider returned HTTP %s: %s" % (exc.code, detail))
    except URLError as exc:
        raise TranscriptionError("provider connection failed: %s" % exc.reason)


def build_fields(args, model):
    fields = [("model_id", model)]
    if args.language:
        fields.append(("language_code", args.language))
    for language in args.secondary_language:
        fields.append(("secondary_languages", language))
    for term in args.keyterm:
        fields.append(("keyterms", term))
    if args.diarize:
        fields.append(("diarize", "true"))
        if args.num_speakers:
            fields.append(("num_speakers", args.num_speakers))
    if args.detect_speaker_roles:
        fields.append(("detect_speaker_roles", "true"))
    if args.no_verbatim:
        fields.append(("no_verbatim", "true"))
    fields.append(("timestamps_granularity", "word"))
    return fields


def elevenapi(args):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise TranscriptionError("ELEVENLABS_API_KEY is not set")
    base = os.environ.get("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io").rstrip("/")
    model = args.model or "scribe_v2"
    body, content_type = multipart(build_fields(args, model), "file", args.input)
    data = post_json(
        base + "/v1/speech-to-text",
        {"xi-api-key": key, "Content-Type": content_type},
        body,
    )
    return {"provider": "elevenapi", "model": model, "response": data}


def openai_compatible(args):
    base = os.environ.get("STT_BASE_URL")
    key = os.environ.get("STT_API_KEY")
    if not base or not key:
        raise TranscriptionError("STT_BASE_URL and STT_API_KEY are required")
    model = args.model or os.environ.get("STT_MODEL")
    if not model:
        raise TranscriptionError("--model or STT_MODEL is required")
    fields = [("model", model)]
    if args.language:
        fields.append(("language", args.language))
    if args.keyterm:
        fields.append(("prompt", ", ".join(args.keyterm)))
    body, content_type = multipart(fields, "file", args.input)
    endpoint = base.rstrip("/")
    if not endpoint.endswith("/audio/transcriptions"):
        endpoint += "/audio/transcriptions"
    data = post_json(
        endpoint,
        {"Authorization": "Bearer " + key, "Content-Type": content_type},
        body,
    )
    return {"provider": "openai-compatible", "model": model, "response": data}


def local(args):
    binary = shutil.which("mlx_whisper")
    if not binary:
        raise TranscriptionError("mlx_whisper is not on PATH")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    command = [
        binary, args.input,
        "--model", args.model or "mlx-community/whisper-large-v3-turbo",
        "--condition-on-previous-text", "False",
        "--output-format", "srt",
        "--output-name", "transcript",
        "--output-dir", str(output),
    ]
    if args.language:
        command += ["--language", args.language]
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    result = subprocess.run(command, env=env, text=True)
    if result.returncode:
        raise TranscriptionError("mlx_whisper exited with status %s" % result.returncode)
    srt = output / "transcript.srt"
    if not srt.exists():
        raise TranscriptionError("mlx_whisper did not create transcript.srt")
    return {"provider": "local", "model": args.model or "mlx-community/whisper-large-v3-turbo", "srt": str(srt)}


def response_text(data):
    response = data.get("response", data)
    text = response.get("text")
    if text:
        return text
    segments = response.get("segments") or []
    return "\n".join(segment.get("text", "").strip() for segment in segments).strip()


def response_words(data):
    response = data.get("response", data)
    return [word for word in response.get("words", []) if word.get("type", "word") == "word"]


def words_to_srt(words, speakers=False):
    if not words:
        return ""
    lines = []
    for index in range(0, len(words), 12):
        group = words[index:index + 12]
        start = group[0].get("start", 0)
        end = group[-1].get("end", start)
        text = "".join(word.get("text", "") for word in group).strip()
        if speakers:
            speaker_ids = {word.get("speaker_id") for word in group if word.get("speaker_id")}
            if len(speaker_ids) == 1:
                text = "%s: %s" % (next(iter(speaker_ids)), text)
        lines.append("%d\n%s --> %s\n%s\n" % (index // 12 + 1, timestamp(start), timestamp(end), text))
    return "\n".join(lines)


def timestamp(seconds):
    millis = int(round(float(seconds) * 1000))
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return "%02d:%02d:%02d,%03d" % (hours, minutes, seconds, millis)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Transcribe a recording through a selectable provider.")
    parser.add_argument("input", nargs="?", help="audio/video file")
    parser.add_argument("--provider", choices=["local", "elevenapi", "openai-compatible"], default="local")
    parser.add_argument("--model", help="provider model; defaults to the provider default")
    parser.add_argument("--output", default="/tmp/listen-to-a-record/transcript", help="output directory")
    parser.add_argument("--language", help="known primary language; omit for automatic detection")
    parser.add_argument("--secondary-language", action="append", default=[], help="additional language, repeatable")
    parser.add_argument("--keyterm", action="append", default=[], help="name or technical term, repeatable")
    parser.add_argument("--diarize", action="store_true", help="request speaker labels when supported")
    parser.add_argument("--num-speakers", type=int, help="expected maximum speakers for diarization")
    parser.add_argument("--detect-speaker-roles", action="store_true", help="request role labels when supported")
    parser.add_argument("--no-verbatim", action="store_true", help="remove filler words when supported")
    parser.add_argument("--self-test", action="store_true", help="run offline checks")
    args = parser.parse_args(argv)
    if args.self_test:
        payload, content_type = multipart([("model_id", "scribe_v2"), ("keyterms", "Example")], "file", __file__)
        assert "multipart/form-data; boundary=" in content_type
        assert b'name="keyterms"' in payload
        assert timestamp(1.234) == "00:00:01,234"
        print("listen-to-a-record self-test: PASS")
        return 0
    if not args.input:
        parser.error("input is required unless --self-test is used")
    if not Path(args.input).is_file():
        raise TranscriptionError("input file not found: %s" % args.input)
    handlers = {"local": local, "elevenapi": elevenapi, "openai-compatible": openai_compatible}
    result = handlers[args.provider](args)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "provider.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.provider != "local":
        text = response_text(result)
        (output / "transcript.txt").write_text(text + "\n", encoding="utf-8")
        srt = words_to_srt(response_words(result), speakers=args.diarize)
        if srt:
            (output / "transcript.srt").write_text(srt, encoding="utf-8")
    print(json.dumps({"provider": result["provider"], "model": result["model"], "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TranscriptionError as exc:
        print("error: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
