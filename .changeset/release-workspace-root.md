---
"@ontos-ai/knowhere-sdk": patch
---

Include the repository root in the pnpm workspace (`pnpm-workspace.yaml`) so
Changesets can resolve the root `@ontos-ai/knowhere-sdk` package during the
release flow. Previously `changeset version` failed with "Found changeset for
package @ontos-ai/knowhere-sdk which is not in the workspace", blocking the
release PR and publish.
