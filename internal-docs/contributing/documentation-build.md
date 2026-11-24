<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Building and Publishing Documentation

Edit repository Markdown; Cargo generates the Fern pages and navigation from those sources.
The official site has separate v0 and v1 products. The v1 branch publishes `/nemoclaw/v1/` on staging and production.
Publication does not qualify the procedures or product configurations they describe.

## Sources and Outputs

| Input | Output or responsibility |
|---|---|
| [Page manifest](../../fern/pages.json) | Selects published guides, navigation labels, and stable route slugs |
| Repository `docs/*.md` and selected subdirectories | Generated `fern/_generated/pages/*.mdx` and `navigation.yml` |
| [Pinned main revision](../../fern/main-source.json) | Earlier guides, generated agent variants, changelog, components, and assets under ignored `fern/_main/` |
| SDK types and constraints | [JSON Schema](../../schemas/nemoclaw-v1alpha1.schema.json) and [configuration reference](../../docs/reference/configuration.md); stale checked-in output fails validation |
| [Fern configuration](../../fern/docs.yml) | Combined local preview, the NVIDIA theme, and retained legacy redirects |
| [Fern CLI pin](../../fern/fern.config.json) | The exact CLI used locally and in CI |

The [Cargo renderer](../../crates/nemoclaw-build/src/docs.rs) preserves code examples and license comments, removes the source H1 because Fern supplies the title, and converts file links to published routes.
It checks local files and Markdown heading anchors before replacing generated output.
Links to examples, code, notices, and unpublished design pages point to GitHub at the build's commit.
External URLs are retained without network validation.
Generated files are ignored by Git; do not edit them.

Both versions publish **Engineer Documentation for AI Agents** from `docs/resources/engineer-agentic-documentation.mdx` on main.
The v1 renderer reads the revision in `fern/main-source.json` and links to the referenced guides at that same revision on GitHub.

The [upstream notice](../../fern/NOTICE.md) records the main revision used for the publishing integration.
The publisher extracts main's documentation and generators at an immutable Git revision without changing another worktree.
It installs only the [locked docs dependency](../../tools/docs/main/package.json), `yaml`, in that extracted directory and runs the original generators with Node's TypeScript support.
Main's npm application dependencies are not installed.
The official v1 home reuses the v0 installation prompt and links to the v0 guides.
V1 runtime guidance remains in [agents.md](../../docs/agents-inference/agents.md), and [resources](../../docs/resources/resources.md#giving-an-agent-the-documentation-task) provides a version-aware documentation prompt.
The installation prompt has not been rehearsed ([#12644](https://github.com/NVIDIA/NemoClaw/issues/12644)).

To refresh Latest, update `fern/main-source.json` to a reviewed main commit, reconcile that revision's theme, components, and redirects in `fern/docs.yml`, and rerun the complete build.
Before a public release, select the main revision intended for publication; a main branch tip is not automatically its latest published release.
The first build fetches the pinned commit if it is absent locally.
To recover a damaged import, stop the preview server, remove only the generated `fern/_main/` directory, and rerun the build.

## Release Notes

The v1 [changelog overview](../../docs/changelog/overview.md) introduces the release series.
Fern displays each `docs/changelog/YYYY-MM-DD.md` file as a searchable entry.
Use the version as its heading, for example `## v0.1.0`.
Keep changes between release candidates in the [maintainer notes](release-candidates.md).

Before creating a final tag, [verify the release entry at the candidate commit](../../.agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md).
If the filename changes, redirect the draft entry URL to the published entry in `fern/docs.yml`.
Use the published release date for each subsequent entry.

## Validating Locally

Complete the Rust and `protoc` prerequisites in [build.md](../../docs/build-deploy/build.md).
Install Node.js 26.13.1 for the documentation tooling.
Node runs main's imported generators and the pinned Fern CLI through `npx`; the application remains a Cargo workspace with no root npm package.
The first Fern invocation downloads its npm dependencies.
CI uses the same Node version and main's pinned reviewed-npm setup action.

From the repository root:

```sh
cargo run --locked -p nemoclaw-build -- fern check
```

The command checks schema/reference freshness, generates both versions, checks generated output, and validates the combined Fern configuration.
V1 gets strict source/anchor and Fern route checks in an isolated copy of its version configuration.
Main retains its existing generated-content and published-route checks; Fern's strict link rule also flags legacy Markdown-download URLs and component links, so it is not applied to the imported version.
It needs no Fern token and publishes nothing.
If the schema is stale, follow [schema maintenance](configuration-schema.md); if a link fails, fix its source path or heading and rerun.

To inspect or compare only generated pages:

```sh
cargo run --locked -p nemoclaw-build -- docs
cargo run --locked -p nemoclaw-build -- docs --check
```

`--check` never writes files and rejects missing, changed, or obsolete output.
Repository links use `git rev-parse HEAD`; `--revision` accepts a full lowercase commit SHA for builds outside Git.
New source links become reachable on GitHub when that commit is pushed.

Run focused tooling tests after changing the generator or publisher:

```sh
cargo test --locked -p nemoclaw-build --test integration -- docs:: fern::
```

Also run the [repository checks](testing.md).

## Previewing Changes

For a local browser preview, install `pnpm` on `PATH`, as required by [Fern's development server](https://buildwithfern.com/learn/docs/preview-publish/preview-changes), then run:

```sh
cargo run --locked -p nemoclaw-build -- fern dev
```

Open the URL printed by Fern.
Use the version selector to switch between Latest and v1.
Without Fern authentication, local preview uses the checked-in styling without the shared NVIDIA global theme.
After editing repository Markdown, rerun `cargo run --locked -p nemoclaw-build -- docs` in another terminal; Fern watches the generated files.
Stop the local server with Ctrl-C.

To publish a shareable branch preview, provide `FERN_TOKEN` with access to the staging instance in the process environment:

```sh
cargo run --locked -p nemoclaw-build -- fern preview --id nemoclaw-v1-my-branch
```

This writes a remotely hosted preview; do not include secrets in documentation.
The preview builds the same [v1 product](../../fern/product.yml) as official staging. The preview link opens `/nemoclaw/v1/home`, and its v0 links open official staging.
The helper passes the token to Fern through the environment, does not store it in the repository, and prints the verified preview URL.
Unset a locally supplied token when finished.
Delete only the preview you own:

```sh
cargo run --locked -p nemoclaw-build -- fern delete --id nemoclaw-v1-my-branch
```

## GitHub Actions

The [v1 workflow](../../.github/workflows/docs.yml) validates every PR carrying the workflow, including stacked PRs targeting feature branches, and every push to `v1`.
This includes Rust changes that could stale the generated reference.
Manual runs perform validation only.

| Event | Publication |
|---|---|
| Same-repository PR targeting `v1` with `FERN_TOKEN` | Isolated v1 product at `nvidia-preview-nemoclaw-v1-pr-N.docs.buildwithfern.com/nemoclaw/v1/home`, linked in the PR comment |
| PR targeting another branch, fork PR, Dependabot PR, or PR without the token | Validation only |
| Push to `v1` | Publish the official v1 staging site, then delete associated merged v1 PR previews |
| Final `v0.1.<patch>` tag on a commit reachable from `origin/v1` | Publish the tagged guides to the [public v1 home](https://docs.nvidia.com/nemoclaw/v1/home) |
| `v0.1.*` release candidate | Validate the docs. Publication waits for the final tag. |
| `v0.0.<patch>` tag on the v0 release branch | The v0 release workflow publishes v0. The v1 workflow does not run. |

The [official v1 staging home](https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v1/home) uses the same home page and product selector as v0.
Staging and production use the same [product configuration](../../fern/product.yml). The v1 commit determines the guide sources and pins the v0 revision used for the home and header. Both builds publish under `/nemoclaw/v1`. The v0 workflow owns the parent site.
After publication, the **Verify official staging routes** step checks the v1 home redirect, release notes, Markdown endpoints, and v0 home.
Failed validation blocks publication.
Publication jobs run the build tool that validation compiled from the same commit, so they set up only Node and npm.
Rerun a failed publication job after correcting credentials or service availability.
Unmerged closed-PR previews require explicit deletion with the helper.

### Configuring Publication

1. Make `FERN_TOKEN` available to same-repository PR jobs for previews.
2. Create the `docs-v1-staging` environment and provide a token for the existing staging Fern instance.
3. Configure the `docs-v1-public` environment with a `FERN_TOKEN` that can publish to `nvidia-nemoclaw.docs.buildwithfern.com/nemoclaw/v1`. Apply the repository's release environment protections.
4. Before cutting a final v1 tag, verify the v1 staging pages and the [pinned layout revision](../../fern/main-source.json). The public job builds from the tag and publishes only the v1 product. A v0 release uses its own source, tag, and publisher.

Each v1 release updates the same public path, `https://docs.nvidia.com/nemoclaw/v1/`.
For a documentation rollback, revert the relevant source/configuration change on `v1`, validate staging, and publish a new release tag through the same ancestry guard.
The pinned main snapshot retains earlier guides, changelog files, and legacy redirect rules in the combined build.
Legacy routes on the hosted site have not been checked, and public rollback has not been rehearsed ([#12644](https://github.com/NVIDIA/NemoClaw/issues/12644)).
Main's separate post-merge documentation-authoring bot is not part of this publishing workflow.

## Hosted Outputs and Release Verification

Fern produces the browser site and [Markdown access](https://buildwithfern.com/learn/docs/ai-features/markdown), including page `.md` URLs and `llms.txt`.
For a publication candidate, verify the rendered overview, a code-heavy guide, a table in the configuration reference, a cross-page heading link, and a source link from that exact revision.
Fetch the v1 overview's `.md` URL and version-specific `llms.txt`; confirm they identify v1 and retain its qualification limits.
Repeat the Markdown checks on the hosted site to verify the published routes.

The [staging build for c7e8e116c8](https://github.com/NVIDIA/NemoClaw/actions/runs/35035121361) was checked on 2026-09-15:

| Hosted output | Observed result |
|---|---|
| `/nemoclaw/v1/overview` and main's `/nemoclaw/user-guide/openclaw/home` | HTTP 200 with the expected page titles |
| `/nemoclaw/v1/overview.md` and `/nemoclaw/v1/get-started.md` | Markdown includes the v1 procedure, qualification TBDs, and revision-pinned source links |
| `/nemoclaw/v1/reference/configuration.md` | Markdown includes configuration fields and tables, with source links pinned to `c7e8e116c8cb81ed64a0625f5b632398607c1d96` |
| `/nemoclaw/v1/llms.txt` | Identifies `v1 (Development)` and lists 31 page links under `/nemoclaw/v1/` |
| Unversioned `/nemoclaw/llms.txt` | Indexes the default main version; use the version-specific index for v1 discovery |

The preview moves with successful publication; repeat these checks for the release candidate.
The generic header on a v1 Markdown page can link to the unversioned index and advertise MCP.
Use the version-specific index explicitly; header text alone does not verify MCP availability or version-scoped search.
Checks of every rendered page, every legacy route and the public switch-over are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

Fern's [docs MCP server](https://buildwithfern.com/learn/docs/ai-features/mcp-server) requires Ask Fern to be enabled for the destination.
Provisioning, search indexing, MCP access and v1-scoped results are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).
Do not advertise a working v1 search or MCP endpoint based only on a successful local build.
