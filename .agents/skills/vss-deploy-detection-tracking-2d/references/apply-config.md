# Apply Configuration Inside the Container

Detailed bash for Step 4 of the workflow.

## ONE-CALL FAST PATH — use this (single permission prompt for all of Step 4)

**Refresh scripts THEN call `apply_config.sh` in a single chained bash
call.** This collapses script copy + chmod + 6 sub-step exec calls into
ONE permission prompt:

```bash
SKILL_DIR="$HOME/.claude/skills/vss-deploy-detection-tracking-2d"
CONTAINER="<CONTAINER_NAME>"

docker exec "$CONTAINER" rm -rf /tmp/scripts && \
docker cp   "$SKILL_DIR/scripts" "$CONTAINER:/tmp/" && \
docker exec "$CONTAINER" chmod -R +x /tmp/scripts/ && \
docker exec "$CONTAINER" /tmp/scripts/apply_config.sh \
    --usecase  "<usecase>" \
    --batch    "<N>" \
    --sink     "<fakesink|eglsink|filedump>" \
    --stream-mode "<dynamic|static>" \
    [--onnx    "<container-onnx-path>"]    # pass if already resolved in Step 1.g — skips 4.a re-scan
    [--videos  "<container-videos-dir>"]   # pass if already resolved in Step 1.g — skips 4.a re-scan
    [--force-rebuild]                      # bypass engine cache
```

> **The script-refresh pattern matters.** Use `docker cp scripts
> <container>:/tmp/` (no trailing `.` or `/`), preceded by `rm -rf
> /tmp/scripts`. The trailing-`.` form (`docker cp scripts/.
> <container>:/tmp/scripts/`) **nests** the files into
> `/tmp/scripts/scripts/` when `/tmp/scripts/` already exists from a
> prior session, leaving `chmod /tmp/scripts/*.sh` matching nothing.
> The `rm -rf` upfront makes the cp deterministic regardless of prior
> state.

**Output markers to parse:**
- `RESOLVE_OK: <label>=<path>` — 4.a found the asset
- `RESOLVE_AMBIGUOUS: <label> count=<N>` — ambiguity → the skill must drive an `AskQuestion`, then re-run with `--onnx` / `--videos` flag
- `ENGINE_PRELAUNCH: HIT_EXACT|HIT_COMPAT|MISS` — 4.f result
- `CONFIG_APPLY_OK usecase=<uc> batch=<N> sink=<sink>` — all sub-steps done

**Auto-co-location for warehouse-3d.** When `--onnx <path>` is supplied
and `--labels` / `--anchor` are not, the script defaults `LABELS` and
`ANCHOR` to siblings of the ONNX (`labels.txt` and the first `*.npy` in
the ONNX's parent dir). This is structurally safe — every warehouse NGC
resource ships these three files in the same directory
(`vss-warehouse-app-data/models/sparse4d/ov/`) — and it prevents
`RESOLVE_AMBIGUOUS: labels count=2` when prior smartcity-rtdetr resources
(which also contain a `labels.txt`) are still cached under
`/opt/storage/resources/`. The canonical Step 4 call from SKILL.md
(`--onnx ... --videos ...`) therefore works for warehouse-3d as-is —
explicit `--labels` / `--anchor` are only needed for non-NGC layouts.

**Parallelism inside the script:**
- 4.a (discovery) runs first (path dependency for 4.b-4.e)
- 4.f (engine cache lookup) starts immediately after 4.a and runs in the background — it is read-only and never touches the config files
- 4.b → 4.c → 4.d → 4.e run sequentially (they all write to overlapping files — `ds-main-config.txt` in particular — so concurrent writes would corrupt the file)
- The script waits for the 4.f background job before printing `CONFIG_APPLY_OK`

**Only fall back to the per-sub-step flow below** when debugging a specific sub-step failure, or when `RESOLVE_AMBIGUOUS` requires the skill to ask the user and retry with an explicit path.

---

## Step 4 exit box — required sectioned format

When `apply_config.sh` returns `CONFIG_APPLY_OK …`, the agent renders the
Step 4 exit box using the **sectioned layout below** — NOT a flat `✔` list.
Each section maps to one sub-step:
- **Model** ← 4.b (path substitution into PGIE / config.yaml)
- **Batch size** ← 4.c (`update_batch_size.sh`)
- **Output sink** ← 4.d (`update_output_sink.sh`)
- **Stream sources** ← 4.e (`update_stream_sources.sh`)
- **Engine cache** ← 4.f (`prelaunch_nvinfer_engine.sh` / `setup_gdino.sh` / `setup_sparse4d.sh`)
- **Backups** ← side-effect of all the above

Use the universal box geometry from SKILL.md § "Universal box format"
(128 chars wide, centered title, blank-line separators between sections).

**The box is constructed dynamically** — the agent reads the actual
sub-step output + the per-use-case key table below + the user's chosen
settings, then emits **one `✔` row per concrete `<section> <key>=<value>`
edit, with a plain-English annotation** explaining what that key does.
Rows are grouped by filename: the basename is a sub-header within each
section, then the `✔` rows for that file follow, indented.

### Required row form

```
   <basename>
       ✔ <[section]> <key>=<value>          — short plain-English annotation
```

The word `Edited` is **never** printed — every row inside the box is
an edit; the prefix is redundant. The `—` separator + annotation tells
the user what the key actually does (e.g. `[sink0] type=2  — turn on
EGL display`).

### Forbidden patterns (what the agent slips into)

| ❌ Forbidden row                                                                | ✅ What to emit instead                                                                                                                |
|---------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `✔ Edited <file> <key>=<value>` (the word "Edited")                             | Drop "Edited". Just `✔ <key>=<value>  — <annotation>` under a `<basename>` sub-header.                                                  |
| `✔ Updated to 3 in ds-main-config.txt ([streammux] [primary-gie] [source-list])`| Three separate rows under `ds-main-config.txt`, each annotated.                                                                       |
| `✔ eglsink applied to ds-main-config.txt`                                       | Four rows for `[sink0] enable=1`, `[sink0] type=2`, `[sink2] enable=0`, `[tiled-display] enable=1`, `[osd] enable=1`, each annotated. |
| `✔ Tile grid  1 rows × 3 columns`                                               | Two rows: `[tiled-display] rows=1` and `[tiled-display] columns=3`, each annotated.                                                    |
| Stream sources section listing only the source URLs                             | Six `[source-list]` rows, each annotated.                                                                                              |

### Counting rule

Number of `✔` rows in each section MUST equal the row count in the
per-use-case table below, given the user's chosen settings.

| Use case + settings                                     | Section row counts                                                              |
|---------------------------------------------------------|---------------------------------------------------------------------------------|
| `warehouse-2d` + eglsink + static + N=4 + cache HIT     | Model 1 · Batch 6 · Sink 5 · Sources 6 · Engine 2 · Backups 1                   |
| `warehouse-2d` + filedump + static + N=4 + cache HIT    | Model 1 · Batch 6 · Sink 11 (5 base + 6 filedump-only) · Sources 6 · Engine 2   |
| `warehouse-3d` + eglsink + static + N=4 + cache HIT     | Model 4 · Batch 6 (incl. `num_sensors`, `network-input-shape`) · Sink 7 (5 base + 2 `generate_3d_bbox`) · Sources 6 · Engine 2 · Backups 1 |
| `smartcity-rtdetr` + eglsink + static + N=4 + cache HIT | Model 1 · Batch 7 · Sink 5 · Sources 6 · Engine 2 · Backups 1                   |
| `smartcity-gdino` + eglsink + static + N=4 + cache HIT  | Model 2 (Triton `model.onnx` + `model.plan`) · Batch 10 (incl. 4 Triton pbtxts) · Sink 5 · Sources 6 · Engine 2 · Backups 1 |

(Sink count assumes the warehouse-2d / smartcity table below where
`[sink0]` enable + type are folded into one row when both are written
together, and `[sink0] nvdslogger=1` is rendered as its own row since
it's a perf-measurement signal, not part of the sink-mode triple.
Either form is fine — the agent picks one row per logical edit.)

If the agent's box doesn't have the exact row count, it collapsed —
re-render with one row per key.

---

### Per-use-case complete edit list

These tables are the source of truth for what the agent renders in each
section. Every row corresponds to one `✔ Edited` line in the box.

#### `warehouse-2d`

Each row below = one `✔` line in the box. The **Annotation** column is
the canonical plain-English text the agent prints after the `—` on
that row.

**Model section** (4.b):
| File                               | Key=Value                       | Annotation        |
|------------------------------------|---------------------------------|-------------------|
| `ds-ppl-analytics-pgie-config.yml` | `onnx-file = <abs path>`        | pin RT-DETR ONNX  |

**Batch size section** (4.c):
| File                               | Key=Value                                          | Annotation                       |
|------------------------------------|----------------------------------------------------|----------------------------------|
| `ds-main-config.txt`               | `[streammux] batch-size=<N>`                       | muxer input batch                |
| `ds-main-config.txt`               | `[primary-gie] batch-size=<N>`                     | PGIE inference batch             |
| `ds-main-config.txt`               | `[source-list] max-batch-size=<N>`                 | source-list capacity             |
| `ds-main-config.txt`               | `[tiled-display] rows=<TILE_ROW>`                  | tile grid rows                   |
| `ds-main-config.txt`               | `[tiled-display] columns=<TILE_COL>`               | tile grid cols                   |
| `ds-ppl-analytics-pgie-config.yml` | `engine-filename → _b<N>_`                         | engine name follows new batch    |

**Output sink section** (4.d) — base rows for any sink:
| File                               | Key=Value (per chosen sink)                           | Annotation                     |
|------------------------------------|-------------------------------------------------------|--------------------------------|
| `ds-main-config.txt`               | `[sink0] enable=1 type=2`  (eglsink — display)        | turn on EGL display sink       |
| `ds-main-config.txt`               | `[sink0] enable=1 type=1`  (fakesink — bench)         | turn on fakesink (no output)   |
| `ds-main-config.txt`               | `[sink0] enable=0`         (filedump — disable sink0) | sink0 off — file-dump owns out |
| `ds-main-config.txt`               | `[sink0] nvdslogger=1`     (all sink modes)           | make /api/v1/metrics report FPS (dormant when sink0 disabled) |
| `ds-main-config.txt`               | `[sink2] enable=0`         (fakesink/eglsink)         | disable file-dump sink         |
| `ds-main-config.txt`               | `[sink2] enable=1`         (filedump)                 | enable file-dump sink          |
| `ds-main-config.txt`               | `[tiled-display] enable=<3\|1\|1>` (fakesink / eglsink / filedump) | fakesink: perf-only tiler (per-source FPS to metrics, no compositing); eglsink/filedump: composite the tile grid |
| `ds-main-config.txt`               | `[osd] enable=<0\|1>`                                 | draw / hide bbox + labels      |

For `filedump` ALSO (6 extra rows):
| File                               | Key=Value                                                       | Annotation                     |
|------------------------------------|-----------------------------------------------------------------|--------------------------------|
| `ds-main-config.txt`               | `[sink2] type=3`                                                | sink type = file               |
| `ds-main-config.txt`               | `[sink2] container=2`  (MKV default — robust on abnormal exit)  | MKV muxer (default)            |
| `ds-main-config.txt`               | `[sink2] codec=1`                                               | H.264                          |
| `ds-main-config.txt`               | `[sink2] enc-type=1`                                            | software encoder (x264)        |
| `ds-main-config.txt`               | `[sink2] bitrate=40000000`                                      | 40 Mb/s                        |
| `ds-main-config.txt`               | `[sink2] output-file=<path>`                                    | output MP4 path                |

**Stream sources section** (4.e):
| File                               | Key=Value                                                                | Annotation                       |
|------------------------------------|--------------------------------------------------------------------------|----------------------------------|
| `ds-main-config.txt`               | `[source-list] num-source-bins=<N>` (static) / `=0` (dynamic)            | static: bake N sources / dynamic: empty until /stream/add |
| `ds-main-config.txt`               | `[source-list] list=<semicolon URLs>` (static) / empty (dynamic)         | exact source URLs                |
| `ds-main-config.txt`               | `[source-list] sensor-id-list=<ids>` (static) / empty (dynamic)          | per-camera id list               |
| `ds-main-config.txt`               | `[source-list] sensor-name-list=<names>` (static) / empty (dynamic)      | per-camera display name          |
| `ds-main-config.txt`               | `[source-list] http-port=9000`                                           | REST listen port                 |
| `ds-main-config.txt`               | `[tests] file-loop=1` (fakesink/eglsink) / `=0` (filedump)               | replay videos forever / one pass — `file-loop` belongs to the `[tests]` group in DS's parser; setting it under `[source-list]` triggers `WARN: Unknown key 'file-loop'` and the value is silently dropped. apply_config.sh also strips any stale `[source-list] file-loop=` left over from earlier deploys. |

#### `warehouse-3d`

**Model section** (4.b) — Sparse4D uses `videotemplate`, so the model
config lives in `config.yaml` (no PGIE):
| File                                  | Section / Key                         | Value                          |
|---------------------------------------|---------------------------------------|--------------------------------|
| `config.yaml`                         | `onnx_file`                           | resolved ONNX absolute path    |
| `config.yaml`                         | `engine_file`                         | `$ENGINE_CACHE_DIR/<onnx-basename>_b<N>.engine` |
| `config.yaml`                         | `labels_file`                         | resolved labels.txt path       |
| `config.yaml`                         | `anchor`                              | resolved `_ov_kmeans*.npy` path|
| `calibration.json` (CONFIGS dir)      | (file copy)                           | from NGC resource (only if user picked one outside CONFIGS) |

**Batch size section** (4.c) — note: no `[primary-gie]` (videotemplate),
plus two extra files unique to warehouse-3d:
| File                                  | Section / Key                         | Value                          |
|---------------------------------------|---------------------------------------|--------------------------------|
| `ds-main-config.txt`                  | `[streammux]` `batch-size`            | `<N>`                          |
| `ds-main-config.txt`                  | `[source-list]` `max-batch-size`      | `<N>`                          |
| `ds-main-config.txt`                  | `[tiled-display]` `rows`              | `<TILE_ROW>`                   |
| `ds-main-config.txt`                  | `[tiled-display]` `columns`           | `<TILE_COL>`                   |
| `config.yaml`                         | `num_sensors`                         | `<N>`                          |
| `ds-mtmc-preprocess-config.txt`       | `network-input-shape`                 | `<N>;3;540;960`                |

**Output sink section** (4.d) — same `[sink0] [sink2] [tiled-display]
[osd]` keys as warehouse-2d. Plus, for `eglsink` ONLY:
| File                                  | Section / Key                         | Value                          |
|---------------------------------------|---------------------------------------|--------------------------------|
| `config.yaml`                         | `generate_3d_bbox`                    | `True`                         |
| `$SPARSE4D_REPO/configs/config.yaml`  | `generate_3d_bbox`                    | `True` (only if file exists)   |

**Stream sources section** (4.e) — same six `[source-list]` keys as warehouse-2d.

#### `smartcity-rtdetr`

**Model section** (4.b):
| File                                  | Section / Key                         | Value                          |
|---------------------------------------|---------------------------------------|--------------------------------|
| `rtdetr-960x544.txt`                  | `[property]` `onnx-file`              | resolved ONNX absolute path    |

**Batch size section** (4.c):
| File                                  | Section / Key                         | Value                          |
|---------------------------------------|---------------------------------------|--------------------------------|
| `run_config-api-rtdetr-protobuf.txt`  | `[streammux]` `batch-size`            | `<N>`                          |
| `run_config-api-rtdetr-protobuf.txt`  | `[primary-gie]` `batch-size`          | `<N>`                          |
| `run_config-api-rtdetr-protobuf.txt`  | `[source-list]` `max-batch-size`      | `<N>`                          |
| `run_config-api-rtdetr-protobuf.txt`  | `[tiled-display]` `rows`              | `<TILE_ROW>`                   |
| `run_config-api-rtdetr-protobuf.txt`  | `[tiled-display]` `columns`           | `<TILE_COL>`                   |
| `rtdetr-960x544.txt`                  | `[property]` `batch-size`             | `<N>`                          |
| `rtdetr-960x544.txt`                  | engine-filename pattern               | `_b<N>_`                       |

**Output sink section** (4.d) — same five keys as warehouse-2d but on
`run_config-api-rtdetr-protobuf.txt` instead of `ds-main-config.txt`.

**Stream sources section** (4.e) — same six `[source-list]` keys but on
`run_config-api-rtdetr-protobuf.txt`.

#### `smartcity-gdino`

**Model section** (4.b) — GDINO uses Triton/`nvinferserver`, so the model
flow goes through `setup_gdino.sh` (file copy + engine build):
| File                                              | Action                                              | Value                          |
|---------------------------------------------------|-----------------------------------------------------|--------------------------------|
| `$TRITON_REPO/gdino_trt/1/model.onnx`             | `cp -f` resolved ONNX → here                        | overwritten on every deploy    |
| `$TRITON_REPO/gdino_trt/1/model.plan`             | symlink → cached engine OR built directly via `trtexec` | depends on cache hit/miss   |

**Batch size section** (4.c):
| File                                              | Section / Key                       | Value                          |
|---------------------------------------------------|-------------------------------------|--------------------------------|
| `run_config-api-rtdetr-protobuf.txt`              | `[streammux]` `batch-size`          | `<N>`                          |
| `run_config-api-rtdetr-protobuf.txt`              | `[primary-gie]` `batch-size`        | `<N>`                          |
| `run_config-api-rtdetr-protobuf.txt`              | `[source-list]` `max-batch-size`    | `<N>`                          |
| `run_config-api-rtdetr-protobuf.txt`              | `[tiled-display]` `rows`            | `<TILE_ROW>`                   |
| `run_config-api-rtdetr-protobuf.txt`              | `[tiled-display]` `columns`         | `<TILE_COL>`                   |
| `config_triton_nvinferserver_gdino.txt`           | `max_batch_size`                    | `<N>`                          |
| `$TRITON_REPO/ensemble_python_gdino/config.pbtxt` | `max_batch_size`                    | `<N>`                          |
| `$TRITON_REPO/gdino_trt/config.pbtxt`             | `max_batch_size`                    | `<N>`                          |
| `$TRITON_REPO/gdino_postprocess/config.pbtxt`     | `max_batch_size`                    | `<N>`                          |
| `$TRITON_REPO/gdino_preprocess/config.pbtxt`      | `max_batch_size`                    | `<N>`                          |

**Output sink section** (4.d) — same five keys as warehouse-2d but on
`run_config-api-rtdetr-protobuf.txt` (the GDINO main config).

**Stream sources section** (4.e) — same six `[source-list]` keys on
`run_config-api-rtdetr-protobuf.txt`.

---

### Worked example — warehouse-2d (eglsink + static streams + cache hit, batch=3)

```
┌──────────────────────────────────────────────────── Apply configuration ─────────────────────────────────────────────────────┐
│                                                                                                                              │
│  Model                                                                                                                       │
│     ds-ppl-analytics-pgie-config.yml                                                                                         │
│         ✔ onnx-file = <resolved abs path>                  — pin RT-DETR ONNX                                                │
│                                                                                                                              │
│  Batch size  (value=3, tile grid 1×3)                                                                                        │
│     ds-main-config.txt                                                                                                       │
│         ✔ [streammux] batch-size=3                         — muxer input batch                                               │
│         ✔ [primary-gie] batch-size=3                       — PGIE inference batch                                            │
│         ✔ [source-list] max-batch-size=3                   — source-list capacity                                            │
│         ✔ [tiled-display] rows=1                           — tile grid rows                                                  │
│         ✔ [tiled-display] columns=3                        — tile grid cols                                                  │
│     ds-ppl-analytics-pgie-config.yml                                                                                         │
│         ✔ engine-filename → _b3_                           — engine name follows new batch                                   │
│                                                                                                                              │
│  Output sink  (eglsink — display)                                                                                            │
│     ds-main-config.txt                                                                                                       │
│         ✔ [sink0]  enable=1   type=2                       — turn on EGL display sink                                        │
│         ✔ [sink0]  nvdslogger=1                            — emit per-stream FPS to /api/v1/metrics                          │
│         ✔ [sink2]  enable=0                                — disable file-dump sink                                          │
│         ✔ [tiled-display] enable=1                         — show tile grid (composite)                                      │
│         ✔ [osd]    enable=1                                — draw bbox / labels                                              │
│                                                                                                                              │
│  Stream sources  (static, 3)                                                                                                 │
│     ds-main-config.txt                                                                                                       │
│         ✔ [source-list] num-source-bins=3                  — bake 3 sources into pipeline                                    │
│         ✔ [source-list] list=<3 file:// URLs>              — exact URLs (Camera_01..03)                                      │
│         ✔ [source-list] sensor-id-list=…                   — Camera_01;Camera_02;Camera_03                                   │
│         ✔ [source-list] sensor-name-list=…                 — same as ids                                                     │
│         ✔ [source-list] http-port=9000                     — REST listen port                                                │
│         ✔ [tests] file-loop=1                              — loop videos (eglsink/fakesink)                                  │
│                                                                                                                              │
│  Engine cache                                                                                                                │
│         ✔ HIT_SYMLINK b3 → b4 base   (no rebuild — saved ~3 min)                                                             │
│         ✔ bound model-engine-file = _b3_                                                                                     │
│                                                                                                                              │
│  Backups                                                                                                                     │
│         ✔ *.bak preserved on first edit  (mode 0600)                                                                         │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

For **warehouse-3d** the Batch section grows by:
- `config.yaml  num_sensors=N  — number of cameras for Sparse4D BEV`
- `ds-mtmc-preprocess-config.txt  network-input-shape=N;3;540;960  — preprocess tensor leading dim`

And for warehouse-3d + eglsink the Sink section grows by:
- `config.yaml  generate_3d_bbox=True  — render 3D BEV bounding boxes`
- `$SPARSE4D_REPO/configs/config.yaml  generate_3d_bbox=True  — same flag for staged copy`

For **smartcity-gdino** the Batch section grows by 5 extra rows:
- `config_triton_nvinferserver_gdino.txt  max_batch_size=N  — Triton nvinferserver batch`
- `<dir>/config.pbtxt  max_batch_size=N  — Triton ensemble/<dir> batch`  (×4 Triton dirs)

If a section has no edits to report (e.g. cache MISS — Engine cache shows
`will build during launch (~3-5 min)` instead of the HIT row), still
render the section with one row stating that.

---

## Path Setup (for manual sub-step debugging only)

> **DO NOT stage configs to `/opt/storage/configs/`.** Every script in `scripts/` (via `common.sh`'s `CONFIGS` default) edits the configs IN-PLACE at the canonical reference-configs path below. Copying configs into `/opt/storage/configs/` and editing them there is dead work — the scripts won't read them, and the app loads from the canonical path. The `metropolis_perception_app -c <path>` command should always point at the canonical path, not a staged copy.

Every command below assumes these are exported:

```bash
export CONFIGS=/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app/reference-configs
export SPARSE4D_REPO=/opt/nvidia/deepstream/deepstream/sources/sparse4d
export TRITON_REPO=/opt/nvidia/deepstream/deepstream/sources/TritonGdino/triton_model_repo
export RESOURCES=/opt/storage/resources
```

Mount the skill's scripts into the container (or `docker cp` them).

See [§ ONE-CALL FAST PATH](#one-call-fast-path--use-this-single-permission-prompt-for-all-of-step-4)
above for the single-permission-prompt variant and the canonical
`docker cp src /tmp/scripts` nesting-gotcha note (always `rm -rf
/tmp/scripts` first to avoid nested `/tmp/scripts/scripts/`).

---

## 4.a — Discover NGC Resource Paths

NGC directory names change per version — discover them at runtime. The one-liners below use `| head -n1` for brevity, but the agent MUST NOT use that in production — if two NGC resource versions are unpacked on the host at the same time, `head -n1` silently picks one. Use the `resolve_or_ask` helper below (or call the shared `resolve_unique_path` function from `common.sh`, which already emits `RESOLVE_OK` / `RESOLVE_AMBIGUOUS` markers on stderr). For every resolved path, print a visible `Using …` line so the user can see the model / video dir choice on the terminal.

### Recommended pattern

```bash
# resolve_or_ask <label> <find-expression...>  -> prints the chosen path on stdout;
# drives an AskQuestion (via the agent) on ambiguity.
resolve_or_ask() {
    local label="$1"; shift
    mapfile -t CANDS < <(find "$@" 2>/dev/null | sort)
    case ${#CANDS[@]} in
        0)  echo "ERROR: no match for $label under '$*'" >&2; return 2 ;;
        1)  echo "Using $label: $(basename "${CANDS[0]}") (${CANDS[0]})" >&2
            printf '%s\n' "${CANDS[0]}" ;;
        *)  # Agent should replace this branch with an AskQuestion covering CANDS[@]
            echo "AMBIGUOUS: $label — $(printf '%d candidates' "${#CANDS[@]}")" >&2
            printf '  [%d] %s\n' "${!CANDS[@]}" "${CANDS[@]}" >&2
            return 3 ;;
    esac
}
```

### Concrete lookups (layout-agnostic — no hardcoded NGC subdirectory names)

**Rule:** each `find` is constrained **only by extension or context-independent filename** (`*.onnx`, `labels.txt`, `*.npy`, `calibration.json`, `*.mp4`). **Never** include directory filters like `-path '*/mtmc/*'`, `-name 'nv-warehouse-4cams'`, `-name 'vss-warehouse-app-data*'` — those assume a specific NGC resource layout and will silently fail when the resource is restructured. The 0/1/>1 dispatch in `resolve_or_ask` handles the multi-candidate case by asking the user.

> **Skip this step entirely if the var is already set by Step 1.g.** The
> resource-plan scan (`resource-plan.md § 7.d`) commits `$WAREHOUSE_2D_ONNX`,
> `$WAREHOUSE_2D_VIDEOS`, `$SPARSE4D_ONNX`, `$SMC_VIDEOS`, etc. directly —
> either from a single-candidate scan, from a hint match
> (`MODEL_NAME_HINT` / `VIDEOS_DIR_HINT`), or from a user picker. When the
> var is already populated, skip the `resolve_or_ask` call for that asset
> — don't re-ask the user the same disambiguation twice. Wrap each call:
>
> ```bash
> : "${WAREHOUSE_2D_ONNX:=$(resolve_or_ask 'warehouse-2d ONNX' "$RESOURCES" -type f -name '*.onnx')}"
> ```
>
> The `:=` default-assignment only fires when the var is unset/empty.

```bash
# Helper: find directories under $1 that contain at least one *.mp4 or *.mkv
find_video_dirs() {
    find "$1" -type d -exec sh -c '
        for d; do
            ls "$d"/*.mp4 "$d"/*.mkv 2>/dev/null | head -n1 | grep -q . && echo "$d"
        done
    ' _ {} +
}

# ---------- warehouse-2d ----------
WAREHOUSE_2D_ONNX=$(resolve_or_ask 'warehouse-2d ONNX' \
    "$RESOURCES" -type f -name '*.onnx')
WAREHOUSE_2D_VIDEOS=$(resolve_or_ask 'warehouse-2d videos dir' \
    <(find_video_dirs "$RESOURCES"))

# ---------- warehouse-3d ----------
SPARSE4D_ONNX=$(resolve_or_ask 'warehouse-3d (sparse4d) ONNX' \
    "$RESOURCES" -type f -name '*.onnx')
SPARSE4D_LABELS=$(resolve_or_ask 'sparse4d labels' \
    "$RESOURCES" -type f -name 'labels.txt')
SPARSE4D_ANCHOR=$(resolve_or_ask 'sparse4d anchor' \
    "$RESOURCES" -type f -name '*.npy')
# calibration.json: prefer NGC-resource-shipped, fall back to the repo copy
SPARSE4D_CALIB=$(resolve_or_ask 'sparse4d calibration' \
    "$RESOURCES" -type f -name 'calibration.json') \
  || SPARSE4D_CALIB="$CONFIGS/warehouse-3d/calibration.json"
WAREHOUSE_3D_VIDEOS=$(resolve_or_ask 'warehouse-3d videos dir' \
    <(find_video_dirs "$RESOURCES"))

# ---------- smartcity-rtdetr / smartcity-gdino ----------
# Pass the ONNX from Step 5's NGC-resource reference, or fall back to a bare *.onnx scan.
RTDETR_ONNX=$(resolve_or_ask 'smartcity-rtdetr ONNX' \
    "$RESOURCES" -type f -name '*.onnx')
GDINO_ONNX=$(resolve_or_ask 'smartcity-gdino ONNX' \
    "$RESOURCES" -type f -name '*.onnx')
SMC_VIDEOS=$(resolve_or_ask 'smartcity videos dir' \
    <(find_video_dirs "$RESOURCES"))
```

> **If the same use case needs to disambiguate multiple ONNXs** (e.g. both RT-DETR and GDINO models live under `$RESOURCES` because both NGC models were pulled), the user's pick in the `AskQuestion` drives which ONNX the skill uses. Print the chosen basename + path on one line, the decision landmark on the next — the terminal output is the contract that a user can audit after the fact.

### Ambiguity handling (non-negotiable)

If any `resolve_or_ask` call returns `3` (multiple candidates), the agent MUST pause and drive an `AskQuestion`:

```json
{
  "questions": [
    {
      "id": "pick_<label>",
      "prompt": "Multiple <label> candidates found under $RESOURCES. Which one should I use?",
      "options": [
        {"id": "0", "label": "<basename-0> — <full-path-0>"},
        {"id": "1", "label": "<basename-1> — <full-path-1>"}
      ]
    }
  ]
}
```

Then set the variable from the chosen candidate and print `Using <label>: <basename> (<full-path>)` so the decision is visible on the terminal.

---

## 4.b — Substitute Discovered Paths Into Config Placeholders

The shipped configs now use generic `<PATH_TO_*>` tokens (see `reference-configs/README.md` § Placeholders). `update_yaml_flat` / `update_ds_config` from `common.sh` find the key and rewrite its value, so they work whether the current value is the placeholder or a previously-substituted path. Each helper verifies the write and fails loud if the edit didn't land.

```bash
source /tmp/scripts/common.sh

# ---------- warehouse-2d ----------
# Only onnx-file is required — model-engine-file is commented out in the shipped
# config; DeepStream auto-builds the engine next to the ONNX on first run.
update_yaml_flat $CONFIGS/warehouse-2d/ds-ppl-analytics-pgie-config.yml \
    onnx-file "$WAREHOUSE_2D_ONNX"

# ---------- warehouse-3d ----------
# All four Sparse4D keys MUST be set. engine_file must point at the persistent
# cache directory so sparse4d_setup.sh's build output is reused next deploy.
ONNX_BASE=$(basename "$SPARSE4D_ONNX")
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml onnx_file    "$SPARSE4D_ONNX"
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml engine_file  "$ENGINE_CACHE_DIR/${ONNX_BASE}_b${BATCH}.engine"
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml labels_file  "$SPARSE4D_LABELS"
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml anchor       "$SPARSE4D_ANCHOR"
# Calibration: if the NGC resource supplied one, copy it over the shipped default.
[[ -n "$SPARSE4D_CALIB" && "$SPARSE4D_CALIB" != "$CONFIGS/warehouse-3d/calibration.json" ]] && \
    cp "$SPARSE4D_CALIB" "$CONFIGS/warehouse-3d/calibration.json"

# ---------- smartcity-rtdetr ----------
# Same as warehouse-2d — only onnx-file; model-engine-file stays commented.
update_ds_config $CONFIGS/smartcities/rt-detr/rtdetr-960x544.txt \
    "[property]" onnx-file "$RTDETR_ONNX"
```

> **Why no `model-engine-file` substitution for warehouse-2d / smartcity-rtdetr?** In both shipped configs that line is commented out because DeepStream auto-builds the engine next to the ONNX on first run (suffix `_b<N>_gpu<G>_fp<P>.engine`) and reuses it on every subsequent run. The post-launch hook `cache_nvinfer_engine.sh` (invoked by `run_app_and_wait.sh` — see `start-app.md` § 5.e and § 4.g of this file) symlinks the auto-built engine into `$ENGINE_CACHE_DIR` so future deploys can reuse it via the tiered cache lookup. Writing an explicit `model-engine-file` here would override that auto-build and pin the engine to a path we no longer control.

---

## 4.c — Update Batch Size (one command covers every file)

```bash
/tmp/scripts/update_batch_size.sh <usecase> <N>
```

This handles every batch-size touch point for the use case (see `usecases.md`).

---

## 4.d — Update Output Sink

**Use the dedicated script** — don't do it inline. The script is idempotent, updates all sink-related keys in one place, and **verifies each key landed** before returning:

```bash
docker exec <CONTAINER_NAME> /tmp/scripts/update_output_sink.sh <usecase> <sink_mode>
# Optional (filedump only):
#   --output-file /opt/storage/output/my_run.mp4   (override the default filename)
#   --container 1                                  (force true MP4 bytes; default is 2=MKV muxer
#                                                   for on-kill recoverability even with .mp4 filename)
```

Expected stdout on success: `SINK_UPDATE_OK <usecase> <sink_mode>`.

### What it writes

| Sink     | [sink0]               | [sink2] (file dump)                                              | [tiled-display] | [osd]  | Extra                           |
|----------|-----------------------|------------------------------------------------------------------|-----------------|--------|---------------------------------|
| fakesink | `enable=1 type=1`     | `enable=0`                                                        | `enable=0`      | `enable=0` | — |
| eglsink  | `enable=1 type=2`     | `enable=0`                                                        | `enable=1`      | `enable=1` | warehouse-3d only: `generate_3d_bbox: True` in `config.yaml` (source + staged) |
| filedump | `enable=0 type=1`     | `enable=1 type=3 container=2 codec=1 enc-type=1 bitrate=40000000 output-file=<path>` | `enable=1`      | `enable=1` | Pre-creates output dir, removes stale mp4 |

**Filedump defaults** — output path `/opt/storage/output/<usecase>_output.mp4` (standard `.mp4` extension) + container muxer `2` (MKV). The extension and the muxer are decoupled by design: the `.mp4` filename is the user-facing standard while the bytes on disk are written by the MKV muxer for on-kill recoverability (MP4's moov atom is only finalized on a clean exit; MKV streams stay playable up to the last written frame). VLC/ffmpeg/mpv detect by content, not filename, so the file plays cleanly. Override filename with `--output-file <path>`, or force true MP4 bytes with `--container 1` (e.g. for a downstream tool that parses the moov atom).

### Why a script (not inline edits)

Sink configuration spans four config sections (`[sink0]`, `[sink2]`, `[tiled-display]`, `[osd]`) that must be set as a coherent group. A single script makes that atomic and verifiable:

1. Applies ALL keys in one logical unit (no partial state)
2. Verifies each key by re-reading the config after editing — fails loudly if any didn't land
3. Handles warehouse-3d's `generate_3d_bbox` toggle automatically
4. Pre-creates the filedump output directory and cleans stale files

### Note on `[tiled-display] enable`

DeepStream's `nvmultistreamtiler` recognizes three meaningful values:

| Value | Meaning                                                                  | Used by skill for |
|-------|--------------------------------------------------------------------------|-------------------|
| `0`   | Element absent from the pipeline.                                        | (not used)        |
| `1`   | Element present, composes all sources into a single tiled buffer.        | `eglsink`, `filedump` (display / file-write paths need the composited buffer) |
| `3`   | Element present in **perf-only** mode — no compositing, but per-source perf samples still flow to `nvdslogger`. | `fakesink` (benchmark path — want per-stream FPS in `/api/v1/metrics` without paying the compositing cost) |

The skill writes one of these three values explicitly so the config is readable and predictable. Some shipped reference-configs default to `3`; that happens to work for display too (DS treats any non-zero as "enabled"), but it makes the config ambiguous about intent — the explicit `1` for display vs `3` for perf-only path makes the agent's output sink choice legible at a glance.

### Tile grid (rows × columns)

`[tiled-display] rows` and `[tiled-display] columns` are written by `update_batch_size.sh` (Step 4.c) using the closest-to-square formula `ROW=floor(sqrt(N))`, `COL=ceil(N/ROW)`. Examples: N=1→1×1, N=4→2×2, N=6→2×3, N=8→2×4, N=9→3×3, N=16→4×4.

---

## 4.e — Configure Stream Sources

**Dynamic mode** (default): no config edit needed — `use-nvmultiurisrcbin=1` starts with zero streams, and users add them via the REST API at `http://localhost:9000`.

**Static mode**: pre-populate the source list. Use the video directory discovered in Step 4.a for the current use case:

| Use case | Video directory variable (set in Step 4.a) |
|---|---|
| `warehouse-2d` | `$WAREHOUSE_2D_VIDEOS` |
| `warehouse-3d` | `$WAREHOUSE_3D_VIDEOS` (must match `calibration.json`'s camera set) |
| `smartcity-rtdetr`, `smartcity-gdino` | `$SMC_VIDEOS` |

> No hardcoded directory names — whichever directory the Step 4.a video-dir scan landed on (after user confirmation if multiple candidates) is the one used here.

### CRITICAL — camera_id MUST match `calibration.json` for warehouse-3d

For **warehouse-3d** the `camera_id` (dynamic REST `camera_id` field, or static `sensor-id-list` / `sensor-name-list`) **MUST exactly match the `id` of a sensor entry in `calibration.json`**. If it doesn't, Sparse4D cannot find the camera's projection matrix, silently falls back to identity, and the BEV bounding boxes will be wrong. The log spams:

```
Warning: No projection matrix found for camera <name>. Using identity matrix.
```

**Always discover the valid camera IDs before adding streams:**

```bash
python3 -c 'import json; d=json.load(open("/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app/reference-configs/warehouse-3d/calibration.json")); [print(s["id"]) for s in d["sensors"]]'
```

For the default warehouse-3d resource this prints `Camera`, `Camera_01`, `Camera_02`, `Camera_03` — matching the `.mp4` filename stems in `$WAREHOUSE_3D_VIDEOS`. Do NOT invent names like `cam1/cam2/cam3/cam4` for warehouse-3d.

> **Safe rule of thumb (warehouse-3d):** reuse the **video filename stem** as the `camera_id` (e.g. `Camera_01.mp4` → `camera_id=Camera_01`). Those were calibrated together.

> warehouse-2d and smartcity use cases do NOT have this constraint — their camera_ids are opaque identifiers.

### Static mode example (4 streams)

```bash
source /tmp/scripts/common.sh

case "<usecase>" in
    warehouse-2d)      VIDEOS=$WAREHOUSE_2D_VIDEOS ;;
    warehouse-3d)      VIDEOS=$WAREHOUSE_3D_VIDEOS ;;
    smartcity-rtdetr|smartcity-gdino) VIDEOS=$SMC_VIDEOS ;;
esac

URLS="file://$VIDEOS/Camera.mp4;file://$VIDEOS/Camera_01.mp4;file://$VIDEOS/Camera_02.mp4;file://$VIDEOS/Camera_03.mp4"

# For warehouse-3d: NAMES MUST match calibration.json sensor ids (video stems work).
# For warehouse-2d / smartcity: any unique names.
NAMES="Camera;Camera_01;Camera_02;Camera_03"
N=4

update_ds_config "$MAIN" "[source-list]" num-source-bins   "$N"
update_ds_config "$MAIN" "[source-list]" list              "$URLS"
update_ds_config "$MAIN" "[source-list]" sensor-id-list    "$NAMES"
update_ds_config "$MAIN" "[source-list]" sensor-name-list  "$NAMES"
update_ds_config "$MAIN" "[source-list]" max-batch-size    "$N"
```

> **Important (warehouse-3d):** Sparse4D expects the camera extrinsics in `calibration.json` to match the video viewpoints. If the NGC resource contains multiple video directories, Step 4.a asks the user which one to use — pick the directory whose `.mp4` stems appear as `sensors[].id` entries in `calibration.json`. Re-using 2D videos with a 3D calibration file will produce garbage BEV boxes.

For RTSP in static mode, replace `URLS` with the `rtsp://...` list the user provided, and set each index of `NAMES` to the calibration entry that corresponds to that RTSP feed.

### Dynamic mode example (REST API — warehouse-3d, 4 streams)

```bash
# --network=host → reach the app at localhost:9000
VIDEOS=/opt/storage/resources/.../videos/warehouse-4cams-20mx20m-synthetic   # or $WAREHOUSE_3D_VIDEOS inside container
for NAME in Camera Camera_01 Camera_02 Camera_03; do
  curl -s -X POST http://localhost:9000/api/v1/stream/add \
    -H 'Content-Type: application/json' \
    -d "{\"key\":\"sensor\",\"value\":{\"camera_id\":\"$NAME\",\"camera_name\":\"$NAME\",\"camera_url\":\"file://$VIDEOS/${NAME}.mp4\",\"change\":\"camera_add\",\"metadata\":{}}}"
done
```

### REST `/stream/remove` requirements

- Remove **requires both `camera_id` AND `camera_url`** in the payload. A remove with only `camera_id` returns `STREAM_REMOVE_FAIL, Source url empty`.
- The `camera_id` on remove must EXACTLY match what was used at add time (case-sensitive).
- To rename a stream, remove it first (with the correct url), then re-add with the new id. Do NOT re-add the same url with a different id while the old one is still active (max-batch-size reject).
- For warehouse-3d, do NOT live-fix wrong camera_ids by remove+add while traffic is flowing — Sparse4D can crash with `std::logic_error: basic_string: construction from null is not valid` mid-remove. Safer path: stop the app, correct the IDs, restart.

---

## 4.f.1 — Sink-specific dependency install (filedump only) — now automatic

The DeepStream container ships **without** the software video encoder needed for `[sink2] type=3` (File sink / MP4 / MKV mux). Previously this required a separate manual step in the agent flow; it is now performed **atomically inside `update_output_sink.sh filedump`** and is no longer a discrete workflow step.

Skip entirely for `fakesink` and `eglsink` — they don't need the encoder.

### What the script does (automatic)

Before editing `[sink2]`, `update_output_sink.sh` runs its `ensure_encoder_deps` function:

1. **Validate via plugin registry (not marker):** `gst-inspect-1.0 x264enc` — if the plugin is registered, skip the install. This is the real success signal; a marker file alone is not trusted.
2. **Stale marker?** If `/opt/storage/.user_additional_install.done` exists but `x264enc` is missing (partial install, volume copied from another host, etc.), the marker is removed and the install is retried.
3. **Install:** `cd /opt/nvidia/deepstream/deepstream && ./user_additional_install.sh` — installs `libx264-dev`, `libx265-dev`, `libmp3lame-dev`, and the GStreamer "ugly" plugins (`mp4mux`, `h264parse`, `matroskamux`, etc.). Output is streamed to `/tmp/ds_user_install.log` in case the apt-get under the hood fails.
4. **Re-verify:** `gst-inspect-1.0 x264enc` again. If still missing after install, the script aborts Step 4.d (no config edit is made), so the agent doesn't end up with a half-applied filedump sink that crashes at pipeline build.
5. **On success:** writes `/opt/storage/.user_additional_install.done` so future calls short-circuit at step 1.

### Why validation, not marker-only

A stale marker can exist when:
- A previous install ran but was partially interrupted (e.g. agent retried before apt finished).
- The host volume was copied from a different machine.
- Someone ran `touch /opt/storage/.user_additional_install.done` manually.

With marker-only checks, these cases produce a silent `Failed to create sink_sub_bin_encoder1` at pipeline build — long after the config edit has landed. With `gst-inspect` validation, the problem is caught and fixed during Step 4.d itself.

### Overriding

Pass `--skip-encoder-install` to `update_output_sink.sh` if you plan to flip `[sink2] enc-type=0` (hardware encoder via `nvv4l2h264enc`) yourself afterwards, or if you're working offline and need to defer the install.

### Agent status reporting

Relay `ENCODER_DEPS:` lines from `update_output_sink.sh` stdout:

| Marker line | Tell the user |
|---|---|
| `ENCODER_DEPS: x264enc available — skipping install.` | `Software video encoders already installed — skipping.` |
| `ENCODER_DEPS: installing software encoders via ...` | `Installing software video encoder deps for filedump sink (one-time, ~1-2 min)...` |
| `ENCODER_DEPS: stale marker at ... reinstalling.` | `Previous marker claimed encoders were installed but x264enc is missing — reinstalling.` |
| `ENCODER_DEPS: install complete, x264enc registered, marker written ✓` | `Software encoders installed ✓ — filedump sink ready.` |
| `ENCODER_DEPS: install FAILED — see /tmp/ds_user_install.log` | `Encoder install failed. Show /tmp/ds_user_install.log to the user and fall back to eglsink/fakesink or enc-type=0 hardware.` |

### Disk usage

`user_additional_install.sh` adds ~250 MB of packages to the container. On a `--rm` container the packages are discarded at teardown, but the marker on the host means the next deploy detects the missing plugins (via gst-inspect) and re-runs automatically.

## 4.f — Use-case-specific setup

All 4 use cases now use the **same tiered engine cache lookup** (exact → compatible larger-batch → miss). The script names differ but the strategy is uniform. Override with `FORCE_ENGINE_REBUILD=1` / `--force` / `--exact-only`.

| Use case | Pre-launch cache script | Where engine lives after this step | Strategy |
|---|---|---|---|
| `warehouse-2d` | `prelaunch_nvinfer_engine.sh --onnx <...> --batch <N>` | `<ONNX-adjacent>/<ONNX>_b<N>_gpu0_fp16.engine` (real file OR symlink to larger-batch) | Scans ONNX dir + `$ENGINE_CACHE_DIR` for compatible engines; symlinks so DS loads without rebuild. On miss, DS auto-builds during launch; post-launch `cache_nvinfer_engine.sh` adds a `$ENGINE_CACHE_DIR/<ONNX-basename>_b<N>.engine` symlink (e.g. `rtdetr_warehouse_v1.0.1.fp16.onnx_b4.engine`). |
| `warehouse-3d` | `setup_sparse4d.sh --batch <N>` (with LD_PRELOAD/LD_LIBRARY_PATH exported) | `$ENGINE_CACHE_DIR/<sparse4d-onnx-basename>_b<N>.engine` (e.g. `sparse4d_warehouse_v2.1.onnx_b4.engine`) | Auto-detects the Sparse4D ONNX (config.yaml `onnx_file:` or `$RESOURCES` glob), then `engine_cache_hit <stem> <N>` tiered check. Miss → runs sparse4d_setup.sh which builds directly into the cache. |
| `smartcity-rtdetr` | `prelaunch_nvinfer_engine.sh --onnx <...> --batch <N>` | Same as warehouse-2d (ONNX-adjacent + optional `$ENGINE_CACHE_DIR/<ONNX-basename>_b<N>.engine` symlink) | Same as warehouse-2d. |
| `smartcity-gdino` | `setup_gdino.sh --batch <N>` | `$TRITON_REPO/gdino_trt/1/model.plan` symlinked to `$ENGINE_CACHE_DIR/<ONNX-basename>_b<N>.plan` (e.g. `mgdino_mask_head_pruned_dynamic_batch.onnx_b4.plan`) | `engine_cache_hit <stem> <N> .plan` tiered check, keyed on the GDINO ONNX basename. Miss → trtexec builds to Triton path, then copy-to-cache + symlink-back. |

### How the cache avoids re-builds

`$ENGINE_CACHE_DIR` defaults to `/opt/storage/engines/` which is the host-mounted `~/rtvicv-storage/engines/`, so built engines survive container restarts.

Cache filenames use the **ONNX basename (with `.onnx`) as the stem plus a `_b<N>` batch suffix**, so every entry is version-scoped to the exact model it came from. Bumping the ONNX version produces a new cache name automatically — no stale-engine risk.

All setup scripts call `engine_cache_hit <onnx-basename> <batch> <ext>`, which returns:

1. **Exact match** (`<onnx-basename>_b<N>.<ext>` exists) — best TRT performance, always preferred
2. **Compatible match** (smallest cached engine for the same ONNX with batch ≥ N) — reused via TRT dynamic shapes, skips the rebuild
3. **Miss** — rebuild, then call `cache_engine` to save for next time

Set `FORCE_ENGINE_REBUILD=1` in the environment (or pass `--force` to either setup script) to bypass the cache and rebuild from scratch.

### warehouse-2d / smartcity-rtdetr pre-launch (nvinfer tiered lookup)

```bash
# The ONNX paths were already resolved in Step 4.a (resolve_or_ask, with
# AskQuestion fallback on multi-candidate). Just reuse the variables —
# do NOT re-scan with `find ... | head -n1` (that silently picks one
# when the user has multiple NGC resource versions unpacked).

# warehouse-2d
/tmp/scripts/prelaunch_nvinfer_engine.sh --onnx "$WAREHOUSE_2D_ONNX" --batch <N>

# smartcity-rtdetr
/tmp/scripts/prelaunch_nvinfer_engine.sh --onnx "$RTDETR_ONNX" --batch <N>
```

**What it does:**

1. Computes the target path: `<ONNX>_b<N>_gpu0_fp16.engine`
2. **Exact match** — if that file exists (not a stale symlink), exit 0 (DS will deserialize it directly on launch).
3. **Compatible match** — if missing, scans (a) the ONNX directory and (b) `$ENGINE_CACHE_DIR` for any `_b<M>_gpu0_fp16.engine` with M ≥ N. Picks the smallest M that fits.
4. If a compatible engine is found → creates a symlink at the target path so DS sees the engine at its expected location. TRT dynamic shapes let the larger engine serve the smaller batch natively.
5. If nothing suitable → miss; DS will build from ONNX during launch (~3-5 min).

**Example: user deployed batch=4 yesterday, wants batch=3 today**

```
Requested: <ONNX>_b3_gpu0_fp16.engine (doesn't exist)
Scanning:  <ONNX>_b2_gpu0_fp16.engine — skip, batch too small
           <ONNX>_b4_gpu0_fp16.engine — MATCH (batch 4 >= 3)
Result:    symlink <ONNX>_b3_gpu0_fp16.engine -> <ONNX>_b4_gpu0_fp16.engine
           DS loads the b4 engine, serves batch=3 natively via dynamic shapes
           → 3-5 min build skipped.
```

**Flags:**

- `--exact-only` or env `ENGINE_EXACT_MATCH_ONLY=1` — disables the compatible-batch fallback
- `--gpu <N>` — GPU index in the filename (default 0)
- `--precision fp16` / `fp32` — precision suffix (default fp16)

### warehouse-3d extras

```bash
export LD_PRELOAD=$SPARSE4D_REPO/libmsda_fp16.so
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:$SPARSE4D_REPO:/usr/local/lib/python3/dist-packages/torch/lib
/tmp/scripts/setup_sparse4d.sh --batch <N>
```

The script reads the Sparse4D ONNX path from `config.yaml`'s `onnx_file:` key (which Step 4.b already substituted to `$SPARSE4D_ONNX`) and uses its basename as the cache stem. It then updates `config.yaml`'s `engine_file:` to point at `$ENGINE_CACHE_DIR/<sparse4d-onnx-basename>_b<N>.engine` and, on a cache miss, runs `sparse4d_setup.sh` which builds directly into the cache. On cache hit the setup is skipped entirely. If `onnx_file:` still holds the literal `<PATH_TO_ONNX_MODEL>` placeholder (Step 4.b was skipped), the script errors out rather than falling back to a path-guess.

### smartcity-gdino extras

```bash
/tmp/scripts/setup_gdino.sh --batch <N>
```

Copies the ONNX into `$TRITON_REPO/gdino_trt/1/model.onnx`, then:
- **Cache hit** → symlinks Triton's fixed `model.plan` at the cached engine, skips trtexec
- **Cache miss** → runs trtexec → saves to `$ENGINE_CACHE_DIR/<ONNX-basename>_b<N>.plan` → symlinks `model.plan` to the cached file

## 4.g — Cache the DS-auto-built engine (warehouse-2d, smartcity-rtdetr only — post-launch reference, invoked from `start-app.md` § 5.e)

**Run AFTER the app has started** and the engine build has completed (signal: the REST server replies on `:9000`, or the app log shows the pipeline running).

DeepStream's `nvinfer` ignores the `model-engine-file` path for writes — it always saves the built engine next to the ONNX as `<onnx-name>_b<N>_gpu<G>_fp<P>.engine`. This script symlinks that auto-built engine into `$ENGINE_CACHE_DIR/<ONNX-basename>_b<N>.engine` so the PGIE config's `model-engine-file` path resolves correctly on the **next** deploy — avoiding a 3-5 min rebuild. Using the ONNX basename as the cache stem keeps entries version-scoped.

### warehouse-2d

```bash
# $WAREHOUSE_2D_ONNX was resolved in Step 4.a (with user-confirm on ambiguity).
docker exec <CONTAINER_NAME> /tmp/scripts/cache_nvinfer_engine.sh \
    --onnx "$WAREHOUSE_2D_ONNX" --batch <N>
```

### smartcity-rtdetr

```bash
# $RTDETR_ONNX was resolved in Step 4.a.
docker exec <CONTAINER_NAME> /tmp/scripts/cache_nvinfer_engine.sh \
    --onnx "$RTDETR_ONNX" --batch <N>
```

### Effect

| Deploy | What happens |
|---|---|
| **1st deploy** (fresh) | DS auto-builds next to ONNX (3-5 min) → skill creates symlink `$ENGINE_CACHE_DIR/<onnx-basename>_b<N>.engine` pointing at the real engine |
| **2nd deploy** (same batch) | Pre-launch hook finds the cached engine via `<onnx-basename>_b<N>`, symlinks it to the DS-expected path → engine loaded instantly (no rebuild) |
| **2nd deploy (different batch N)** | No exact-batch symlink → tiered lookup picks a compatible larger-batch engine if one exists; otherwise DS rebuilds for the new batch and a fresh cache entry is created |
| **New ONNX version** (NGC resource bumped) | Cache stem changes (new ONNX basename) → no accidental reuse of a stale engine → DS rebuilds fresh, fresh cache entry is populated |

### Skipping conditions

`cache_nvinfer_engine.sh` is safe to run at any time — it's idempotent and exits cleanly if the engine hasn't been built yet (it just logs `ENGINE_CACHE: LINK_SKIP`). If the expected auto-built engine isn't found, the deploy still works (DS handles its own cache), but the symlink won't be created — re-run after the engine is built.

### Why not run this for warehouse-3d / smartcity-gdino?

Those use custom setup scripts (`setup_sparse4d.sh`, `setup_gdino.sh`) that **build directly into the cache**, so no post-build linking is needed. `cache_nvinfer_engine.sh` is only for nvinfer-based models that use DeepStream's auto-build path.

## 4.h — Deployment log (every deploy creates one — owned by `start-app.md` § 5.a)

Every `rtvicv-deploy` run MUST produce a persistent log file under `$STORAGE/logs/<usecase-and-model>_<timestamp>.txt` (persisted to `~/rtvicv-storage/logs/` on the host). The log is initialized by `scripts/write_deployment_log.sh` before the app starts and captures the full deployment context in one file.

### What goes into the log (in order)

1. **Header** — timestamp, host, user
2. **Deployment Settings** — use case, batch size, sink, platform, stream mode, input type, videos dir, docker image, NGC resource
3. **Docker Run Command** — the exact multi-line `docker run ...` used to start the container
4. **App Launch Command** — the `metropolis_perception_app -c <cfg>` command about to run
5. **Config file dumps** — full content of every config file this use case touches:
   - warehouse-2d: `ds-main-config.txt`, `ds-ppl-analytics-pgie-config.yml`, `ds-nvdcf-accuracy-tracker-config.yml`, `ds-detector-labels.txt`
   - warehouse-3d: `ds-main-config.txt`, `config.yaml`, `calibration.json`, `ds-mtmc-preprocess-config.txt`, `ds-mtmc-videotemplate_custom_lib_config.txt`
   - smartcity-rtdetr: `run_config-api-rtdetr-protobuf.txt`, `rtdetr-960x544.txt`, `rtdetr-960x544-labels.txt`
   - smartcity-gdino: `run_config-api-rtdetr-protobuf.txt`, `config_triton_nvinferserver_gdino.txt`
6. **Runtime log** — the app's stdout/stderr appended after launch

### Invocation (wire into Step 5)

```bash
LOG=$(docker exec <CONTAINER_NAME> /tmp/scripts/write_deployment_log.sh \
    --usecase "$USECASE" --batch "$BATCH" --sink "$SINK" \
    --platform "$PLATFORM" --stream-mode "$STREAM_MODE" --input-type "$INPUT_TYPE" \
    --videos "$VIDEOS_DIR" --image "$RTVI_CV_IMAGE" --ngc "$NGC_REF" \
    --docker-cmd "$DOCKER_RUN_CMD" --app-cmd "$APP_CMD")

# $LOG now points at /opt/storage/logs/deployment_YYYYMMDD_HHMMSS.txt
# Start the app and APPEND its output to the same file:
docker exec -d <CONTAINER_NAME> bash -c "$APP_CMD >> \"$LOG\" 2>&1"
```

### Why this matters

- **Debug later** — every deploy captures the exact config state that was used, even after the container exits (`--rm` cleanup)
- **Reproducibility** — share the log file with a colleague to reproduce a specific run
- **Rebuild-free config diffing** — compare two deployments by just diffing their log files
- **Engine build traces** — if the engine build fails mid-run, the full trtexec/TRT output is preserved
- **Persistence** — `$STORAGE/logs/` is the host-mounted `~/rtvicv-storage/logs/` so logs survive container teardown

### Log file location

| Inside container | On host |
|---|---|
| `/opt/storage/logs/<usecase-and-model>_<ts>.txt` | `~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt` |

Users can `tail -f ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt` from any shell to watch the build + runtime progress in real time.
