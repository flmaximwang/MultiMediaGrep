# MultiMediaGrep

MultiMediaGrep is a local media perception MCP server for multimodal agents. It turns local video, audio, and documents into model-ready visual material—storyboard grids, single-frame crops, and page thumbnails—paired with time- or page-aligned text indices. The server itself makes no LLM calls; interpretation and reasoning stay with the host agent.

By design, it accepts only local absolute paths and performs no network downloads or content retrieval. Speech-to-text (ASR) and scanned-document OCR are delegated to configured external providers; when unconfigured, it returns visual frames or pages only and states explicitly why text is unavailable. Outside its own cache directory, it writes beside source files only when write tools are invoked (`.mmgrep.*` sidecars / VTT files, or in-place PDF outline and annotation updates).

Further reading: [Install & Operations](docs/install.md) · [MCP Contract](docs/mcp-contract.md) · [Changelog](CHANGELOG.md)

## Tools

MultiMediaGrep exposes six tools shared across media types:

| Tool | Purpose |
|---|---|
| `media_probe` | Inspects metadata (duration, resolution, page count, codecs, tracks, text-layer reliability, ASR/OCR availability, and outline/annotation counts) without spending image tokens. |
| `media_overview` | Produces video storyboard grids, timestamped audio transcripts, or document page thumbnails with text previews; full text is written to `content.md` on disk for chunked reading. |
| `media_zoom` | Extracts a single video frame at a timestamp or range, or renders a document page (with optional cropping) to inspect fine visual details and on-screen text. |
| `media_locate` | Searches subtitles, document text, transcripts, or annotations by keyword and returns matching timestamps, page numbers, and surrounding snippets (text-only, zero images). |
| `media_bookmark` | Writes or updates outlines and chapters, maintaining `<file>.mmgrep.bookmark.json` and syncing PDF outlines or `.mmgrep.bookmark.vtt`. |
| `media_annotate` | Writes or updates annotations, maintaining `<file>.mmgrep.annotation.json` and syncing PDF annotation objects or `.mmgrep.annotation.vtt`. |

> `media_bookmark` and `media_annotate` modify the target PDF in place (without keeping a backup copy) and create sidecar files beside the source. Commit to git or back up important files before writing. See [MCP Contract](docs/mcp-contract.md) §15 and §16 for full semantics.

## Deployment & Setup

The simplest way to deploy and connect is through **Magpie**, without manually managing host configs or environment variables.

For manual installation or self-hosting, ensure Node.js >= 20 and `ffmpeg` / `ffprobe` are installed. For PDFs, reading requires one of `poppler`, `mutool`, or `gs`; writing outlines/annotations and reading PDF annotations requires `mutool`; reading PDF bookmarks optionally uses `qpdf`.

```bash
# Run directly via npx (stdio by default)
npx -y github:flmaximwang/MultiMediaGrep

# Or install the release runtime package (excludes tests and fixtures)
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.3.1/multimediagrep-mcp-0.3.1.tgz
```

Add the following to your MCP client configuration (see [examples/mcp-config.json](examples/mcp-config.json) for the full environment template):

```json
{
  "mcpServers": {
    "multimediagrep": {
      "command": "npx",
      "args": ["-y", "github:flmaximwang/MultiMediaGrep"]
    }
  }
}
```

For multi-client sharing or remote access, start the Streamable HTTP server with `--http` (listens on `127.0.0.1:3927/mcp` by default; supports `--port`, `--token`, and `x-mmgrep-*` per-request headers). To transcribe unsubtitled audio/video or recognize scanned PDFs, configure ASR (`elevenlabs`, `openai-compatible`, `deepseek`) and document providers (OCR via `mineru`; typesetting defaults to local `builtin`).

See [docs/install.md](docs/install.md) for OS-specific dependencies, host integrations, HTTP reverse proxy setup, and the full environment variable reference.

## Usage

For a local media file (e.g., `/abs/path/demo.mp4`), work from lightweight inspection to targeted detail:

1. **Probe first**: Call `media_probe` to check duration or page count, available subtitle tracks, text-layer quality, and ASR/OCR availability before fetching images.
2. **Overview**: Call `media_overview` (e.g., `cells: 9, images: 2` for video) to get storyboard or page thumbnails alongside aligned text previews. When text is long, the inline response is a preview while the full output is written to `content.md`, `segments.jsonl`, and `manifest.json` on disk—read those files in chunks rather than re-calling the tool. For videos over 30 minutes or documents over 30 pages, narrow the range with `start`/`end` or `pages`.
3. **Locate and zoom**: Use text-only `media_locate` to jump to specific keywords or phrases, and reserve `media_zoom` (with optional `crop`) for moments where you need to read on-screen text or inspect visual details. Prefer human-authored subtitles over machine transcripts (ASR is unreliable on proper nouns and numbers).
4. **Write back**: Once located, use `media_bookmark` or `media_annotate` to persist chapters and notes; once a sidecar file exists, subsequent reads treat it as the source of truth.

## Development

Written in pure ESM with no build step; runtime dependencies are limited to `@modelcontextprotocol/sdk` and `zod`.

```bash
npm install
npm run check      # Syntax check across the repo
npm test           # Run test suite (node --test)
npm run fixtures   # Generate local test media via ffmpeg scripts
```

## License & Attribution

Licensed under Apache-2.0 ([LICENSE](LICENSE)). `geometry.js`, `frames.js`, `sheet.js`, `shots.js`, and `mapPool` in `storyboard.js` under `src/backend/video/` are adapted from Apache-2.0 [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) v0.5.9; see [NOTICE](NOTICE) and [CREDITS.md](CREDITS.md) for full attribution.
