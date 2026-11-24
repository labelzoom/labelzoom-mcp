import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LabelZoomError,
  LabelZoomValidationError,
  PrintQuotaExceededError,
  type ConversionOptions,
  type DataRecord,
  type LabelZoomClient,
  type PrintOptions,
} from '@labelzoom/sdk';
import {
  PRINT_SOURCE_FORMATS,
  SOURCE_DPI_SOURCES,
  SOURCE_FORMATS,
  TARGET_FORMATS,
  formatLabel,
  isBinarySource,
  isTextTarget,
  outputText,
  type SourceFormat,
  type TargetFormat,
} from './formats.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (value: string): Content => ({ type: 'text', text: value });
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

// --- Options ------------------------------------------------------------------------------------
//
// Named as the API names them, so an option reads the same here, in the SDKs and in the docs.
// The SDK serializes them and checks what it can locally; which formats take which option is the
// server's call, and its error message comes back through the tool result.

const record = z.record(z.string(), z.unknown());

/** How the document is read. Every tool that takes a document takes these. */
const sourceOptionsShape = {
  sourceDpi: z.number().int().positive().optional()
    .describe('The resolution the label code or image was made for, in dots per inch. Printer languages and images only. The output follows it unless targetDpi is set.'),
  labelWidth: z.number().positive().optional()
    .describe('Label width in inches. Leave unset to use the size the label code declares, or else the size of its content.'),
  labelHeight: z.number().positive().optional()
    .describe('Label height in inches. Leave unset to use the size the label code declares, or else the size of its content.'),
  labelIndex: z.number().int().min(0).optional()
    .describe('Convert only this label of a multi-label document, counting from 0.'),
  data: z.union([record, z.array(record)]).optional()
    .describe('Values for the label\'s variable fields. An array produces one label per entry.'),
  pdfPageNumber: z.number().int().min(0).optional()
    .describe('PDF sources: the page to convert, counting from 0. Omit to convert every page.'),
  pdfConversionMode: z.enum(['IMAGE', 'NATIVE']).optional()
    .describe('PDF sources: IMAGE (the default) rasterizes each page; NATIVE extracts text and vector content.'),
  zplCommandsToIgnore: z.array(z.string()).optional()
    .describe('ZPL and ESC/Label sources: commands to skip, such as ["^PQ"].'),
  scaling: z.number().positive().optional()
    .describe('PDF and image sources: scale percentage. 100 is no scaling.'),
  darkness: z.number().min(0).max(100).optional()
    .describe('Luminance threshold, 0 to 100, used when reducing color to black and white. Raise it to darken thin lines.'),
  colorMode: z.enum(['BW', 'GRAYSCALE', 'COLOR']).optional()
    .describe('How color is reduced. GRAYSCALE (the default) dithers to simulate gray.'),
  split: z.object({
    rows: z.number().int().min(1).max(20).optional(),
    columns: z.number().int().min(1).max(20).optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    left: z.number().min(0).optional(),
    top: z.number().min(0).optional(),
    columnGap: z.number().min(0).optional(),
    rowGap: z.number().min(0).optional(),
    skipBlank: z.boolean().optional(),
  }).optional()
    .describe('PDF and image sources: cut each page into a grid of labels, such as a sheet of address labels. Lengths are in inches; leave width and height unset to divide the page equally.'),
  rotation: z.number().int().optional()
    .describe('Rotate the output, in degrees. A multiple of 90.'),
};

/** What is written. Convert and preview take these; a print's output is set by the printer. */
const targetOptionsShape = {
  targetDpi: z.number().int().positive().optional()
    .describe('The resolution of the output, in dots per inch. Match the printer. Every target except PDF.'),
  zplImageCompression: z.enum(['Z64', 'COMPRESSED_HEX']).optional()
    .describe('ZPL targets: how images are encoded. COMPRESSED_HEX suits older firmware.'),
  zplCollapseCopies: z.boolean().optional()
    .describe('ZPL targets from a PDF or image: write each run of identical labels as one label with a ^PQ count.'),
  layout: z.object({
    across: z.number().int().min(1).max(10).optional(),
    gap: z.number().min(0).optional(),
    fill: z.enum(['SEQUENTIAL', 'REPEAT']).optional(),
  }).optional()
    .describe('ZPL targets from a PDF or image: labels side by side on a multi-across roll. gap is in inches.'),
  watermark: z.boolean().optional().describe('Force a watermark on the output.'),
  dialect: z.string().optional().describe('Output dialect, such as "moca". Requires a paid plan.'),
};

type SourceOptionArgs = {
  [K in keyof typeof sourceOptionsShape]?: z.infer<(typeof sourceOptionsShape)[K]>;
};
type TargetOptionArgs = {
  [K in keyof typeof targetOptionsShape]?: z.infer<(typeof targetOptionsShape)[K]>;
};

/** Map tool arguments to the API's option object. Only what the caller set is included. */
export function printOptions(args: SourceOptionArgs): PrintOptions {
  const options: PrintOptions = {};
  if (args.sourceDpi !== undefined) options.sourceDpi = args.sourceDpi;
  if (args.labelWidth !== undefined || args.labelHeight !== undefined) {
    options.label = {
      ...(args.labelWidth !== undefined ? { width: args.labelWidth } : {}),
      ...(args.labelHeight !== undefined ? { height: args.labelHeight } : {}),
    };
  }
  if (args.labelIndex !== undefined) options.labelIndex = args.labelIndex;
  if (args.data !== undefined) options.data = args.data as DataRecord | DataRecord[];
  if (args.pdfPageNumber !== undefined || args.pdfConversionMode !== undefined) {
    options.pdf = {
      ...(args.pdfPageNumber !== undefined ? { pageNumber: args.pdfPageNumber } : {}),
      ...(args.pdfConversionMode !== undefined ? { conversionMode: args.pdfConversionMode } : {}),
    };
  }
  if (args.zplCommandsToIgnore !== undefined) options.zpl = { commandsToIgnore: args.zplCommandsToIgnore };
  if (args.scaling !== undefined) options.scaling = args.scaling;
  if (args.darkness !== undefined) options.darkness = args.darkness;
  if (args.colorMode !== undefined) options.colorMode = args.colorMode;
  if (args.split !== undefined) options.split = args.split;
  if (args.rotation !== undefined) options.rotation = args.rotation;
  return options;
}

export function conversionOptions(args: SourceOptionArgs & TargetOptionArgs): ConversionOptions {
  const options: ConversionOptions = { ...printOptions(args) };
  if (args.targetDpi !== undefined) options.targetDpi = args.targetDpi;
  if (args.zplImageCompression !== undefined || args.zplCollapseCopies !== undefined) {
    options.zpl = {
      ...options.zpl,
      ...(args.zplImageCompression !== undefined ? { imageCompression: args.zplImageCompression } : {}),
      ...(args.zplCollapseCopies !== undefined ? { collapseCopies: args.zplCollapseCopies } : {}),
    };
  }
  if (args.layout !== undefined) options.layout = args.layout;
  if (args.watermark !== undefined) options.watermark = args.watermark;
  if (args.dialect !== undefined) options.dialect = args.dialect;
  return options;
}

// --- Documents ----------------------------------------------------------------------------------

const documentShape = {
  content: z.string().optional()
    .describe('The document inline: label code as text, or base64 for a PDF, an image, or a NiceLabel or BarTender file. For the url source, the URL.'),
  input_path: z.string().optional().describe('A file to read the document from, instead of content.'),
};

interface Document {
  /** The bytes, or the base64 text when `asBase64Text` is set. */
  body: Uint8Array | string;
  asBase64Text: boolean;
}

function requireOneInput(content: string | undefined, inputPath: string | undefined): void {
  if ((content === undefined) === (inputPath === undefined)) {
    throw new LabelZoomValidationError('body', 'Provide exactly one of `content` or `input_path`.');
  }
}

/**
 * The document for a conversion. Inline content for a binary source is sent as base64 text,
 * which the API decodes; a file is sent as its own bytes.
 */
async function conversionDocument(
  source: SourceFormat,
  content: string | undefined,
  inputPath: string | undefined,
): Promise<Document> {
  requireOneInput(content, inputPath);
  if (inputPath !== undefined) return { body: new Uint8Array(await readFile(inputPath)), asBase64Text: false };
  return { body: content!, asBase64Text: isBinarySource(source) };
}

/**
 * The document for a print. Print reads the body as the file itself, so inline base64 is decoded
 * here: sent as base64 text, it would reach the printer as base64 characters.
 */
async function printDocument(
  source: SourceFormat,
  content: string | undefined,
  inputPath: string | undefined,
): Promise<Uint8Array | string> {
  requireOneInput(content, inputPath);
  if (inputPath !== undefined) return new Uint8Array(await readFile(inputPath));
  if (!isBinarySource(source)) return content!;
  const compact = content!.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new LabelZoomValidationError('body', `Inline content for a ${source} document must be base64.`);
  }
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

// --- Results and errors -------------------------------------------------------------------------

export function errorResult(error: unknown): ToolResult {
  if (error instanceof LabelZoomValidationError) {
    return { content: [text(`Invalid ${error.parameter}: ${error.message}`)], isError: true };
  }
  if (error instanceof LabelZoomError) {
    const lines = [
      `LabelZoom returned HTTP ${error.status}${error.code !== null ? ` (${error.code})` : ''}: ${error.message}`,
    ];
    if (error instanceof PrintQuotaExceededError) {
      lines.push('The daily print job limit is reached. It resets at midnight UTC; get_print_quota shows the reset time.');
    } else if (error.status === 401) {
      lines.push('Set LABELZOOM_API_KEY to a LabelZoom API key. Printing needs a key with the print scope.');
    } else if (error.status === 403 && /paid/i.test(error.message)) {
      lines.push('This conversion needs a paid LabelZoom plan.');
    }
    if (error.requestId !== undefined) lines.push(`Request ID: ${error.requestId} (quote it to LabelZoom support).`);
    return { content: [text(lines.join('\n'))], isError: true };
  }
  // fetch rejects with a TypeError when the request never got a response: DNS, a refused
  // connection, TLS. The SDK has already retried it by the time it lands here.
  if (error instanceof TypeError) {
    return {
      content: [text(`Could not reach the LabelZoom API: ${error.message}. Check the network, and LABELZOOM_API_BASE_URL if it is set.`)],
      isError: true,
    };
  }
  return { content: [text(error instanceof Error ? error.message : String(error))], isError: true };
}

const json = (value: unknown): ToolResult => ({ content: [text(JSON.stringify(value, null, 2))] });

function requireKey(client: LabelZoomClient): void {
  if (!client.isAuthenticated) {
    throw new Error(
      'Printing needs a LabelZoom API key with the print scope. Set LABELZOOM_API_KEY in this server\'s environment.',
    );
  }
}

const WATERMARK_NOTE =
  'Converted without a LabelZoom API key, so the output carries a watermark and holds only the first label.';

// --- Tools --------------------------------------------------------------------------------------

export function registerTools(server: McpServer, client: LabelZoomClient): void {
  server.registerTool(
    'convert_label',
    {
      title: 'Convert a label between formats',
      description:
        'Convert a barcode label between formats: printer languages (ZPL, EPL, IPL, TSPL, DPL, SBPL, CPCL, ' +
        'and read-only ESC/Label, Fingerprint, EZPL and TPCL), NiceLabel, BarTender and DYMO design files ' +
        '(read-only), PDF, PNG, BMP, GIF, JPEG, and LabelZoom XML and JSON. Text output is returned inline; ' +
        'binary output is written to output_path when given and returned as base64 otherwise. To look at a ' +
        'label, use render_label_preview.',
      inputSchema: {
        source_format: z.enum(SOURCE_FORMATS as [SourceFormat, ...SourceFormat[]]).describe('Format of the input.'),
        target_format: z.enum(TARGET_FORMATS as [TargetFormat, ...TargetFormat[]]).describe('Format to convert to.'),
        ...documentShape,
        output_path: z.string().optional()
          .describe('Where to write the result. Use it for large or binary output.'),
        ...sourceOptionsShape,
        ...targetOptionsShape,
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        const source = args.source_format as SourceFormat;
        const target = args.target_format as TargetFormat;
        const document = await conversionDocument(source, args.content, args.input_path);
        const result = await client.convert({
          from: source,
          to: target,
          body: document.body,
          asBase64Text: document.asBase64Text,
          options: conversionOptions(args),
        });

        const content: Content[] = [];
        if (args.output_path !== undefined) {
          await writeFile(args.output_path, result.bytes);
          const kb = (result.bytes.byteLength / 1024).toFixed(1);
          content.push(text(`Wrote ${kb} KB of ${target.toUpperCase()} to ${args.output_path}.`));
        } else if (target === 'png') {
          content.push({ type: 'image', data: base64(result.bytes), mimeType: 'image/png' });
        } else {
          const decoded = outputText(target, result.bytes);
          content.push(
            text(
              decoded ??
                `${target.toUpperCase()} output, base64-encoded${isTextTarget(target) ? '' : ' because it holds raw bytes'}:\n\n${base64(result.bytes)}`,
            ),
          );
        }
        if (!client.isAuthenticated) content.push(text(WATERMARK_NOTE));
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'render_label_preview',
    {
      title: 'Render a label to a viewable image',
      description:
        'Render a label to a PNG image so it can be looked at directly. Use this to check that label code ' +
        'produces the intended label (element placement, barcodes, text overflow) instead of reasoning ' +
        'about the source alone. Takes any source format convert_label takes.',
      inputSchema: {
        source_format: z.enum(SOURCE_FORMATS as [SourceFormat, ...SourceFormat[]]).describe('Format of the input.'),
        ...documentShape,
        save_to: z.string().optional().describe('Also write the PNG to this path.'),
        ...sourceOptionsShape,
        targetDpi: targetOptionsShape.targetDpi,
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        const source = args.source_format as SourceFormat;
        const document = await conversionDocument(source, args.content, args.input_path);
        const result = await client.convert({
          from: source,
          to: 'png',
          body: document.body,
          asBase64Text: document.asBase64Text,
          options: conversionOptions(args),
        });

        const content: Content[] = [{ type: 'image', data: base64(result.bytes), mimeType: 'image/png' }];
        if (args.save_to !== undefined) {
          await writeFile(args.save_to, result.bytes);
          content.push(text(`Also saved to ${args.save_to}.`));
        }
        if (!client.isAuthenticated) content.push(text(WATERMARK_NOTE));
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_conversion_formats',
    {
      title: 'List supported label formats',
      description:
        'List the formats LabelZoom converts from and to, which sources take sourceDpi, and whether an API ' +
        'key is configured. Call this when unsure whether a conversion or print is supported.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const describe = (formats: readonly string[], dpi?: Set<SourceFormat>) =>
        formats
          .map((f) => `  ${f.padEnd(12)} ${formatLabel(f)}${dpi?.has(f as SourceFormat) ? ' [sourceDpi]' : ''}`)
          .join('\n');
      return {
        content: [
          text(
            `Source formats:\n${describe(SOURCE_FORMATS, SOURCE_DPI_SOURCES)}\n\n` +
              `Target formats:\n${describe(TARGET_FORMATS)}\n\n` +
              'Any source converts to any target, and every source except url prints. Inline content is ' +
              'text for label code and base64 for a PDF, an image, or a NiceLabel or BarTender file. ' +
              'Without an API key, output is watermarked and holds only the first label; some paths, such ' +
              'as JSON output and image to image, need a paid plan. ' +
              (client.isAuthenticated ? 'An API key is configured.' : 'No API key is configured.'),
          ),
        ],
      };
    },
  );

  server.registerTool(
    'print_label',
    {
      title: 'Print a label on a Cloud Print printer',
      description:
        'Send a document to a printer connected through LabelZoom Cloud Print. LabelZoom converts it to the ' +
        'printer\'s own language on the way, so a PDF prints on a ZPL printer. Needs an API key with the ' +
        'print scope. The job is accepted, not printed, when this returns: use get_print_job to follow it.',
      inputSchema: {
        printer_id: z.string().min(1).describe('The printer\'s ID, from the LabelZoom dashboard.'),
        source_format: z
          .enum(PRINT_SOURCE_FORMATS as [SourceFormat, ...SourceFormat[]])
          .describe('Format of the document.'),
        ...documentShape,
        copies: z.number().int().min(1).max(9999).optional()
          .describe('Send the job this many times, 1 to 9999. A quantity in the label itself multiplies with it.'),
        idempotency_key: z.string().optional()
          .describe('Repeating a key returns the original job instead of printing again. Use an order number to make a retry safe. Without one, a key is generated for this call.'),
        ...sourceOptionsShape,
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        requireKey(client);
        const source = args.source_format as Exclude<SourceFormat, 'url'>;
        const job = await client.print({
          printerId: args.printer_id,
          from: source,
          body: await printDocument(source, args.content, args.input_path),
          options: printOptions(args),
          copies: args.copies,
          idempotencyKey: args.idempotency_key,
        });
        return json(job);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'print_template',
    {
      title: 'Print a LabelZoom template',
      description:
        'Fill a Print Template published from LabelZoom Studio with data and print it on a Cloud Print ' +
        'printer, one label per record. Needs an API key with the print scope. Returns the jobs and how many ' +
        'records at the end were not submitted (remaining); resend with the same idempotency_key to submit them.',
      inputSchema: {
        printer_id: z.string().min(1).describe('The printer\'s ID, from the LabelZoom dashboard.'),
        template_id: z.string().min(1).describe('The template\'s ID.'),
        data: z.union([record, z.array(record)]).optional()
          .describe('Merge-field values: one object per label. Omit it for a template with no merge fields.'),
        validate: z.boolean().optional()
          .describe('Check every record for missing merge fields before anything prints.'),
        copies: z.number().int().min(1).max(9999).optional().describe('Send each label this many times.'),
        idempotency_key: z.string().optional()
          .describe('One key for the whole batch. Repeating it returns the original jobs instead of printing again.'),
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        requireKey(client);
        const batch = await client.printTemplate({
          printerId: args.printer_id,
          templateId: args.template_id,
          data: args.data as DataRecord | DataRecord[] | undefined,
          validate: args.validate,
          copies: args.copies,
          idempotencyKey: args.idempotency_key,
        });
        return json(batch);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_print_job',
    {
      title: 'Get a print job',
      description:
        'Look up a print job by ID to see whether it printed. dispatched and queued mean accepted; only ' +
        'completed means the label came out of the printer.',
      inputSchema: {
        job_id: z.string().min(1).describe('The jobId returned by print_label or print_template.'),
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        requireKey(client);
        return json(await client.jobs.get(args.job_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_print_quota',
    {
      title: 'Get the Cloud Print quota',
      description:
        'Show the plan\'s limits on agents, printers and daily print jobs, what is used, and when the daily ' +
        'count resets.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        requireKey(client);
        return json(await client.getPrintQuota());
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
