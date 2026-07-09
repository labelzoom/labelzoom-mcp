# labelzoom-mcp

An [MCP](https://modelcontextprotocol.io) server that puts LabelZoom's label conversion engine
inside Claude Code, Claude Desktop, and any other MCP client.

It lets an assistant convert barcode labels between ZPL, PDF, PNG, BMP, GIF, JPEG, LabelZoom XML,
and LabelZoom JSON — and, importantly, **render a label to an image and look at it**, so it can
check that ZPL actually produces the label you meant instead of reasoning about the source blind.

## Install

Add it to Claude Code:

```sh
claude mcp add labelzoom -- npx -y labelzoom-mcp
```

To convert without a watermark, supply a LabelZoom API token:

```sh
claude mcp add labelzoom --env LABELZOOM_TOKEN=your_token -- npx -y labelzoom-mcp
```

<details>
<summary>Claude Desktop / other clients</summary>

```json
{
  "mcpServers": {
    "labelzoom": {
      "command": "npx",
      "args": ["-y", "labelzoom-mcp"],
      "env": { "LABELZOOM_TOKEN": "your_token" }
    }
  }
}
```
</details>

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LABELZOOM_TOKEN` | _(none)_ | License JWT. Without it, conversions still work but output is watermarked, and some paths are unavailable. |
| `LABELZOOM_API_BASE_URL` | `https://api.labelzoom.net` | Point at a different environment. |

A token is not required to get started. Anonymous conversions are watermarked, and the API gates
JSON export, printer dialects, image-to-image conversion, and multi-page output behind a paid
license.

## Tools

**`render_label_preview`** — Render `zpl`, `xml`, `json`, or `pdf` to a PNG returned as an image, so
the model can see it. This is the one that makes label work feel interactive.

**`convert_label`** — Convert between any supported source and target format. Text output (`zpl`,
`xml`, `json`) comes back inline; binary output is written to `output_path` when given, and returned
as base64 otherwise.

**`list_conversion_formats`** — Report the supported formats, their media types, and whether a token
is configured.

Both conversion tools accept input either inline via `content` (raw text for text formats, base64
for binary ones) or from disk via `input_path`, and take optional `dpi`, `rotation`, `scaling`,
`darkness`, `colorMode`, `labelWidth`, `labelHeight`, `pdfPageNumber`, and a `data` object whose
keys are merged into the label's dynamic fields.

## Try it

> Render this ZPL and tell me if the barcode fits on a 4x6 label.
>
> ```
> ^XA
> ^FO50,50^A0N,60,60^FDHello LabelZoom^FS
> ^FO50,150^BY3^BCN,100,Y,N,N^FD12345678^FS
> ^XZ
> ```

## Development

Requires Node 20+.

```sh
npm install
npm run build      # compile to dist/
npm test           # unit tests (no network)
npm run typecheck
```

`src/api.ts` is a transport-agnostic client for `POST /api/v2/convert/{source}/to/{target}`;
`src/tools.ts` registers the MCP tools against it; `src/index.ts` is the stdio entrypoint. The tools
are deliberately kept independent of the transport so the same set can later be served over
Streamable HTTP from a Cloudflare Worker alongside the other `labelzoom-cf-*` services.

## License

MIT
