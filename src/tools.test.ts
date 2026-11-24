/**
 * The tool layer: that each tool's arguments become the right request, and each response the
 * right tool result. The wire contract itself (retries, error mapping, serialization) belongs to
 * `@labelzoom/sdk`, whose conformance suite covers it; these tests check that this server drives
 * the SDK correctly. Entirely offline: `fetch` is a recording stub.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION, createClient } from './client.js';
import { registerTools } from './tools.js';

interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface Scripted {
  status?: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}>;

/** Register the tools against a stand-in server and a client whose fetch records every request. */
function setup(options: { env?: NodeJS.ProcessEnv; responses?: Scripted[]; maxRetries?: number } = {}) {
  const requests: Recorded[] = [];
  const queue = [...(options.responses ?? [{ body: '^XA^XZ' }])];
  const fetchStub = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined || init.body === null ? Buffer.alloc(0) : Buffer.from(init.body as Uint8Array),
    });
    const scripted = queue.shift() ?? { body: '^XA^XZ' };
    return new Response(scripted.body ?? '', {
      status: scripted.status ?? 200,
      headers: { 'content-type': 'text/plain', ...scripted.headers },
    });
  }) as typeof fetch;

  const client = createClient(options.env ?? { LABELZOOM_API_KEY: 'lz_test_key' }, {
    fetch: fetchStub,
    useJitter: false,
    sleep: async () => {},
    maxRetries: options.maxRetries ?? 0,
  });

  const tools: Record<string, { config: { inputSchema: Record<string, z.ZodType> }; handler: Handler }> = {};
  const server = {
    registerTool: (name: string, config: never, handler: Handler) => {
      tools[name] = { config, handler };
    },
  } as unknown as McpServer;
  registerTools(server, client);

  const call = (name: string, args: Record<string, unknown> = {}) => tools[name].handler(args);
  return { requests, call, tools };
}

const params = (request: Recorded) => JSON.parse(request.url.searchParams.get('params') ?? 'null');
const textOf = (result: Awaited<ReturnType<Handler>>) => result.content.map((c) => c.text ?? '').join('\n');
const JOB = { body: '{"jobId":"job-1","status":"dispatched"}', headers: { 'content-type': 'application/json' } };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// --- Client -------------------------------------------------------------------------------------

test('identifies as the SDK first, then this server, and never as LabelZoom Studio', async () => {
  const { requests, call } = setup();
  await call('convert_label', { source_format: 'zpl', target_format: 'zpl', content: '^XA^XZ' });

  const userAgent = requests[0].headers['user-agent'];
  assert.match(userAgent, /^labelzoom-node-sdk\//);
  assert.ok(userAgent.endsWith(` labelzoom-mcp/${VERSION}`), userAgent);
});

test('reads the key from LABELZOOM_API_KEY, falls back to LABELZOOM_TOKEN, and goes anonymous without either', async () => {
  const withKey = setup({ env: { LABELZOOM_API_KEY: 'lz_live_a' } });
  const withToken = setup({ env: { LABELZOOM_TOKEN: 'legacy.jwt' } });
  const anonymous = setup({ env: {} });
  for (const { call } of [withKey, withToken, anonymous]) {
    await call('convert_label', { source_format: 'zpl', target_format: 'zpl', content: '^XA^XZ' });
  }

  assert.equal(withKey.requests[0].headers.authorization, 'Bearer lz_live_a');
  assert.equal(withToken.requests[0].headers.authorization, 'Bearer legacy.jwt');
  assert.equal(anonymous.requests[0].headers.authorization, undefined);
});

test('calls the production API by default, and LABELZOOM_API_BASE_URL overrides it', async () => {
  const production = setup();
  const staging = setup({ env: { LABELZOOM_API_BASE_URL: 'https://staging.example.com/' } });
  for (const { call } of [production, staging]) {
    await call('convert_label', { source_format: 'zpl', target_format: 'zpl', content: '^XA^XZ' });
  }

  assert.equal(production.requests[0].url.origin, 'https://api.labelzoom.com');
  assert.equal(staging.requests[0].url.origin, 'https://staging.example.com');
});

// --- convert_label ------------------------------------------------------------------------------

test('converts with Accept */* and only the options that were set', async () => {
  const { requests, call } = setup({ responses: [{ body: '%PDF-1.4', headers: { 'content-type': 'application/pdf' } }] });
  await call('convert_label', {
    source_format: 'zpl',
    target_format: 'pdf',
    content: '^XA^FO50,50^FDHi^FS^XZ',
    labelWidth: 4,
    labelHeight: 6,
  });

  const request = requests[0];
  assert.equal(request.url.pathname, '/api/v2/convert/zpl/to/pdf');
  // Rule B2: an exact media type gets a 406 for gif, bmp and jpeg.
  assert.equal(request.headers.accept, '*/*');
  assert.equal(request.headers['content-type'], 'text/plain');
  assert.equal(request.body.toString(), '^XA^FO50,50^FDHi^FS^XZ');
  assert.deepEqual(params(request), { label: { width: 4, height: 6 } });
});

test('sends no params at all when no option is set', async () => {
  const { requests, call } = setup();
  await call('convert_label', { source_format: 'zpl', target_format: 'zpl', content: '^XA^XZ' });
  assert.equal(requests[0].url.search, '');
});

test('sends source and target resolution, split, layout and collapse in the 2.0 shape', async () => {
  const { requests, call } = setup();
  await call('convert_label', {
    source_format: 'pdf',
    target_format: 'zpl',
    content: 'JVBERi0xLjQK',
    targetDpi: 300,
    labelIndex: 0,
    pdfPageNumber: 1,
    pdfConversionMode: 'IMAGE',
    split: { rows: 10, columns: 3 },
    layout: { across: 2, gap: 0.125 },
    zplCollapseCopies: true,
    zplImageCompression: 'Z64',
  });

  assert.deepEqual(params(requests[0]), {
    targetDpi: 300,
    labelIndex: 0,
    pdf: { pageNumber: 1, conversionMode: 'IMAGE' },
    split: { rows: 10, columns: 3 },
    layout: { across: 2, gap: 0.125 },
    zpl: { collapseCopies: true, imageCompression: 'Z64' },
  });
});

test('sends inline content for a binary source as base64 text, and a file as its own bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lz-mcp-'));
  const btwBytes = Buffer.from([0x00, 0xff, 0x42, 0x54, 0xc3, 0x28]);
  await writeFile(join(dir, 'label.btw'), btwBytes);
  const { requests, call } = setup({ responses: [{}, {}] });

  await call('convert_label', { source_format: 'pdf', target_format: 'zpl', content: 'JVBERi0xLjQK' });
  await call('convert_label', { source_format: 'btw', target_format: 'zpl', input_path: join(dir, 'label.btw') });

  // Rule B1: text/plain is what tells the server the body is base64.
  assert.equal(requests[0].headers['content-type'], 'text/plain');
  assert.equal(requests[0].body.toString(), 'JVBERi0xLjQK');
  assert.equal(requests[1].url.pathname, '/api/v2/convert/btw/to/zpl');
  assert.equal(requests[1].headers['content-type'], 'application/octet-stream');
  assert.ok(requests[1].body.equals(btwBytes));
});

test('sends jpg as jpeg in the path', async () => {
  const { requests, call } = setup();
  await call('convert_label', { source_format: 'jpg', target_format: 'zpl', content: '/9j/4AAQ' });
  assert.equal(requests[0].url.pathname, '/api/v2/convert/jpeg/to/zpl');
});

test('shows printer code inline only when no byte would be lost', async () => {
  const plainEpl = 'N\nA50,50,0,4,1,1,N,"Hi"\nP1\n';
  const graphicEpl = Buffer.concat([Buffer.from('N\nGW10,10,1,1,'), Buffer.from([0x00, 0xff]), Buffer.from('\nP1\n')]);
  const { call } = setup({ responses: [{ body: plainEpl }, { body: graphicEpl }, { body: '! 0 200 200 210 1\r\nEG 1 1 0 0 FF\r\nPRINT\r\n' }] });

  const plain = await call('convert_label', { source_format: 'zpl', target_format: 'epl', content: '^XA^XZ' });
  const graphic = await call('convert_label', { source_format: 'zpl', target_format: 'epl', content: '^XA^XZ' });
  const cpcl = await call('convert_label', { source_format: 'zpl', target_format: 'cpcl', content: '^XA^XZ' });

  assert.equal(plain.content[0].text, plainEpl);
  assert.match(graphic.content[0].text ?? '', /base64-encoded because it holds raw bytes/);
  assert.ok((graphic.content[0].text ?? '').endsWith(graphicEpl.toString('base64')));
  assert.match(cpcl.content[0].text ?? '', /^! 0 200 200 210 1/);
});

test('returns PNG output as an image, and notes the watermark when anonymous', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const { call } = setup({ env: {}, responses: [{ body: png, headers: { 'content-type': 'image/png' } }] });
  const result = await call('render_label_preview', { source_format: 'fingerprint', content: 'PP 10,10\nPT "Hi"\nPF\n' });

  assert.deepEqual(result.content[0], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.match(textOf(result), /watermark/);
});

test('writes output to output_path instead of returning it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lz-mcp-'));
  const { call } = setup({ responses: [{ body: '%PDF-1.4' }] });
  const result = await call('convert_label', {
    source_format: 'zpl',
    target_format: 'pdf',
    content: '^XA^XZ',
    output_path: join(dir, 'out.pdf'),
  });
  assert.match(textOf(result), /Wrote 0\.0 KB of PDF/);
});

test('reports an API error with its status, code and request ID', async () => {
  const { call } = setup({
    responses: [{
      status: 422,
      body: '{"status":422,"message":"This Idempotency-Key was already used for a different request.","code":"idempotency_key_reused"}',
      headers: { 'content-type': 'application/problem+json', 'x-lz-request-id': 'req-123' },
    }],
  });
  const result = await call('print_label', { printer_id: 'p1', source_format: 'zpl', content: '^XA^XZ', idempotency_key: 'SO-1' });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /HTTP 422 \(idempotency_key_reused\): This Idempotency-Key was already used/);
  assert.match(textOf(result), /Request ID: req-123/);
});

test('reports a local validation error without sending anything', async () => {
  const { requests, call } = setup();
  const result = await call('convert_label', { source_format: 'zpl', target_format: 'png', content: '^XA^XZ', rotation: 45 });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Invalid rotation:/);
  assert.equal(requests.length, 0);
});

test('offers every 2.0 format, and no source-only format as a target', () => {
  const { tools } = setup();
  const schema = z.object(tools.convert_label.config.inputSchema);
  const parse = (source: string, target: string) =>
    schema.safeParse({ source_format: source, target_format: target, content: 'x' }).success;

  for (const source of ['esclabel', 'fingerprint', 'ezpl', 'cpcl', 'tpcl', 'nlbl', 'lbl', 'btw', 'dymo', 'url']) {
    assert.ok(parse(source, 'zpl'), source);
  }
  assert.ok(parse('zpl', 'cpcl'));
  assert.ok(!parse('zpl', 'url'));
  assert.ok(!parse('zpl', 'jpg'));
  assert.ok(!parse('zpl', 'btw'));
});

test('lists the formats, marking the sources that take sourceDpi', async () => {
  const { call } = setup();
  const listing = textOf(await call('list_conversion_formats'));
  assert.match(listing, /btw\s+BarTender design file/);
  assert.match(listing, /cpcl\s+CPCL \(Zebra mobile printers\) \[sourceDpi\]/);
  assert.doesNotMatch(listing, /pdf\s+PDF \[sourceDpi\]/);
});

// --- Printing -----------------------------------------------------------------------------------

test('prints with the source wire token, Accept application/json and a generated idempotency key', async () => {
  const { requests, call } = setup({ responses: [JOB] });
  const result = await call('print_label', {
    printer_id: 'printer 1',
    source_format: 'jpg',
    content: '/9j/4AAQ',
    copies: 2,
    rotation: 90,
  });

  const request = requests[0];
  assert.equal(request.url.pathname, '/api/v3/printers/printer%201/print');
  assert.equal(request.url.searchParams.get('sourceFormat'), 'jpeg');
  assert.equal(request.url.searchParams.get('copies'), '2');
  assert.deepEqual(params(request), { rotation: 90 });
  assert.equal(request.headers.accept, 'application/json');
  assert.match(request.headers['idempotency-key'], UUID_V4);
  assert.deepEqual(JSON.parse(textOf(result)), { jobId: 'job-1', status: 'dispatched', copies: null, idempotent: false });
});

test('decodes inline base64 before printing, because print reads the file itself', async () => {
  const { requests, call } = setup({ responses: [JOB] });
  await call('print_label', { printer_id: 'p1', source_format: 'pdf', content: 'JVBERi0x\nLjQK' });

  assert.equal(requests[0].headers['content-type'], 'application/pdf');
  assert.equal(requests[0].body.toString(), '%PDF-1.4\n');
});

test('refuses inline content that is not base64 for a binary print, without sending anything', async () => {
  const { requests, call } = setup();
  const result = await call('print_label', { printer_id: 'p1', source_format: 'pdf', content: '%PDF-1.4 not base64!' });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /must be base64/);
  assert.equal(requests.length, 0);
});

test('sends the caller\'s idempotency key as given, the same on a retry', async () => {
  const { requests, call } = setup({
    maxRetries: 1,
    responses: [{ status: 503, body: 'Service Unavailable' }, JOB],
  });
  await call('print_label', { printer_id: 'p1', source_format: 'zpl', content: '^XA^XZ', idempotency_key: 'SO-1001' });

  assert.deepEqual(requests.map((r) => r.headers['idempotency-key']), ['SO-1001', 'SO-1001']);
});

test('never retries the daily print limit, and says when it resets', async () => {
  const { requests, call } = setup({
    maxRetries: 2,
    responses: [{
      status: 429,
      body: '{"message":"Daily print job limit of 1000 reached.","code":"daily_job_limit_reached"}',
      headers: { 'content-type': 'application/json', 'retry-after': '14400' },
    }],
  });
  const result = await call('print_label', { printer_id: 'p1', source_format: 'zpl', content: '^XA^XZ' });

  assert.equal(requests.length, 1);
  assert.match(textOf(result), /daily_job_limit_reached/);
  assert.match(textOf(result), /resets at midnight UTC/);
});

test('needs an API key to print, and says so without sending anything', async () => {
  const { requests, call } = setup({ env: {} });
  const result = await call('print_label', { printer_id: 'p1', source_format: 'zpl', content: '^XA^XZ' });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /LABELZOOM_API_KEY/);
  assert.equal(requests.length, 0);
});

test('prints a template batch as one array with one key', async () => {
  const { requests, call } = setup({
    responses: [{
      body: '{"jobs":[{"jobId":"j1","status":"queued"}],"remaining":1,"message":"Resubmit the remaining 1."}',
      headers: { 'content-type': 'application/json' },
    }],
  });
  const result = await call('print_template', {
    printer_id: 'p1',
    template_id: 't1',
    data: [{ sku: 'A-100' }, { sku: 'B-200' }],
    validate: true,
    idempotency_key: 'BATCH-1',
  });

  const request = requests[0];
  assert.equal(request.url.pathname, '/api/v3/printers/p1/templates/t1/print');
  assert.equal(request.url.searchParams.get('validate'), 'true');
  assert.deepEqual(JSON.parse(request.body.toString()), [{ sku: 'A-100' }, { sku: 'B-200' }]);
  assert.equal(request.headers['idempotency-key'], 'BATCH-1');
  assert.deepEqual(JSON.parse(textOf(result)), {
    jobs: [{ jobId: 'j1', status: 'queued', copies: null, idempotent: false }],
    remaining: 1,
    message: 'Resubmit the remaining 1.',
  });
});

test('gets a job and the print quota', async () => {
  const { requests, call } = setup({
    responses: [
      {
        body: '{"id":"j1","printer_id":"p1","status":"completed","copies":null,"retry_count":0,"created_date":"2026-11-24T00:00:00.000Z"}',
        headers: { 'content-type': 'application/json' },
      },
      {
        body: '{"plan":"beta","jobsToday":{"used":1,"limit":1000,"remaining":999,"resetAt":"2026-11-25T00:00:00.000Z"}}',
        headers: { 'content-type': 'application/json' },
      },
    ],
  });
  const job = JSON.parse(textOf(await call('get_print_job', { job_id: 'j1' })));
  const quota = JSON.parse(textOf(await call('get_print_quota')));

  assert.deepEqual(requests.map((r) => `${r.method} ${r.url.pathname}`), ['GET /api/v3/jobs/j1', 'GET /api/v3/print/quota']);
  assert.equal(job.printerId, 'p1');
  assert.equal(job.status, 'completed');
  assert.equal(quota.jobsToday.remaining, 999);
});
