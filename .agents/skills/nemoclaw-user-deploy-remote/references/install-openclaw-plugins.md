<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Install OpenClaw Plugins

OpenClaw plugins extend the OpenClaw runtime with hooks, services, tools, or
provider integrations. They are different from NemoClaw-managed agent skills:

- **Plugins** are code packages loaded by OpenClaw.
- **Skills** are `SKILL.md` directories that teach an agent how to perform a task.
- **Policy presets** are network-egress rules that control what sandboxed code can reach.

Today, the supported NemoClaw path for OpenClaw plugins is to bake the plugin
into a custom sandbox image and onboard from that Dockerfile.

## Prepare a Build Directory

Put the Dockerfile and everything it needs to `COPY` in one directory.
`nemoclaw onboard --from <Dockerfile>` uses the Dockerfile's parent directory as
the Docker build context.

```text
my-plugin-sandbox/
├── Dockerfile
└── my-plugin/
    ├── package.json
    └── src/
```

## Example Dockerfile

Use the custom image to copy the plugin into the OpenClaw extensions directory
and let OpenClaw refresh its config before NemoClaw starts the sandbox.

```dockerfile
ARG SANDBOX_BASE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
FROM ${SANDBOX_BASE}

COPY my-plugin/ /opt/my-plugin/
WORKDIR /opt/my-plugin
RUN npm ci --no-audit --no-fund && npm run build

RUN mkdir -p /sandbox/.openclaw-data/extensions \
 && cp -a /opt/my-plugin /sandbox/.openclaw-data/extensions/my-plugin \
 && openclaw doctor --fix

WORKDIR /opt/nemoclaw
```

If the plugin needs configuration in `openclaw.json`, apply it after
`openclaw doctor --fix` so the base config exists first.

## Create the Sandbox

Point `nemoclaw onboard --from` at the Dockerfile in the build directory.

```console
$ nemoclaw onboard --from ./my-plugin-sandbox/Dockerfile
```

If you need a second sandbox alongside an existing one, use a dedicated build
directory and rerun onboarding with the sandbox name and ports you intend to
use.

## Network Access

Plugins still run inside the sandbox policy boundary. If a plugin needs network
egress, add or update a policy preset for the required hostnames and binaries
before rebuilding the sandbox.

For example, see Network Policies (use the `nemoclaw-user-reference` skill) for
policy concepts and Customize Network Policy (use the `nemoclaw-user-manage-policy` skill)
for custom preset workflows.

## Common Mistakes

These are the most common places where plugin installation gets mixed up with
other NemoClaw extension paths.

- Do not use `nemoclaw <sandbox> skill install` for OpenClaw plugins. That
  command only installs `SKILL.md` agent skills.
- Do not put a Dockerfile in a broad directory such as `/tmp` unless you intend
  to send that whole directory as the Docker build context.
- Keep plugin dependencies in the build stage or plugin directory; avoid copying
  unrelated host files into the sandbox image.

## Next Steps

- Review Sandbox Hardening (use the `nemoclaw-user-deploy-remote` skill) before adding plugin code to a
  shared or long-lived sandbox.
- Review Network Policies (use the `nemoclaw-user-reference` skill) to plan plugin
  egress rules.
- Follow Customize Network Policy (use the `nemoclaw-user-manage-policy` skill)
  if the plugin needs a custom preset.
