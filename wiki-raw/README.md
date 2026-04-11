# Raw Sources

Immutable source documents for the NemoClaw wiki. The LLM reads from this
directory but never modifies files after they are deposited.

## Subdirectories

| Directory | Contents |
|---|---|
| `documents/` | Articles, papers, notes |
| `web/` | Fetched web content |
| `conversations/` | Saved transcripts and session notes |
| `observations/` | Cross-project learnings |
| `artifacts/` | Code snapshots, configs, system state |

## Usage

Drop a source file into the appropriate subdirectory, then ask the LLM to
ingest it:

> "Ingest the document I just added to wiki-raw/documents/new-research.md"
