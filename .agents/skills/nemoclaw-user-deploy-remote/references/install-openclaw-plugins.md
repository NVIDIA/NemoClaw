# Install OpenClaw Plugins

OpenClaw plugins extend the OpenClaw runtime with hooks, services, tools, or provider integrations.
They are different from NemoClaw-managed agent skills:

- **Plugins** are code packages loaded by OpenClaw.
- **Skills** are `SKILL.md` directories that teach an agent how to perform a task.
- **Policy presets** are network-egress rules that control what sandboxed code can reach.

The supported NemoClaw path for OpenClaw plugins is to bake the plugin into a custom sandbox image and onboard from that Dockerfile.

## Prepare a Build Directory

Put the Dockerfile and everything it needs to `COPY` in one directory.
`nemoclaw onboard --from <Dockerfile>` uses the Dockerfile's parent directory as the Docker build context.
Add a `.dockerignore` next to the Dockerfile to exclude local caches, generated artifacts, model files, or other paths that are not needed by the image build.
NemoClaw still applies its own secret-safety exclusions for credential-like paths such as `.env*`, `.ssh/`, `.aws/`, `.npmrc`, `secrets/`, `*.pem`, and `*.key`, even if `.dockerignore` negates them.

```text
my-plugin-sandbox/
├── Dockerfile
└── my-plugin/
    ├── package.json
    └── src/
```

## Example Dockerfile

Use the custom image to copy the plugin into the OpenClaw extensions directory and let OpenClaw refresh its config before NemoClaw starts the sandbox.

```dockerfile
ARG SANDBOX_BASE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
FROM ${SANDBOX_BASE}

COPY my-plugin/ /opt/my-plugin/
WORKDIR /opt/my-plugin
RUN npm ci --no-audit --no-fund && npm run build

RUN mkdir -p /sandbox/.openclaw/extensions \
 && cp -a /opt/my-plugin /sandbox/.openclaw/extensions/my-plugin \
 && openclaw doctor --fix

WORKDIR /opt/nemoclaw
```

If the plugin needs configuration in `openclaw.json`, apply it after `openclaw doctor --fix` so the base config exists first.

## Create the Sandbox

Point `nemoclaw onboard --from` at the Dockerfile in the build directory.

```bash
nemoclaw onboard --from ./my-plugin-sandbox/Dockerfile
```

If you need a second sandbox alongside an existing one, use a dedicated build directory and rerun onboarding with the sandbox name and ports you intend to use.

## Build Performance

Custom plugin images are normal Docker builds, so build time depends on the build context size and the Docker layer cache rather than on NemoClaw.

Keep the build context small and dedicated.
The Dockerfile's parent directory is staged as the build context before the Docker build starts, so a broad directory can make onboarding look stuck while Docker is only preparing context.
A small build directory stages quickly:

```text
my-plugin-sandbox/        # fast: only what the image needs
├── Dockerfile
├── .dockerignore
└── my-plugin/
```

A Dockerfile placed in a large tree stages slowly:

```text
~/                        # slow: stages the whole home directory
├── Dockerfile
├── Downloads/
├── datasets/
└── models/
```

Distinguish cold builds from warm rebuilds.
The first build on a fresh host is a cold build that downloads the base image and package indexes, so it is the slowest run.
Later warm rebuilds reuse cached layers when the base image and earlier layers are unchanged.

Order Dockerfile instructions from least-changing to most-changing so warm rebuilds reuse cached dependency layers:

1. Base image.
2. System package installs.
3. Dependency manifests such as `package.json`.
4. Dependency install such as `npm ci`.
5. Application source.

Pin the base image to an explicit tag or digest so warm rebuilds resolve the same cached base instead of pulling a new one.

When a build feels slow, set `NEMOCLAW_TRACE=1` before onboarding to capture phase timings that separate context staging, Docker build, image upload, and sandbox readiness.
For the full `--from` build-context rules and trace details, refer to CLI Commands Reference (use the `nemoclaw-user-reference` skill).

## Network Access

Plugins still run inside the sandbox policy boundary.
If a plugin needs network egress, add or update a policy preset for the required hostnames and binaries before rebuilding the sandbox.

For policy concepts, refer to Network Policies (use the `nemoclaw-user-reference` skill).
For custom preset workflows, refer to Customize Network Policy (use the `nemoclaw-user-manage-policy` skill).

## Common Mistakes

These are the most common places where plugin installation gets mixed up with other NemoClaw extension paths.

- Do not use `nemoclaw <sandbox> skill install` for OpenClaw plugins. That command only installs `SKILL.md` agent skills.
- Do not put a Dockerfile in a broad directory such as `/tmp` unless you intend to send that whole directory as the Docker build context.
- Do not rely on `.dockerignore` to include credential-like paths; NemoClaw excludes those from staged custom build contexts for safety.
- Keep plugin dependencies in the build stage or plugin directory; avoid copying
  unrelated host files into the sandbox image.

## Next Steps

- Review [Sandbox Hardening](sandbox-hardening.md) before adding plugin code to a shared or long-lived sandbox.
- Review Network Policies (use the `nemoclaw-user-reference` skill) to plan plugin egress rules.
- Follow Customize Network Policy (use the `nemoclaw-user-manage-policy` skill) if the plugin needs a custom preset.
