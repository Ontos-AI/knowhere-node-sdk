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
KNOWHERE_API_KEY=sk_... npx knowhere-mcp
```

The server uses stdio transport and stores parsed result ZIPs under the SDK local
knowledge cache by default.

## Tools

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
- `knowhere_get_document_outline`: inspect a cached document outline.
- `knowhere_read_chunks`: read exact chunks from a cached result.
- `knowhere_grep_chunks`: run local literal or regex grep over cached chunks.
- `knowhere_search`: search cached chunks locally, or delegate to remote
  Knowhere retrieval with `useRemote: true`.

## Package Boundary

Use `@ontos-ai/knowhere-sdk` directly when building an app. Install this MCP
package when an agent host needs a local MCP server.
