---
name: nemoclaw-contributor-create-pr
description: Create or update a NemoClaw pull request with its authoring-session report, then follow its checks and automated reviews.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create or Update a Pull Request

Session reporting retains the format from v1 PR #13918. Main also accepts reports posted by repository maintainers, including when they take over an existing PR.

Before publication, follow [Validation](references/validation.md) and [Publication](references/publication.md). For an open PR, first follow the [PR follow-up contract](../_shared/pr-follow-up.md); route valid code repairs to `nemoclaw-contributor-implement-issue`. These references own trusted-base validation, source-repository selection, guarded writes, verified commits, DCO, draft handling, and review follow-up. Follow [Writing and review](../_shared/documentation-writing-review.md) for PR text.

When changing live E2E evidence, require the implementation handoff to apply [Define the Live Contract](../../references/e2e-authoring.md#define-the-live-contract), or [Move or Remove Evidence](../../references/e2e-authoring.md#move-or-remove-evidence) when pruning or relocating assertions. Route incomplete handoffs back to implementation.

1. Write the description from the canonical base’s `.github/PULL_REQUEST_TEMPLATE.md`; keep the report out of it. Prepare a separate comment from `.github/SESSION_REPORT_TEMPLATE.md` using the [evidence rules](#session-report). Keep `<details>` without `open`.
2. Validate the comment:

   ```sh
   rustc --edition=2024 tools/ci/pr-session-report.rs -o /tmp/pr-session-report
   /tmp/pr-session-report report-comment.md
   ```

3. Publish through the [publication procedure](references/publication.md), preserving main’s description sections, DCO, and draft requirements. Read all pages of PR comments before posting, including after an uncertain retry. Reuse an existing opening report from the PR author or a repository maintainer. If absent, either may post it with `gh pr comment NUMBER --body-file report-comment.md`. When a maintainer takes over an existing or automated PR, do not require the original author to post the report or add a separate takeover record.
4. Read back the description and comments. Verify the description has no report, exactly one eligible opening report exists, and its contents match the intended report. CI accepts the PR author and accounts with repository `maintain` or `admin` permission, verified through GitHub's collaborator-permission API. Keep the exact summary `Authoring session — opening`. Validate the retrieved files with `/tmp/pr-session-report --pr description.md report-comment-1.md report-comment-2.md`; pass comments from eligible accounts, including later reports and unrelated comments. Ignore reports from other accounts.
5. Follow checks and automated reviews on the latest commit. If the metadata job fetched comments before the opening report was posted, wait for that run to finish, then use `gh run rerun --job JOB_ID` for its failed `commit-lint` job. Select the job from this PR's latest-revision run; a rerun retains the original revision but fetches current comments. Reruns require repository write permission, so external contributors may need a maintainer. Confirm the rerun passes.

CI fetches the description and all comment pages on PR opening, updates, reopening, and description/title edits. It checks the report's presence, format, and posting account's eligibility, not the truth or completeness of its evidence. Comment or permission fetch failures fail the check. Comment posting, editing, or deletion alone does not trigger a refresh; rerun the metadata job after such changes.

The check uses the candidate checkout's validator and workflow. It does not protect against a PR changing its own validation; trusted-base enforcement is outside this check's scope.

Preserve historical reports and their cutoffs. Optional later commit or merge reports may use the same collapsed format with a distinct summary and revision; they do not replace the opening report or create a publication requirement.

## Existing Pull Requests

A PR opened before this requirement needs one opening report on its next update.

- If the PR author has no opening report, post one with the summary `Authoring session — opening`. Report only what the available session record establishes, up to a cutoff you state. Mark each field you cannot establish `unavailable` with `-` and the reason, for example that the session record no longer exists or the update session did not author the earlier commits. Do not reconstruct values from memory.
- If an opening report by the PR author already exists, keep it and its cutoff unchanged. Do not edit it to cover later work.
- Report later work, if you choose to, in a separate collapsed comment with a distinct summary and revision, as described above. It does not replace the opening report.

## Session Report

Report the session that wrote the change, up to a cutoff you state. When publishing or taking over a PR without the original authoring-session evidence, mark the fields unavailable; the report does not need to come from the person who wrote the change.
Give each row one status:

- `recorded`: the session record covers the whole session.
- `partial`: it covers part of the session; say what is missing. Counts are lower bounds.
- `unavailable`: it can't establish the field; the value is `-`, and the last column says why.

A missing record never means zero.
Count a skill or instruction file only when its full contents appear in the record, injected or completely read; instruction files are guidance outside skills, such as `AGENTS.md`, not source files read for the change.
Don't publish session file paths or IDs; comments are public.

For example:

| Field | Status | Value | Evidence or limit |
| --- | --- | --- | --- |
| Harness | recorded | Codex CLI 0.163.0 | Session metadata |
| Skills | recorded | test-driven-development (injected); terminal-ux (complete read) | Skill injections and reads to cutoff |
| Instruction files | partial | AGENTS.md (complete read); WRITING.md (complete read) | Startup injections not recorded |
| Tool calls | partial | exec: 31; apply_patch: 4 | Includes failed calls; the exec wrapper hides nested calls |
| Session window | recorded | 2026-10-27T19:56Z to 2026-10-27T20:04Z; 8 min | First event to cutoff, including idle time |
| Compactions | recorded | 0 | Complete record to cutoff |
| Models | recorded | gpt-6-astra | Turn context; no changes |
| Reasoning levels | recorded | medium; high | Effort changes, in order |

Where to find the record:

- **Codex CLI:** `CODEX_HOME/sessions/YYYY/MM/DD/rollout-….jsonl`, which is not a stable interface. In a forked session, exclude the parent's activity.
- **Pi:** `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`. Read only the active branch; a branch summary is not a compaction.

## Completion

Report the PR URL, latest commit, CI and automated-review results, and remaining blockers. A successful push alone is not completion. This skill does not grant merge authority.
