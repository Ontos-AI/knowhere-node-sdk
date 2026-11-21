---
'@ontos-ai/knowhere-sdk': major
---

Remove `jobs.retryEnhancement`. New ingestion jobs complete once their initial result is searchable. Progressive PDF and PPTX jobs expose one frozen baseline snapshot. Historical baseline and final snapshots remain readable by ID.

Use `replacesDocumentId` to submit a private replacement job with a new document ID. Read integer directory versions through `documents.getStructure` and explicitly select `job.enrichment.failed` in `webhook.events` to receive per-attempt failure notifications.
