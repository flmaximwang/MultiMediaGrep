// src/media/detect.js —— 媒体类型判定
// 只看本地文件：扩展名 + 文件头魔数。不解析内容、不联网。

import { open } from 'node:fs/promises';

/** 契约 §2.1 的三类媒体 */
export const MEDIA_TYPES = Object.freeze(['video', 'audio', 'document']);

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.mts', '.m2ts', '.ts', '.3gp',
]);
const AUDIO_EXT = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr', '.m4b', '.weba',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const TEXT_DOC_EXT = new Set(['.txt', '.md', '.markdown']);
/** Office 文档：本版不解析，但归到 document，让后端给出「先转 PDF」的准确提示 */
const OFFICE_DOC_EXT = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.odp', '.ods']);
/** 字幕文件不是「媒体」，是 subtitle 参数的输入 */
export const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

export function extOf(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function isSubtitlePath(filePath) {
  return SUBTITLE_EXT.has(extOf(filePath));
}

async function readHead(filePath, bytes = 16) {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return buf.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

function ascii(buf, offset, length) {
  return buf.subarray(offset, offset + length).toString('latin1');
}

/**
 * 用魔数判断文件类型；识别不出返回 null。
 * 覆盖：MP4/MOV(fTyp)、Matroska/WebM(EBML)、MP3、RIFF(WAVE/WEBP/AVI)、FLAC、OggS、PDF、PNG、JPEG、GIF、TIFF。
 */
export function sniffMagic(head) {
  if (!head || head.length === 0) return null;
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(head, [0x47, 0x49, 0x46])) return 'gif';
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'matroska';
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
  if (startsWith(head, [0x66, 0x4c, 0x61, 0x43])) return 'flac';
  if (ascii(head, 0, 4) === 'RIFF') {
    const kind = ascii(head, 8, 4);
    if (kind === 'WAVE') return 'wav';
    if (kind === 'WEBP') return 'webp';
    if (kind === 'AVI ') return 'avi';
  }
  if (ascii(head, 4, 4) === 'ftyp') return 'mp4';
  if (ascii(head, 0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/**
 * 判定媒体类型：'video' | 'audio' | 'document'。
 * 先看魔数（更可信），再看扩展名；两者都没有就抛错。
 * 注意：.mp4/.m4a 里可能只有音轨，最终类型以 probe 的 ffprobe 结果为准（这里给的是候选类型）。
 */
export async function detectMediaType(filePath) {
  const ext = extOf(filePath);
  let head = null;
  try {
    head = await readHead(filePath);
  } catch {
    head = null;
  }
  const magic = sniffMagic(head);

  const byMagic = {
    mp4: 'video',
    matroska: 'video',
    avi: 'video',
    wav: 'audio',
    ogg: 'audio',
    flac: 'audio',
    mp3: 'audio',
    pdf: 'document',
    png: 'document',
    jpg: 'document',
    webp: 'document',
    gif: 'document',
    tiff: 'document',
  }[magic];

  const byExt = VIDEO_EXT.has(ext) ? 'video'
    : AUDIO_EXT.has(ext) ? 'audio'
      : IMAGE_EXT.has(ext) || ext === '.pdf' || TEXT_DOC_EXT.has(ext) || OFFICE_DOC_EXT.has(ext) ? 'document'
        : null;

  const type = byMagic ?? byExt;
  if (!type) {
    throw new Error(`不支持的文件类型：${filePath}（扩展名 ${ext || '无'}，魔数 ${magic || '未识别'}）`);
  }
  return {
    mediaType: type,
    /** 判定依据，写进 probe 结果便于排查 */
    detectedBy: byMagic ? `magic:${magic}` : `extension:${ext}`,
    magic,
    extension: ext,
  };
}
