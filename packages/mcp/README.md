# Knowhere MCP

`@ontos-ai/knowhere-mcp` is a thin Model Context Protocol wrapper around
`@ontos-ai/knowhere-sdk`.

The SDK owns the parse, cache, outline, read, grep, and search behavior. This
package only exposes that SDK interface as MCP tools.

## Install

```bash
npm install @ontos-ai/knowhere-mcp
```

## Run

```bash
npx -y @ontos-ai/knowhere-mcp login
npx -y @ontos-ai/knowhere-mcp
```

The server uses stdio transport. Parse tools store expanded Knowhere result
files under the SDK local knowledge cache; published `documentId` reads use the
SDK's remote chunk fallback unless the host explicitly configures a cache
directory for parsed result-layout storage. `knowhere-mcp login` opens the Knowhere
dashboard in your browser and stores a local MCP login at
`~/.knowhere-node-sdk/mcp/auth.json`.

During login, the dashboard asks for a Permission:

- Read only: query Knowhere and read existing parsed documents. Parse and
  delete tools are not exposed to the MCP host.
- Full access: query, read, start async URL/file parse jobs, cache completed
  parse jobs, and archive documents.

Useful auth commands:

```bash
npx -y @ontos-ai/knowhere-mcp login
npx -y @ontos-ai/knowhere-mcp status
npx -y @ontos-ai/knowhere-mcp logout
```

`knowhere-mcp status` shows the stored Permission for the current login.

Set `KNOWHERE_BASE_URL` (or `--base-url`) to the Knowhere site base URL when
using a non-default environment, e.g. `https://staging.knowhereto.ai`; it
defaults to `https://knowhereto.ai`. The API and login routes are derived from
it. `KNOWHERE_API_KEY` is still supported as a manual fallback and takes
precedence over the local dashboard login. API-key authentication runs with
full access.

## Connect From MCP Hosts

The package is a local stdio MCP server. Use `npx -y @ontos-ai/knowhere-mcp`
as the server command in hosts that manage MCP processes for you. Run the login
command once before connecting a host:

```bash
npx -y @ontos-ai/knowhere-mcp login
```

The host config does not need `KNOWHERE_API_KEY` when dashboard login is used.
Do not commit real API keys to shared project config files if you choose the
manual API-key fallback.

### Codex

Codex stores MCP servers in `~/.codex/config.toml` by default. Trusted projects
can also use project-scoped `.codex/config.toml`.

Add the server with the Codex CLI:

```bash
codex mcp add knowhere -- npx -y @ontos-ai/knowhere-mcp
```

Or edit `config.toml` directly:

```toml
[mcp_servers.knowhere]
command = "npx"
args = ["-y", "@ontos-ai/knowhere-mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

For project-scoped config with a non-default API endpoint, forward only the
endpoint variable:

```toml
[mcp_servers.knowhere]
command = "npx"
args = ["-y", "@ontos-ai/knowhere-mcp"]
env_vars = ["KNOWHERE_BASE_URL"]
```

Restart Codex or run `/mcp` in the Codex TUI to inspect connected MCP servers.

### Claude Code

Add the server with the Claude Code CLI:

```bash
claude mcp add \
  --transport stdio \
  knowhere \
  -- npx -y @ontos-ai/knowhere-mcp
```

Use `/mcp` inside Claude Code to verify the server and `claude mcp list` to see
configured servers.

For a project-shared `.mcp.json`, forward environment variables rather than
committing secrets:

```json
{
  "mcpServers": {
    "knowhere": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ontos-ai/knowhere-mcp"]
    }
  }
}
```

### Claude Desktop

Open Claude Desktop settings, go to the developer settings, and edit
`claude_desktop_config.json`.

Config file locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the Knowhere server:

```json
{
  "mcpServers": {
    "knowhere": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ontos-ai/knowhere-mcp"]
    }
  }
}
```

Save the file and fully restart Claude Desktop. If the server does not appear,
check Claude's MCP logs and verify that `node`, `npm`, and `npx` are available
from the desktop app's environment.

### Other Stdio MCP Hosts

Use the same process configuration:

```json
{
  "command": "npx",
  "args": ["-y", "@ontos-ai/knowhere-mcp"]
}
```

Host documentation:

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Claude Code MCP configuration](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Claude Desktop local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

## Tools

When logged in with Read only permission, the MCP server exposes only
`knowhere_search`, `knowhere_list_documents`,
`knowhere_get_document_outline`, `knowhere_read_chunks`,
`knowhere_grep_chunks`, and `knowhere_async_get_job_status`.

- `knowhere_async_parse_url`: start parsing a remote URL and return the job
  immediately. When checking status, use exponential backoff.
- `knowhere_async_parse_file`: start parsing a local file path, upload it if
  needed, and return the job immediately. When checking status, use exponential
  backoff. The path is resolved on the machine running this stdio MCP server.
- `knowhere_async_get_job_status`: check a parse job status. For large PDFs or
  OCR-heavy files, parsing can take 10+ minutes; poll with `5s`, `10s`, `20s`,
  `40s`, `80s`, then cap at `120s` between follow-up status checks. After
  completion, use the returned `localDocumentId`, `documentId`, or `jobId` with
  outline/read/grep tools.
- `knowhere_list_documents`: list published Knowhere documents from the remote
  API, optionally filtered by namespace. Returned `documentId` values can be
  passed to outline/read/grep tools.
- `knowhere_delete_document`: archive, or soft-delete, a published Knowhere
  document through the Knowhere API.
- `knowhere_get_document_outline`: inspect one parsed document outline by
  passing `localDocumentId`, published `documentId`, or completed `jobId`.
- `knowhere_read_chunks`: read exact chunks from one parsed document by passing
  `localDocumentId`, published `documentId`, or completed `jobId`. Use
  `page`/`pageSize` for display reads; asset URLs are returned when the source
  or configured storage provides them. Page screenshots are listed as primary
  `<pageAsset>` entries before chunk preview text.
- `knowhere_grep_chunks`: run literal or regex grep over one parsed document by
  passing `localDocumentId`, published `documentId`, or completed `jobId`.
  Broad workspace search belongs to `knowhere_search`.
- `knowhere_search`: search published documents through the Knowhere API
  retrieval query. Page results and references are marked
  `hasPageAssets="true"` when a follow-up `knowhere_read_chunks` call should be
  used to inspect readable page asset URLs and chunk storage locations.

## Response Contract

All tools return a single MCP text content item:

```json
{
  "content": [{ "type": "text", "text": "<knowhere operation=\"...\">..." }]
}
```

The MCP package does not expose `structuredContent` or tool `outputSchema`
fields. Each response is tagged text rooted at
`<knowhere operation="...">`, using SDK-native camelCase field names such as
`documentId`, `jobId`, `localDocumentId`, `chunkId`, `assetUrl`,
`chunkPath`, `filePath`, and `storageRoot`.

Document tags include `storageRoot` when the SDK response has
`document.resultDirectoryPath`. Local cache roots remain local directory paths.
Remote fallback roots use marker values such as `remote:<documentId>` and
configured parsed-storage roots use `parsed-storage:<documentId>`.

Chunk tags include `chunkPath` from `sourceChunkPath` and a display-only
`storageLocation` when it can be derived. Media and table chunks prefer
`filePath` for that location and include `assetUrl` when available. Text and
page chunks use `chunkPath`, so marker roots render as logical paths such as
`parsed-storage:doc_x/chunks/page-1`.

For page chunks, `<pageAssets primary="true">` appears immediately before
`<previewText>`. Each `<pageAsset>` carries `pageNum`, `artifactRef`,
`assetUrl`, `contentType`, `width`, and `height` when the SDK provides them.
The following `<instruction>` tells callers to open or fetch the listed
`assetUrl` before relying on preview text. If a page asset exists without an
`assetUrl`, the text says that the asset is not directly readable.

Async parse responses return the job identifier and source metadata
immediately. Use `knowhere_async_get_job_status` to poll the job until it
completes, then pass the returned `localDocumentId`, `documentId`, or `jobId`
to outline, read, or grep tools.

## Package Boundary

Use `@ontos-ai/knowhere-sdk` directly when building an app. Install this MCP
package when an agent host needs a local MCP server.
