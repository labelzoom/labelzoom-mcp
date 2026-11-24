/**
 * How this server moves documents in and out of tool calls.
 *
 * The format list itself comes from `@labelzoom/sdk`, which owns the wire contract. What is
 * decided here is MCP-specific: a tool call carries text, so binary documents travel as base64,
 * and output is shown inline only when doing so cannot change a byte.
 */
import { SOURCE_FORMATS, TARGET_FORMATS, type SourceFormat, type TargetFormat } from '@labelzoom/sdk';

export { SOURCE_FORMATS, TARGET_FORMATS, type SourceFormat, type TargetFormat };

/** Print takes every source except a URL: print sends the document itself and never fetches. */
export const PRINT_SOURCE_FORMATS = SOURCE_FORMATS.filter(
  (format): format is Exclude<SourceFormat, 'url'> => format !== 'url',
);

/**
 * Sources whose files are binary, so inline `content` for them is base64. Every other source is
 * text: printer code, LabelZoom XML or JSON, a DYMO file (XML), or a URL.
 */
const BINARY_SOURCES = new Set<SourceFormat>(['pdf', 'png', 'bmp', 'gif', 'jpeg', 'jpg', 'nlbl', 'lbl', 'btw']);

export const isBinarySource = (format: SourceFormat): boolean => BINARY_SOURCES.has(format);

/** Targets that are always text. CPCL writes its graphics as hex, so it is one of them. */
const TEXT_TARGETS = new Set<TargetFormat>(['zpl', 'cpcl', 'xml', 'json']);

/**
 * Printer languages that come back as `text/plain` but can carry raw bytes: EPL's `GW` and
 * TSPL's `BITMAP` inline a bitmap, IPL frames commands in STX/ETX, DPL starts with STX, and SBPL
 * prefixes every command with ESC. They are shown inline only when the output has none of that.
 */
const MAYBE_BINARY_TARGETS = new Set<TargetFormat>(['epl', 'ipl', 'tspl', 'dpl', 'sbpl']);

export const isTextTarget = (format: TargetFormat): boolean => TEXT_TARGETS.has(format);

/** Sources that accept `sourceDpi`: the printer languages and images. */
export const SOURCE_DPI_SOURCES = new Set<SourceFormat>([
  'zpl', 'epl', 'ipl', 'tspl', 'dpl', 'sbpl', 'esclabel', 'fingerprint', 'ezpl', 'cpcl', 'tpcl',
  'png', 'bmp', 'gif', 'jpeg', 'jpg',
]);

/**
 * The output as text, or `undefined` when showing it as text could alter it.
 *
 * Text targets always decode. A printer-language target decodes only when every byte is valid
 * UTF-8 and the only control characters are tab, line feed and carriage return; anything else
 * goes out as base64, so a label with an inline bitmap is never corrupted on the way to the user.
 */
export function outputText(target: TargetFormat, bytes: Uint8Array): string | undefined {
  if (TEXT_TARGETS.has(target)) return new TextDecoder().decode(bytes);
  if (!MAYBE_BINARY_TARGETS.has(target)) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) ? undefined : text;
}

const FORMAT_LABELS: Record<string, string> = {
  zpl: 'ZPL (Zebra)',
  epl: 'EPL (Eltron, Zebra)',
  ipl: 'IPL (Intermec, Honeywell)',
  tspl: 'TSPL (TSC)',
  dpl: 'DPL (Datamax-O\'Neil, Honeywell)',
  sbpl: 'SBPL (SATO)',
  cpcl: 'CPCL (Zebra mobile printers)',
  esclabel: 'ESC/Label (Epson ColorWorks)',
  fingerprint: 'Fingerprint and Direct Protocol (Honeywell)',
  ezpl: 'EZPL (GoDEX)',
  tpcl: 'TPCL (Toshiba TEC)',
  nlbl: 'NiceLabel or ZebraDesigner 3 design file (.nlbl)',
  lbl: 'NiceLabel design file (.lbl)',
  btw: 'BarTender design file (.btw, .btc)',
  dymo: 'DYMO design file (.label, .dymo)',
  xml: 'LabelZoom XML',
  json: 'LabelZoom JSON',
  pdf: 'PDF',
  png: 'PNG',
  bmp: 'BMP',
  gif: 'GIF',
  jpeg: 'JPEG',
  jpg: 'JPEG (jpg spelling)',
  url: 'A URL that LabelZoom fetches',
};

export const formatLabel = (format: string): string => FORMAT_LABELS[format] ?? format.toUpperCase();
