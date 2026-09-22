<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build and Publish Documentation

Edit repository Markdown; Cargo generates the Fern pages and navigation from those sources.
Fern's version selector offers **Latest (main)** and **v1 (Development)** in one site.
Latest remains the default at its existing routes; v1 uses `/nemoclaw/v1/`.
Sections marked **TBD** remain visible in generated pages.
Publication does not qualify the procedures or product configurations they describe.

## Sources and Outputs

| Input | Output or responsibility |
|---|---|
| [Page manifest](../fern/pages.json) | Selects published guides, navigation labels, and stable route slugs |
| Repository `docs/*.md` and selected subdirectories | Generated `fern/_generated/pages/*.mdx` and `navigation.yml` |
| [Pinned main revision](../fern/main-source.json) | Earlier guides, generated agent variants, changelog, components, and assets under ignored `fern/_main/` |
| SDK types and constraints | [JSON Schema](../schemas/nemoclaw-v1alpha1.schema.json) and [configuration reference](reference/configuration.md); stale checked-in output fails validation |
| [Fern configuration](../fern/docs.yml) | NVIDIA theme, both versions, existing instances, and retained legacy redirects |
| [Fern CLI pin](../fern/fern.config.json) | The exact CLI used locally and in CI |

The [Cargo renderer](../crates/nemoclaw-build/src/docs.rs) preserves code examples and license comments, removes the source H1 because Fern supplies the title, and converts file links to published routes.
It checks local files and Markdown heading anchors before replacing generated output.
Links to examples, code, notices, and unpublished design pages point to GitHub at the build's commit.
External URLs are retained without network validation.
Generated files are ignored by Git; do not edit them.

The [upstream notice](../fern/NOTICE.md) records the main revision used for the publishing integration.
The publisher extracts main's documentation and generators at an immutable Git revision without changing another worktree.
It installs only the [locked docs dependency](../tools/docs/main/package.json), `yaml`, in that extracted directory and runs the original generators with Node's TypeScript support.
Main's npm application dependencies are not installed.
The imported installation prompt and agent variants appear only in Latest.
V1 runtime guidance remains in [agents.md](agents.md), and [resources](resources.md#give-an-agent-the-documentation-task) provides a version-aware documentation prompt.
A rehearsed installation prompt remains **TBD** until its procedure is verified.

To refresh Latest, update `fern/main-source.json` to a reviewed main commit, reconcile that revision's theme, components, and redirects in `fern/docs.yml`, and rerun the complete build.
Before a public release, select the main revision intended for publication; a main branch tip is not automatically its latest published release.
The first build fetches the pinned commit if it is absent locally.
To recover a damaged import, stop the preview server, remove only the generated `fern/_main/` directory, and rerun the build.

## Validate Locally

Complete the Rust and `protoc` prerequisites in [build.md](build.md).
Install Node.js 24.21.0 and Python 3.12 or newer for the documentation tooling.
Node runs main's imported generators and the pinned Fern CLI through `npx`; the application remains a Cargo workspace with no root npm package.
The first Fern invocation downloads its npm dependencies.
CI uses the same Node version and main's pinned reviewed-npm setup action.

From the repository root:

```sh
python3 tools/docs/fern.py check
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
cargo test --locked -p nemoclaw-build --test docs
python3 -B -m unittest discover -s tools/docs -p 'test_*.py'
```

Also run the [repository checks](testing.md).

## Preview Changes

For a local browser preview, install `pnpm` on `PATH`, as required by [Fern's development server](https://buildwithfern.com/learn/docs/preview-publish/preview-changes), then run:

```sh
python3 tools/docs/fern.py dev
```

Open the URL printed by Fern.
Use the version selector to switch between Latest and v1.
Without Fern authentication, local preview uses the checked-in styling without the shared NVIDIA global theme.
After editing repository Markdown, rerun `cargo run --locked -p nemoclaw-build -- docs` in another terminal; Fern watches the generated files.
Stop the local server with Ctrl-C.

To publish a shareable branch preview, provide `FERN_TOKEN` with access to the staging instance in the process environment:

```sh
python3 tools/docs/fern.py preview --id nemoclaw-v1-my-branch
```

This writes a remotely hosted preview; do not include secrets in documentation.
The helper passes the token to Fern through the environment, does not store it in the repository, and prints the verified preview URL.
Unset a locally supplied token when finished.
Delete only the preview you own:

```sh
python3 tools/docs/fern.py delete --id nemoclaw-v1-my-branch
```

## GitHub Actions

The [v1 workflow](../.github/workflows/docs.yml) validates every PR targeting `v1` and every push to `v1`, including Rust changes that could stale the generated reference.
Manual runs perform validation only.

| Event | Publication |
|---|---|
| Same-repository PR with `FERN_TOKEN` | `nemoclaw-v1-pr-N` preview, with one updated PR comment |
| Fork PR, Dependabot PR, or PR without the token | Validation only |
| Push to `v1` | Stable `nemoclaw-v1` preview; delete associated merged v1 PR previews after success |
| `v1.*.*` tag with public publication enabled | Both versions on the existing public site, after checking that the tagged commit is reachable from `origin/v1` |

The stable staging URL is `https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw` after its first successful publish.
It uses main's staging instance only in Fern preview mode; publishing it does not replace main's staging pages.
Failed validation blocks publication.
Rerun a failed publication job after correcting credentials or service availability.
Unmerged closed-PR previews require explicit deletion with the helper.

### Configure Publication

1. Make `FERN_TOKEN` available to same-repository PR jobs for previews.
2. Create the `docs-v1-staging` environment and provide a token for the existing staging Fern instance.
3. Create `docs-v1-public` with a token for `nvidia-nemoclaw.docs.buildwithfern.com/nemoclaw` and the desired environment protection rules.
4. Coordinate ownership of the shared `/nemoclaw` site with main's release publisher: retire its single-version publication job or update it to publish this same combined version set.
5. Review the pinned main revision and staging selector, then set the **repository** variable `FERN_V1_PUBLIC_ENABLED=true`.

Public publication is disabled while the variable is absent.
The workflow uses a repository variable because GitHub evaluates the job condition before loading environment variables.
The existing `docs.nvidia.com/nemoclaw` domain serves both versions.
Main's current single-version publisher would remove the v1 entry on its next release; coordination in step 4 is required before enabling this workflow.
That change on main and the shared-site cutover are **TBD**.
Changes to the public destination must update both the Fern configuration and the publisher, then repeat preview and release checks.

The v1 version entry is a moving documentation version, not a per-release archive.
For a documentation rollback, revert the relevant source/configuration change on `v1`, validate staging, and publish a new release tag through the same ancestry guard.
The pinned main snapshot retains earlier guides, changelog files, and legacy redirect rules in the combined build.
A complete hosted legacy-route sweep and a rehearsed public rollback remain **TBD**.
Main's separate post-merge documentation-authoring bot is not part of this publishing workflow.

## Hosted Outputs and Release Verification

Fern produces the browser site and [Markdown access](https://buildwithfern.com/learn/docs/ai-features/markdown), including page `.md` URLs and `llms.txt`.
For a publication candidate, verify the rendered overview, a code-heavy guide, a table in the configuration reference, a cross-page heading link, and a source link from that exact revision.
Fetch the v1 overview's `.md` URL and version-specific `llms.txt`; confirm they identify v1 and retain its qualification limits.
The local Fern server does not serve page `.md` previews; use a hosted preview for this check.

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
Complete rendered-page/legacy-route coverage and public-cutover verification remain **TBD**.

Fern's [docs MCP server](https://buildwithfern.com/learn/docs/ai-features/mcp-server) requires Ask Fern to be enabled for the destination.
Provisioning, search indexing, MCP access, and checks that results stay within v1 are **TBD**.
Do not advertise a working v1 search or MCP endpoint based only on a successful local build.
