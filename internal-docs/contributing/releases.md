<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Staging a v1 Release

v1 releases stay private until the installer, onboarding, and QA and product sign-off are ready ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638), [#13516](https://github.com/NVIDIA/NemoClaw/issues/13516)).
Staging assembles a release privately, so publishing it later is a final switch.

## Per-Commit Images

On each `v1` push that builds images, the [image workflow](testing.md#image-source-checks) pushes the agent and proxy images it checked, and the reference image the live suites use, to one package, as `ghcr.io/nvidia/nemoclaw/v1-ci:<image>-<commit>-<arch>`.
The package is internal: only members of NVIDIA's enterprise can pull it.

## Provisioning the Packages

A package that a workflow's token creates inherits this public repository's visibility, so the workflows never create one: they push only to packages that already exist and aren't public.
Before the first push, a maintainer creates each package as internal, which makes them its administrator, and grants this repository's Actions write access:

- `v1-ci`, which holds every per-commit image. Grant it the **Admin** role instead, so the image workflow can delete per-commit images older than the latest ten commits.
- `v1/<image>` for each agent image (`claude`, `codex`, `deepagents`, `hermes`, `mini-swe-agent`, `nooa`, `nooa-bench`, `openclaw`, `opencode`, `pi`, `remote-agent`), and for `ollama-proxy`, `vllm`, and `ollama`.
- Create a package by pushing any image to it with a personal token that has `write:packages`; it starts internal.
- Then, in the package's settings under **Manage Actions access**, add `NVIDIA/NemoClaw` with the **Write** role.

A public package can't be made private again; delete it and create it again.
Until every package exists, `v1` pushes skip pushing images with a warning, and the staging workflow fails before it pushes anything.

## Staging From a Tag

Push a semver tag on a `v1` commit, starting with `v0.1.0-rc1`; the `v1` branch ships 0.1 releases.
Version tags are permanent: a repository rule forbids deleting them.

```sh
git tag v0.1.0-rc1 <commit>
git push origin v0.1.0-rc1
```

The [staging workflow](../../.github/workflows/release.yml):

1. Finds the latest commit in the tag's `v1` history with per-commit images, and checks with `nemoclaw-build changes images` that nothing since could change them; otherwise it builds and checks the images at the tag.
2. Builds the vLLM, Ollama, and llama.cpp runtime images on each native platform; their builds are reproducible.
3. Joins each image's ARM64 and AMD64 images into one index at `ghcr.io/nvidia/nemoclaw/v1/<image>:<tag>`, without rebuilding.
4. Creates a draft release listing every image digest, marked as a prerelease when the tag has one, and attaches the [CLI bundles](#cli-bundles), their [evidence record](#evidence-record), and each agent image's Kubernetes metadata bundle as `<image>.metadata.json`. Rerunning the workflow updates the draft; a published release is never changed.

Only users with push access see a draft release, and the `v1` packages stay internal.

## CLI Bundles

Pushing the tag also starts [CI / Bundle](../../.github/workflows/rust.yml) at the tag, and staging waits for it.
Staging attaches each platform's bundle as the latest push or manual run of CI / Bundle at the tag built and checked it, without rebuilding: `nemoclaw-<tag>-<platform>.tar.gz` for `linux_arm64`, `linux_amd64`, `darwin_arm64`, and `windows_amd64`, which extracts to `dist/<platform>`.
`SHA256SUMS` lists their SHA-256 checksums.
A bundle built from a clean checkout of a version tag reports the tag without its `v` as its version, in `nemoclaw --version` and its `manifest.json`, so the bundles of a run at the same commit without the tag don't count.
Any other bundle reports `0.1.0-dev.<hash>`, where the hash names its source files.
Until [signing](#signing) is configured, the executables are neither signed nor notarized ([#14621](https://github.com/NVIDIA/NemoClaw/issues/14621)).

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
| `windows_amd64` | Signs the programs the [inventory](#program-inventory) assigns to NVIDIA on Windows through Azure Artifact Signing, and checks them and the Helm provider's HashiCorp signature with `signtool verify /pa /all /tw`. Needs the environment's `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, and `AZURE_ARTIFACT_SIGNING_PROFILE` variables. |
| `darwin_arm64` | Checks that every program is notarized and signed as the [inventory](#program-inventory) assigns: by the Apple team in the environment's `APPLE_TEAM_ID` variable, or by HashiCorp's team `D38WU7D763` for the Helm provider. It doesn't sign yet, so listing `darwin_arm64` stops staging until the signing step lands. |

Staging puts the signed executables in their bundles with the bundles' file modes, records their new hashes in `manifest.json` with `nemoclaw-build reseal`, and then writes `SHA256SUMS`.
When a listed platform's signing job fails, staging stops before it drafts the release.

Linux is out of scope for OS code signing: Linux has no publisher check like Gatekeeper or SmartScreen.
A final release's [attestations](#verifying-provenance) authenticate the Linux archives, as they do the others.

### Final Releases Require Signing

A final release's tag has no prerelease suffix such as `-rc1`.
Its `darwin_arm64` and `windows_amd64` executables must be signed: `RELEASE_SIGNING` must list both platforms, and both signing jobs must pass.
Otherwise staging fails after packing the archives, before it pushes release images or drafts the release, and names the unsigned platforms.
Release candidates may stay unsigned.
Until the macOS signing step lands, a final release needs the exception below.

The only exception is the `RELEASE_UNSIGNED_EXCEPTION` repository variable, set to `<tag>:<reason>`, such as `v0.1.0:<reason>`.
It applies only to the tag it names and needs a reason.
Under it, staging publishes the unsigned platforms' archives, and the draft's notes name them and give the reason.

### Evidence Record

Staging attaches `release-evidence.json` to every release, for nSpect `NSPECT-SQ44-PJFM`.
It records:

- `version`, `commit`, and `run`: the tag, its commit, and the staging run's URL.
- `signing`: whether the release required signing, which of `darwin_arm64` and `windows_amd64` are unsigned, and the exception's reason, if one applied.
- `archives`: each archive's SHA-256, the programs NVIDIA signed in it with their SHA-256, and the output of the signing job's signature checks.
- `verification`: the output of `sha256sum --check --strict SHA256SUMS` over the final archives. Before it publishes a final release, the workflow adds the output of `gh attestation verify` for each archive and `SHA256SUMS`.

[`record-cli-signing.sh`](../../.github/scripts/record-cli-signing.sh) applies the signing rule and writes the record.

### Program Inventory

Each bundle holds these programs; everything else in it is data: `manifest.json`, the configuration schema, and licenses.

| Program | Bundle path | Built by | Upstream provenance | macOS signature | Windows signature |
|---|---|---|---|---|---|
| `nemoclaw` | `bin/` | NVIDIA, from this repository | Not applicable | NVIDIA | NVIDIA |
| NemoClaw providers `openshell`, `fabric`, `vllm`, `ollama`, `host` | `providers/registry.opentofu.org/nvidia/` | NVIDIA, from this repository | Not applicable | NVIDIA | NVIDIA |
| OpenTofu 1.13.9, `tofu` | `libexec/` | OpenTofu | `SHA256SUMS` and each archive have GPG and Sigstore cosign signatures. Upstream ships only an ad hoc macOS signature and no Authenticode signature. | NVIDIA | None, as upstream ships it |
| Docker provider 4.7.0, `kreuzwerker/docker` | `providers/registry.opentofu.org/kreuzwerker/docker/` | kreuzwerker | `SHA256SUMS` is GPG-signed with key `F31236BA85096E3AE22A8C660DCE698927DAF8EC`. Upstream ships only an ad hoc macOS signature and no Authenticode signature. | NVIDIA | None, as upstream ships it |
| Helm provider 3.3.0, `hashicorp/helm` | `providers/registry.opentofu.org/hashicorp/helm/` | HashiCorp | `SHA256SUMS` is GPG-signed with key `C874011F0AB405110D02105534365D9472D7468F`. | HashiCorp's Developer ID, team `D38WU7D763`, notarized | HashiCorp's timestamped Authenticode signature |

The build checks each upstream archive against its SHA-256 pin in [`versions.json`](../../versions.json); the Docker and Helm provider pins were checked against their GPG-signed `SHA256SUMS` when they were set.
The upstream signature details were read from the release files for these versions.

The last two columns are the [signing decision](https://github.com/NVIDIA/NemoClaw/issues/14621): NVIDIA signs the programs it builds on both platforms, and the Helm provider keeps HashiCorp's signatures.
On macOS, extracting a browser download quarantines every program, and Gatekeeper checks each quarantined program NemoClaw starts, so ad hoc signed programs stall; NVIDIA therefore signs OpenTofu and the Docker provider there too.
Signing them needs Product Security's approval, after their upstream provenance is checked and they are scanned.
On Windows, SmartScreen doesn't check programs that another program starts, so OpenTofu and the Docker provider stay unsigned; whether Smart App Control accepts them still needs a Windows host ([#14639](https://github.com/NVIDIA/NemoClaw/issues/14639)).

[`signing-inventory.sh`](../../.github/scripts/signing-inventory.sh) holds this decision: both signing jobs and the evidence record select programs through it, and it fails on a program it doesn't classify, so a new program needs a decision before it can ship.

## Testing a Staged Release

Use [image assessment](image-assessment.md) to evaluate the saved SPDX inventories.
Local assessment does not authorize publication.

Deploy with the CLI archive for your platform and the digests the draft lists.
Docker deployments pull private images through `spec.registries`; Kubernetes deployments use `imagePullSecrets`.

## Publishing

Push a final tag only from a commit whose release candidate has completed installer, onboarding, QA, and product sign-off; until then, the draft and packages stay private.
The workflow publishes a final release's draft without an approval step, once a release candidate of the same version staged the same images, the [security assessment](image-assessment.md#hosted-enforcement) passes, the registry digests are unchanged, and the [provenance](#verifying-provenance) of every image, CLI archive, and `SHA256SUMS` is attested.
Release candidates run the same assessment report-only and attach it to the private draft, so blocking findings surface before the final tag.
Publishing a draft by hand and package-administrator privileges bypass the workflow.
An administrator handles package visibility changes; making a package public cannot be undone.
Before pushing a final tag, complete the [license review](image-licenses.md) of every image the release publishes.

## Verifying Provenance

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

A final release also attests the build provenance of each CLI archive and of `SHA256SUMS`, for every platform.
Staging records their digests after it packs the signed executables, and the attestations cover those digests.
Before it publishes the draft, the workflow downloads the draft's archives and `SHA256SUMS`, verifies each attestation, and adds the output to the [evidence record](#evidence-record).
Verify a downloaded file the same way:

```sh
gh attestation verify nemoclaw-<tag>-<platform>.tar.gz --owner NVIDIA
gh attestation verify SHA256SUMS --owner NVIDIA
```

## SBOM Assets

Each image is scanned by the job that pushes it, with Syft 1.57.1: the image workflow scans each agent and proxy image it pushes on `v1`, and staging's runtime jobs scan the vLLM, Ollama, and llama.cpp images they build.
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
