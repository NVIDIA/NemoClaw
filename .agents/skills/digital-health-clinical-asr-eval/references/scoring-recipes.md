# Inline scoring recipes — WER / CER / KER / SER

Pure-Python, no `jiwer` dependency required. `jiwer` is fine if installed; this is the self-contained fallback the skill ships with. Definitions, normalization rules, and the strict-contiguous KER semantics live in `SKILL.md` §3c — this file carries only the executable form.

```python
import re, unicodedata

def normalize(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).lower()
    # Strip punctuation except hyphen; collapse whitespace.
    s = re.sub(r"[^\w\s\-]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def edit_distance(ref, hyp) -> int:
    """O(n*m) Levenshtein on any sequence (list of tokens or list of chars)."""
    n, m = len(ref), len(hyp)
    if n == 0: return m
    if m == 0: return n
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): dp[i][0] = i
    for j in range(m + 1): dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i-1] == hyp[j-1] else 1
            dp[i][j] = min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost)
    return dp[n][m]

def wer(ref: str, hyp: str) -> float:
    r, h = normalize(ref).split(), normalize(hyp).split()
    return edit_distance(r, h) / max(len(r), 1)

def cer(ref: str, hyp: str) -> float:
    r, h = list(normalize(ref)), list(normalize(hyp))
    return edit_distance(r, h) / max(len(r), 1)

def ker(hyp: str, term: str) -> int:
    """Strict KER per row: 1 = miss, 0 = hit.
    Term words must appear in order, adjacent, in the normalized hypothesis."""
    norm_hyp = normalize(hyp).split()
    norm_term = normalize(term).split()
    for i in range(len(norm_hyp) - len(norm_term) + 1):
        if norm_hyp[i:i + len(norm_term)] == norm_term:
            return 0  # hit
    return 1  # miss

def ser(ref: str, hyp: str) -> int:
    """Sentence error rate per row: 1 if any difference (post-normalize), 0 if exact."""
    return 0 if normalize(ref) == normalize(hyp) else 1
```

Aggregate across rows: `mean(per-row score)` for each metric.

## Representative `ipa_source` split (what to expect in the §3d leaderboard)

```
ipa_source           KER     n
merriam-webster      0.05    420
magpie_g2p           0.41    180   ← these are the pronunciation-coverage gap
override             0.03     45
```

The 0.05 vs 0.41 delta tells the deployment story. If the user sees this gap and asks "should we fine-tune?" — the answer is *not yet*. Route them back to `/digital-health-clinical-asr-build`'s IPA QA pipeline (Stage 2d), per the SKILL.md special-case rule.
