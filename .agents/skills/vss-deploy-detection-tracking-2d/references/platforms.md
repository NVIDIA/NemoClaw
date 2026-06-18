# Platform Reference

Docker launch commands and platform-specific setup for the RTVI-CV container.

## Placeholders

| Placeholder | Description |
|---|---|
| `<RTVI_CV_IMAGE>` | Full image reference, e.g. `nvcr.io/<org>/<repo>:<tag>` |
| `<GPU_INDEX>` | GPU device index. Default sourced from `assets/deploy-defaults.yml > runtime.gpu_id` (currently `0`). The skill captures it as `DEFAULT_GPU_ID` via `scripts/load_defaults.sh`. Override per-deploy by saying e.g. "run on gpu 1" in the skill query — that overrides the YAML default but does NOT mutate the file. |
| `<STORAGE_HOST>` | Host path for persistent storage (default `$HOME/rtvicv-storage`) |
| `<CONTAINER_NAME>` | Docker container name. Canonical: `rtvicv-perception-docker`. Only differs in the parallel-instance branch — see `container-reuse.md`. |

**Host vs container:** Persistent RTVI-CV data lives on the host at `~/rtvicv-storage` by default, or override with `<STORAGE_HOST>`. All docker run templates mount it as **`-v <STORAGE_HOST>:/opt/storage`** so resources, engines, and logs are accessed at **`/opt/storage`** inside the container.

**GPU selection default:** all docker-run templates use
`--gpus '"device=<GPU_INDEX>"'`. `<GPU_INDEX>` resolves to
`runtime.gpu_id` from `assets/deploy-defaults.yml` (default `0`).
Pinning the container to a specific GPU avoids claiming every device
on the host (which `--gpus all` would do, surprising users on shared
multi-GPU workstations). To target a different device, change
`runtime.gpu_id` in the YAML or override per-deploy by including
"on gpu N" in the skill query. For the rare case where the workload
needs every device, replace the whole flag with `--gpus all`.

---

## Platform Detection

The agent should detect platform before choosing a command:

```bash
ARCH=$(uname -m)                    # x86_64 / aarch64
IS_JETSON=0
[[ -f /etc/nv_tegra_release ]] && IS_JETSON=1
GPU_ARCH=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)
```

| Detection signal | Platform |
|---|---|
| `x86_64` and not Jetson | x86 dGPU |
| `aarch64` and `/etc/nv_tegra_release` present | Jetson (Thor/Orin/Xavier) |
| `aarch64` and NOT Jetson | SBSA (Spark, Grace-Hopper) |

Ask the user to confirm detection before proceeding.

---

## Privileged access (run once, before any `sudo` command below)

The docker-run and Jetson perf commands below use `sudo`. An agent cannot
type an interactive password, so on a host where `sudo` requires one these
commands hang or fail silently. Detect sudo capability up front and capture
the result in `$SUDO`:

```bash
# Self-contained: this snippet may run in a different shell than the Platform
# Detection block above, so re-derive IS_JETSON here (env vars don't persist
# across separate bash invocations) before the docker-group guard reads it.
IS_JETSON=0
[[ -f /etc/nv_tegra_release ]] && IS_JETSON=1

if sudo -n true 2>/dev/null; then
    SUDO="sudo"                       # passwordless sudo → proceed as-is
elif [ "$(id -u)" -eq 0 ]; then
    SUDO=""                           # already root → no sudo needed
elif docker info >/dev/null 2>&1 && [ "${IS_JETSON:-0}" -eq 0 ]; then
    SUDO=""                           # docker-group / rootless (x86/SBSA only — Jetson perf commands
                                      # nvpmodel, jetson_clocks, and governor writes require real root,
                                      # so Jetson docker-group hosts fall through to the recovery below)
else
    echo "✖ sudo requires a password and the agent cannot enter it." >&2
    echo "  Run this once in your terminal, then re-run the skill:" >&2
    echo "      sudo -v        # caches your sudo credential for ~15 min" >&2
    exit 1
fi
```

Use **`$SUDO`** in place of `sudo` in every command below. On passwordless /
root / docker-group hosts the resolved command is identical to today; only
password-required hosts now get a clear recovery handoff instead of a silent
hang.

---

## x86 / aarch64 (multi-arch dGPU)

Use the default multi-arch image tag for this platform.

```bash
$SUDO docker run --name=<CONTAINER_NAME> --network=host \
  --gpus "device=<GPU_INDEX>" --shm-size=6g \
  -v <STORAGE_HOST>:/opt/storage \
  -it --user root --rm \
  <RTVI_CV_IMAGE>
```

> **The container does NOT mount `~/.ngc`.** All NGC downloads run on
> the host via `scripts/fetch_resources.sh` (Step 1.g) BEFORE
> `docker run`. The fetched data lands in `~/rtvicv-storage/resources/`
> and is exposed inside the container by the existing
> `~/rtvicv-storage:/opt/storage` bind mount. The container never
> invokes `ngc registry`, so passing `~/.ngc` in would only increase
> credential exposure with no functional benefit.
>
> If you see a `-v $HOME/.ngc:/root/.ngc:ro` line in any old example
> below, treat it as obsolete and drop it.

---

## SBSA (Spark / Grace-Hopper)

Requires `--privileged`. Use the SBSA image variant.

```bash
$SUDO docker run --name=<CONTAINER_NAME> --network=host \
  --gpus "device=<GPU_INDEX>" --privileged --shm-size=6g \
  -v <STORAGE_HOST>:/opt/storage \
  -it --user root --rm \
  <RTVI_CV_IMAGE>
```

---

## Jetson Thor (and other Jetson devkits)

### Before launching (on the host)

Boost CPU/GPU and VIC clocks. Run **outside the container**:

```bash
$SUDO nvpmodel -m 0
$SUDO jetson_clocks
for p in /sys/class/devfreq/*.vic; do $SUDO sh -c "echo performance > $p/governor"; done
```

### Launch

```bash
$SUDO docker run --name=<CONTAINER_NAME> --network=host \
  --gpus '"device=<GPU_INDEX>"' --runtime nvidia --shm-size=6g \
  -v <STORAGE_HOST>:/opt/storage \
  -it --user root --rm \
  <RTVI_CV_IMAGE>
```

---

## Display-Enabled Launch (eglsink / visualization)

When the output sink is set to `eglsink` (visualization), X11 must be accessible
from inside the container.

### On the HOST (before docker run)

```bash
xhost +
export DISPLAY=:0    # or :1 depending on your X11 setup
```

### Add these flags to the docker run command

```bash
-e DISPLAY=$DISPLAY \
-v /tmp/.X11-unix:/tmp/.X11-unix \
```

Example (x86 dGPU with display):

```bash
$SUDO docker run --name=<CONTAINER_NAME> --network=host \
  --gpus "device=<GPU_INDEX>" --shm-size=6g \
  -v <STORAGE_HOST>:/opt/storage \
  -e DISPLAY=$DISPLAY \
  -v /tmp/.X11-unix:/tmp/.X11-unix \
  -it --user root --rm \
  <RTVI_CV_IMAGE>
```

---

## File-Dump Launch

When output sink is set to `filedump`, no special host setup is needed — output
files are written to `/opt/storage` inside the container, which is persisted to
`<STORAGE_HOST>` on the host.

---

## Inside the Container (NGC usage)

If `~/.ngc/config` was mounted into the container (recommended), NGC is already
configured — just create the resources dir and start downloading:

```bash
mkdir -p /opt/storage/resources
ngc config current    # verify (should print org/team without prompting)
```

If the mount was NOT used, the agent must configure NGC inside the container
(see `ngc-setup.md` > "Non-interactive config"). Prefer the mount approach so
the user is never prompted twice.

---

## Port Reference

| Port | Purpose |
|---|---|
| `9000` | RTVI-CV REST API (stream add/remove, health, metrics). Use `--network=host` or map `-p 9000:9000`. |
| Kafka (9092 default) | Optional — only if Kafka sink is enabled |
