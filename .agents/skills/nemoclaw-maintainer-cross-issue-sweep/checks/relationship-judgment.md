# Relationship Judgment

How the LLM classifies each candidate issue. The judgment is the only non-deterministic step in the pipeline; everything else is mechanical search.

## Contents

- Inputs to the LLM
- The prompt
- Evidence requirement
- Confidence levels
- Reverse-link boost

## Inputs to the LLM (per candidate)

- PR diff (truncated to 3000 chars if larger)
- PR description body
- PR's primary linked issue number (for context — used by SAME_ISSUE_DIFF check)
- Candidate issue number, title, body (truncated to 2000 chars)
- Candidate issue's first ~5 comments (for symptom context)

## The prompt

```text
Judge whether this PR's changes affect the open issue.

PR #{pr_number}: {pr_title}
PR description: {pr_body}
PR diff (relevant slice): {diff}

Candidate issue #{issue_number}: {issue_title}
Issue body: {issue_body}

PR's primary linked issue: #{primary_issue}

Classify the relationship:

- ADJACENT_FIX: PR's changes resolve this issue OR open a clear follow-on path
  on the same code the PR just touched
- CONTRADICTING: PR's approach makes this issue's desired behavior impossible,
  OR the PR's scope is incomplete and the issue reports the leftover gap
- SAME_ISSUE_DIFF: same root bug as #{primary_issue} (dedupe filter)
- UNRELATED: no meaningful relationship

For ADJACENT_FIX or CONTRADICTING, REQUIRED — cite ONE of these evidence shapes:

  (a) DIRECT: cite specific PR diff line(s) (file:line) AND specific issue
      symptom(s) that map to those lines

  (b) BY-OMISSION (partial-fix detection): cite the PR's diff *scope* — what
      class of bug it addressed — AND the issue's symptom showing the same
      class but a different instance the PR did NOT touch. Required: name the
      bug class, name the instances PR fixed, name the instances issue
      reports as still broken.

  (c) FOLLOW-ON: cite the symbol/file the PR introduced or modified AND the
      issue's request to harden the same symbol/file (e.g., "PR introduced
      rcf_patch.py; issue requests rcf_patch.py be hardened against X").

Confidence: high / medium / low

If you cannot cite specific evidence under any of (a), (b), (c), answer UNRELATED.
```

## Evidence requirement (anti-hallucination)

For any ADJACENT_FIX or CONTRADICTING verdict, the LLM must cite evidence under one of three shapes:

- **Direct**: specific PR diff line + specific issue symptom that map to each other
- **By-omission**: PR's diff *scope* (the bug class it addressed) + issue symptom showing the same class but a different instance the PR did NOT touch (catches partial-fix patterns)
- **Follow-on**: the symbol/file the PR introduced + the issue's request to harden the same symbol/file (catches "PR introduced X, now harden X" follow-up patterns)

Without one of these citations, the answer must be UNRELATED.

This rule is the single most important defense against hallucinated matches. The three shapes give the LLM legitimate paths to flag genuine relationships without lowering the bar to vague "they touch the same area" matches.

## Confidence levels

- **high**: clear semantic match between cited PR change and cited issue symptom
- **medium**: plausible match but partial evidence (e.g., the change touches the right area but doesn't directly fix the cited symptom)
- **low**: weak inference; below the default `confidence_floor` from `repo-policy.md` and gets dropped

## Reverse-link boost

If the candidate issue's body or comments already mention this PR's number (e.g., "fixed by PR #2851"), the relationship is already in someone's mental model. Boost confidence one tier:

- low → medium (rescues a borderline match)
- medium → high (cements a likely match)
- high → unchanged (already at ceiling)

Implementation: after the LLM's classification, the orchestrator checks the candidate issue body and comments for the PR number. If found, applies the boost.

## Why this beats naive token-overlap

Naive token-overlap finds candidates but produces high false-positive rates. Two filters separate signal from noise:

1. **LLM judgment** distinguishes "function name appears in issue" from "function's behavior is what the issue describes"
2. **Evidence requirement** forces the LLM to commit to specific lines, not vague hand-waving

The reverse-link boost handles the case where humans have already noticed the relationship — that's strong prior signal the skill should respect.
