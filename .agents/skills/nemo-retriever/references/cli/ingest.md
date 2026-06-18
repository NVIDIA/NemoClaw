# retriever ingest

End-to-end ingestion of supported documents and media into a LanceDB table — runs the full
extract -> embed -> vector-DB flow in a single command.

If flags below look stale, re-check `retriever ingest --help`.

## When to use this

- You have one or more supported files (or a directory/glob of files) and want them
  searchable via `retriever query`.
- You want an auto-routed ingest: supported file families are detected from
  the manifest, then routed through document/image/text/audio/video extraction
  branches before embedding and LanceDB insert.

**Use a different command when:**

- You only need a single stage (e.g. just extract text, no embeddings) →
  `retriever pdf`, `retriever chart`, `retriever image`, etc.
- You need a long-running service rather than one-shot CLI → `retriever service`.
- You're benchmarking throughput → `retriever benchmark`.
- You're iterating on the pipeline locally and want a non-distributed runner →
  `retriever local`.

## Canonical invocations

Ingest a single file into the default table (`lancedb/nv-ingest.lance`):

```bash
<RETRIEVER_VENV>/bin/retriever ingest data/multimodal_test.pdf
```

Default PDF ingest:

```bash
<RETRIEVER_VENV>/bin/retriever ingest data/corpus/
```

Large text-only PDF fallback:

```bash
retriever ingest data/pdfs/ --profile fast-text
```

Optional local VLM captioning:

```bash
retriever ingest data/pdfs/ --caption \
  --caption-infographics
```

Add `--caption-invoke-url` only when a remote OpenAI-compatible VLM endpoint is already deployed.

Ingest a directory of supported files:

```bash
retriever ingest data/corpus/
```

Ingest via glob:

```bash
retriever ingest "data/**/*"
```

Write to a custom DB / table:

```bash
<RETRIEVER_VENV>/bin/retriever ingest data/multimodal_test.pdf \
  --lancedb-uri ./my-lancedb \
  --table-name my-corpus
```

## Inputs

- **Positional `DOCUMENTS...`** — one or more file paths, directories, or
  shell globs. Required, repeatable.
- **Supported input types** — `pdf`, `doc` (`.docx`, `.pptx`), `txt`, `html`,
  `image` (`.jpg`, `.jpeg`, `.png`, `.tiff`, `.tif`, `.bmp`, `.svg`),
  `audio` (`.mp3`, `.wav`, `.m4a`), and `video` (`.mp4`, `.mov`, `.mkv`).

## Outputs

- A LanceDB dataset at `<lancedb-uri>/<table-name>.lance`. Default:
  `./lancedb/nemo-retriever.lance`.
- One row per extracted primitive (text chunk, table, chart, image region),
  each with: `text`, `source`, `page_number`, `metadata` (JSON: type, bbox, …),
  and the embedding vector.

## Key flags

| Flag | Default | Notes |
|---|---|---|
| `--lancedb-uri` | `lancedb` | Path or URI of the LanceDB database. |
| `--table-name` | `nemo-retriever` | LanceDB table to write into. Must match `retriever query`'s table on read. |
| `--profile` | `auto` | `auto` is normal manifest-routed ingest. `fast-text` disables expensive PDF recall stages for a text-only fallback. |
| `--caption` | `false` | Optional VLM captioning stage after extraction. Never enabled by profiles. |
| `--caption-invoke-url` | unset | Remote VLM endpoint. If omitted with `--caption`, local VLM captioning is used. |
| `--caption-context-text-max-chars` | default | Include nearby extracted text in caption prompts. |
| `--caption-infographics` | default | Caption infographic crops in addition to extracted images. |
| `--run-mode` | `batch` | `batch` for the SDK batch ingestor; pass `inprocess` to skip Ray for local debug or CI. |
| `--dry-run` | `false` | Print the resolved manifest/profile JSON without creating an ingestor. |

## Pipeline shape

The default `ingest` entrypoint expands inputs, builds a manifest, resolves the
selected profile into normal params, and calls `GraphIngestor.extract(...)`.
The manifest planner routes PDF/document, image, text, HTML, audio, and video
branches without relying on `retriever pipeline`.

For text, HTML, image, audio, video, or mixed `auto` inputs, `ingest` routes
through the same GraphIngestor extraction paths used by `retriever pipeline`.

## Common failure modes

- **`Clamping num_partitions from 16 to 7`** — informational, not an error.
  LanceDB IVF index needs `num_partitions < row_count`; happens on very small
  ingests.
- **First run is slow (~60s+ before any pages process)** — vLLM model load and
  CUDA-graph capture for the embedder. Subsequent runs in the same process
  are fast; one-shot CLI invocations always pay this cost.
- **`No existing dataset at …/nemo-retriever.lance, it will be created`** — expected
  on the first ingest into a new DB. Subsequent ingests append.
- **HuggingFace download on first run** — the embedder and page-element
  detector pull weights to `~/.cache/huggingface`. Needs network the first
  time; cached afterwards.

## Related

- [[query]] — search the table this command writes.
- `retriever vector-store --help` — utilities for inspecting/moving LanceDB
  tables.
