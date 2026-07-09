import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LabelZoomClient,
  LabelZoomError,
  SOURCE_FORMATS,
  TARGET_FORMATS,
  isTextFormat,
  mediaTypeFor,
  type ConversionParams,
  type SourceFormat,
  type TargetFormat,
} from './api.js';

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

const paramsShape = {
  dpi: z.number().int().positive().optional()
    .describe('Dots per inch of the label. Defaults to 203 (standard Zebra thermal printer).'),
  rotation: z.number().int().optional()
    .describe('Rotation in degrees. Must be a multiple of 90.'),
  scaling: z.number().positive().optional()
    .describe('Scale percentage. 100 means no scaling.'),
  darkness: z.number().int().min(0).max(100).optional()
    .describe('Luminance threshold (0-100) used when reducing images to black and white.'),
  colorMode: z.enum(['BW', 'GRAYSCALE', 'COLOR']).optional()
    .describe('GRAYSCALE (the default) dithers to simulate gray on a monochrome printer.'),
  data: z.record(z.unknown()).optional()
    .describe('Key/value data merged into the label\'s dynamic fields before output.'),
  labelWidth: z.number().positive().optional().describe('Override label width, in inches.'),
  labelHeight: z.number().positive().optional().describe('Override label height, in inches.'),
  pdfPageNumber: z.number().int().min(0).optional()
    .describe('Zero-based page to convert when the source is a PDF. Omit to convert every page.'),
};

type ParamsArgs = {
  dpi?: number;
  rotation?: number;
  scaling?: number;
  darkness?: number;
  colorMode?: 'BW' | 'GRAYSCALE' | 'COLOR';
  data?: Record<string, unknown>;
  labelWidth?: number;
  labelHeight?: number;
  pdfPageNumber?: number;
};

function buildParams(args: ParamsArgs): ConversionParams {
  const params: ConversionParams = {};
  if (args.dpi !== undefined) params.dpi = args.dpi;
  if (args.rotation !== undefined) params.rotation = args.rotation;
  if (args.scaling !== undefined) params.scaling = args.scaling;
  if (args.darkness !== undefined) params.darkness = args.darkness;
  if (args.colorMode !== undefined) params.colorMode = args.colorMode;
  if (args.data !== undefined) params.data = args.data;
  if (args.labelWidth !== undefined || args.labelHeight !== undefined) {
    params.label = { width: args.labelWidth, height: args.labelHeight };
  }
  if (args.pdfPageNumber !== undefined) params.pdf = { pageNumber: args.pdfPageNumber };
  return params;
}

/**
 * Resolve the request body from either inline content or a file on disk.
 * Inline content for a binary source format is expected to be base64.
 */
async function resolveBody(
  format: SourceFormat,
  content: string | undefined,
  inputPath: string | undefined,
): Promise<Uint8Array> {
  if ((content === undefined) === (inputPath === undefined)) {
    throw new Error('Provide exactly one of `content` or `input_path`.');
  }
  if (inputPath !== undefined) {
    return new Uint8Array(await readFile(inputPath));
  }
  return isTextFormat(format)
    ? new TextEncoder().encode(content!)
    : new Uint8Array(Buffer.from(content!, 'base64'));
}

function toErrorResult(err: unknown): ToolResult {
  const message =
    err instanceof LabelZoomError
      ? `LabelZoom API rejected the request (HTTP ${err.status}).\n\n${err.detail}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function registerTools(server: McpServer, client: LabelZoomClient): void {
  server.registerTool(
    'convert_label',
    {
      title: 'Convert a label between formats',
      description:
        'Convert a barcode label between any of the formats LabelZoom supports: ZPL, LabelZoom XML, ' +
        'LabelZoom JSON, PDF, PNG, BMP, GIF, and JPEG. Text formats (zpl, xml, json) are returned inline; ' +
        'binary formats are written to `output_path` if given, and otherwise returned as base64. ' +
        'To visually inspect a label, prefer `render_label_preview`.',
      inputSchema: {
        source_format: z.enum(SOURCE_FORMATS).describe('Format of the input.'),
        target_format: z.enum(TARGET_FORMATS).describe('Format to convert to.'),
        content: z.string().optional()
          .describe('Inline input. Raw text for zpl/xml/json; base64 for binary formats.'),
        input_path: z.string().optional().describe('Path to a file to read the input from instead.'),
        output_path: z.string().optional()
          .describe('Where to write the result. Required in practice for large binary output.'),
        ...paramsShape,
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        const body = await resolveBody(args.source_format, args.content, args.input_path);
        const result = await client.convert(
          args.source_format as SourceFormat,
          args.target_format as TargetFormat,
          body,
          buildParams(args),
        );

        if (args.output_path) {
          await writeFile(args.output_path, result.bytes);
          const kb = (result.bytes.byteLength / 1024).toFixed(1);
          return {
            content: [{
              type: 'text',
              text: `Wrote ${kb} KB of ${args.target_format.toUpperCase()} to ${args.output_path}.`,
            }],
          };
        }

        if (isTextFormat(args.target_format)) {
          return { content: [{ type: 'text', text: new TextDecoder().decode(result.bytes) }] };
        }

        if (args.target_format === 'png') {
          return {
            content: [{
              type: 'image',
              data: Buffer.from(result.bytes).toString('base64'),
              mimeType: 'image/png',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `${args.target_format.toUpperCase()} output, base64-encoded:\n\n${Buffer.from(result.bytes).toString('base64')}`,
          }],
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  server.registerTool(
    'render_label_preview',
    {
      title: 'Render a label to a viewable image',
      description:
        'Render a label to a PNG image so it can be looked at directly. Use this to check that ZPL or ' +
        'LabelZoom XML actually produces the intended label — element placement, barcode rendering, text ' +
        'overflow — rather than reasoning about the source alone.',
      inputSchema: {
        source_format: z.enum(['zpl', 'xml', 'json', 'pdf']).describe('Format of the input.'),
        content: z.string().optional().describe('Inline input. Raw text for zpl/xml/json; base64 for pdf.'),
        input_path: z.string().optional().describe('Path to a file to read the input from instead.'),
        save_to: z.string().optional().describe('Optionally also write the PNG to this path.'),
        ...paramsShape,
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        const body = await resolveBody(args.source_format as SourceFormat, args.content, args.input_path);
        const result = await client.convert(
          args.source_format as SourceFormat,
          'png',
          body,
          buildParams(args),
        );

        const content: ToolResult['content'] = [{
          type: 'image',
          data: Buffer.from(result.bytes).toString('base64'),
          mimeType: 'image/png',
        }];

        if (args.save_to) {
          await writeFile(args.save_to, result.bytes);
          content.push({ type: 'text', text: `Also saved to ${args.save_to}.` });
        }
        if (!client.isAuthenticated) {
          content.push({
            type: 'text',
            text: 'Note: rendered without a LabelZoom token, so the image carries a watermark.',
          });
        }
        return { content };
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  server.registerTool(
    'list_conversion_formats',
    {
      title: 'List supported label formats',
      description:
        'List the source and target formats LabelZoom can convert between, and the media type each uses. ' +
        'Call this when unsure whether a given conversion path is supported.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const describe = (formats: readonly string[]) =>
        formats.map((f) => `  ${f.padEnd(6)} ${mediaTypeFor(f)}`).join('\n');
      return {
        content: [{
          type: 'text',
          text:
            `Source formats:\n${describe(SOURCE_FORMATS)}\n\n` +
            `Target formats:\n${describe(TARGET_FORMATS)}\n\n` +
            'Any source may convert to any target. Some paths are gated behind a paid license: ' +
            'JSON export, printer dialects, image-to-image conversion, and multi-page output. ' +
            (client.isAuthenticated
              ? 'A token is configured.'
              : 'No token is configured, so output will be watermarked.'),
        }],
      };
    },
  );
}
