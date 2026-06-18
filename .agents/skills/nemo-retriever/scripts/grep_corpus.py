"""Case-insensitive keyword/regex search over the corpus via the LanceDB index.

This script scans the already-built LanceDB table, so it returns matches
across every chunk `retriever ingest` indexed (text, table, chart, image
transcriptions where present) without re-reading any PDF.

Usage:
    <RETRIEVER_VENV>/bin/python <skill_dir>/scripts/grep_corpus.py <pattern> \\
        [--max-hits 50] [--lancedb-uri ./lancedb] [--table-name nemo-retriever]

`pattern` is a Python regex, case-insensitive. For a literal-string search,
just write the string — most identifier characters (`.`, `-`, `_`, digits,
letters) are unambiguous unless you include regex metacharacters
(`(`, `|`, `*`, `?`, `[`, `]`, `\\`, `^`, `$`).

Output (one line per hit; sorted by pdf_basename then page_number):
    <pdf_basename>:p<page_number>:<type>:  ...<snippet around match>...

Prints `NO_MATCH` on zero hits. Caps at `--max-hits` to keep the turn output
bounded; raise it if you really want more.
"""

from __future__ import annotations

import argparse
import json
import re
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pattern", help="Python regex (case-insensitive)")
    ap.add_argument("--max-hits", type=int, default=50)
    ap.add_argument("--snippet-pad", type=int, default=60)
    ap.add_argument("--lancedb-uri", default="./lancedb")
    ap.add_argument("--table-name", default="nemo-retriever")
    args = ap.parse_args()

    try:
        import lancedb
    except ImportError:
        print("ERROR: lancedb not importable. Run with <RETRIEVER_VENV>/bin/python.", file=sys.stderr)
        return 1

    try:
        pat = re.compile(args.pattern, re.IGNORECASE)
    except re.error as e:
        print(f"ERROR: bad regex {args.pattern!r}: {e}", file=sys.stderr)
        return 2

    try:
        db = lancedb.connect(args.lancedb_uri)
        tbl = db.open_table(args.table_name)
    except Exception as e:
        print(f"ERROR: can't open lancedb table {args.table_name!r} at " f"{args.lancedb_uri!r}: {e}", file=sys.stderr)
        return 1

    rows = tbl.to_pandas()
    if "text" not in rows.columns:
        print(f"ERROR: lancedb table has no 'text' column. columns={list(rows.columns)}", file=sys.stderr)
        return 1

    hits = []
    for row in rows.itertuples(index=False):
        text = getattr(row, "text", "") or ""
        m = pat.search(text)
        if not m:
            continue
        pdf = getattr(row, "pdf_basename", "?")
        page = getattr(row, "page_number", "?")
        meta_raw = getattr(row, "metadata", "") or ""
        if isinstance(meta_raw, str):
            try:
                meta = json.loads(meta_raw) if meta_raw else {}
            except json.JSONDecodeError:
                meta = {}
        elif isinstance(meta_raw, dict):
            meta = meta_raw
        else:
            meta = {}
        type_ = meta.get("type", "?")
        start = max(0, m.start() - args.snippet_pad)
        end = min(len(text), m.end() + args.snippet_pad)
        snippet = text[start:end].replace("\n", " ")
        hits.append((pdf, page, type_, snippet))

    hits.sort(key=lambda h: (str(h[0]), int(h[1]) if isinstance(h[1], (int, float)) else 0))
    for pdf, page, type_, snippet in hits[: args.max_hits]:
        print(f"{pdf}:p{page}:{type_}:  ...{snippet}...")
    if not hits:
        print("NO_MATCH")
    elif len(hits) > args.max_hits:
        print(f"... ({len(hits) - args.max_hits} more matches truncated; " f"raise --max-hits to see them)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
