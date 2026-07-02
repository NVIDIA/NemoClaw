---
name: nemoclaw-maintainer-release-notes
description: Drafts NemoClaw release notes from live GitHub tag and compare data. Produces the repo's narrative release-note style with three lead paragraphs, categorized shipped changes, why-it-matters bullets, and external-only contributor thanks. Use after cutting a release tag or when asked to draft release notes, prepare an announcement, write a changelog, or summarize v0.0.x.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Release Notes

Draft NemoClaw release notes from live release data. The house style is:

- three narrative lead paragraphs,
- a categorized list of shipped changes,
- one "what changed and why it matters / why we did it" bullet for every included shipped change,
- external-only contributor thanks,
- visible `#NNNN` GitHub links.

Create a local Markdown draft. Do not create or update a GitHub Discussion; the maintainer posts the announcement manually.

## Prerequisites

- You must be in the NemoClaw git repository.
- `gh` must be authenticated for `NVIDIA/NemoClaw`.
- The release tag should already exist. If the user is still cutting the tag, use `nemoclaw-maintainer-cut-release-tag` first.
- Use live GitHub and remote tag state, not memory or a stale local branch.
- If `<release-dir>/notes-data.json` exists from `npm run release:notes-data`, use it as the starting source of truth and query GitHub only to fill missing fields.
- If `notes-data.json` has `status: "partial"` or non-empty `pullRequestWarnings`, report those warnings and ask the maintainer whether to fetch or fill the missing PR metadata before drafting.

## Step 1: Verify the Release Range

Identify the current release tag and previous release tag. If the user gives only the current version, derive the previous semver tag from remote tags.

```bash
git ls-remote https://github.com/NVIDIA/NemoClaw.git \
  refs/heads/main \
  refs/tags/<previous-version> 'refs/tags/<previous-version>^{}' \
  refs/tags/<current-version> 'refs/tags/<current-version>^{}' \
  refs/tags/latest 'refs/tags/latest^{}'
```

Confirm:

- `<current-version>^{}` peels to the intended release commit.
- `latest` points to the same peeled commit unless the user explicitly says otherwise.
- The compare range is `<previous-version>...<current-version>`.

## Step 2: Collect the Shipped Surface

If `notes-data.json` exists, read it first. Otherwise, use the compare API as the first source of truth:

```bash
gh api repos/NVIDIA/NemoClaw/compare/<previous-version>...<current-version> \
  --jq '{status,ahead_by,total_commits,commits:[.commits[] | {sha:.sha, headline:(.commit.message|split("\n")[0]), author:.commit.author.name}], files:[.files[] | {filename,status,changes}]}'
```

For each PR number in commit headlines, collect live PR metadata:

```bash
gh pr view <number> --repo NVIDIA/NemoClaw \
  --json number,title,author,headRepositoryOwner,url,mergeCommit,labels,body,mergedAt
```

Also inspect any shipped commit that does not have a PR number in the headline. Include it only if it is a real shipped change worth announcing.

## Step 3: Decide What to Include

Include the shipped product, docs, release-surface, and CI confidence changes that a reader should know about.

For each included item, write:

- what changed,
- why it matters or why we did it,
- a visible PR link like `[#4474](https://github.com/NVIDIA/NemoClaw/pull/4474)`.

Be careful with sensitive internal cleanup:

- Do not count testing reverts or guardrail reversions as release value unless the user explicitly asks for a full raw changelog.
- If a revert-like commit must be mentioned, use neutral language and do not frame it as someone else's mistake.
- Avoid public wording that could embarrass a teammate.

## Step 4: Categorize the Changes

Use categories that match the release surface. Prefer 4-6 sections. Common categories:

- OpenClaw, Sandbox, and Network Stability
- Windows, WSL, and Onboarding Recovery
- Messaging and OpenClaw Runtime Activation
- Hermes and Inference
- Skills, Docs, and Release Surface
- CI and Release Confidence

Every included shipped change should appear in exactly one category unless the user asks for a shorter note.

## Step 5: Handle Contributor Credit

By default, thank external contributors only. Do not thank NVIDIA/internal contributors by GitHub ID unless the user explicitly asks.

Determine external contributors from live GitHub state:

```bash
for login in <github-logins>; do
  code=$(gh api -i orgs/NVIDIA/members/$login 2>/dev/null \
    | sed -n '1s/.* \([0-9][0-9][0-9]\).*/\1/p' || true)
  printf '%s %s\n' "$login" "${code:-unknown}"
done
```

Interpretation:

- `204` means the account is a visible member of `NVIDIA`.
- `404` means the account is not a visible member and should be treated as external for release-note thanks.

Replay PRs need special care:

- If a maintainer replayed an external PR, inspect the replay PR body and the original PR.
- Credit the original external GitHub username in the issue-level bullet for the shipped replay.
- Also thank that username in the final thanks section.
- Do not mention affiliations, organizations, domains, or companies unless the user explicitly asks. Use the GitHub username only.

Example:

```markdown
- [#4474](https://github.com/NVIDIA/NemoClaw/pull/4474) replays and narrows the Hermes Provider host-smoke fix originally contributed by @shannonsands in [#4385](https://github.com/NVIDIA/NemoClaw/pull/4385). ...

## Thank you

Thank you to external contributor @shannonsands for the original Hermes Provider smoke-check contribution in [#4385](https://github.com/NVIDIA/NemoClaw/pull/4385), which was replayed and narrowed into [#4474](https://github.com/NVIDIA/NemoClaw/pull/4474) for this release.
```

## Step 6: Draft the Narrative

Write the top section as exactly three paragraphs unless the user asks otherwise.

If the user requests a theme, let it shape the paragraphs. If the user asks for the voice of Carl Sagan, keep it subtle: cosmic scale, humility, clarity, and wonder, but no parody, no quotes, and no overdone imitation.

Suggested structure:

1. Stability theme and infrastructure/security boundary changes.
2. User-facing workflow stability: messaging, Hermes, inference, onboarding.
3. Maintenance stability: skills, docs, checks, and release confidence.

Keep the prose warm and polished, but concrete. Tie the narrative to actual PRs in the release range.

## Step 7: Write a Local Draft First

Create a Markdown draft outside the checkout root so the repo stays clean, for example:

```bash
../nemoclaw-<current-version>-release-note-draft.md
```

The Markdown body is the source the maintainer can paste into GitHub Discussions.

Stop here. The maintainer creates the GitHub Discussion and shares the announcement link.

## Output

For a draft-only run, return:

- Markdown draft path,
- a short note about the compare range and any excluded revert/test-cleanup items.

Also return the suggested discussion title: `NemoClaw <current-version> is out`.

## Hard Rules

- Never create or update a GitHub Discussion from this skill.
- Never draft from memory alone; use live `gh api compare` and PR metadata.
- Never mention contributor affiliation unless the user explicitly asks.
- Never thank internal contributors by default; keep thanks external-only.
- Never include testing reverts as release-value bullets unless explicitly asked for a raw changelog.
- Never create duplicate release Discussions.
