"""Query-turn filename fast path for the nemo-retriever skill.

Reads `./pdfs/` from the current working directory. If the query string
literally contains any PDF basename (with or without the `.pdf` extension,
stem ≥6 chars, case-insensitive), runs `retriever pdf stage page-elements`
on each matched file via pdfium, ranks pages by query-token frequency,
and emits a top-10 ranking + the top page's raw text.

Invoked from SKILL.md as:
    <RETRIEVER_VENV>/bin/python <skill_dir>/scripts/filename_fast_path.py "$QUERY"

The retriever binary is resolved from sys.executable's directory, so the
script is portable across venvs.

Stdout protocol (exactly one of):
- `NO_MATCH\n`                    — no PDF basename in the query.
- `NO_TEXT\n`                     — matches found but extraction produced no
                                    text on any page (image-only PDFs).
- `<JSON>\n---TOP_PAGE_TEXT---\n<text>` — JSON with a "ranking" list of
                                    {doc_id, page_number, rank} (1-indexed
                                    pages, up to 10), followed by the top-
                                    ranked page's raw text (first 4000 chars).

Exit code is 0 in all three success outcomes; non-zero only on hard errors
(missing ./pdfs, page-elements subprocess failure, malformed sidecar JSON).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

PDF_DIR = "./pdfs"
EXTRACT_OUT = "/tmp/pdf_text"
MIN_STEM_LEN = 6
TOP_K = 10
TOP_PAGE_TEXT_CHARS = 4000

STOPWORDS = frozenset(
    "the a an of in on for to and or is are was were what which how when "
    "where who why this that these those with by from as at be it its do "
    "does did please could would should tell me you i we us our my".split()
)


def find_matches(query_lower: str, basenames: list[str]) -> list[str]:
    """Return PDF basenames whose name (with or without .pdf) appears verbatim
    in the lowercased query. Skip stems shorter than MIN_STEM_LEN."""
    matches = []
    for name in basenames:
        stem, ext = os.path.splitext(name)
        if ext.lower() != ".pdf" or len(stem) < MIN_STEM_LEN:
            continue
        if name.lower() in query_lower or stem.lower() in query_lower:
            matches.append(name)
    return matches


def extract_pages(retriever_bin: str, matches: list[str]) -> None:
    os.makedirs(EXTRACT_OUT, exist_ok=True)
    for m in matches:
        subprocess.run(
            [
                retriever_bin,
                "pdf",
                "stage",
                "page-elements",
                f"{PDF_DIR}/{m}",
                "--method",
                "pdfium",
                "--json-output-dir",
                EXTRACT_OUT,
                "--compact-json",
            ],
            check=True,
        )


def sidecar_path(pdf_name: str) -> str | None:
    stem = os.path.splitext(pdf_name)[0]
    candidates = (
        f"{EXTRACT_OUT}/{pdf_name}.pdf_extraction.json",
        f"{EXTRACT_OUT}/{stem}.pdf.pdf_extraction.json",
    )
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def page_records(sidecar: str) -> list[dict]:
    data = json.load(open(sidecar))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("pages") or data.get("documents") or []
    return []


def page_text(rec: dict) -> str:
    txt = rec.get("text") or rec.get("content") or ""
    if not txt and isinstance(rec.get("primitives"), list):
        txt = " ".join(p.get("text", "") for p in rec["primitives"] if isinstance(p, dict))
    return txt or ""


def tokenize(query: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", query.lower()) if t and t not in STOPWORDS and len(t) > 2]


def rank_pages(matches: list[str], toks: list[str]) -> list[tuple[int, int, str, str]]:
    """Return list of (score, page_number, doc_stem, text) sorted by
    descending score, ascending page number."""
    scored = []
    for m in matches:
        sidecar = sidecar_path(m)
        if sidecar is None:
            continue
        stem = os.path.splitext(m)[0]
        for rec in page_records(sidecar):
            pn = rec.get("page_number") or rec.get("page") or 0
            txt = page_text(rec)
            score = sum(txt.lower().count(t) for t in toks)
            if score > 0:
                scored.append((score, pn, stem, txt))
    scored.sort(key=lambda r: (-r[0], r[1]))
    return scored


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <query>", file=sys.stderr)
        return 2
    query = sys.argv[1]
    ql = query.lower()
    retriever_bin = os.path.join(os.path.dirname(sys.executable), "retriever")

    basenames = sorted(p for p in os.listdir(PDF_DIR) if p.lower().endswith(".pdf"))
    matches = find_matches(ql, basenames)
    if not matches:
        print("NO_MATCH")
        return 0

    extract_pages(retriever_bin, matches)
    scored = rank_pages(matches, tokenize(ql))
    if not scored:
        print("NO_TEXT")
        return 0

    ranking = [{"doc_id": s[2], "page_number": s[1], "rank": i + 1} for i, s in enumerate(scored[:TOP_K])]
    print(json.dumps({"ranking": ranking}))
    print("---TOP_PAGE_TEXT---")
    print(scored[0][3][:TOP_PAGE_TEXT_CHARS])
    return 0


if __name__ == "__main__":
    sys.exit(main())
