---
name: nemoclaw-maintainer-verify-stale
description: "Verifies whether stale NVIDIA/NemoClaw bug reports still reproduce on the latest tag. Use when maintainers ask to verify stale issues, reproduce old bugs on latest, drain the bug backlog, or apply fixed-on-latest, verify-inconclusive, or status: wont-fix. Runs candidate filtering, local/Brev reproduction, by-design detection, confidence scoring, redacted comments, and tag-only labeling; never auto-closes."
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Verify Stale Issues

Automates the maintainer loop: choose an old bug, verify whether it still reproduces on the latest NemoClaw tag, then post an evidence-backed comment and label. It is tag-only: never close issues automatically.

## Progress checklist

Copy this checklist and update it as you work:

```text
Verify-stale progress:
- [ ] Select issue(s), latest tag, and reported version
- [ ] Apply skip/idempotency/active-discussion filters
- [ ] Classify environment, provider, and bug class
- [ ] Extract or synthesize a reproducer
- [ ] Verify preconditions and try local-first if eligible
- [ ] If Brev is needed, get plan approval before provisioning
- [ ] Validate the reproducer on baseline, then verify latest
- [ ] Check by-design/static-analysis branch when behavior was removed
- [ ] Score, redact, draft, and self-verify comment links
- [ ] Re-check issue state, post comment/label, update tracker when required
- [ ] Append activity log entry
```

## Workflow

1. **Select candidates and versions.** Read [reference/candidate-selection.md](reference/candidate-selection.md). Use it for single-issue mode, batch mode, latest-tag detection, filters, idempotency, active-discussion handling, and reported-version parsing.
2. **Classify and prepare.** Read [reference/environment-and-reproducer.md](reference/environment-and-reproducer.md). Use it for CPU/GPU/provider/bug-class classification, safe API-key handling, reproducer extraction, dependency checks, Brev auth, label checks, and local-first verification.
3. **Stop for approval before cost.** In batch mode, present one issue's plan and wait for maintainer approval before provisioning Brev.
4. **Provision and install.** If local-first does not settle the issue, read [reference/brev-provisioning.md](reference/brev-provisioning.md). Use it for Brev reuse/provisioning, reset, baseline/latest installs, dependency bootstrap, and `brev exec` footguns.
5. **Run the verification rubric.** Read [reference/reproduction-rubrics.md](reference/reproduction-rubrics.md). Use it to validate baseline behavior, retry with a synthesized reproducer if needed, run latest, handle architectural drift, and branch for performance or rebuild-cycle bugs.
6. **Check intentional changes.** If the symptom targets removed/deprecated behavior, read [reference/by-design.md](reference/by-design.md). Use static evidence to apply `status: wont-fix` only when the by-design branch self-verifies.
7. **Score, comment, label, and log.** Read [reference/scoring-comments-and-logging.md](reference/scoring-comments-and-logging.md). Use it for confidence scoring, redaction, concise templates, issue-state race checks, Project 199 movement, infra failures, and activity logging.

## Non-negotiables

- Never auto-close an issue. Apply labels and ask a maintainer/reporter to confirm.
- Never put API keys on a command line. Use the file-based pattern in `environment-and-reproducer.md`.
- Never post unredacted transcripts, issue excerpts, synthesized scripts, internal hostnames, email addresses, or tokens.
- Never post a comment with broken markdown links or tag-drifting `file:line` citations. Re-run cited commands and link-check at least one rendered link per comment section.
- Never use Brev for unsupported platforms or integration-token issues in v1.
- Keep comments concise: default to 200–300 words for fixed/by-design, 100–200 for inconclusive, and 30–80 for still-reproduces.

## Reference map

| Need | Read |
|---|---|
| Candidate query, filters, version parser | [reference/candidate-selection.md](reference/candidate-selection.md) |
| Environment classification, credentials, reproducer, preconditions, local-first | [reference/environment-and-reproducer.md](reference/environment-and-reproducer.md) |
| Brev box reuse/provision, reset, installs, dependency bootstrap | [reference/brev-provisioning.md](reference/brev-provisioning.md) |
| Baseline/latest matching, synth-repro, drift, performance, rebuild-cycle | [reference/reproduction-rubrics.md](reference/reproduction-rubrics.md) |
| Static by-design/wont-fix branch | [reference/by-design.md](reference/by-design.md) |
| Score, redact, comment, label, tracker move, infra handling, log | [reference/scoring-comments-and-logging.md](reference/scoring-comments-and-logging.md) |
