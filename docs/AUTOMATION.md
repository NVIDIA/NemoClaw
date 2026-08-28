<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Documentation Automation Contracts

This file owns contributor-facing contracts for generated documentation, routes, and publishing.

## Updating the Changelog

The native Fern changelog under `docs/changelog/` is the release history.
One source directory is shared by every configured user-guide variant.
The end-of-day flow merges the planned release entry. Follow
[Post-Merge Documentation Catch-Up](#post-merge-documentation-catch-up) for the release-cutoff
procedure and documentation coverage decision.

For each release:

- Add the complete release entry to `docs/changelog/YYYY-MM-DD.mdx`, using the release date as the filename.
- Start the entry with an H2 version heading such as `## v0.0.83`.
- If more than one release ships on the same date, put each version in the same file with the newest version first.
- Include the summary and detailed bullets in the dated file; do not create separate variant-specific Release Notes pages.
- Use literal CLI names instead of the `$$nemoclaw` variant placeholder because native changelog files do not pass through agent-variant generation.
- Use root-absolute published routes for internal links in dated entries.
  Generic links should target the OpenClaw route under `/user-guide/openclaw/`; agent-specific links should target the corresponding Hermes, Deep Agents, or Pi route.
- Use MDX comment syntax (`{/* ... */}`) for the SPDX header; HTML comments do not parse in Fern changelog entries.
- Keep every dated entry directly under `docs/changelog/`; Fern does not support subdirectories there.

Follow [documentation validation](CONTRIBUTING.md#validate-the-change) after adding or changing the release entry.

## Post-Merge Documentation Catch-Up

When an independently reviewed cumulative patch changes documentation, the workflow creates or
refreshes one draft documentation PR for merged changes after the latest release tag. The PR title
names the next patch tag. Its body names both tags, identifies the reviewed `main` boundary, states
the current branch owner, and links to this procedure.

Later pushes to `main` refresh the same cumulative patch when they change a path outside `docs/**`,
`fern/docs.yml`, and `fern/assets/**`.
Automation refreshes the patch only while it owns the draft PR.
Documentation-only pushes do not trigger catch-up.
The workflow creates no PR for an empty documentation patch.
It leaves a ready-for-review PR unchanged.
The publisher uses fast-forward-only updates.
It stops when a person changes the branch or PR metadata.
It never force-pushes.
When a person changes the title or body of a managed draft PR, the publisher reports the PR URL and
fails. Restore the previous workflow-authored title and body from the PR edit history to resume
cumulative updates on the next qualifying push. To take ownership instead, mark the PR ready for
review; later workflow runs leave it unchanged. When a person changes the managed branch, mark the
PR ready for review before continuing the change because automation does not overwrite that branch.
The publisher also leaves a draft with previous workflow metadata unchanged. It reports the PR URL
and stops without writing. Close that legacy draft so a later qualifying push can create a current
workflow-owned draft, or mark it ready for review to transfer ownership to maintainers.

### Recover an Orphaned Managed Branch

If draft PR creation fails after branch creation, the publisher reports the exact branch and commit.
It also logs that pair immediately after branch creation so a cancelled or timed-out run retains the
recovery identity. Recover without deleting the branch:

1. Cancel and wait for other in-progress `Docs / Author Post-Merge Catch-Up` runs. Do not start
   another run during recovery.
2. Rerun the failed or cancelled workflow for the same triggering `main` commit. The publisher
   validates the deterministic branch, its verified workflow-created commit, and its parent before
   it creates or reconciles the draft PR.
3. Confirm that exactly one draft PR is attached to the reported branch. Stop if the publisher
   reports an unmanaged branch or changed commit; do not delete or overwrite it.

The [post-merge automation guide](../tools/post-merge-docs/README.md) owns its credential boundary.

At release cutoff, follow the canonical maintainer
[release-train policy](https://github.com/NVIDIA/NemoClaw/blob/main/.agents/skills/nemoclaw-maintainer-policies/references/release-train.md#release-prep-docs).
That policy owns the documentation coverage evidence, maintainer decision, and tag procedure.

## Local Fern Tooling

Repository npm scripts use the Fern CLI version pinned in `fern/fern.config.json`. Run
`npm run docs:deps` to print that version.

Before publishing a preview, authenticate Fern with permission to publish to the selected staging instance.
Repository automation supplies `FERN_TOKEN`; local contributors can use that variable or another Fern-supported authentication method.

Run `npm run docs:preview:watch` to publish a branch preview and watch `docs/` and `fern/` for
changes. The current branch name becomes the preview ID. The default instance is
`nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw`. Override it with
`FERN_STAGING_INSTANCE=<hostname>/<path>`. Invalid or empty override segments fail before Fern starts.

## Publishing Docs

GitHub Actions publishes Fern docs from the same source files that `npm run docs` validates locally.

Docs PRs get Fern previews when they change `docs/`, `fern/`, or docs build inputs.
The preview workflow publishes to the staging Fern instance with a `pr-<number>` preview ID and posts the preview URL on the PR when `FERN_TOKEN` is available.

After a docs PR merges, pushes to `main` publish the affected docs to the staging Fern instance.
The staging publish job regenerates agent variants, validates Fern docs, publishes staging, and deletes the merged PR preview when it can map the merge commit back to a PR.

Public docs publish automatically when a `v*.*.*` release tag is pushed.
The public publish job runs in the `docs-public` environment, verifies that the tag commit is reachable from `origin/main`, regenerates agent variants, validates Fern docs, and publishes to the public Fern instance.
If the tag does not point to a commit on `main`, the job stops before installing dependencies or running Fern.

## Starter Prompt Generation

The coding-agent installation prompt lives in `docs/resources/starter-prompt.md`.
Edit that Markdown file instead of placing prompt text in a React component.
Keep conditional platform instructions in focused Markdown files under `docs/resources/prompt-assets/` and link to their raw GitHub URLs from the starter prompt.
The main prompt should tell the coding agent when to load each asset and should not repeat the asset's detailed instructions.
Use one shared immutable commit SHA for every platform-asset URL in a starter-prompt revision.
The contributor who changes any platform asset owns the corresponding pin update.
First commit the updated assets, starter-prompt behavior, and related tests without changing the existing URLs, `promptAssetRevision`, or pinned SHA-256 values.
Then use that commit's SHA in every platform-asset URL, update `promptAssetRevision` and every pinned SHA-256 value in `test/generation/starter-prompt-docs.test.ts`, and commit the repin as one atomic follow-up.
Never mix asset URLs from different revisions or point an asset URL at a commit that predates its content.
The asset test compares each local file byte-for-byte with its Git blob at `promptAssetRevision`, so the intermediate content commit intentionally fails until the atomic repin follow-up points every URL, revision, and digest at that content commit.
Updating only a local digest does not prove what the pinned revision contains.
Downstream consumers can pin the source with a raw URL such as
`https://raw.githubusercontent.com/NVIDIA/NemoClaw/<commit-sha>/docs/resources/starter-prompt.md`.
The Markdown SPDX comment is part of that raw file but does not appear when Markdown is rendered.

The `scripts/generate-starter-prompt.mts` script removes the Markdown SPDX preamble and writes `docs/_build/StarterPrompt.generated.mdx`.
The generated snippet wraps the prompt in Fern's native visible `Prompt` component, which displays the prompt body and supplies the copy button.
The generated file is ignored by Git and is recreated by the docs build.

Run the generator directly when you need to inspect the generated snippet:

```bash
npm run docs:sync-starter-prompt
```

Run the read-only comparison after generation when you need to verify that the snippet matches the Markdown source:

```bash
npm run docs:check-starter-prompt
```

The shared `npm run docs:prepare` step generates the Starter Prompt and agent variants.
The normal `npm run docs`, `npm run docs:live`, agent-variant sync, preview-watcher, and docs publish workflows run that step before Fern validates, serves, previews, or publishes the pages that include the prompt.

## Agent Variant Generation

Some Fern pages appear in the OpenClaw, Hermes, Deep Agents, and Pi guide variants.
The `scripts/sync-agent-variant-docs.mts` script reads `docs/index.yml` and renders variant-specific copies for every page that appears in multiple guide variants before Fern validates or publishes the site.
The source pages stay in their normal `docs/` locations, and generated pages are written under `docs/_build/agent-variants/`, which is ignored by Git.
Navigation in `docs/index.yml` points Fern at generated pages for shared entries so Fern still renders normal fenced code blocks with copy buttons and syntax highlighting.
OpenClaw-only, Hermes-only, Deep Agents-only, or Pi-only pages stay as source pages in navigation.

Determine page applicability from the implementation, tests, or accepted product scope before adding or moving navigation entries.
Do not use the current navigation tree as evidence that a page is agent-specific.
Publish a shared source page through generated navigation targets in every applicable variant.
The established shared scope is OpenClaw, Hermes, and Deep Agents. A page in that complete scope can omit `agent-variants`. When a page has a narrower scope or appears in the Pi guide, declare the exact subset in frontmatter, for example `agent-variants: ["openclaw", "hermes"]` or `agent-variants: ["pi"]`.
The sync command fails when a subset declaration is missing or differs from navigation membership.

When shared page content is the same except for the host CLI binary, write one source page and use `$$nemoclaw` as a build-time placeholder.
Do not duplicate fenced code blocks or inline command examples only to switch among `nemoclaw`,
`nemohermes`, and `nemo-deepagents`.
Use literal command names on those single-variant pages rather than `$$nemoclaw`, because no generated page will rewrite the placeholder.

Run `npm run docs:sync-agent-variants` after editing shared variant source pages or navigation.
Run `npm run docs` before opening a PR to verify the generated pages, rewritten relative links, and Fern navigation.
Update `docs/index.yml` when navigation, slugs, or page placement changes.
If content differs by behavior, setup flow, state layout, or agent-specific wording, keep using `<AgentOnly>` blocks for that content.
Treat `<AgentOnly>` as a build-time directive rather than a React component, and do not import it from `AgentGuide.tsx`.
Put each opening and closing tag at the first column on its own line, and do not nest the blocks.
Keep a section heading inside the `<AgentOnly>` block that holds its body, or the heading renders in every variant with nothing beneath it.
The sync command fails when a generated variant leaves a heading without content.
The generated pages must contain only statically resolved content, with no `AgentGuide` imports or runtime agent components.

Before review, render every guide variant that uses a changed shared page.
Confirm that commands, paths, state locations, and capabilities are correct in each variant.
State when a variant has no equivalent operation.

## Route-Style Links

Fern links between docs pages should use route-style paths, not filesystem paths.
Route-style paths omit the `.mdx` extension and follow the page slugs declared in `docs/index.yml`.
For example, a source page under `docs/get-started/` should link to the OpenClaw quickstart as `../quickstart`, not `quickstart.mdx`.
The published route comes from the navigation hierarchy and page `slug`, not directly from the file path.

This matters for generated agent variants because shared source pages may not appear directly in `docs/index.yml`.
The navigation can point Fern at generated pages under `docs/_build/agent-variants/`, while the source MDX remains in its normal folder.
The link checker maps those generated nav entries back to their source paths when validating route-style links.
Do not convert route-style links to `.mdx` file links just to satisfy a local filesystem check.
