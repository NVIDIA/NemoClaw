# retriever query

Embed a text query and return the top-k nearest rows from a LanceDB table
previously written by `retriever ingest` (or any compatible pipeline).

If flags below look stale, re-check `retriever query --help`.

## When to use this

- You have already ingested documents and want to retrieve relevant
  chunks/primitives for a natural-language query.
- You want a one-shot CLI lookup — no service, no UI.

**Use a different command when:**

- You want recall metrics over a labelled query set → `retriever recall`.
- You want to grade end-to-end QA quality → `retriever eval`.
- You want a long-running query endpoint → `retriever service`.
- You want to compare two retrieval runs → `retriever compare`.

## Canonical invocations

Top-10 search against the default table:

```bash
<RETRIEVER_VENV>/bin/retriever query "what is in chart 1?"
```

Top-3, custom table:

```bash
<RETRIEVER_VENV>/bin/retriever query "average frequency ranges for tweeters" \
  --top-k 3 \
  --lancedb-uri ./my-lancedb \
  --table-name my-corpus
```

## Inputs

- **Positional `QUERY`** — single text string. Required. Quote it in the shell
  to keep multi-word queries intact.

## Outputs

- JSON array on stdout, one object per hit, sorted by ascending `_distance`
  (lower = more similar). Each hit includes:
  - `_distance` — vector distance in the embedding space.
  - `text` — the retrieved primitive's text content.
  - `source` / `path` / `source_id` — origin document path.
  - `page_number`, `pdf_basename`, `pdf_page` — locator.
  - `metadata` — JSON string with `type` (`text` / `table` / `chart` / `image`)
    and, where applicable, a normalised `bbox_xyxy_norm`.

Pipe through Python for filtering, e.g. only chart hits:

```bash
<RETRIEVER_VENV>/bin/retriever query "gadget costs" | <RETRIEVER_VENV>/bin/python -c 'import json,sys; hits=json.load(sys.stdin); print(json.dumps([h for h in hits if json.loads(h["metadata"]).get("type")=="chart"], indent=2))'
```

## Key flags

| Flag | Default | Notes |
|---|---|---|
| `--top-k` | `10` | Max hits to return. Must be ≥ 1. |
| `--lancedb-uri` | `lancedb` | Must match what `ingest` wrote to. |
| `--table-name` | `nemo-retriever` | Must match what `ingest` wrote to. |

## Distance interpretation

- The embedder (`llama-nemotron-embed-vl-1b-v2`) returns mean-pooled vectors;
  LanceDB returns L2 distance by default. Typical relevant hits are in the
  ~1.0–1.7 range for this model on prose queries; treat `_distance` as
  **ranking-only**, not a calibrated similarity score.
- The query uses the **VL** variant of the embedder so text queries can match
  ingested image/chart embeddings as well as text. Expect mixed-modality hits
  in the result list.

## Common failure modes

- **Empty result array** — table is empty (no ingest run yet) or
  `--table-name` / `--lancedb-uri` don't match where ingest wrote.
- **`Table 'nemo-retriever' was not found`** — same root cause: wrong table/URI,
  or ingest hasn't been run.
- **First query is slow (~10–15s)** — vLLM startup for the query embedder.
  Subsequent queries in the same process are sub-second; one-shot CLI
  invocations always pay this cost.
- **Surprisingly low-relevance top hit** — for very short corpora, even
  unrelated queries return *something* with a non-huge distance. Inspect
  `_distance` gaps between hits rather than absolute values.

## Related

- [[ingest]] — populate the table this command reads.
- `retriever recall --help` — batch query → recall@k against ground truth.
- `retriever eval --help` — end-to-end QA evaluation.
