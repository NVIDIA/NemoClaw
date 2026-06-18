# Dataset layout, `train.json`, and conversion

Load this when shaping `corpus/` + `train.json` or converting external benchmarks.

## Dataset layout

Each `--dataset-paths` entry is a directory containing:

1. `corpus/` — files indexed recursively for ingestion.
2. `train.json` — evaluation questions and answers.

## `train.json` schema

The driver accepts a **top-level JSON array** of objects only. Required per row: `question`, `answer`. Optional: `id` or `query_id`.

Field rules:

- `id`: **integer** from the source row index. Do not use prefixed strings (e.g. `"dataset-0"`).
- `is_impossible`: include as a boolean if the source dataset carries it; use `false` for benchmarks that have no unanswerable questions.
- `contexts`: optional array of objects — one entry per supporting document. **`filename`** (required on each object) is the file’s basename under `corpus/` exactly as on disk (including any percent-encoding in the name). **`text`** is **optional**: include it when you have a ground-truth span; omit it when you only need to tie the row to corpus files by name (for example multimodal PDFs where no span was curated).
- Omit benchmark-internal metadata fields (reasoning category labels, source tags, etc.) that are not `question`, `answer`, `id`, `is_impossible`, or `contexts`.

```json
[
  {
    "id": 0,
    "question": "...",
    "answer": "...",
    "is_impossible": false,
    "contexts": [
      { "filename": "Article_Title" },
      { "filename": "Another%20Article", "text": "…" }
    ]
  }
]
```

Multiple context entries per row are allowed. Plain strings (`["...", "..."]`) remain acceptable for minimal bundles without per-file tagging.

### Quick validation

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d, list) and all(isinstance(x, dict) for x in d), 'train.json must be a list of objects'" train.json
```

Run this after any conversion step to catch shape errors before the eval.

## Corpus format when converting external benchmarks

Prefer putting sources in `corpus/` as PDF. That matches typical production RAG on documents, aligns with the evaluator default `--file-type pdf`, and unlocks PDF page counts in ingestion metrics.

### Materializing `corpus/` from public links (datasets, sites, and mirrors)

Eval requires a real **`corpus/`** tree on disk. When the only inputs are **public links**—dataset landing pages, file listings, paper or supplement URLs, or arbitrary websites—**download or render into `corpus/` as documents the ingestor can index**, do not point the eval at URLs alone.

For **multimodal** material (figures, tables, charts, photos, diagrams, or screenshots that carry meaning), **standardize on PDF** as the file format under `corpus/` whenever practical so **images and layout stay inside the same artifact** the retriever will chunk and embed. Goals:

- **Preserve visuals:** Use the publisher’s **official PDF download** or export when it exists. Avoid workflows that rebuild PDFs from plain text only (for example simple text-to-PDF libraries): those often drop graphics and produce a corpus that no longer matches multimodal retrieval expectations.
- **Web-only pages:** Prefer **full-fidelity print paths** (browser print-to-PDF, or headless Chromium / Playwright rendering) so embedded and inline images survive in the PDF. HTML or `.txt` alone usually discard or isolate visuals from the indexed blob you need side-by-side with questions.
- **One logical source → one primary file:** Keep a stable **basename** under `corpus/` and reference that same basename in `train.json` `contexts[].filename` (see below). If a source truly splits into separate image files plus text, still align names with how citations and ingestion expose `document_name`.

After materializing files, pass **`--file-type`** to `evaluate_rag.py` according to what sits under `corpus/` (for example keep the default when the corpus is mostly PDF).

**Image-heavy web articles:** When upstream pages mix text and images, still prefer a **PDF export or faithful render** over generating PDFs with text-only toolkits. If an API offers binary PDF download, use it before HTML-to-text shortcuts.

If the upstream artifact only gives URLs or document pointers that do not name a concrete file (common in published benchmarks), assume PDF as the target format. Use plain text or HTML only when converting to PDF is impractical; then set `--file-type` to match what dominates under `corpus/`.

Each `contexts` object’s **`filename`** must match the actual corpus file basename (same as the file’s name in `corpus/`, e.g. `Report_2023` for `corpus/Report_2023` or `corpus/subdir/Report_2023`). **`text`**, when present, should be the reference span or excerpt; when omitted, only the filename association is carried through.

### Deriving corpus filenames from URLs

When the benchmark provides a URL per source document, derive the corpus filename and `contexts[].filename` using this rule — it preserves the source URL's identity exactly and ensures downstream citation matching works:

```text
stem = path_last_segment + "#" + fragment   (if URL has a fragment)
stem = path_last_segment                     (if no fragment)
```

The file you write under `corpus/` must start with `stem` and follow the same naming pattern as the rest of that dataset so `--file-type` and `document_name` from ingestion stay consistent.

Where:

- `path_last_segment` = last `/`-separated component of `urllib.parse.urlparse(url).path`.
- **Do not call `urllib.parse.unquote()`** on the segment — keep percent-encoding exactly as it appears in the URL.
- `fragment` = `urllib.parse.urlparse(url).fragment` — include verbatim if non-empty.
- **Do not pass the segment through any slug or sanitize function** that strips or replaces characters (`%`, `'`, `.`, `#`, `-`, non-ASCII bytes, etc.). Any such transformation breaks alignment between the corpus file, the `train.json` context reference, and the ingestor's `document_name`.

If the content must be fetched via an API that requires a decoded title (e.g. a REST endpoint that does not accept percent-encoded paths), decode **only for that API call**: `urllib.parse.unquote(path_last_segment)`. The on-disk filename stays encoded.

## Bringing external data into this layout

Benchmarks packaged elsewhere (CSV, JSONL, parquet, archives, APIs, annotation exports, etc.) are not consumed directly. **Convert** them so each eval root has `corpus/` documents and a `train.json` that follows the schema. Keep `corpus/` filenames consistent with how the ingestor and citations surface `document_name` so retrieval and scoring align.

**Conversion checklist:**

1. Normalize source encodings to UTF-8.
2. `train.json`: top-level array of objects, each with at minimum `question` and `answer`.
3. `id`: integer from the source row index — not a prefixed or composite string.
4. `is_impossible`: carry over from the source if present; add as `false` if the benchmark has no unanswerable questions.
5. Corpus filenames: if derived from URLs, use the stem rule above (raw path last segment + `#fragment` if any, no decoding, no sanitization).
6. `contexts` entries: `filename` must equal the corpus file basename; `text` is optional (add when you have a gold span).
7. Drop any benchmark-internal fields that are not part of the schema (`question`, `answer`, `id`, `is_impossible`, `contexts`).
8. Run the quick `train.json` validation above after any conversion.

## Conversion patterns

### JSONL → `train.json`

```python
import json, pathlib

rows = [json.loads(l) for l in pathlib.Path("source.jsonl").read_text().splitlines() if l.strip()]
train = [{"id": r.get("id"), "question": r["question"], "answer": r["answer"]} for r in rows]
pathlib.Path("my_dataset/train.json").write_text(json.dumps(train, indent=2, ensure_ascii=False))
```

### CSV → `train.json`

```python
import csv, json, pathlib

with open("source.csv", newline="", encoding="utf-8") as f:
    rows = list(csv.DictReader(f))

train = [{"question": r["question"], "answer": r["answer"]} for r in rows]
pathlib.Path("my_dataset/train.json").write_text(json.dumps(train, indent=2, ensure_ascii=False))
```

Map source column names to `question` / `answer` as needed. Add `"id"` from the source if available to aid per-query traceability.
