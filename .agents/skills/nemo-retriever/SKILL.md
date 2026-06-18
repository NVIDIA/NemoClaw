---
name: nemo-retriever
description: "Use when the user wants to search, query, extract, transcribe, describe, quote, filter, or aggregate across documents — PDFs, scanned forms / images (`.jpg` `.png` `.tiff`), Office (`.docx` `.pptx`), text (`.html` `.txt`), audio (`.mp3` `.wav` `.m4a`), or video (`.mp4` `.mov`). Prefer this over native Read / Grep for multi-file or non-PDF corpora. Not for: editing files, web browsing, single-file plain-text lookups, fine-tuning."
license: Apache-2.0
allowed-tools: Bash Write Read
---

# nemo-retriever

The `retriever` CLI indexes a folder of PDFs into LanceDB (`retriever ingest`) and serves vector search over it (`retriever query`). For any task about searching/answering questions across a folder of PDFs, use this CLI — do not write a custom RAG.

**Beyond PDFs and beyond semantic search.** `retriever ingest` also handles images, Office, HTML, TXT, audio, and video — see `references/setup.md` for the per-format recipe and `references/install.md` for the install extras (`[multimedia]`, libreoffice, ffmpeg). For non-semantic operations — page filter, verbatim quote with citation, corpus-level aggregate, chart/image caption hits — see `references/query.md`. Don't fall back to native Read/Grep/Python on non-PDF inputs.

## Install (if `retriever` is missing)

If `command -v retriever` returns nothing, follow `references/install.md` to install the NeMo Retriever Library before proceeding. It prints `RETRIEVER_VENV=<path>`; substitute that path for `<RETRIEVER_VENV>` in every example in this skill (setup, query, troubleshooting, and the CLI references).

## Workflow — read the reference for the current phase, then execute

| Turn type | Read this once | Then execute |
| :--- | :--- | :--- |
| **Setup turn** (first turn — `./lancedb/nv-ingest.lance` doesn't exist) | `references/setup.md` | Build the index |
| **Query turn** (every subsequent turn — user asks a question) | `references/query.md` | One `retriever query` call |
| Anything errored or returned empty | `references/troubleshooting.md` | Apply the named recovery; do not improvise |

For the full `retriever ingest` / `retriever query` CLI specs, see `references/cli/ingest.md` and `references/cli/query.md`. You do not need these for routine turns — `<RETRIEVER_VENV>/bin/retriever <subcommand> --help` is faster.

Before ingesting a mixed folder, inventory extensions (`find <dir> -name '*.*' | sed 's/.*\.//' | sort -u`) — `--input-type=auto` silently drops anything outside the supported set. See `references/troubleshooting.md` "Unsupported file types".

## Hard limits (apply to every turn)

- **Setup turn**: build the index in one shell command (see `references/setup.md`). STOP after the index lands.
- **Query turn**: at most **2 Bash calls** — 1 `retriever query`, +1 optional targeted text-extract per `references/query.md`. Reply and then STOP.
- **No narration between tool calls.** Tokens you emit between calls become input + cached input for every later turn — quadratic cost. Go straight from reading the summary to writing the JSON file.
- **Banned**: `TodoWrite`, Glob, Grep, `Read` of whole PDFs, re-running setup, spawning subagents, speculative "confirmation" calls.

Long query turns (5+ tool calls, 1M+ cache-read tokens) cost ~5× a disciplined turn and almost always still produce the wrong answer. **Answering partially beats timing out.**
