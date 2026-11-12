---
name: nemoclaw-contributor-create-pr
description: Create or update a NemoClaw v1 pull request with its authoring-session report, then follow its checks and automated reviews.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create or Update a Pull Request

Adapted from main's PR creation skill at `8c72b552cc92fe7082908f3a13db7dc94f2f6685`, without its npm, governance, and draft steps, and with a session report added.

1. Write the description from `.github/PULL_REQUEST_TEMPLATE.md`, following [WRITING.md](../../../WRITING.md) and the [description rules](#description-rules); keep the report out of it. Prepare a separate comment from `.github/SESSION_REPORT_TEMPLATE.md` using the [evidence rules](#session-report). Keep `<details>` without `open`.
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

## Description Rules

The description becomes the squash commit's message, so it stays in the history.

- The first paragraph says what changes and for whom; a reviewer who reads only that paragraph knows what the diff does. Keep the rest as long as the change needs: a small change gets a few lines.
- Back every claim with CI or a check under Beyond CI, and make no claim stronger than that check shows. Write "Resolves #N" only when every acceptance criterion is met.
- Don't list checks that CI runs; reviewers read CI's results on the final commit. Report local runs to whoever asked for the change, not in the description.
- Write only what stays true after merge. CI status, review state, run IDs, and links readers outside NVIDIA can't open go in a PR comment, beside the session report.

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
| Tokens | recorded | input: 120000; cached input: 80000; output: 4000 | Last Codex cumulative usage event at the stated cutoff |
| Session window | recorded | 2026-10-27T19:56Z to 2026-10-27T20:04Z; 8 min | First event to cutoff, including idle time |
| Compactions | recorded | 0 | Complete record to cutoff |
| Models | recorded | gpt-6-astra | Turn context; no changes |
| Reasoning levels | recorded | medium; high | Effort changes, in order |

### Tokens

Read token counts from the authoring record through the report's cutoff, never from memory or a context-window estimate.
Use `input: N; cached input: N; output: N` in the Value cell.
Input includes uncached input, cache reads, and cache writes; cached input is the cache-read subset of input.
The evidence cell names the counters, cutoff, and any excluded activity.

- **Codex:** use the last actual cumulative usage snapshot in `event_msg` / `token_count` events' `info.total_token_usage` at or before the cutoff.
  Map `input_tokens`, `cached_input_tokens`, and `output_tokens` to the three counts.
  Check the recorded version's accounting before treating that snapshot as complete.
  In Codex 0.160.0, remote compaction v2 (`codex-rs/core/src/compact_remote_v2.rs`) records response usage separately without adding it to these cumulative counters.
  Reconcile response-level usage once per response ID when the records establish coverage, adding only usage not already included in the cumulative counters.
  If compaction usage cannot be reconciled, report known counts as `partial` and explain the gap; use `unavailable` if no usable counters exist.
  Skip context-limit placeholders that set only `total_tokens` and zero the category counters.
  In Codex 0.160.0, a placeholder resets the counters (`codex-rs/protocol/src/protocol.rs`), so later snapshots can omit earlier usage.
  Reconcile disjoint segments on both sides of each reset when the record supports it; otherwise report a known lower bound as `partial`, even when later actual counters exist, or `unavailable` if none exist.
  Do not sum running totals within a segment, add `last_token_usage` to them, or add `reasoning_output_tokens` to output again.
- **Claude Code:** read assistant `message.usage` from the session JSONL.
  Count each API response once, using `message.id` and `requestId` when present to identify repeated streaming records; use its final usage snapshot through the cutoff.
  Confirm that the recorded version persisted final usage, including for completed subagent responses; the last transcript entry can still contain streaming placeholders.
  Reconcile with final response usage when available; otherwise report known lower bounds as `partial`, or `unavailable` if no usable counters exist.
  Sum `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` for input, `cache_read_input_tokens` for cached input, and `output_tokens` for output.
- **Pi:** inspect the recorded version's schema.
  At Pi revision `2a32a605a9f18a5f0191f65358a2e764b2f69fc7`, usage accounting (`packages/coding-agent/src/core/usage-totals.ts`) reads assistant and tool-result `message.usage`, plus `usage` on usage, compaction, and branch-summary entries when present.
  Sum unique authoring-session entries through the cutoff, including paid activity on abandoned branches: `input + cacheRead + cacheWrite` for input, `cacheRead` for cached input, and `output` for output.
  Do not add `totalTokens` or reasoning subtotals to these counts.
  Confirm that the provider reported the counters before marking usage `recorded`: at the same Pi revision, the OpenAI-completions adapter (`packages/ai/src/api/openai-completions.ts`) defaults missing usage fields to zero, so a stored zero alone does not establish zero usage.
  Treat unverified counters as gaps; use `partial` for known lower bounds, or `unavailable` if no usable counters exist.

Exclude inherited activity before a fork's authoring boundary; subtract a recorded cumulative baseline when needed.
Include separate subagent usage only when its records were inspected and it is not already included; state the coverage.
Use `partial` for known lower bounds, identifying missing usage, an unfinished response, or a gap between the last counter and the cutoff.
Use `unavailable` with value `-` when the record or usable counters are absent, and explain what was checked.
Missing counters never mean zero; use zero for an absent cache field only when the recorded schema establishes that it means no cache usage.

Locate the record using the harness’s available session metadata or export, then its local storage when accessible:

- **Codex CLI/Desktop:** `${CODEX_HOME:-$HOME/.codex}/sessions/YYYY/MM/DD/rollout-….jsonl`; also check `archived_sessions` under that root when appropriate. Paths and record schemas can change; confirm identity from metadata.
- **Claude Code:** `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`; confirm session identity, project, and message usage before counting. Inspect separate subagent records when including their usage.
- **Pi:** `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`. Read the active branch for activity fields; use the Tokens rules for usage. A branch summary is not a compaction.
