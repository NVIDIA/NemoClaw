---
name: nemoclaw-maintainer-verify-stale
description: "Verifies whether stale NVIDIA/NemoClaw bug reports still reproduce on the latest tag. Use when maintainers ask to verify stale issues, reproduce old bugs on latest, or drain the bug backlog. Uses native Issue Type, canonical labels, local/Brev reproduction, by-design detection, confidence scoring, approved Project updates, and redacted verdict comments; never auto-closes."
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Verify Stale Issues

Automates the maintainer loop: choose an old issue whose native Issue Type is `Bug`, verify whether it still reproduces on the latest NemoClaw tag, then prepare an evidence-backed Project/comment write set for maintainer approval. It never closes issues automatically and never substitutes labels for Issue Type, lifecycle, or resolution.

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
- [ ] Re-check issue state, apply the accepted Project/comment write set
- [ ] Append activity log entry
```

## Workflow

1. **Select candidates and versions.** Read [reference/candidate-selection.md](reference/candidate-selection.md). Use it for single-issue mode, batch mode, latest-tag detection, filters, idempotency, active-discussion handling, and reported-version parsing.
2. **Classify and prepare.** Read [reference/environment-and-reproducer.md](reference/environment-and-reproducer.md). Use it for CPU/GPU/provider/bug-class classification, safe API-key handling, reproducer extraction, dependency checks, Brev auth, and local-first verification.
3. **Stop for approval before cost.** In batch mode, present one issue's plan and wait for maintainer approval before provisioning Brev.
4. **Provision and install.** If local-first does not settle the issue, read [reference/brev-provisioning.md](reference/brev-provisioning.md). Use it for Brev reuse/provisioning, reset, baseline/latest installs, dependency bootstrap, and `brev exec` footguns.
5. **Run the verification rubric.** Read [reference/reproduction-rubrics.md](reference/reproduction-rubrics.md). Use it to validate baseline behavior, retry with a synthesized reproducer if needed, run latest, handle architectural drift, and branch for performance or rebuild-cycle bugs.
6. **Check intentional changes.** If the symptom targets removed/deprecated behavior, read [reference/by-design.md](reference/by-design.md). Use static evidence to recommend Project Status `Won't Fix`, then request explicit approval for the exact Project/comment write set.
7. **Score, propose, apply, and log.** Read [reference/scoring-comments-and-logging.md](reference/scoring-comments-and-logging.md). Use it for confidence scoring, redaction, concise templates, authorization, issue-state race checks, approved Project 199 movement, infra failures, and activity logging.

## Non-negotiables

- Never auto-close an issue. Verdict names belong in comments and logs, not labels.
- Never write a Project field, assignment, or public comment before the maintainer accepts that exact write set.
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
| Static by-design branch and proposed `Won't Fix` Project state | [reference/by-design.md](reference/by-design.md) |
| Score, redact, authorize, comment, Project update, infra handling, log | [reference/scoring-comments-and-logging.md](reference/scoring-comments-and-logging.md) |
