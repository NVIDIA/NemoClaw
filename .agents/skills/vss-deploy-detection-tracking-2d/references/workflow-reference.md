# Workflow Reference

Status messages, error recovery, and agent-vs-script responsibility tables for the deploy workflow.

## Status Messages (what to print at each transition)

| When | Print |
|---|---|
| Before Step 1 | *(no print — just call `TodoWrite` with the full 10-task plan)* |
| Identifying use case | `Identifying use case to deploy...` |
| Use case confirmed | `Use case confirmed: <usecase>. Looking up its NGC resources and config files in references/usecases.md.` |
| Detecting platform | `Detecting target platform via uname -m and nvidia-smi...` |
| Platform auto-accepted | `Platform: <platform> (arch=<ARCH>, Jetson=<yes|no>, GPU=<GPU>) — auto-detected, no confirmation needed.` |
| Platform fallback (rare) | `Could not auto-detect platform — asking user.` |
| Collecting image ref | `Need the RTVI-CV docker image reference. Asking user...` |
| Image verified | `Docker image verified: <IMAGE> (arch: <ARCH>, matches <PLATFORM>)` |
| Image mismatch | `WARNING: image <IMAGE> is <ARCH> but platform is <PLATFORM>.` |
| Checking NGC creds | `Checking NGC credentials at ~/.ngc/config...` |
| NGC creds reused | `Using existing NGC config for org <ORG> — skipping credential prompt.` |
| NGC creds saved | `NGC credentials saved to ~/.ngc/config (chmod 600, reused on every future run).` |
| Collecting NGC refs | `Collecting NGC resource references for <usecase>...` |
| Pipeline configured | `Pipeline config: batch=<N>, streams=<mode>, input=<type>, sink=<sink>` |
| Resource reuse | `Reusing existing resource: <NAME> (saved ~10 GB download)` |
| Resource download start | `Downloading <RESOURCE>... (this may take several minutes)` |
| Resource download done | `Downloaded <RESOURCE> ✓` |
| Checking for existing | `Checking for an existing RTVI-CV container using image <IMAGE>...` |
| Existing found (good mounts) | `Found existing <NAME> running <IMAGE> with correct mounts — asking user whether to reuse, restart, or go parallel.` |
| Existing found (bad mounts) | `Found existing <NAME> but required mounts are missing: <LIST> — asking user to restart or go parallel.` |
| Reusing | `Reusing existing container <NAME> — skipping docker run, going straight to config apply.` |
| Stopping to restart | `Stopping <NAME> to relaunch with fresh config...` |
| Parallel launch | `Launching parallel container <NEW_NAME> on REST port <PORT> (existing <OLD_NAME> untouched)...` |
| Launching container | `Launching RTVI-CV container (name=<CONTAINER_NAME>, image=<IMAGE>)...` |
| Container up | `Container is running. Entering for configuration...` |
| Applying config | `Applying <usecase> configuration inside container...` |
| Discovering paths | `  - discovering NGC resource paths via find $RESOURCES...` |
| Substituting paths | `  - updating model path placeholders in configs...` |
| Batch size | `  - running update_batch_size.sh <usecase> <N>...` |
| Sink update | `  - applying <sink> sink edits to main config...` |
| Source list | `  - populating source list (static mode, <N> streams)...` |
| Extra setup | `  - running setup_<gdino|sparse4d>.sh...` |
| Encoder deps — validated | `  - ENCODER_DEPS: x264enc already registered ✓ (no install needed)` |
| Encoder deps — installing | `  - ENCODER_DEPS: software video encoders missing, installing via user_additional_install.sh (one-time, ~1-2 min)...` |
| Encoder deps — stale marker | `  - ENCODER_DEPS: marker present but x264enc missing — removing stale marker and reinstalling` |
| Encoder deps — installed | `  - ENCODER_DEPS: install complete, x264enc registered ✓ — filedump sink ready` |
| Encoder deps — install failed | `  - ENCODER_DEPS: install FAILED — show /tmp/ds_user_install.log to the user; fall back to eglsink or enc-type=0 hardware` |
| Encoder deps — skipped (flag) | `  - ENCODER_DEPS: --skip-encoder-install set, x264enc is missing; expect pipeline failure unless you flip [sink2] enc-type=0 afterwards` |
| Engine prelaunch (nvinfer) exact | `  - ENGINE PRELAUNCH (exact) — <model> b<N> engine already present, DS will deserialize directly ✓` |
| Engine prelaunch (nvinfer) compat | `  - ENGINE PRELAUNCH (compatible) — symlinked larger b<M> engine for <model> b<N> request, skipped ~3-5 min build ✓` |
| Engine prelaunch (nvinfer) symlink | `  - ENGINE PRELAUNCH (symlink) — pre-existing symlink from prior deploy, resolves to valid engine ✓` |
| Engine prelaunch (nvinfer) miss | `  - ENGINE PRELAUNCH (miss) — no cached <model> engine >= b<N>, DS will build from ONNX (~3-5 min)` |
| Engine cache hit (exact) | `  - ENGINE CACHE HIT (exact) — reusing cached <model> b<N> engine, skipped ~3-10 min build ✓` |
| Engine cache hit (compat) | `  - ENGINE CACHE HIT (compatible) — reusing larger b<M> <model> engine for b<N> request, skipped ~3-10 min build ✓` |
| Engine cache miss | `  - ENGINE CACHE MISS — no cached <model> engine for b<N>, building now (~3-10 min, one-time cost)...` |
| Engine force rebuild | `  - FORCE REBUILD — ignoring cached <model> engine, rebuilding from scratch...` |
| Engine cache saved | `  - Engine cached at <path> for future reuse ✓` |
| Config done | `Configuration complete.` |
| Initializing log | `Initializing deployment log at $STORAGE/logs/<usecase-and-model>_<ts>.txt (settings + configs + docker cmd)...` |
| Log ready | `Deployment log ready: ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt` |
| Starting app | `Starting metropolis_perception_app -c <config-file> (output -> deployment log)...` |
| Caching nvinfer engine | `Linking DS-auto-built engine -> $ENGINE_CACHE_DIR/<model>_b<N>.engine (future deploys skip the rebuild)` |
| App ready | `RTVI-CV is live at http://localhost:9000 — full runtime log at ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt` |
| Done | `Deployment complete. Switch to this skill's API USAGE flow to add streams.` |
| Stream add plan | `Adding <N> streams dynamically with <DELAY>s spacing — total add time ≈ <(N-1)*DELAY>s.` |
| Stream add progress | `Adding stream <i>/<N>: <camera_id> (<camera_url>)...` |
| Stream added | `Added <camera_id> ✓ (<i>/<N>)` |
| Stream gap | `Waiting <DELAY>s before next stream add (pipeline attach stability)...` |
| Stream add done | `All <N> streams added.` |
| Removing stream | `Removing stream <camera_id> (<camera_url>)...` |
| Stream removed | `Stream <camera_id> removed ✓ (<ACTIVE-1>/<MAX_BATCH> active)` |
| Stop app | `Stopping perception app inside <CONTAINER_NAME> (container stays up for fast redeploy)...` |
| App stopped | `Perception app stopped. Container <CONTAINER_NAME> is idle — call Step 5 again to restart with new config.` |
| Stop docker | `Stopping container <CONTAINER_NAME> (graceful)...` |
| Docker stopped | `Container <CONTAINER_NAME> stopped. Cache + NGC creds preserved on host.` |

## Error Recovery

For the consolidated symptom → cause → fix table covering engine builds,
sinks, X11, stream binding, reused-container config drift, and filedump
muxer issues, see [`troubleshooting.md` § Common Failures](troubleshooting.md#common-failures).
The workflow-reference-specific notes that don't fit there:

- `ngc: command not found` — install NGC CLI (`pip install ngcsdk`) or run
  inside the container where it's pre-installed.
- Batch size change didn't take effect — edit hit the wrong file. Check
  `*.bak` files in `$CONFIGS/<usecase>/` to diff, then re-run
  `update_batch_size.sh <usecase> <N>`.
- Reused container has stale configs — user picked "reuse" but the baked
  configs don't reflect new NGC resource / batch. Pick "restart" instead,
  OR mount `reference-configs/` from the host so config edits persist.
- Filedump MP4 muxer choice — by default the skill writes `.mp4` filename +
  MKV muxer (container=2) for on-kill recoverability. Pass `--container 1`
  to force true MP4 bytes (unplayable if killed before moov atom write).

## Bash Batching (reduce permission prompts)

Sequential bash commands with no user decision between them **must be combined into a single bash tool call** — never one call per line.

| Pattern | Rule |
|---|---|
| Variable set → use → report (same step) | One call |
| Cache check → content scan → engine check | One call (all read-only; result parsed together) |
| `docker exec` for 2+ sub-steps in the same step | One call via `bash -c "cmd1 && cmd2 && cmd3"` |
| Log tail + grep filter | One call |
| Two calls where call 2 is always run after call 1 | One call with `&&` or `;` |
| Two calls where call 2 depends on a conditional from call 1 output | Two calls are OK — genuine branch |

Splitting a single logical operation across multiple bash tool calls multiplies permission prompts and round-trips for no benefit.

## What the Agent Does vs What the Scripts Do

Keep the split clean — scripts do the brittle multi-file work; the agent does everything else.

| Task | Owner |
|---|---|
| Collect user inputs (use case, batch, sink, etc.) | Agent (`AskQuestion`) |
| Detect platform | Agent (one-liner: `uname -m`, `nvidia-smi`, `/etc/nv_tegra_release`) |
| Write `~/.ngc/config` | Agent (simple `cat > file` + `chmod 600`) |
| Download NGC resources | Agent (one-liner: `ngc registry resource download-version ...`) |
| Verify docker image arch | Agent (`docker manifest inspect ...`) |
| Launch docker | Agent (builds command from `platforms.md` template) |
| Edit simple INI/YAML keys (sink, source list, path placeholders) | Agent (sources `common.sh`, one-line calls to `update_ds_config` / `update_yaml_flat`) |
| Discover NGC resource paths | Agent (one-liner `find` commands) |
| **Update batch size across all files for a usecase** | **Script** — `update_batch_size.sh` (multi-file orchestration with per-usecase logic) |
| **Build GDINO TensorRT engine** | **Script** — `setup_gdino.sh` (trtexec with 6 dynamic shape params) |
| **Stage Sparse4D configs + run setup.sh** | **Script** — `setup_sparse4d.sh` (multi-step copy + env check + bash invocation) |
| Start the perception app | Agent (single command from `usecases.md`) |

### Why this split

- Agent strength: one-off logic, user interaction, orchestration
- Script strength: deterministic multi-file edits, complex CLI invocations with many args, idempotency
- Anything that would be a **5+ line bash snippet with variable substitution** belongs in a script — too error-prone for the agent to generate inline every time.
