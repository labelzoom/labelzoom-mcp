import { createRequire } from 'node:module';
import { LabelZoomClient, type LabelZoomClientOptions } from '@labelzoom/sdk';

/** This package's version, read from package.json so the User-Agent never drifts from it. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/**
 * Build the LabelZoom client from the server's environment.
 *
 * - `LABELZOOM_API_KEY`: an API key or license token. Without one, conversions run on the free
 *   tier (watermarked, first label only) and printing is unavailable. `LABELZOOM_TOKEN`, the name
 *   used before 0.2.0, is still read when `LABELZOOM_API_KEY` is unset.
 * - `LABELZOOM_API_BASE_URL`: another environment. Defaults to the production API.
 *
 * The SDK identifies itself first in the User-Agent and this server appends its own token, so
 * LabelZoom can tell MCP traffic apart.
 */
export function createClient(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<LabelZoomClientOptions> = {},
): LabelZoomClient {
  return new LabelZoomClient({
    // An empty string is passed through on purpose: the SDK reads it as "anonymous" rather than
    // falling back to the environment.
    apiKey: env.LABELZOOM_API_KEY ?? env.LABELZOOM_TOKEN ?? '',
    baseUrl: env.LABELZOOM_API_BASE_URL?.trim() || undefined,
    userAgentSuffix: `labelzoom-mcp/${VERSION}`,
    ...overrides,
  });
}
