---
name: nemoclaw-contributor-create-pr
description: Create or update a NemoClaw v1 pull request with its authoring-session report, then follow its checks and automated reviews.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create or Update a Pull Request

Adapted from main's PR creation skill at `8c72b552cc92fe7082908f3a13db7dc94f2f6685`, without its npm, governance, and draft steps, and with a session report added.

1. Write the description from `.github/PULL_REQUEST_TEMPLATE.md`; keep the report out of it. Prepare a separate comment from `.github/SESSION_REPORT_TEMPLATE.md` using the [evidence rules](#session-report). Keep `<details>` without `open`.
2. Validate the comment:

   ```sh
   rustc --edition=2024 tools/ci/pr-session-report.rs -o /tmp/pr-session-report
   /tmp/pr-session-report report-comment.md
   ```

3. Publish with `gh pr create --body-file` or `gh pr edit --body-file`. Read all pages of PR comments before posting, including after an uncertain retry; reuse an existing opening report by the PR author instead of duplicating it. If absent, post once as the PR author with `gh pr comment NUMBER --body-file report-comment.md`.
4. Read back the description and comments. Verify the description has no report, exactly one opening report by the PR author exists, and its contents match the intended report. Keep the exact summary `Authoring session — opening`. Validate the retrieved files with `/tmp/pr-session-report --pr description.md author-comment-1.md author-comment-2.md`; pass every PR-author comment, including later reports and unrelated comments. Comments by others are ignored; a maintainer's comment cannot substitute for an automated PR author's report.
5. Follow checks and automated reviews on the latest commit. If the metadata job fetched comments before the opening report was posted, wait for that run to finish, then use `gh run rerun --job JOB_ID` for its failed `Session report format` job. Select the job from this PR's latest-revision run; a rerun retains the original revision but fetches current comments. Reruns require repository write permission, so external contributors may need a maintainer. Confirm the rerun passes.

CI fetches the description and all comment pages on PR opening, updates, reopening, and description/title edits. It checks the presence and format of the PR author's opening report, not the truth or completeness of its evidence. Fetch failures fail the check. Comment posting, editing, or deletion alone does not trigger a refresh; rerun the metadata job after such changes. A `v1`-only `issue_comment` workflow would not run: GitHub requires it on the default branch.

The check uses the candidate checkout's validator and workflow. It does not protect against a PR changing its own validation; trusted-base enforcement is outside this check's scope.

Preserve historical reports and their cutoffs. Optional later commit or merge reports may use the same collapsed format with a distinct summary and revision; they do not replace the opening report or create a publication requirement.

## Session Report

Report the session that wrote the change, up to a cutoff you state. A publishing session must use the authoring record, not its own activity.

Before assigning statuses, locate and inspect the available authoring record through that cutoff. Use the harness session identity and recorded repository or branch activity to confirm the match; a PR mention alone is insufficient.
Inspect persisted records even after conversation compaction. A compacted conversation does not establish that the underlying record is missing.
For each field, extract the available evidence first. Use `partial` or `unavailable` only for a concrete gap after inspection; state the source checked and the missing evidence or access failure. “Not audited” is not an evidence gap.
If the authoring record cannot be located or accessed, report that limitation; do not substitute a publishing session or invent values.
Give each row one status:

- `recorded`: the session record covers the whole session.
- `partial`: it covers part of the session; say what is missing. Counts are lower bounds.
- `unavailable`: it can't establish the field; the value is `-`, and the last column says why.

A missing record never means zero.
Read harness/version metadata, model and reasoning changes, timestamps, compaction events, tool invocations, and instruction injections/read results. Do not infer historical settings from current defaults.
Count attempted tool invocations, including failures, at a stated layer. Report wrapper calls and observable nested invocations separately; never add them together. Unobserved nested calls remain a limitation.
State the session window and elapsed time, including idle time. Distinguish the whole session from a task-only interval; other work in that session does not make its totals unavailable.
For forks or branches, identify inherited history and the active authoring scope. Exclude inherited calls from new activity counts; disclose gaps when the boundary cannot be established.
Count a skill or instruction file only when its full contents appear in the record, injected or completely read; instruction files are guidance outside skills, such as `AGENTS.md`, not source files read for the change.
Include guidance templates in the instruction inventory when fully read. A listed skill, file path, or truncated read does not establish a complete read.
Don't publish raw records, session file paths, IDs, or secrets; comments are public.

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

Locate the record using the harness’s available session metadata or export, then its local storage when accessible:

- **Codex CLI/Desktop:** `${CODEX_HOME:-$HOME/.codex}/sessions/YYYY/MM/DD/rollout-….jsonl`; also check `archived_sessions` under that root when appropriate. Paths and record schemas can change; confirm identity from metadata.
- **Pi:** `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`. Read only the active branch; a branch summary is not a compaction.
