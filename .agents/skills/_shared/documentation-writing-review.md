<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Write and Review Explanatory Text

Use this contract in any skill that writes or reviews comments, test titles, PR text,
documentation, changelog entries, Announcements, or maintainer guidance.

## Load the Authoritative Guidance

- Read the [NemoClaw Writing Guide](../../../WRITING.md) and
  [NemoClaw Controlled Word List](controlled-words.md) before writing or reviewing
  changed explanatory text.
- For user-facing documentation, also read the
  [documentation contributor guide](../../../docs/CONTRIBUTING.md).
- Treat `docs/` as the source of truth for user-facing documentation.
- Verify commands, defaults, and behavior against checked-in source, tests, or scripts.
- Use existing documentation, issues, and PRs to locate claims and rationale, not as behavior
  authority.
- Verify support claims against an accepted issue or accepted design decision.
- Apply the writing rules and controlled terms to changed text. Preserve literal identifiers,
  commands, output, API fields, quotations, and official third-party names.

## Keep Documentation with Behavior

Before completing a code change, determine whether it changes a user-visible API, CLI,
configuration, UI behavior, workflow, default, error, or other supported product behavior.

- Update the affected source pages under `docs/` in the same change.
- When the host supports subagents, start a documentation authoring subagent while the primary
  agent continues implementation. Give it the changed sources, user-visible impact, likely pages,
  and required validation.
- Reconcile the authoring subagent's changes and validation evidence before completing the
  implementation.
- When authoring subagents are unavailable, complete the documentation work in the primary task.
  Do not omit required documentation because parallel execution is unavailable.

Documentation authoring does not replace the independent final review.

## Review High-Risk Procedures and Claims

For each changed procedure or operational claim, check the following items:

- Put prerequisites and warnings about destructive or replacement behavior, security relaxation,
  public ingress, external traffic, credential exposure, and other material risks before the
  action that creates them.
- After the action, state the resulting state changes and other effects.
- For each credential that the procedure handles, name its location, access, lifetime, and removal.
- Name the lifecycle boundary for each persistence claim.
- For a conditional or best-effort control, state the failure or fallback result.
- Give the verification command or observation and its acceptance criterion.
- Use the claim ladder in the controlled word list. Do not infer readiness, compatibility, or
  support from weaker evidence.
- Verify support claims against an accepted issue or accepted design decision. User approval and
  passing tests do not establish product support.
- For a changed shared user-facing page, inspect every rendered guide variant. Use `$$nemoclaw`
  when only the host CLI binary differs.
- Use an `<AgentOnly>` block when behavior, setup, paths, state locations, capabilities, or
  agent-specific wording differ. State when a variant has no equivalent operation.

## Review the Completed Change

Before final handoff, run an independent documentation writer subagent for every completed code or
documentation change.

- Give the reviewer the changed files, change summary, and test or docs-build evidence.
- For a documentation-only change, require review against the writing guide, controlled word list,
  and documentation contributor guide.
- Require the review to cover terminology, structure, voice, and code-sample presentation.
- Apply valid findings and rerun affected validation.
- If the current host cannot run the reviewer, hand the completed diff and evidence to a capable
  host. If no capable host is available, record the review as `blocked` and do not complete final
  handoff.

## Record the Review Receipt

When preparing a PR, complete the
[Documentation Writer Review](../../../.github/PULL_REQUEST_TEMPLATE.md) section after the final
review. Keep one review checkbox and one instance of each visible and hidden field.

- Use `docs-updated` when documentation changed. List the changed documentation paths. For a
  documentation-only change, state that the writing rules and documentation style were reviewed.
- Use `no-docs-needed` when a code change needs no documentation. State why.
- Use `blocked` when a named decision, dependency, access problem, or input prevents the review.
- Record a consistent product and agent surface, such as `Codex Desktop` or `Codex CLI`.

Commit all changes from the final review before recording receipt metadata. Then record:

```bash
git rev-parse --short HEAD
git rev-parse --short HEAD:AGENTS.md
```

Put those values in the receipt's hidden head-SHA and `AGENTS.md` blob-SHA comments. Rerun the
review and refresh both values after any new commit changes the PR head.

## Validate

- Run `npm run docs` for documentation or Fern changes.
- Use normal repository hooks as the primary local verification.
- If hooks were skipped or unavailable, run `npm run check:diff`.
- Run any additional focused checks required by the changed documentation surface.
