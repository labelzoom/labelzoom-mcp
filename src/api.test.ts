import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LabelZoomClient, LabelZoomError, isTextFormat, mediaTypeFor } from './api.js';

interface Captured {
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A fetch stand-in that records the request and returns a canned response. */
function spyFetch(response?: Partial<{ status: number; body: string; contentType: string }>) {
  const calls: Captured[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: new Uint8Array(init?.body as ArrayBuffer),
    });
    const status = response?.status ?? 200;
    return new Response(response?.body ?? 'ok', {
      status,
      headers: { 'content-type': response?.contentType ?? 'text/plain' },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const bodyOf = (s: string) => new TextEncoder().encode(s);

test('mediaTypeFor maps each format to the content type the API demands', () => {
  assert.equal(mediaTypeFor('zpl'), 'text/plain');
  assert.equal(mediaTypeFor('xml'), 'application/xml');
  assert.equal(mediaTypeFor('json'), 'application/json');
  assert.equal(mediaTypeFor('pdf'), 'application/pdf');
  assert.equal(mediaTypeFor('png'), 'image/png');
  assert.equal(mediaTypeFor('bmp'), 'image/bmp');
  // jpg and jpeg are distinct URL segments but share one media type.
  assert.equal(mediaTypeFor('jpg'), 'image/jpeg');
  assert.equal(mediaTypeFor('jpeg'), 'image/jpeg');
  assert.equal(mediaTypeFor('JPG'), 'image/jpeg', 'should be case-insensitive');
});

test('isTextFormat distinguishes inline-text formats from binary ones', () => {
  assert.ok(isTextFormat('zpl') && isTextFormat('xml') && isTextFormat('json'));
  assert.ok(!isTextFormat('png') && !isTextFormat('pdf') && !isTextFormat('gif'));
});

test('convert builds the documented URL and content negotiation headers', async () => {
  const { calls, impl } = spyFetch();
  const client = new LabelZoomClient({ baseUrl: 'https://api.example.com', fetchImpl: impl });

  await client.convert('zpl', 'png', bodyOf('^XA^XZ'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/v2/convert/zpl/to/png');
  assert.equal(calls[0].headers['Content-Type'], 'text/plain');
  assert.equal(calls[0].headers['Accept'], 'image/png');
  assert.equal(new TextDecoder().decode(calls[0].body), '^XA^XZ');
});

test('convert serializes params as a JSON query string, and omits it when empty', async () => {
  const { calls, impl } = spyFetch();
  const client = new LabelZoomClient({ fetchImpl: impl });

  await client.convert('zpl', 'pdf', bodyOf('^XA^XZ'), { dpi: 300, label: { width: 4 } });
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('params')!), { dpi: 300, label: { width: 4 } });

  await client.convert('zpl', 'pdf', bodyOf('^XA^XZ'));
  assert.equal(calls[1].url.searchParams.has('params'), false);
});

test('a token becomes a bearer header; absence of one sends no Authorization', async () => {
  const withToken = spyFetch();
  const authed = new LabelZoomClient({ token: 'abc123', fetchImpl: withToken.impl });
  assert.equal(authed.isAuthenticated, true);
  await authed.convert('zpl', 'xml', bodyOf('^XA^XZ'));
  assert.equal(withToken.calls[0].headers['Authorization'], 'Bearer abc123');

  const without = spyFetch();
  const anon = new LabelZoomClient({ fetchImpl: without.impl });
  assert.equal(anon.isAuthenticated, false);
  await anon.convert('zpl', 'xml', bodyOf('^XA^XZ'));
  assert.equal(without.calls[0].headers['Authorization'], undefined);
});

test('a trailing slash on baseUrl does not produce a doubled path separator', async () => {
  const { calls, impl } = spyFetch();
  const client = new LabelZoomClient({ baseUrl: 'https://api.example.com///', fetchImpl: impl });
  await client.convert('zpl', 'xml', bodyOf('^XA^XZ'));
  assert.equal(calls[0].url.pathname, '/api/v2/convert/zpl/to/xml');
});

test('an empty body is rejected before a request is sent', async () => {
  const { calls, impl } = spyFetch();
  const client = new LabelZoomClient({ fetchImpl: impl });
  await assert.rejects(() => client.convert('zpl', 'xml', new Uint8Array(0)), /empty body/i);
  assert.equal(calls.length, 0, 'must not hit the network');
});

test('a byte-offset view sends only its own bytes, not the whole backing buffer', async () => {
  const { calls, impl } = spyFetch();
  const client = new LabelZoomClient({ fetchImpl: impl });

  // Buffer.from(string) commonly returns a view into a shared pool.
  const pooled = Buffer.from('PADDING^XA^XZ');
  const view = new Uint8Array(pooled.buffer, pooled.byteOffset + 7, 6);

  await client.convert('zpl', 'xml', view);
  assert.equal(new TextDecoder().decode(calls[0].body), '^XA^XZ');
});

test('a non-2xx response raises LabelZoomError carrying status and detail', async () => {
  const { impl } = spyFetch({ status: 400, body: 'Invalid ZPL. ZPL must contain ^XA' });
  const client = new LabelZoomClient({ fetchImpl: impl });

  await assert.rejects(
    () => client.convert('zpl', 'xml', bodyOf('nope')),
    (err: unknown) => {
      assert.ok(err instanceof LabelZoomError);
      assert.equal(err.status, 400);
      assert.match(err.detail, /Invalid ZPL/);
      return true;
    },
  );
});

test('convert returns the response bytes and its content type', async () => {
  const { impl } = spyFetch({ body: '<labelZoomXml/>', contentType: 'application/xml' });
  const client = new LabelZoomClient({ fetchImpl: impl });

  const result = await client.convert('zpl', 'xml', bodyOf('^XA^XZ'));
  assert.equal(new TextDecoder().decode(result.bytes), '<labelZoomXml/>');
  assert.equal(result.contentType, 'application/xml');
});
