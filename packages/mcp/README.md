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

The server uses stdio transport and stores expanded Knowhere result files under
the SDK local knowledge cache by default. `knowhere-mcp login` opens the
Knowhere dashboard in your browser and stores a local MCP login at
`~/.knowhere-node-sdk/mcp/auth.json`.

During login, the dashboard asks for a Permission:

- Read only: query Knowhere and read existing parsed documents. Parse and
  delete tools are not exposed to the MCP host.
- Full access: query, read, parse URLs/files, cache completed parse jobs, and
  archive documents.

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
`knowhere_grep_chunks`, `knowhere_async_get_job_status`, and
`knowhere_async_cache_job_result`.

- `knowhere_parse_url`: blocking parse for a remote URL; waits for completion
  and caches the result locally.
- `knowhere_parse_file`: blocking parse for a file path available to the MCP
  process; waits for completion and caches the result locally.
- `knowhere_async_parse_url`: start parsing a remote URL and return the job
  immediately.
- `knowhere_async_parse_file`: start parsing a local file path, upload it if
  needed, and return the job immediately.
- `knowhere_async_get_job_status`: check a parse job status; completed jobs
  started by async parse tools are cached locally automatically.
- `knowhere_async_cache_job_result`: manually cache a completed parse job result
  locally, mainly for recovery or jobs started outside the async parse tools.
- `knowhere_list_documents`: list locally cached parse results.
- `knowhere_delete_document`: archive, or soft-delete, a published Knowhere
  document through the Knowhere API.
- `knowhere_get_document_outline`: inspect a cached document outline.
- `knowhere_read_chunks`: read exact chunks from a cached result.
- `knowhere_grep_chunks`: run local literal or regex grep over cached chunks.
- `knowhere_search`: search published documents through the Knowhere API
  retrieval query.

## Package Boundary

Use `@ontos-ai/knowhere-sdk` directly when building an app. Install this MCP
package when an agent host needs a local MCP server.
