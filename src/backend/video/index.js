// src/backend/video/index.js —— 视频后端
//
// 职责：
//   probe     容器/流信息 + 音频体检 + 转写来源判定（不扫镜头、不烧图）
//   overview  分镜宫格 + 按格对齐的时间/文字清单（字幕优先，ASR 兜底）
//   zoom      单帧特写（at 精确帧 / start+end 选最清晰帧，crop 在缩放后裁）
//   locate    在转写里找短语，返回时间码；可选附带最佳匹配处的一帧
//   subtitles 只读已有字幕，绝不跑 ASR
//
// 约定见 docs/mcp-contract.md §4–§8。这里不调用任何 LLM，也不下载任何东西。

import { ToolError } from '../../media/interface.js';
import { matchSegments, splitIntoSentences } from '../../media/match.js';
import { resolveSubtitleSource } from '../../media/transcript.js';
import { getAudioHealth, probeVideoMedia, readVideoInfo } from './probe.js';
import { resolveTranscript } from './transcript.js';
import { composeOverviewImages, detectCuts } from './storyboard.js';
import { captureFrame, outputGeometry, pickSharpest } from './capture.js';

const NO_TRANSCRIPT_MESSAGE = 'no transcript available for this file and no ASR provider is configured (MMGREP_ASR_PROVIDER="none"). '
  + 'Pass subtitle with a local .srt/.vtt file, a track index, or a language code, or configure an ASR provider. '
  + 'For visuals only, use media_overview instead.';

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 请求窗口 → 合法的 [startMs, endMs]；server 已经校验过，这里只做后端的最后一道防越界 */
function computeWindow(input, media, warnings) {
  const durationMs = media.durationSec !== null ? Math.max(0, Math.round(media.durationSec * 1000)) : null;
  let startMs = Number.isInteger(input.startMs) ? input.startMs : 0;
  let endMs = Number.isInteger(input.endMs) ? input.endMs : durationMs;
  if (startMs < 0) startMs = 0;
  if (durationMs !== null) {
    if (startMs >= durationMs) startMs = Math.max(0, durationMs - 1);
    if (endMs === null || endMs > durationMs) endMs = durationMs;
  }
  if (endMs !== null && endMs <= startMs) endMs = startMs + 1;

  let endSec;
  if (endMs !== null) {
    endSec = endMs / 1000;
  } else {
    endSec = media.durationSec ?? startMs / 1000 + 1;
    warnings.push('duration-unknown: using a 1-second window');
  }
  return { startMs, endMs, startSec: startMs / 1000, endSec, durationMs };
}

/** 半开区间 [startMs, endMs)：恰好落在边界上的段落不算越过窗口 */
function overlapsWindow(segment, startMs, endMs) {
  const start = Number.isInteger(segment.startMs) ? segment.startMs : 0;
  const end = Number.isInteger(segment.endMs) ? segment.endMs : start;
  if (startMs !== null && end <= startMs) return false;
  if (endMs !== null && start >= endMs) return false;
  return true;
}

function mergeWarnings(target, ...sources) {
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const warning of source) {
      if (!target.includes(warning)) target.push(warning);
    }
  }
  return target;
}

function noTranscriptError(input, ctx, transcript) {
  if (!ctx.asrProvider) return new ToolError('NO_TRANSCRIPT', NO_TRANSCRIPT_MESSAGE);
  const reason = transcript?.reason ?? 'ASR produced no usable text.';
  return new ToolError(
    'NO_TRANSCRIPT',
    `no transcript available for this file: ${reason} `
      + 'Pass subtitle with a local .srt/.vtt file, a track index, or a language code, or use media_overview instead.',
  );
}

/** 给 zoom/locate 的 at 附近准备退路：最后一个帧可能抽不出来，往前退一两帧 */
function frameCandidates(atSec, fps) {
  const step = fps > 0 ? 1 / fps : 1 / 25;
  const candidates = [atSec, atSec - step, atSec - 0.05, atSec - 0.25];
  const seen = new Set();
  const out = [];
  for (const value of candidates) {
    const at = Math.max(0, value);
    const key = at.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(at);
  }
  return out;
}

export function createVideoBackend(ctx = {}) {
  const backendCtx = () => ({ ...ctx, config: ctx.config ?? {} });

  async function probe(input, callCtx = backendCtx()) {
    return probeVideoMedia(input, callCtx);
  }

  async function overview(input, callCtx = backendCtx()) {
    const c = callCtx;
    const media = await readVideoInfo(input, c);
    const warnings = [];
    const window = computeWindow(input, media, warnings);
    const cells = clampInt(input.cells, 1, 16, 9);
    const images = clampInt(input.images, 1, 4, 2);
    const maxEdge = clampInt(input.maxEdge, 256, 1600, 1280);

    c.onProgress?.({ stage: 'transcript', used: input.subtitle !== undefined && input.subtitle !== null ? String(input.subtitle) : (input.transcript ?? 'auto') });
    const transcriptData = await resolveTranscript(input, c, media, {
      fromSec: window.startSec,
      toSec: window.endSec,
      warnings,
      healthProvider: () => getAudioHealth(media, c),
    });
    mergeWarnings(warnings, transcriptData.warnings);

    const transcriptSegments = transcriptData.segments.filter(
      (segment) => overlapsWindow(segment, window.startMs, window.endMs),
    );

    c.onProgress?.({ stage: 'scanning', used: `${window.startSec.toFixed(2)}-${window.endSec.toFixed(2)}s` });
    const cuts = await detectCuts({
      inputPath: input.path,
      fps: media.fpsForScan,
      startSec: window.startSec,
      endSec: window.endSec,
      signal: c.signal,
      warnings,
    });

    c.onProgress?.({ stage: 'frames', used: `${cells} cells x up to ${images} image(s)` });
    const composed = await composeOverviewImages({
      inputPath: input.path,
      startSec: window.startSec,
      endSec: window.endSec,
      cuts,
      capacity: cells,
      maxImages: images,
      maxEdge,
      aspect: media.aspect,
      transcriptSegments,
      transcriptSource: transcriptData.transcript.source,
      transcriptOrigin: transcriptData.transcript.origin,
      concurrency: c.config?.runtime?.concurrency ?? 2,
      signal: c.signal,
      onProgress: c.onProgress,
      warnings,
    });

    return {
      mediaType: 'video',
      path: input.path,
      durationMs: window.durationMs,
      durationSec: media.durationSec,
      width: media.width,
      height: media.height,
      aspect: media.aspect,
      audioHealth: transcriptData.audioHealth,
      segments: composed.segments,
      images: composed.images,
      transcript: transcriptData.transcript,
      warnings,
    };
  }

  async function zoom(input, callCtx = backendCtx()) {
    const c = callCtx;
    const media = await readVideoInfo(input, c);
    const warnings = [];
    const maxEdge = clampInt(input.maxEdge, 256, 1600, 1600);
    const crop = input.crop ?? null;
    const selection = input.selection === 'sharpest' || input.atMs === undefined || input.atMs === null
      ? 'sharpest'
      : 'exact';

    let atSec;
    let fromMs = null;
    let toMs = null;
    if (selection === 'exact') {
      const atMs = Number.isFinite(Number(input.atMs))
        ? Number(input.atMs)
        : Math.round(Number(input.atSec ?? 0) * 1000);
      atSec = Math.max(0, atMs / 1000);
      if (media.durationSec !== null) {
        atSec = Math.min(atSec, Math.max(0, media.durationSec - 0.001));
      }
    } else {
      fromMs = Number.isInteger(input.startMs) ? input.startMs : 0;
      toMs = Number.isInteger(input.endMs)
        ? input.endMs
        : (media.durationSec !== null ? Math.round(media.durationSec * 1000) : fromMs + 1000);
      if (media.durationSec !== null) {
        toMs = Math.min(toMs, Math.round(media.durationSec * 1000));
      }
      fromMs = Math.max(0, Math.min(fromMs, Math.max(0, toMs - 1)));
      atSec = await pickSharpest({
        inputPath: input.path,
        startSec: fromMs / 1000,
        endSec: toMs / 1000,
        width: media.width,
        height: media.height,
        ctx: c,
        warnings,
      });
    }

    const geometry = outputGeometry({ width: media.width, height: media.height, maxEdge, crop });
    const captured = await captureFrame({
      inputPath: input.path,
      atSeconds: frameCandidates(atSec, media.fpsForScan),
      geometry,
      ctx: c,
    });

    const actualSec = Math.round(captured.atSeconds * 1000) / 1000;
    const target = {
      kind: 'frame',
      atMs: Math.round(actualSec * 1000),
      atSec: actualSec,
      fromMs: selection === 'sharpest' ? fromMs : null,
      toMs: selection === 'sharpest' ? toMs : null,
      selection,
      page: null,
      crop,
    };

    return {
      mediaType: 'video',
      path: input.path,
      images: [{
        index: 1,
        buffer: captured.buffer,
        width: captured.width,
        height: captured.height,
        cells: 1,
        mimeType: 'image/png',
      }],
      target,
      warnings,
    };
  }

  async function locate(input, callCtx = backendCtx()) {
    const c = callCtx;
    const media = await readVideoInfo(input, c);
    const warnings = [];
    const window = computeWindow(input, media, warnings);

    const transcriptData = await resolveTranscript(input, c, media, {
      fromSec: window.startSec,
      toSec: window.endSec,
      warnings,
      healthProvider: () => getAudioHealth(media, c),
    });
    mergeWarnings(warnings, transcriptData.warnings);

    const segments = transcriptData.segments.filter(
      (segment) => overlapsWindow(segment, window.startMs, window.endMs),
    );
    if (transcriptData.transcript.source === 'none' || segments.length === 0) {
      throw noTranscriptError(input, c, transcriptData.transcript);
    }

    const candidates = segments.flatMap((segment) => splitIntoSentences(segment));
    const matches = matchSegments(candidates, input.query ?? '', { max: input.max ?? 5 })
      .map((match, index) => ({ ...match, rank: index + 1, page: null }));

    let frame = null;
    if (input.includeFrame && matches.length > 0 && matches[0].startMs !== null) {
      try {
        const geometry = outputGeometry({ width: media.width, height: media.height, maxEdge: 1280, crop: null });
        const atSec = Math.max(0, matches[0].startMs / 1000);
        const captured = await captureFrame({
          inputPath: input.path,
          atSeconds: frameCandidates(atSec, media.fpsForScan),
          geometry,
          ctx: c,
        });
        frame = {
          buffer: captured.buffer,
          width: captured.width,
          height: captured.height,
          cells: 1,
          mimeType: 'image/png',
          atMs: Math.round(captured.atSeconds * 1000),
        };
      } catch (error) {
        if (c.signal?.aborted) throw error;
        warnings.push(`includeFrame failed: ${error?.message ?? error}`);
      }
    }

    return {
      mediaType: 'video',
      query: input.query ?? '',
      totalSegments: candidates.length,
      matches,
      transcript: transcriptData.transcript,
      frame,
      warnings,
      note: matches.length === 0
        ? `no line matched ${JSON.stringify(input.query ?? '')} among ${candidates.length} transcript segments. `
          + 'Try shorter keywords, or a phrase that appears verbatim.'
        : undefined,
    };
  }

  /** 契约 §8：只用已有字幕，不跑 ASR；完全没有字幕来源 → NO_TRANSCRIPT */
  async function subtitles(input, callCtx = backendCtx()) {
    const c = callCtx;
    const media = await readVideoInfo(input, c);
    const warnings = [];
    const subtitle = await resolveSubtitleSource({
      mediaPath: input.path,
      subtitle: input.subtitle,
      streams: media.streams,
      signal: c.signal,
      warnings,
    });
    if (!subtitle) {
      throw new ToolError(
        'NO_TRANSCRIPT',
        `no subtitle source for "${input.path}": no embedded subtitle track, no sibling .srt/.vtt/.ass/.ssa file, `
          + 'and no ASR provider configured. Pass subtitle with a local subtitle file, a track index, or a language code.',
      );
    }
    mergeWarnings(warnings, subtitle.warnings);

    let segments = subtitle.segments.map((segment, i) => ({
      ...segment,
      index: i + 1,
      source: 'subtitle',
      origin: subtitle.origin,
    }));
    const startMs = Number.isInteger(input.startMs) ? input.startMs : null;
    const endMs = Number.isInteger(input.endMs) ? input.endMs : null;
    if (startMs !== null || endMs !== null) {
      segments = segments.filter((segment) => overlapsWindow(segment, startMs, endMs));
    }
    segments = segments.map((segment, i) => ({ ...segment, index: i + 1 }));

    return {
      mediaType: 'video',
      path: input.path,
      segments,
      origin: subtitle.origin,
      sourcePath: subtitle.sourcePath ?? null,
      format: subtitle.format ?? null,
      language: subtitle.language ?? null,
      warnings,
    };
  }

  return { probe, overview, zoom, locate, subtitles };
}

export default createVideoBackend;
