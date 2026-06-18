# Result analysis scripts

Ready-to-run Python patterns for analyzing `evaluate_rag.py` RAGAS outputs. Load when the user wants per-row queries, worst-accuracy tables, or CSV export.

All paths assume default `--output_dir results`; substitute your actual dataset basename for `my_dataset`.

## Per-query table with worst-accuracy rows

```python
import json

data   = json.load(open("results/my_dataset/rag_my_dataset_evaluation_data.json"))
scores = json.load(open("results/my_dataset/rag_my_dataset_evaluation_results.json"))

rows = []
for i, (d, acc) in enumerate(zip(data, scores.get("nv_accuracy", []))):
    rows.append({
        "i": i,
        "id": d.get("id"),
        "question": d["question"][:80],
        "nv_accuracy": acc,
        "has_context": bool(d.get("generated_contexts")),
        "answer_len": len(d.get("generated_answer", "")),
    })

rows.sort(key=lambda r: r["nv_accuracy"])
print(f"{'i':>3}  {'acc':>5}  {'ctx':>3}  question")
print("-" * 70)
for r in rows[:10]:
    print(f"{r['i']:>3}  {r['nv_accuracy']:>5.2f}  {'Y' if r['has_context'] else 'N':>3}  {r['question']}")
```

`has_context=N` with low `nv_accuracy` → retrieval problem (ingestion gap or collection mismatch), not generation.

## Export to CSV

```python
import csv, json

data   = json.load(open("results/my_dataset/rag_my_dataset_evaluation_data.json"))
scores = json.load(open("results/my_dataset/rag_my_dataset_evaluation_results.json"))

acc  = scores.get("nv_accuracy",  [None]*len(data))
ctxr = scores.get("nv_context_relevance", [None]*len(data))
grd  = scores.get("nv_response_groundedness", [None]*len(data))

with open("eval_out.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["id","question","answer","generated_answer",
                                       "nv_accuracy","nv_context_relevance","nv_response_groundedness"])
    w.writeheader()
    for i, d in enumerate(data):
        w.writerow({"id": d.get("id",""), "question": d["question"],
                    "answer": d["answer"], "generated_answer": d.get("generated_answer",""),
                    "nv_accuracy": acc[i], "nv_context_relevance": ctxr[i],
                    "nv_response_groundedness": grd[i]})
```

## Markdown table of worst queries

Paste into a PR description or evaluation report:

```python
import json

data   = json.load(open("results/my_dataset/rag_my_dataset_evaluation_data.json"))
scores = json.load(open("results/my_dataset/rag_my_dataset_evaluation_results.json"))

pairs = sorted(zip(scores.get("nv_accuracy", []), data), key=lambda x: x[0])
print("| id | acc | question | generated_answer |")
print("|----|-----|----------|-----------------|")
for acc, d in pairs[:5]:
    q = d["question"][:60].replace("|", "\\|")
    a = d.get("generated_answer", "")[:80].replace("|", "\\|")
    print(f"| {d.get('id','')} | {acc:.2f} | {q} | {a} |")
```
