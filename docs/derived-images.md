<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build a Derived Agent Image

You can extend a NemoClaw agent image with your own skills, tools, and files, then reference the result from a deployment by its digest.
NemoClaw doesn't build or host derived images; your own build system owns them.

## Start From a Base Image by Digest

Derive from a NemoClaw agent image of the release you deploy with, pinned by digest:

```dockerfile
FROM registry.example.com/nemoclaw/agent-hermes@sha256:...
COPY skills /opt/example/skills
COPY --chmod=755 example-tool /usr/local/bin/example-tool
```

NemoClaw doesn't publish base images yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)); until it does, [build them](build.md) and push them to your registry.
A local image ID such as `name@sha256:<id>` can't be used in `FROM`; use a registry digest or a local tag.

## Keep What NemoClaw Relies On

NemoClaw reads a small set of the base image's properties; a derived image must keep them:

| Keep | Why |
|---|---|
| The `io.nemoclaw.fabric.catalog` label | NemoClaw reads it to find the image's harnesses and how to launch them; `FROM` copies it |
| `/opt/fabric`, including `/opt/fabric/bin/fabric-agent-ctl` | The sandbox's launch command and the Fabric runtime |
| The sandbox user, UID and GID `10001` | Files the agent writes, and mounted volumes, belong to this user |
| The image's platform | NemoClaw checks it against the engine before deploying |

Add files anywhere else; prefer paths outside `/sandbox`, which OpenShell manages as the sandbox's working area.

## Use Your Additions

- **Skills:** point the harness configuration's `skills` paths at them, as in [skills on a mounted volume](agents.md#skills-on-a-mounted-volume), using the path inside the image instead of a mount.
- **Tools:** binaries on the agent's `PATH` are available to harnesses that run commands, within the sandbox policy.
- **Network access** for your tools still comes from the sandbox policy: [grants](sandbox-network.md) decide which hosts they can reach.

Reference the image by its digest in `sandboxes.<name>.image.ref`, as for any agent image.

## When Releases Change

Rebuild from the new release's base image when you upgrade NemoClaw; see [compatibility](compatibility.md).
NemoClaw doesn't compare Fabric versions: the image's own Fabric runtime reports an incompatibility when the agent starts.
An image from an older base can fail at apply with `sandbox unavailable`; `openshell logs SANDBOX --source sandbox` shows why, for example a missing `fabric-agent-ctl`.

## What Fails Early

| Problem | When and how it's reported |
|---|---|
| The catalog label is missing or empty | Plan fails with `Harness unavailable`, naming the `io.nemoclaw.fabric.catalog` label |
| The selected harness isn't in the catalog | Plan fails: the image doesn't provide the selected adapter |
| The image's platform doesn't match the engine | Plan fails: the image platform isn't the engine's |
| The image's Fabric runtime is incompatible | Apply fails when the agent starts, with Fabric's or OpenShell's error |
