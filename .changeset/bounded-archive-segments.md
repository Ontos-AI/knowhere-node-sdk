---
'@ontos-ai/knowhere-sdk': patch
---

Interrupt active archive transfers at the segment deadline, persist the contiguous completed prefix, and return a resumable pending result. Caller cancellation and checkpoint failures remain errors.

Validate duplicate ZIP resource names before starting uploads. Reuse byte-identical resources after SHA-256 verification and reject conflicting resources without partial writes.
