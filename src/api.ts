/**
 * Thin client over the LabelZoom conversion API.
 *
 * Endpoint: POST {base}/api/v2/convert/{sourceFormat}/to/{targetFormat}?params={json}
 * The Content-Type must agree with sourceFormat, and Accept must admit the
 * media type implied by targetFormat, or the server rejects the request before
 * any conversion happens.
 */

export const SOURCE_FORMATS = ['zpl', 'xml', 'json', 'pdf', 'png', 'bmp', 'gif', 'jpeg', 'jpg'] as const;
export const TARGET_FORMATS = ['zpl', 'xml', 'json', 'pdf', 'png', 'bmp', 'gif', 'jpeg'] as const;

export type SourceFormat = (typeof SOURCE_FORMATS)[number];
export type TargetFormat = (typeof TARGET_FORMATS)[number];

const MEDIA_TYPES: Record<string, string> = {
  xml: 'application/xml',
  json: 'application/json',
  zpl: 'text/plain',
  png: 'image/png',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** Formats whose payload is human-readable text rather than opaque bytes. */
const TEXT_FORMATS = new Set(['zpl', 'xml', 'json']);

export const isTextFormat = (format: string): boolean => TEXT_FORMATS.has(format.toLowerCase());

export const mediaTypeFor = (format: string): string =>
  MEDIA_TYPES[format.toLowerCase()] ?? 'application/octet-stream';

export interface ConversionParams {
  dpi?: number;
  rotation?: number;
  scaling?: number;
  darkness?: number;
  colorMode?: 'BW' | 'GRAYSCALE' | 'COLOR';
  watermark?: boolean;
  dialect?: string;
  data?: unknown;
  label?: { width?: number; height?: number };
  pdf?: { conversionMode?: 'IMAGE' | 'NATIVE'; pageNumber?: number };
  zpl?: { commandsToIgnore?: string[]; imageCompression?: 'Z64' | 'COMPRESSED_HEX' };
}

export interface ConversionResult {
  bytes: Uint8Array;
  contentType: string;
}

export class LabelZoomError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`LabelZoom API returned ${status}: ${detail}`);
    this.name = 'LabelZoomError';
  }
}

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class LabelZoomClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.labelzoom.net').replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get isAuthenticated(): boolean {
    return Boolean(this.token);
  }

  async convert(
    sourceFormat: SourceFormat,
    targetFormat: TargetFormat,
    body: Uint8Array,
    params: ConversionParams = {},
  ): Promise<ConversionResult> {
    if (body.byteLength === 0) {
      throw new Error('Refusing to send an empty body; the API rejects zero-length requests.');
    }

    const url = new URL(`${this.baseUrl}/api/v2/convert/${sourceFormat}/to/${targetFormat}`);
    if (Object.keys(params).length > 0) {
      url.searchParams.set('params', JSON.stringify(params));
    }

    const headers: Record<string, string> = {
      'Content-Type': mediaTypeFor(sourceFormat),
      Accept: mediaTypeFor(targetFormat),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      // Copy into a fresh ArrayBuffer so a pooled Buffer's offset can't leak extra bytes.
      body: body.slice().buffer as ArrayBuffer,
    });

    if (!response.ok) {
      throw new LabelZoomError(response.status, (await response.text()).trim() || response.statusText);
    }

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? mediaTypeFor(targetFormat),
    };
  }
}
