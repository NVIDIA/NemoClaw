<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stage a v1 Release

v1 releases stay private until the installer, onboarding, and QA and product sign-off are ready ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638), [#13516](https://github.com/NVIDIA/NemoClaw/issues/13516)).
Staging assembles a release privately, so publishing it later is a final switch.

## Per-Commit Images

On each `v1` push that builds images, the [image workflow](testing.md#image-source-checks) pushes the agent and proxy images it checked, and the reference image the live suites use, to one package, as `ghcr.io/nvidia/nemoclaw/v1-ci:<image>-<commit>-<arch>`.
The package is internal: only members of NVIDIA's enterprise can pull it.

## Provision the Packages

A package that a workflow's token creates inherits this public repository's visibility, so the workflows never create one: they push only to packages that already exist and aren't public.
Before the first push, a maintainer creates each package as internal, which makes them its administrator, and grants this repository's Actions write access:

- `v1-ci`, which holds every per-commit image. Grant it the **Admin** role instead, so the image workflow can delete per-commit images older than the latest ten commits.
- `v1/<image>` for each agent image (`claude`, `codex`, `deepagents`, `hermes`, `mini-swe-agent`, `nooa`, `nooa-bench`, `openclaw`, `opencode`, `pi`, `remote-agent`), and for `ollama-proxy`, `vllm`, and `ollama`.
- Create a package by pushing any image to it with a personal token that has `write:packages`; it starts internal.
- Then, in the package's settings under **Manage Actions access**, add `NVIDIA/NemoClaw` with the **Write** role.

A public package can't be made private again; delete it and create it again.
Until every package exists, `v1` pushes skip pushing images with a warning, and the staging workflow fails before it pushes anything.

## Stage From a Tag

Push a semver tag on a `v1` commit, starting with `v0.1.0-rc1`; the `v1` branch ships 0.1 releases.
Version tags are permanent: a repository rule forbids deleting them.

```sh
git tag v0.1.0-rc1 <commit>
git push origin v0.1.0-rc1
```

The [staging workflow](../../.github/workflows/release.yml):

1. Finds the latest commit in the tag's `v1` history with per-commit images, and checks with `nemoclaw-build changes images` that nothing since could change them; otherwise it builds and checks the images at the tag.
2. Builds the vLLM and Ollama runtime images on each native platform; their builds are reproducible.
3. Joins each image's ARM64 and AMD64 images into one index at `ghcr.io/nvidia/nemoclaw/v1/<image>:<tag>`, without rebuilding.
4. Creates a draft release listing every image digest, marked as a prerelease when the tag has one, and attaches the [CLI bundles](#cli-bundles) and each agent image's Kubernetes metadata bundle as `<image>.metadata.json`. Rerunning the workflow updates the draft; a published release is never changed.

Only users with push access see a draft release, and the `v1` packages stay internal.

## CLI Bundles

Pushing the tag also starts [CI / Bundle](../../.github/workflows/rust.yml) at the tag, and staging waits for it.
Staging attaches each platform's bundle as the latest push or manual run of CI / Bundle at the tag built and checked it, without rebuilding: `nemoclaw-<tag>-<platform>.tar.gz` for `linux_arm64`, `linux_amd64`, `darwin_arm64`, and `windows_amd64`, which extracts to `dist/<platform>`.
`SHA256SUMS` lists their SHA-256 checksums.
A bundle built from a clean checkout of a version tag reports the tag without its `v` as its version, in `nemoclaw --version` and its `manifest.json`, so the bundles of a run at the same commit without the tag don't count.
Any other bundle reports `0.1.0-dev.<hash>`, where the hash names its source files.
The executables are neither signed nor notarized yet ([#14621](https://github.com/NVIDIA/NemoClaw/issues/14621)).

If CI / Bundle fails at the tag, staging fails before it pushes release images or drafts the release; rerun the failed jobs, then the staging workflow.
CI keeps a run's bundles for 7 days; after that, staging names the missing platforms.
Run CI / Bundle at the tag again, and rerun the staging workflow once it passes:

```sh
gh workflow run rust.yml --ref v0.1.0-rc1
```

### Signing

Staging signs a platform's executables only when a repository administrator lists the platform in the `RELEASE_SIGNING` repository variable, such as `windows_amd64`.
A job's `if:` can't read an environment's variables, so the repository variable turns signing on; the signing jobs run in the `release-signing` environment and read its variables.

| Platform | Signing job |
|---|---|
| `windows_amd64` | Signs every `.exe` through Azure Artifact Signing, appending NVIDIA's signature to the Helm provider's HashiCorp signature, and checks each with `signtool verify /pa /all /tw`. Needs the environment's `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, and `AZURE_ARTIFACT_SIGNING_PROFILE` variables. |
| `darwin_arm64` | Checks that every executable is notarized and signed by the Apple team in the environment's `APPLE_TEAM_ID` variable, or by HashiCorp's team `D38WU7D763` for the Helm provider. It doesn't sign yet, so listing `darwin_arm64` stops staging until the signing step lands. |

Staging puts the signed executables in their bundles with the bundles' file modes, records their new hashes in `manifest.json` with `nemoclaw-build reseal`, and then writes `SHA256SUMS`.
When a listed platform's signing job fails, staging stops before it drafts the release.

Don't list a platform before [#14628](https://github.com/NVIDIA/NemoClaw/issues/14628) is fixed: signing changes the bytes of providers whose versions stay the same, such as the Docker provider, and a deployment created with an unsigned bundle then fails on its dependency lock file.


## Test a Staged Release

Use [image assessment](image-assessment.md) to evaluate the saved SPDX inventories.
Local assessment does not authorize publication.

Deploy with the CLI archive for your platform and the digests the draft lists.
Docker deployments pull private images through `spec.registries`; Kubernetes deployments use `imagePullSecrets`.

## Publish

Push a final tag only from a commit whose release candidate has completed installer, onboarding, QA, and product sign-off; until then, the draft and packages stay private.
The workflow publishes a final release's draft without an approval step, once a release candidate of the same version staged the same images, the [security assessment](image-assessment.md#hosted-enforcement) passes, the registry digests are unchanged, and every image's [provenance](#verify-provenance) is attested.
Release candidates run the same assessment report-only and attach it to the private draft, so blocking findings surface before the final tag.
Publishing a draft by hand and package-administrator privileges bypass the workflow.
An administrator handles package visibility changes; making a package public cannot be undone.
Before pushing a final tag, complete the [license review](image-licenses.md) of every image the release publishes.

## Verify Provenance

A final release attests each image index's build provenance with a GitHub artifact attestation before it publishes the draft.
The attestation is signed through Sigstore's public-good instance, whose log is public, so release candidates get none.
It is stored beside the image in `ghcr.io` as an OCI referrer, so the index digest stays the one staging pushed; `ghcr.io` has no referrers API, so the image's package shows it under the tag `sha256-<index digest hex>`.

Verify an image by the index digest the release lists:

```sh
gh attestation verify oci://ghcr.io/nvidia/nemoclaw/v1/<image>@<digest> --owner NVIDIA
```

Add `--bundle-from-oci` to read the attestation from the registry instead of GitHub's API; the workflow verifies each attestation this way after creating it.
While the packages are internal, sign in with `docker login ghcr.io` first.
Platform manifests have no attestation of their own: verify the index that lists them.

## SBOM Assets

Each image is scanned by the job that pushes it, with Syft 1.57.1: the image workflow scans each agent and proxy image it pushes on `v1`, and staging's runtime jobs scan the vLLM and Ollama images they build.
Each scan reads the pushed platform manifest from the registry, so the SPDX document's subject is that manifest's digest; `v1-ci` keeps the document as `sbom-DIGEST`, and an unchanged image is never scanned again.
Staging copies each release platform's document from there.
It scans an image only when no recorded document names its digest, and records the result.
Each platform gets a digest-named SPDX 2.3 JSON asset; `sboms.json` maps each asset to its image reference, platform, and SHA-256 checksum.
Staging also retains `inventory.json` with each image's index digest and platform descriptors so assessment and publication can verify the same subjects.
The existing Kubernetes metadata bundles remain separate assets.
The scanner catalogs OS packages and installed Python and Node packages.
Runtime images retain the supervisor's `Cargo.lock` beside its source archive, and the proxy retains its package-specific `Cargo.lock`, so their Rust dependency inventories are discoverable without relying on binary metadata.
Those Rust entries describe the retained build sources, including build dependencies; they do not prove that each dependency is linked into the executable.
Image scanning cannot recover components whose upstream images contain neither package metadata nor recognizable binaries; inspect representative OS, Python, Node, and Rust entries before publishing.

The assets stay private with the draft: release candidates and internal packages publish nothing about their images.
No release attests the inventories yet ([#13521](https://github.com/NVIDIA/NemoClaw/issues/13521)).
A Syft failure fails the job that runs it, before staging uploads any SBOM asset; rerun it.
Assets are named by digest, so a rerun can't overwrite another image's inventory.
