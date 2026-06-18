# Environment, Secrets, Mounts & GPU Selection

Reference for everything the host must provide before `docker run`: credentials,
storage layout, environment variables, GPU selection, and port mapping.

---

## Required Secrets & Credentials

| Env var / file       | Purpose                                                | Where to get                                                | Format          |
|----------------------|--------------------------------------------------------|-------------------------------------------------------------|-----------------|
| `NGC_API_KEY`        | Pull image from `nvcr.io`, download NGC models/videos  | <https://ngc.nvidia.com/setup/api-key>                      | ~80 char token  |
| `~/.ngc/config`      | NGC CLI config — written by skill on first run         | Derived from `NGC_API_KEY`                                  | INI file (0600) |
| `RTVI_CV_IMAGE`      | Full Docker image reference                            | Provided by user or release notes                            | `nvcr.io/<org>/<repo>:<tag>` |

The skill writes `~/.ngc/config` with permissions `0600`. The container itself
never receives a `~/.ngc` mount — all NGC downloads run on the host via
`scripts/fetch_resources.sh` and the resulting files are staged into
`~/rtvicv-storage/resources/`.

---

## Required Volume Mounts

Create the storage tree before `docker run`:

```bash
mkdir -p ~/rtvicv-storage/resources \
         ~/rtvicv-storage/engines \
         ~/rtvicv-storage/logs
```

| Host path             | Container path        | Purpose                      | Stateful? |
|-----------------------|-----------------------|------------------------------|-----------|
| `~/rtvicv-storage`    | `/opt/storage`        | Resources, engines, logs     | yes       |
| `/tmp/.X11-unix`      | `/tmp/.X11-unix`      | X11 — **`eglsink` only**     | no        |

---

## Required Environment Variables

| Var               | Required                | Default | Notes                                       |
|-------------------|-------------------------|---------|---------------------------------------------|
| `RTVI_CV_IMAGE`   | yes                     | —       | Full image reference; set before `docker run` |
| `NGC_API_KEY`     | only if NGC assets used | —       | Used for `docker login nvcr.io` and NGC CLI |

No runtime env vars are required inside the container — all configuration is
applied to INI/YAML files under
`/opt/nvidia/deepstream/.../reference-configs/<use-case>/`.

---

## Optional / Feature-Flag Environment Variables

| Var                       | Default            | Notes                                                        |
|---------------------------|--------------------|--------------------------------------------------------------|
| `NVIDIA_VISIBLE_DEVICES`  | from `--gpus`      | Override per-container GPU selection                         |
| `REST_API_PORT`           | `9000`             | Change `[http-server] http-port` in `ds-main-config.txt`     |
| `DISPLAY`                 | host `$DISPLAY`    | Required for `eglsink`; pass via `-e DISPLAY=$DISPLAY`       |
| `XAUTHORITY`              | `/root/.Xauthority`| Required for `eglsink` inside container                      |
| `LD_LIBRARY_PATH`         | —                  | **warehouse-3d only**: must include the Sparse4D repo lib path |
| `FORCE_ENGINE_REBUILD`    | `0`                | Set to `1` to bypass engine cache and force a TRT rebuild    |

---

## GPU Selection & Hardware

```bash
# Default — pin to GPU 0 (single-GPU systems and the common case on
# multi-GPU hosts where the user wants a deterministic device).
docker run --gpus '"device=0"' ...

# Specific GPU by index (multi-GPU host, pick a non-default device)
docker run --gpus '"device=1"' ...

# Multiple specific GPUs
docker run --gpus '"device=0,1"' ...

# Specific GPU by UUID (most precise — survives index changes after
# host reboot or driver reload)
docker run --gpus '"device=GPU-<uuid>"' ...

# All GPUs — only when you genuinely need every device on the host
docker run --gpus all ...

# Jetson / SBSA — use --runtime nvidia, then --gpus picks visibility
docker run --runtime nvidia --gpus '"device=0"' ...
```

**Default for the vss-deploy-detection-tracking-2d skill: `--gpus '"device=$DEFAULT_GPU_ID"'`.**
`DEFAULT_GPU_ID` is emitted by `scripts/load_defaults.sh` from
`assets/deploy-defaults.yml > runtime.gpu_id` (ships at `0`).
Pinning a specific device avoids accidentally claiming every GPU on
a multi-GPU host (a common surprise during smoke-testing on a shared
workstation). The agent uses the YAML value unless the user
explicitly asks for a different device (e.g. "run on gpu 1") or for
`all`. Per-deploy overrides do NOT mutate the YAML.

Verify the image's CUDA architecture support against your GPU:

```bash
nvidia-smi --query-gpu=compute_cap --format=csv,noheader
```

Images are built against CUDA 12.x and target SM 7.5+ (Turing and newer).

---

## Port Conflict Map

| Container port | Default host bind          | Conflict scenario                                     | Remap                                          |
|----------------|----------------------------|-------------------------------------------------------|------------------------------------------------|
| `9000`         | `9000` (via `--network=host`) | Another RTVI-CV instance or dashboard on same host | Set `[http-server] http-port=9001` in `ds-main-config.txt` |
| `9092`         | `9092`                     | Kafka (only if Kafka sink is enabled)                 | Change `cfg_kafka.txt` broker address          |

For parallel deploys, give each container its own `http-port` and a different
container name — see `references/container-reuse.md`.

---

## Dry Run / Pre-flight

```bash
# Verify image exists and matches platform arch
docker manifest inspect "$RTVI_CV_IMAGE" 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
              print([m['platform']['architecture'] for m in d.get('manifests',[])])"

# Test NGC auth before downloading.
# IMPORTANT: pipe the API key via stdin (--password-stdin). Passing the
# token as `-p "$NGC_API_KEY"` would expose it in `ps aux` and shell
# history — never use that form even in examples.
printf '%s' "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin \
  && echo "auth OK"
ngc config current && echo "NGC config OK"
```

To preview the full `docker run` command without launching it, pass `--dry-run`
in your skill query.
