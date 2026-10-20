<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stage a v1 Release

v1 releases stay private until the installer, onboarding, and QA and product sign-off are ready ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638), [#13516](https://github.com/NVIDIA/NemoClaw/issues/13516)).
Staging assembles a release privately, so publishing it later is a final switch.

## Per-Commit Images

On each `v1` push that builds images, the [image workflow](testing.md#image-source-checks) pushes the agent and proxy images it checked to one package, as `ghcr.io/nvidia/nemoclaw/v1-ci:<image>-<commit>-<arch>`.
The package is internal: only members of NVIDIA's enterprise can pull it.

## Provision the Packages

A package that a workflow's token creates inherits this public repository's visibility, so the workflows never create one: they push only to packages that already exist and aren't public.
Before the first push, an organization administrator creates each package as internal and grants this repository's Actions write access:

- `v1-ci`, which holds every per-commit image.
- `v1/<image>` for each agent image (`claude`, `codex`, `deepagents`, `hermes`, `mini-swe-agent`, `nooa`, `nooa-bench`, `openclaw`, `pi`, `remote-agent`), and for `ollama-proxy`, `vllm`, and `ollama`.
- Create a package by pushing any image to it with a personal token that has `write:packages`; it starts internal.
- Then, in the package's settings under **Manage Actions access**, add `NVIDIA/NemoClaw` with the **Write** role.

A public package can't be made private again; delete it and create it again.
Until every package exists, `v1` pushes skip pushing images with a warning, and the staging workflow fails before it pushes anything.

## Stage From a Tag

Push a semver tag on a `v1` commit, starting with `v1.0.0-rc1`:

```sh
git tag v1.0.0-rc1 <commit>
git push origin v1.0.0-rc1
```

The [staging workflow](../../.github/workflows/release.yml):

1. Finds the latest commit in the tag's `v1` history with per-commit images, and checks with `nemoclaw-build changes images` that nothing since could change them; otherwise it builds and checks the images at the tag.
2. Builds the vLLM and Ollama runtime images on each native platform; their builds are reproducible.
3. Joins each image's ARM64 and AMD64 images into one index at `ghcr.io/nvidia/nemoclaw/v1/<image>:<tag>`, without rebuilding.
4. Creates a draft release listing every image digest, marked as a prerelease when the tag has one. Rerunning the workflow updates the draft; a published release is never changed.

Only users with push access see a draft release, and the `v1` packages stay internal.

## Test a Staged Release

Deploy with the digests the draft lists.
Docker deployments pull private images through `spec.registries`; Kubernetes deployments use `imagePullSecrets`.

## Publish

Publishing is manual: publish the draft, then make each `v1` package public in its package settings.
Making a package public can't be undone, and the organization's package policy may need an administrator.
Before publishing, complete the provenance, SBOM, scanning, and license work ([#13521](https://github.com/NVIDIA/NemoClaw/issues/13521), [#13522](https://github.com/NVIDIA/NemoClaw/issues/13522), [#13523](https://github.com/NVIDIA/NemoClaw/issues/13523), [#13524](https://github.com/NVIDIA/NemoClaw/issues/13524)).
