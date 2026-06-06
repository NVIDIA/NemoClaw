# Sandbox Image Hardening

The NemoClaw sandbox image applies several security measures to reduce attack surface and limit the blast radius of untrusted workloads.

## Removed Unnecessary Tools

NemoClaw explicitly purges build toolchains (`gcc`, `g++`, `make`) and network probes (`netcat`) from the runtime image.
These tools are not needed at runtime and would unnecessarily widen the attack surface.

The runtime image keeps a small set of operational utilities for normal sandbox workflows, including `vi`, `jq`, and `dos2unix`.
Use these utilities for lightweight inspection and file cleanup inside the sandbox, but make durable image or policy changes in the NemoClaw source tree and rebuild the sandbox.

If you need a compiler during build, use the existing multi-stage build.
The `builder` stage has full Node.js tooling.
Copy only artifacts into the runtime stage.

## Process Limits

The container ENTRYPOINT sets `ulimit -u 512` to cap the number of processes a sandbox user can spawn.
This mitigates fork-bomb attacks.
The startup script (`nemoclaw-start.sh`) applies the same limit.

Adjust the value with the `--ulimit nproc=512:512` flag if you launch with `docker run` directly.

## Dropping Linux Capabilities

The NemoClaw entrypoint drops dangerous capabilities from the process bounding set before it starts agent services.
It removes `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_NET_RAW`,
`CAP_DAC_OVERRIDE`, `CAP_SYS_CHROOT`, `CAP_FSETID`, `CAP_SETFCAP`,
`CAP_MKNOD`, `CAP_AUDIT_WRITE`, and `CAP_NET_BIND_SERVICE`.
When `setpriv` is available, the entrypoint also removes the remaining privilege-separation capabilities during the switch from root to the `sandbox` and `gateway` users.

The bounding-set drop is best effort: if `capsh` or `CAP_SETPCAP` is unavailable the entrypoint logs a warning and continues with the runtime-provided capability set.
If `setpriv` is unavailable, the entrypoint falls back to `gosu`.
To make the drop fail-closed instead, set `NEMOCLAW_REQUIRE_CAP_DROP=1` in the entrypoint environment: the agent then refuses to start unless the agent process tree's bounding set is verified free of the dangerous capabilities.
This is opt-in because hosts that cannot drop capabilities (no `CAP_SETPCAP` — many cloud VMs, Docker Desktop, WSL) are common, and the check covers the agent process tree only.

For defense-in-depth, also drop all Linux capabilities at the container runtime
when you launch the image directly:

```bash
docker run --rm \
    --cap-drop=ALL \
    --ulimit nproc=512:512 \
    nemoclaw-sandbox
```

### Docker Compose Example

```yaml
services:
  nemoclaw-sandbox:
    image: nemoclaw-sandbox:latest
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    ulimits:
      nproc:
        soft: 512
        hard: 512
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=64m
```

> **Note:** The `Dockerfile` itself cannot enforce `--cap-drop`. That is a
> runtime concern controlled by the container orchestrator. Always configure
> capability dropping in your `docker run` flags, Compose file, or Kubernetes
> `securityContext`.

## Filesystem Layout

The sandbox Landlock policy declares which paths are writable.
The agent's home directory (`/sandbox`) is writable by default:

| Path | Access | Purpose |
|------|--------|---------|
| `/sandbox` | read-write | Home directory where agents can create files and use standard home paths |
| `/sandbox/.openclaw` | read-write | Agent config, state, workspace, plugins |
| `/sandbox/.nemoclaw` | read-write (Landlock); DAC-restricted | Parent directory is `root:root` mode `1755`; the sandbox user can write only to `state/`, `migration/`, `snapshots/`, `staging/`, and `config.json`. `blueprints/` and the parent itself are root-owned to prevent tampering. |
| `/tmp` | read-write | Temporary files and logs |

The `Access` column reflects the Landlock policy declaration only.
Actual write success additionally requires POSIX (DAC) ownership and permissions to allow it.
For example, Landlock lists `/sandbox/.nemoclaw` as writable, but the sandbox user cannot create files directly under it because the parent directory is root-owned; writes must target the sandbox-owned subdirectories listed above.

This writable default is intentional.
Seeing the sandbox user create files under `/sandbox` or `/sandbox/.openclaw` in a fresh sandbox does not mean Landlock failed.
Landlock still enforces the fixed read-only system paths below.

System paths remain read-only to prevent agents from:

- Replacing system binaries with trojanized versions
- Modifying DNS resolution or TLS trust stores
- Tampering with libraries or shell configuration outside `/sandbox`

The image build pre-creates locked shell init files `.bashrc` and `.profile` without proxy entries.
System-wide shell hooks that read `/tmp/nemoclaw-proxy-env.sh` source the runtime proxy configuration.

### Landlock Kernel Requirements

Landlock LSM requires Linux kernel 5.13 or later with `CONFIG_SECURITY_LANDLOCK=y`.
The NemoClaw sandbox policy uses `compatibility: best_effort`, which means Landlock enforcement is silently skipped on kernels that do not support it.

On such kernels, protection falls back to DAC (file ownership and permissions) only.
Files outside the writable paths would be inaccessible to the agent regardless of DAC permissions.

Operators should verify Landlock availability:

```bash
ls /sys/kernel/security/landlock
```

For production deployments, kernel 5.13+ with Landlock enabled is strongly recommended.
The `test/e2e/e2e-cloud-experimental/checks/04-landlock-readonly.sh` script validates enforcement at runtime.

## References

- [#804](https://github.com/NVIDIA/NemoClaw/issues/804): Filesystem layout and Landlock policy
- [#807](https://github.com/NVIDIA/NemoClaw/issues/807): gcc in sandbox image
- [#808](https://github.com/NVIDIA/NemoClaw/issues/808): netcat in sandbox image
- [#809](https://github.com/NVIDIA/NemoClaw/issues/809): No process limit
- [#797](https://github.com/NVIDIA/NemoClaw/issues/797): Drop Linux capabilities
