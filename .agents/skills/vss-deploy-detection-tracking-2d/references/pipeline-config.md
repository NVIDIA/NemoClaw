# Step 2 — Pipeline Configuration (batch size, streams, sink)

Collect the 4 pipeline parameters in a single `AskQuestion` interaction, then a conditional follow-up for the stream-add delay (dynamic mode only).

## Defaults — the skill is **static-mode by default**

The default `stream_mode` is **`static`** — the agent bakes auto-discovered
`file://` stream URLs into the DS main config's `[source-list]` block
**before** the perception app starts. The skill MUST NOT silently choose
`dynamic`; that mode exists only when the user explicitly asks for it (e.g.
"add streams later via REST" or "dynamic stream mode").

Why static is the default:
- Eval rubrics expect static mode for "deploy with N streams" queries —
  the `[source-list]` block is checked at app-start time.
- All streams come up together at launch, so FPS / `/metrics` reflect the
  full requested batch immediately; no inter-add race.
- Static mode plays nicely with `[tests] file-loop=1` for fakesink/eglsink
  — videos loop forever, keeping the pipeline alive until the user tears
  it down.

Dynamic mode is appropriate only when the user explicitly says so, or when
they want to add cameras to a running deployment after the fact via REST
`/api/v1/stream/add`. The Step 2 `AskQuestion` keeps `dynamic` available as
a non-default option for those cases.

## Primary `AskQuestion` (4 parameters at once)

```json
{
  "questions": [
    {
      "id": "batch_size",
      "prompt": "Max batch size / max concurrent streams?",
      "options": [
        {"id": "1", "label": "1"},
        {"id": "2", "label": "2"},
        {"id": "4", "label": "4 (default)"},
        {"id": "8", "label": "8"},
        {"id": "custom", "label": "Custom (I'll specify)"}
      ]
    },
    {
      "id": "stream_mode",
      "prompt": "How will streams be added?",
      "options": [
        {"id": "static",  "label": "Static — pre-configure sources in the main config (DEFAULT — recommended for almost all deploys)"},
        {"id": "dynamic", "label": "Dynamic — add via REST /stream/add after the app starts (choose only if the user explicitly wants late stream attach)"}
      ]
    },
    {
      "id": "input_type",
      "prompt": "Input source type?",
      "options": [
        {"id": "filesrc", "label": "Local video files — filesrc (default, uses test videos from NGC resource)"},
        {"id": "rtsp",    "label": "RTSP streams — I'll provide the URL list"}
      ]
    },
    {
      "id": "output_sink",
      "prompt": "Output sink?",
      "options": [
        {"id": "fakesink", "label": "Fakesink — no display, no file (default, for benchmarking)"},
        {"id": "eglsink",  "label": "Display (eglsink) — visualize on screen (requires X11)"},
        {"id": "filedump", "label": "File dump — save output to disk"}
      ]
    }
  ]
}
```

**If `input_type = rtsp`:** ask in chat for the RTSP URLs (semicolon-separated or one per line).

## Warehouse-3d follow-up — batch > calibrated cameras

This only applies to `usecase == warehouse-3d` AND `input_type == filesrc`. For every other case, skip this section entirely.

After the primary `AskQuestion` resolves, the agent counts `.mp4` files in the resolved videos directory (or the user-supplied custom dir). If the chosen `batch_size` exceeds that count, fire a follow-up `AskQuestion` with **exactly two options, cycle = Recommended**:

```json
{
  "questions": [
    {
      "id": "warehouse3d_cycle",
      "prompt": "Warehouse-3d videos directory has <N> .mp4 files but batch=<B>. How should I fill the extra streams?",
      "options": [
        {"id": "cycle",  "label": "Cycle through the <N> videos in cyclic order to replicate <B> streams (Recommended)"},
        {"id": "reduce", "label": "Reduce to batch=<N> (use the <N>-cam set as-is)"}
      ]
    }
  ]
}
```

- **`cycle`** (default): proceed with the user's requested batch size. `discover_streams.sh` cycles the available `.mp4` files into `batch` unique stream ids (cycled ids get a `_<i>` suffix so REST `/stream/add` doesn't reject duplicates). No warning prose — treat cycling as expected.
- **`reduce`**: overwrite `batch_size` with `<N>` (the available-cam count) and continue. The Step 2 exit box reflects the reduced batch.

The follow-up is silent (no `AskQuestion`) when batch ≤ available cam count, and is skipped entirely for non-warehouse-3d use cases or when `input_type == rtsp` (RTSP URLs are user-supplied — no cycling concept).

## Delay between stream adds — dynamic mode only

The delay-between-adds setting **only applies to `stream_mode = dynamic`**. In static mode, all streams are pre-baked into the main config's `[source-list]` and started together when the pipeline launches — the REST `/stream/add` loop is never invoked, so there is nothing to space out.

```text
stream_mode = dynamic  →  ask the delay question (below)
stream_mode = static   →  SKIP — streams are fired simultaneously at app launch,
                          no per-add timing exists. Set STREAM_ADD_DELAY to an
                          empty / sentinel value (or leave it undefined).
```

**If `stream_mode = dynamic`:** apply a default `STREAM_ADD_DELAY=20` per
the minimal-interaction contract. 20s spacing is stable on all platforms
(dGPU, SBSA, Jetson) and avoids the "Opening in BLOCKING MODE" interleave
that happens with back-to-back `/stream/add` calls.

**Apply silently, but announce before use** (per SKILL.md § Announce-before-
applying). Do NOT drive an `AskQuestion` — the user can interrupt if they
want a different value.

```bash
: "${STREAM_ADD_DELAY:=20}"   # default — applied silently, announced below
```

Announce line (emit BEFORE Step 5.g starts adding streams):

```
ℹ stream_add_delay: 20s (default) — interrupt now if you want a different value.
```

If the user's query explicitly specified a delay, use that value and
announce as:

```
ℹ stream_add_delay: <N>s (from query) — interrupt now if you want a different value.
```

Also include the value in the pipeline summary line on Step 2 exit:
`✔ Pipeline: batch=<N>, static, filesrc, fakesink` (defaults: `static`
stream-mode and `fakesink` sink; the `delay=<N>s` segment appears only
when the user picked `dynamic`).

**Legacy prompt (kept for reference — do NOT use by default):** if a future
deploy mode explicitly asks for an interactive delay choice, here's the
`AskQuestion` JSON:

```json
{
  "questions": [
    {
      "id": "stream_add_delay",
      "prompt": "Delay between each dynamic /stream/add call?",
      "options": [
        {"id": "20", "label": "20 seconds — safest"},
        {"id": "10", "label": "10 seconds — default (recommended)"},
        {"id": "5",  "label": "5 seconds — fast (dGPU, ≤4 streams)"},
        {"id": "0",  "label": "0 seconds — may race"}
      ]
    }
  ]
}
```

Store as `STREAM_ADD_DELAY` (used only by Step 5.g, which itself runs only when `stream_mode = dynamic`).

## Step 2 exit box — mode-aware rows

The Step 2 box uses the universal 128-wide box format from SKILL.md (single source of truth: SKILL.md § "Universal box format").
**Render only the rows that apply to the chosen settings.** Never show
a row with an "(ignored)" / "(not used)" annotation — drop it entirely.

| Row             | Show when…                          |
|-----------------|--------------------------------------|
| `Batch size`    | always                                |
| `Stream mode`   | always                                |
| `Input type`    | always                                |
| `Output sink`   | always                                |
| `Add delay`     | **only if `stream_mode=dynamic`**    |
| `RTSP URLs`     | only if `input_type=rtsp`            |

### Worked examples

`static + filesrc + eglsink, batch=2` (4 rows, no delay row):

```
┌─────────────────────────────────────────────────── Pipeline configuration ───────────────────────────────────────────────────┐
│                                                                                                                              │
│   ✔ Batch size    2                                                                                                          │
│   ✔ Stream mode   static  (sources baked into ds-main-config.txt at app startup)                                             │
│   ✔ Input type    filesrc  (.mp4 files from nv-warehouse-4cams)                                                              │
│   ✔ Output sink   eglsink  (on-screen display via X11 / DISPLAY)                                                             │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

`dynamic + filesrc + eglsink, batch=4` (5 rows including delay):

```
┌─────────────────────────────────────────────────── Pipeline configuration ───────────────────────────────────────────────────┐
│                                                                                                                              │
│   ✔ Batch size    4                                                                                                          │
│   ✔ Stream mode   dynamic  (REST /stream/add after the app starts)                                                           │
│   ✔ Input type    filesrc  (.mp4 files from nv-warehouse-4cams)                                                              │
│   ✔ Output sink   eglsink  (on-screen display via X11 / DISPLAY)                                                             │
│   ✔ Add delay     20 s  (inter-add delay between /stream/add calls)                                                          │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

`dynamic + rtsp + filedump, batch=4` (6 rows including delay + RTSP list):

```
┌─────────────────────────────────────────────────── Pipeline configuration ───────────────────────────────────────────────────┐
│                                                                                                                              │
│   ✔ Batch size    4                                                                                                          │
│   ✔ Stream mode   dynamic  (REST /stream/add after the app starts)                                                           │
│   ✔ Input type    rtsp  (4 URLs, supplied in chat)                                                                           │
│   ✔ Output sink   filedump  (MP4 → /opt/storage/output/<usecase>_output.mp4)                                                 │
│   ✔ Add delay     20 s  (inter-add delay between /stream/add calls)                                                          │
│   ✔ RTSP URLs     rtsp://cam-01/stream  rtsp://cam-02/stream  rtsp://cam-03/stream  …                                        │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
