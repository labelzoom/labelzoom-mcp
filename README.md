# LabelZoom MCP server

An [MCP](https://modelcontextprotocol.io) server for [LabelZoom](https://www.labelzoom.com). It lets
Claude and other MCP clients convert barcode labels between formats, render a label to an image and
look at it, and print labels with LabelZoom Cloud Print. It's published to npm as `@labelzoom/mcp`.

Rendering is the part that changes how label work goes: the assistant can check that ZPL produces the
label you meant, instead of reasoning about the code blind.

## Install

You need Node.js 20 or later.

Add the server to Claude Code:

```sh
claude mcp add labelzoom -- npx -y @labelzoom/mcp
```

To convert without a watermark, or to print, give it a LabelZoom API key:

```sh
claude mcp add labelzoom --env LABELZOOM_API_KEY=YOUR_API_KEY -- npx -y @labelzoom/mcp
```

For Claude Desktop and other clients, add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "labelzoom": {
      "command": "npx",
      "args": ["-y", "@labelzoom/mcp"],
      "env": { "LABELZOOM_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LABELZOOM_API_KEY` | None | An API key from the **API Access** section of your [LabelZoom dashboard](https://www.labelzoom.com/dashboard). Printing needs a key with the `print` scope. |
| `LABELZOOM_API_BASE_URL` | `https://api.labelzoom.com` | The API to call. Change it only if you were given a dedicated endpoint. |

Without a key, conversions run on the free tier: output is watermarked, only the first label of each
request converts (set `labelIndex` to convert any other one), and some conversions, such as JSON
output and image to image, need a paid plan. See
[rate limits and plans](https://docs.labelzoom.com/reference/rate-limits-and-plans/).

`LABELZOOM_TOKEN`, the variable name before version 0.2.0, still works when `LABELZOOM_API_KEY` isn't
set.

## Tools

| Tool | What it does |
| --- | --- |
| `render_label_preview` | Renders a label to a PNG and returns it as an image, so the assistant can see it |
| `convert_label` | Converts a label between any source and target format |
| `list_conversion_formats` | Lists the formats, which sources take `sourceDpi`, and whether a key is set |
| `print_label` | Sends a document to a Cloud Print printer, converting it to the printer's language on the way |
| `print_template` | Fills a published Print Template with data and prints it, one label per record |
| `get_print_job` | Looks up a print job to see whether it printed |
| `get_print_quota` | Shows your plan's printer and daily job limits, and when the daily count resets |

### Documents

The tools that take a document read it from `content` or from a file at `input_path`:

- **Text formats:** pass label code in `content` as is. This covers the printer languages, LabelZoom XML
  and JSON, and DYMO files.
- **Binary formats:** pass a PDF, an image, or a NiceLabel or BarTender file in `content` as base64, or
  point `input_path` at the file.
- **The `url` source:** put the URL in `content`, and LabelZoom fetches the document. You can convert a
  URL, but you can't print one.

`convert_label` returns text output inline. It writes binary output to `output_path` when you give one,
and returns it as base64 otherwise. EPL, IPL, TSPL, DPL and SBPL output can contain raw bytes, such as an
inline bitmap. That output comes back inline only when it has none, and as base64 when it does.

### Formats

| Kind | Sources | Targets |
| --- | --- | --- |
| Printer languages | `zpl` `epl` `ipl` `tspl` `dpl` `sbpl` `cpcl` `esclabel` `fingerprint` `ezpl` `tpcl` | `zpl` `epl` `ipl` `tspl` `dpl` `sbpl` `cpcl` |
| Label design files | `nlbl` `lbl` (NiceLabel), `btw` (BarTender), `dymo` (DYMO) | None |
| Documents and images | `pdf` `png` `bmp` `gif` `jpeg` `jpg` | `pdf` `png` `bmp` `gif` `jpeg` |
| LabelZoom | `xml` `json` | `xml` `json` |
| Other | `url` | None |

### Options

Options use the API's own names.

| Option | Applies to | What it does |
| --- | --- | --- |
| `sourceDpi` | Printer-language and image sources | The resolution the document was made for. The output follows it unless `targetDpi` is set |
| `targetDpi` | Every target except PDF | The resolution of the output. Match the printer |
| `labelWidth`, `labelHeight` | Every source | The label size in inches. Leave them unset to use the size the label code declares |
| `labelIndex` | Multi-label documents | Converts only this label, counting from 0 |
| `data` | Labels with variable fields | Values for the fields. An array produces one label per entry |
| `rotation` | Every conversion and print | Rotates the output by a multiple of 90 degrees |
| `pdfPageNumber`, `pdfConversionMode` | PDF sources | The page, counting from 0, and `IMAGE` or `NATIVE` conversion |
| `split` | PDF and image sources | Cuts each page into a grid of labels. Lengths are in inches |
| `scaling`, `darkness`, `colorMode` | PDF and image sources | How the page is scaled and reduced to black and white |
| `zplCommandsToIgnore` | ZPL and ESC/Label sources | Commands to skip, such as `["^PQ"]` |
| `zplImageCompression`, `zplCollapseCopies` | ZPL targets | Image encoding, and collapsing identical labels into a `^PQ` count |
| `layout` | Printer-language targets from a PDF or image | Labels side by side on a multi-across roll |
| `watermark`, `dialect` | Every target | Forces a watermark, or picks an output dialect on a paid plan |

A print takes the document options and `rotation`. The printer decides the output format.

### Printing

Printing needs a printer connected through [LabelZoom Cloud Print](https://www.labelzoom.com/cloud-print)
and an API key with the `print` scope. Copy the printer's ID from the dashboard.

- **Accepted is not printed.** A job starts out `dispatched` or `queued`. Only `completed` means the label
  came out of the printer, so use `get_print_job` to follow it.
- **Retries are safe.** Every print carries an idempotency key. Pass `idempotency_key`, such as an order
  number, and repeating the print returns the original job instead of printing again. Without one,
  the server generates a key for each call and reuses it if that call is retried.
- **Copies multiply.** `copies` sends the job 1 to 9999 times. A quantity in the label itself, such as
  `^PQ3`, multiplies with it.
- **The daily job limit isn't retried.** It resets at midnight UTC, and `get_print_quota` shows when.

## Try it

> Render this ZPL and tell me if the barcode fits on a 4x6 label.
>
> ```
> ^XA
> ^FO50,50^A0N,60,60^FDHello LabelZoom^FS
> ^FO50,150^BY3^BCN,100,Y,N,N^FD12345678^FS
> ^XZ
> ```

## Contributing

The server is built on the [LabelZoom Node.js SDK](https://www.npmjs.com/package/@labelzoom/sdk), which
handles the API's wire rules and runs the shared LabelZoom conformance suite. The tests here check that
each tool drives the SDK correctly. They run offline.

```sh
npm install
npm test           # builds, then runs the tool tests
npm run typecheck
```

`src/tools.ts` registers the tools, `src/client.ts` builds the SDK client from the environment,
`src/formats.ts` decides how documents travel in a tool call, and `src/index.ts` is the stdio entry point.

To release, publish a GitHub Release tagged `vX.Y.Z` that matches `package.json`. The publish workflow
tests the build and publishes it to npm with provenance.

## License

MIT
