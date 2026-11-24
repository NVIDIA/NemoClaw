<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Building a Derived Agent Image

You can extend a NemoClaw agent image with your own skills, tools, and files, then reference the result from a deployment by its digest.
NemoClaw doesn't build or host derived images.
Your own build system owns them.

## Starting From a Base Image by Digest

Derive from a NemoClaw agent image of the release you deploy with, pinned by digest:

```dockerfile
FROM registry.example.com/nemoclaw/agent-hermes@sha256:...
COPY skills /opt/example/skills
COPY --chmod=755 example-tool /usr/local/bin/example-tool
```

Use the base image digest from your release. For a harness without a release image, [build the image](build.md) and push it to your registry.
A local image ID such as `name@sha256:<id>` can't be used in `FROM`.
Use a registry digest or a local tag.

## Harnesses Without a Published Image

Check the [harness matrix](../references/fabric-harnesses.md) and the build targets in [`docker-bake.hcl`](../../docker-bake.hcl) before choosing a base image.

| What Is Available | What to Build |
| --- | --- |
| A build target, but no published image | Build that target on a native Linux host using [Building Agent Images](build.md#building-agent-images). For example, `cargo images build --platform linux/amd64 claude` builds Claude locally on AMD64. Local use does not grant permission to redistribute its proprietary CLI. |
| A Fabric adapter, but no NemoClaw image target | Use your own image build to install a compatible Fabric runtime, the adapter, and the harness version that adapter supports. Publish the installed adapter's canonical descriptor and runtime metadata in the image catalog, following the [image contract](../../internal-docs/design/fabric-management.md). |
| No Fabric adapter for the harness | Add the integration in Fabric first. Installing an executable or changing `harness.kind` alone does not provide an adapter. |

When adding or replacing an adapter, regenerate the image catalog from what you installed; a derived image's inherited label still describes its base image.
The [catalog maintenance guide](../../internal-docs/contributing/agent-image-maintenance.md) explains the descriptors and build inputs.
Keep the adapter's required executables and files available to its runtime and sandbox policy.
Your build owns the harness dependency pins, license notices, required sources, and redistribution permissions.

After building, reference the image by digest and select its advertised adapter ID as `harness.kind`.
For Kubernetes or OpenShift, export the image metadata as [Building Agent Images](build.md#building-agent-images) describes.
Run [one agent request](../agents-inference/agents.md#running-one-agent-request) to check the harness and model together; successful planning or apply does not establish a working model response.

## Keeping What NemoClaw Relies On

NemoClaw reads a small set of the base image's properties.
A derived image must keep them:

| Keep | Why |
|---|---|
| The `io.nemoclaw.fabric.catalog` label | NemoClaw reads it to find the image's harnesses and how to launch them; `FROM` copies it |
| `/opt/fabric`, including `/opt/fabric/bin/fabric-agent-ctl` | The sandbox's launch command and the NVIDIA NeMo Fabric runtime |
| The sandbox user, UID and GID `10001` | Files the agent writes, and mounted volumes, belong to this user |
| The image's platform | NemoClaw checks it against the engine before deploying |

Add files anywhere else.
Prefer paths outside `/sandbox`, which NVIDIA OpenShell manages as the sandbox's working area.

## Using Your Additions

Connect files added to the image through the agent's configuration.
Adding them to the image alone doesn't make the agent use them.
Connect each kind of addition as follows:

- **Skills:** List them in the agent's `skills.directories`, as a `folder` of skills such as `/opt/example/skills` or as a single `skill`, the way [skills on a mounted volume](../agents-inference/agents.md#skills-on-a-mounted-volume) does, using the path inside the image instead of a mount.
- **Tools:** Binaries on the agent's `PATH` are available to harnesses that run commands, within the sandbox policy.
- **Network access:** Your tools still get network access from the sandbox policy.
  [Grants](../security/sandbox-network.md) decide which hosts they can reach.

Reference the image by its digest in `sandboxes.<name>.image.ref`, as for any agent image.

## When Releases Change

Rebuild from the new release's base image when you upgrade NemoClaw.
See [compatibility](../references/compatibility.md).
NemoClaw doesn't compare Fabric versions: the image's own Fabric runtime reports an incompatibility when the agent starts.
An image from an older base can fail at apply with `sandbox unavailable`.
`openshell logs SANDBOX --source sandbox` shows why, for example a missing `fabric-agent-ctl`.

## What Fails Early

Inspect image and adapter validation before relying on a runtime request to discover an incompatible image.

| Problem | When and how it's reported |
|---|---|
| The catalog label is missing or empty | Plan fails with `Harness unavailable`, naming the `io.nemoclaw.fabric.catalog` label |
| The selected harness isn't in the catalog | Plan fails: the image doesn't provide the selected adapter |
| The image's platform doesn't match the engine | Plan fails: the image platform isn't the engine's |
| The image's Fabric runtime is incompatible | Apply fails when the agent starts, with Fabric's or OpenShell's error |
