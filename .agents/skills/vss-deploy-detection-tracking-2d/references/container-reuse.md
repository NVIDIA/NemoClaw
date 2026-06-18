# Container Reuse (Step 3 detail)

Before running `docker run`, check for an existing container using the same image and offer the user three options: reuse, restart, or parallel. Reuse is the fastest path — it skips the docker run entirely and goes straight to config apply + app start.

## Step 3.0 — Detect existing containers

```bash
EXISTING=$(docker ps --filter "ancestor=$RTVI_CV_IMAGE" --format \
    '{{.Names}}\t{{.Status}}\t{{.CreatedAt}}')
```

If `$EXISTING` is non-empty, inspect each match's mounts:

```bash
for name in $(docker ps --filter "ancestor=$RTVI_CV_IMAGE" --format '{{.Names}}'); do
    echo "--- $name ---"
    docker inspect "$name" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Type}}){{"\n"}}{{end}}'
done
```

**Required mounts for a reusable container:**

- `$HOME/rtvicv-storage` → `/opt/storage` (resources + engine cache + logs)
- `/tmp/.X11-unix` → `/tmp/.X11-unix` (only if `output_sink = eglsink`)

**DISPLAY env is NOT a reuse blocker.** Even if the existing container has `DISPLAY` unset, empty, or malformed (e.g. literal `1` instead of `:1`), the reused container is still viable — `docker exec -e DISPLAY=:N` at launch time (Step 5.b.2) overrides it. Do NOT reject a reuse just because `docker inspect ... .Config.Env` shows no `DISPLAY=`. The X11 socket mount is what matters.

## Step 3.0.5 — GPU health-check before the reuse decision

A container that's been "Up" for many hours can silently lose its CUDA / NVML handle after a host driver service restart, NVIDIA Container Toolkit re-init, or cgroup remount. `docker ps` still shows the container as healthy and mounts look fine, but `nvidia-smi` fails inside it with `Failed to initialize NVML: Unknown Error`. If the agent picks **Reuse** in this state, the perception app crashes at `Cuda failure: status=100` / `NvBufSurfaceGetDeviceInfoImpl: Error: Failed to get GPU info` ~30 s into Step 5 — long after the decision window has closed.

**Run the probe before the AskQuestion fires** (only when an existing matching container is found):

```bash
bash $SKILL_DIR/scripts/check_container_gpu.sh --container <NAME>
```

| Probe exit | Meaning | Agent action |
|------------|---------|--------------|
| `0` (`GPU_OK`)    | GPU visible inside the container — CUDA / NVML healthy. | Proceed to the normal AskQuestion (`Reuse / Restart / Parallel`). The probe's stdout line is a one-liner you can fold into the Step 3 box description. |
| `2` (`GPU_STALE`) | NVML init failed inside the container. Stale GPU handle. | **Hide the "Reuse" option** from the AskQuestion. Present only `Restart fresh / New parallel container`, with the description noting "existing container has lost GPU access (stale NVML); reuse is not viable". |
| `1`               | Wrong args / container not running — should not happen at this point. | Treat as a hard error; surface the script's stderr and stop. |

The probe runs in ~0.5 s on a healthy container and is read-only (`nvidia-smi -L` only — no CUDA work submitted), so adding it to the reuse path costs almost nothing on the happy path and saves a wasted ~30 s app launch on the unhappy one.

## AskQuestion — all required mounts present

```json
{
  "questions": [
    {
      "id": "container_action",
      "prompt": "Found existing container '<NAME>' running <IMAGE> with all required mounts. What should I do?",
      "options": [
        {"id": "reuse",    "label": "Reuse — skip docker run, apply configs and start the app inside this container (fastest)"},
        {"id": "restart",  "label": "Stop this container and relaunch a fresh one (clean slate)"},
        {"id": "parallel", "label": "Leave it running and start a NEW parallel container (different name + port)"}
      ]
    }
  ]
}
```

## AskQuestion — missing mounts (reuse not viable)

```json
{
  "questions": [
    {
      "id": "container_action_bad_mounts",
      "prompt": "Found existing container '<NAME>' but it's missing required mounts: <LIST>. What now?",
      "options": [
        {"id": "restart",  "label": "Stop this container and relaunch with correct mounts"},
        {"id": "parallel", "label": "Leave it alone and start a NEW container (different name + port)"}
      ]
    }
  ]
}
```

If nothing matching is running, skip directly to Step 3.1 (launch fresh).

## Action branches

All four use cases share the canonical name `rtvicv-perception-docker`.
The only branch that uses a different name is `parallel` (the user
explicitly opts in).

| Choice | What the skill does |
|---|---|
| **reuse**    | Skip 3.1/3.2. Use `CONTAINER_NAME="rtvicv-perception-docker"` as-is. If `RUNNING=0`, `docker start` it first; if `APP_RUNNING=1`, `pkill -TERM metropolis_perception_app` inside it. Go directly to Step 4 (apply config) and Step 5 (start app). Do NOT run `docker run`. |
| **restart**  | `docker stop rtvicv-perception-docker && docker rm rtvicv-perception-docker` → run 3.1 and 3.2 with the same name. |
| **parallel** | Launch in 3.2 with `CONTAINER_NAME="rtvicv-perception-docker-$(date +%Y%m%d_%H%M%S)"` and **different REST port** (`REST_API_PORT=9001`; update main config `[http-server] http-port=9001`). The original `rtvicv-perception-docker` keeps running on 9000. Tell the user both REST URLs. |

> **Always allocate a fresh port for parallel mode** — otherwise the new app will fail to bind `:9000` since the existing container already holds it on `--network=host`.

## Step 3 box and deploy log MUST show the full `docker run` equivalent

Regardless of which branch (`reuse` / `restart` / `parallel` / fresh
launch), the Step 3 exit box and the deployment log's "Docker Run
Command" section MUST show the **full equivalent `docker run …`
command** with all flags in effect — never a truncated `docker start
<name>`.

For **fresh launches** the agent already builds the command itself, so
just pass it through to `--docker-cmd "$DOCKER_RUN_CMD"`.

For **reuse / restart**, where there's no fresh `docker run` invocation,
synthesize the equivalent from the existing container:

```bash
DOCKER_CMD=$(bash $SKILL_DIR/scripts/synthesize_docker_run.sh <CONTAINER_NAME>)
```

The helper reads `docker inspect`, filters out image-baked env vars, and
emits a clean multi-line `docker run -d --name <c> --network=host
--gpus 'device=0' -e DISPLAY=:1 -v /home/.../rtvicv-storage:/opt/storage ...
<image>` ready for the deploy log. `start_app_in_container.sh` calls
this automatically when `--docker-cmd` is empty, so the deploy log is
always populated correctly.

The user reads the log later (sometimes weeks later, sometimes attached
to a bug report) and the full `docker run` is the load-bearing piece —
without it they can't reproduce the deployment context.

## What REUSE does NOT skip

Reusing an existing container only skips the docker-run portion. **All deployment parameters still need to be collected.** The running container gives us a GPU + DS runtime; it does NOT tell us what to deploy.

| Step | Reuse still runs it? | Why |
|---|---|---|
| 1  Use case                 | ✅ yes | Which model/pipeline to run is independent of the container |
| 2  Platform detect          | ✅ yes (auto-pass) | Already implied by the running container's arch — mark `completed` from `docker inspect` |
| 3  Image arch verify        | ⏭ skip | Container is running = image was already pulled and works |
| 4  NGC credentials          | ✅ yes | Needed for any downloads the reused container might not have |
| 5  NGC resource refs        | ✅ yes | Reused container doesn't "know" which NGC resource the user wants for this deploy |
| 6  Pipeline config          | ✅ yes | Batch size / sink / stream mode / input type are always deploy-specific |
| 7  Download / reuse NGC     | ✅ yes | Cache check still runs — may hit or download |
| 3.1 / 3.2 Docker run        | ⏭ skip | That's the whole point of reuse |
| 9  Apply config             | ✅ yes | Batch-size edits, sink toggle, model path substitution — all per-deploy |
| 4.f Use-case-specific setup  | ✅ yes | Sparse4D engine setup / GDINO trtexec may still run if different batch / use case |
| 10 Start app                | ✅ yes | App wasn't running the chosen config before; we're starting a new run |
| 5.0 Cache nvinfer engine   | ✅ yes | Still applies for warehouse-2d / smartcity-rtdetr |
| 5.a Deployment log         | ✅ yes | Each deploy run gets its own log file regardless of container reuse |

### Todo list update when the user picks reuse

The `image` slot is part of the consolidated `targets` todo (already
marked `completed` in Step 1). On reuse, mark `launch` `completed`
immediately as well:

```json
{
  "merge": true,
  "todos": [
    {"id": "launch", "status": "completed"}
  ]
}
```

> **Do NOT** mutate the `prepare` `content` to mention reuse — labels
> stay short and canonical. Print the reuse rationale on the scrollback
> as `✔ Container: reused rtvicv-perception-docker` (or
> `restarted rtvicv-perception-docker`).

### Note — perception app still running from previous deploy

If the previous deploy left the app running inside the container on port 9000, the new Step 5 launch will fail to bind. Before starting the new app:

1. `docker exec <NAME> pgrep -x metropolis_perception_app` — check if it's still running
2. If yes, **stop the existing app** inside the container first (`docker exec <NAME> pkill metropolis_perception_app`) before starting the new one
3. The container stays up; only the app process restarts with the new config

### Note — reusing a container for eglsink

When reusing an existing container for `output_sink=eglsink`, the container's `DISPLAY`/`XAUTHORITY` env may be wrong (e.g. a prior `docker run -e DISPLAY=1` stripped the `:`, or a fakesink-era container never had it set). This does NOT require a restart. The skill handles it at launch time by passing `DISPLAY` / `XAUTHORITY` via `docker exec -e` (see `start-app.md` § 5.b.1 pre-flight + § 5.b.2 launch).

The reuse flow must still verify that **`/tmp/.X11-unix` is mounted** — if it isn't, `-e DISPLAY=:N` can't help and the container needs `restart` (not `reuse`).

## Step 3.1 — Host prep (only if launching new: restart or parallel)

If `output_sink = eglsink`:

```bash
xhost +
export DISPLAY=${DISPLAY:-:0}
```

## Step 3.2 — Build and confirm the docker run command (only if launching new)

Build the docker run command from `platforms.md` matching `<platform>` and `<output_sink>`. Always include:

- `-v $HOME/rtvicv-storage:/opt/storage` (resources + engines + logs mount)
- Display flags (only if eglsink)
- `--name <CONTAINER_NAME>` (use the parallel-safe name if parallel mode)

Conditional mount:

Show the constructed command to the user and confirm before running:

```json
{
  "questions": [
    {
      "id": "launch_confirm",
      "prompt": "Ready to launch the container with this command?",
      "options": [
        {"id": "yes",  "label": "Yes, launch it"},
        {"id": "edit", "label": "No, let me change something"},
        {"id": "show", "label": "Just show the command, don't run (I'll run it myself)"}
      ]
    }
  ]
}
```

**Print after launch:** `Container <CONTAINER_NAME> is running. Entering for configuration...`
