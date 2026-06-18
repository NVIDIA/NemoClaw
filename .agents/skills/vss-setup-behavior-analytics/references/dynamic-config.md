> See [`../SKILL.md`](../SKILL.md) for the project overview.

# Dynamic Configuration

behavior-analytics supports updating `AppConfig.app[*]` and `AppConfig.sensors[*]` at runtime via messages on the `mdx-notification` Kafka topic. This document is the **contract for component authors** — anything you add to the codebase that consumes config has to play by these rules or dynamic updates will silently no-op against it.

For end-user docs (HTTP API, video-analytics-api integration, message envelopes from the operator side), see the video-analytics-api repo. This file is about the behavior-analytics-side mechanics.

---

## Quick mental model

```
video analytics api  -- upsert -->  mdx-notification  -- broadcast -->  behavior-analytics replicas
                                                                              |
                                                                              v
                                                                ConfigListener (main process)
                                                                              |
                                                                              v
                                                                ConfigApplier on main +
                                                                ConfigFileMonitor on workers
                                                                              |
                                                                              v
                                                                AppConfig.invalidate_caches()
                                                                              |
                                                                              v
                                                                Read-at-use consumers see
                                                                new values on next read.
```

Two flows:

- **Flow A** (`upsert`): operator updates config via the video analytics api → broadcast to all replicas → each applies, publishes `ack`.
- **Flow B** (`request-config` → `upsert-all`): behavior-analytics asks the video analytics api for the latest verified config at startup → it replies with a payload tagged for that specific replica.

---

## Consumer classification (how your code reads config)

When you add a class that reads `self.config.X`, decide which of these patterns you want — it determines whether dynamic updates reach you automatically.

### Read-at-use (preferred)

Store the `AppConfig` reference, read values **inside method bodies** at call time:

```python
class StateMgmtBase:
    def __init__(self, config: AppConfig, calibration: CalibrationBase) -> None:
        self.config = config             # reference, not value

    def some_method(self):
        if not self.config.in_simulation_mode:   # read-at-use
            ...
```

**Behavior under dynamic updates:** `ConfigApplier.apply(...)` mutates `config.app` then calls `config.invalidate_caches()`. The next read returns the new value. **No additional code needed.**

### Per-call value-capture (rotates within seconds)

Pass values into a sub-object that's reconstructed on every call:

```python
class StateMgmt:
    def _create_trajectory(self, ...) -> TrajectoryE:
        return TrajectoryE(
            smooth_window_size=self.config.traj_smooth_window_size,  # value passed in
            ...
        )
```

**Behavior under dynamic updates:** new sub-objects pick up the new value; pre-existing ones keep the old value until naturally rotated. The stale window is bounded by sub-object lifetime — for trajectories that's one frame batch per object, which is acceptable.

### Captured-at-`__init__` (restart-required)

Capture a value into an attribute at `__init__` time:

```python
class CollisionDetection:
    def __init__(self, config: CollisionDetectionConfig, ...) -> None:
        self.config = config           # CAPTURED reference -- no AppConfig view
```

**Behavior under dynamic updates:** the captured value stays stale forever — `invalidate_caches()` clears AppConfig's caches, but the value already copied into `self.config` (or any other captured attribute) doesn't get refreshed.

**This is supported but not auto-refreshed.** Operators must restart the process to pick up changes to these fields. There is no in-process reload mechanism — none of the consumers shipping today require one. If you want a value to take effect at runtime, refactor to read-at-use (`self.config.X` inside the method that uses it). The validator's allowlist (see below) explicitly excludes the names known to be captured-at-`__init__` so operators don't silently believe an update landed.

---

## Refactoring captured-at-`__init__` → read-at-use

If your class currently captures a value at `__init__`, the typical refactor is:

```python
# Before (captured-at-__init__):
class MyConsumer:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.threshold = self.config.behavior_water_mark   # captured value

    def process(self, items):
        return [x for x in items if x.score < self.threshold]

# After (read-at-use):
class MyConsumer:
    def __init__(self, config: AppConfig) -> None:
        self.config = config

    def process(self, items):
        return [x for x in items if x.score < self.config.behavior_water_mark]  # read at use-time
```

For sub-config consumers (those that take e.g. `CollisionDetectionConfig` instead of `AppConfig`), you have two options:

1. **Refactor to take `AppConfig`** and re-derive the sub-config inside the method that needs it. Most flexible.
2. **Accept that this consumer is restart-only** and document it. Make sure the affected names are NOT in the validator's allowlist.

Test that a mutation followed by `config.invalidate_caches()` causes the next read of your method to return the new value.

---

## Wire format

```
topic:    mdx-notification
key:      "behavior-analytics-config"            # filters dynamic-config from calibration on the same topic
headers:
  event.type:    upsert | upsert-all | ack | request-config
  reference-id:  <uuid>                          # correlates request and reply
                                                 # video analytics api -> "video-analytics-api-<uuid>"
                                                 # behavior-analytics -> "behavior-analytics-<uuid>"
value (JSON):
  {
    "status":       null | "success" | "partial-success" | "failure",
    "config":       null | { "app": [...], "sensors": [...] },
    "error": null | "<details>"
  }
```

Read-only sections (`kafka`, `redisStream`, `mqtt`, `coordinateReferenceSystem`, `inference`) **are stripped** — each one becomes a per-section rejection in the `error`. If they appear alongside valid `app` / `sensors` items, the result is `partial-success`. If they appear alone (operator tried to set them, every section was refused), the result is `failure` — distinct from sending an empty `{}` (success no-op).

---

## Flow A — operator update

```
 user        video analytics api      mdx-notification         behavior-analytics (×N)
  │ POST /config   │                       │                         │
  ├───────────────▶│                       │                         │
  │                │ publish upsert        │                         │
  │                ├──────────────────────▶│ fan-out to every group  │
  │                │                       ├────────────────────────▶│ verify + apply
  │                │                       │                         │ publish ack
  │                │ consume ack           │                         │
  │                ◀──────────────────────────────────────────────────
  │                │ persist DB            │                         │
  │                │                       │                         │
```

| Phase | `event.type` | `value` |
|---|---|---|
| video analytics api → topic | `upsert` | `{ status: null, config: <patch>, error: null }` |
| behavior-analytics → topic (success) | `ack` | `{ status: "success", config: <full merged: app+sensors only>, error: null }` |
| behavior-analytics → topic (partial) | `ack` | `{ status: "partial-success", config: <merged with applied parts only>, error: "<which succeeded / failed>" }` |
| behavior-analytics → topic (failure) | `ack` | `{ status: "failure", config: null, error: "<reason>" }` |

---

## Flow B — replica bootstrap

```
 behavior-analytics            mdx-notification         video analytics api    DB
      │ start, load disk baseline   │                  │                  │
      │ publish request-config      │                  │                  │
      ├────────────────────────────▶│                  │                  │
      │                             ├─────────────────▶│ read latest      │
      │                             │                  ├─────────────────▶│
      │                             │                  ◀─────────────────┤
      │                             │ publish upsert-all                  │
      │                             ◀─────────────────┤ (echoes ref-id)   │
      ◀────────────────────────────┤                  │                  │
      │ apply iff ref-id matches mine; otherwise ignore                   │
   -- if no reply within bootstrap_timeout: continue with disk baseline --
```

`bootstrap_timeout` defaults to 15 s (see `config_listener.DEFAULT_BOOTSTRAP_TIMEOUT_SEC`). On timeout the listener logs a warning and proceeds with whatever was loaded from disk.

| Phase | `event.type` | `value` |
|---|---|---|
| behavior-analytics → topic | `request-config` | `{ status: null, config: null, error: null }` |
| video analytics api → topic (DB has) | `upsert-all` | `{ status: "success", config: <full latest>, error: null }` |
| video analytics api → topic (DB empty) | `upsert-all` | `{ status: "failure", config: null, error: "no config in DB" }` |

`upsert-all` is filtered by `reference-id` — each replica only adopts the reply tagged with its own `behavior-analytics-<uuid>` (generated fresh per process). This is what lets a single broadcast reply target one specific replica.

---

## Component map

Under `video-search-and-summarization/services/analytics/behavior-analytics/`:

```
src/mdx/analytics/core/transform/config/
├── config_validator.py        # Stateless validation: shape -> scope -> allowlist -> per-key value
├── config_value_validators.py # Per-key value-rule registry (type / range / enum / Pydantic-JSON)
├── config_applier.py          # Mutate AppConfig + invalidate caches (no validation)
├── config_publisher.py        # Emit request-config and ack via the app's Sink
├── config_listener.py         # Main-process: bootstrap + dispatch + write file + apply on main
└── config_monitor.py          # Per-worker watchdog: pick up files written by the listener
```

Wired up in `video-search-and-summarization/services/analytics/behavior-analytics/src/mdx/analytics/core/app/app_runner.py` (one `ConfigListener` per main process) and `video-search-and-summarization/services/analytics/behavior-analytics/src/mdx/analytics/core/app/app_base.py` (one `ConfigFileMonitor` per worker). The listener writes a JSON file into `CONFIG_DIR` (default `/tmp/checkpoint/config`) on every successful apply; each worker's `ConfigFileMonitor` picks up the file via watchdog `on_moved` and applies through its own local `ConfigApplier`.

### Why per-worker monitor, not per-process

Workers are separate processes (multiprocessing). Each has its own `AppConfig` after pickling. Mutating the main-process `AppConfig` would not propagate. So:

- **Main**: a single `ConfigListener` consumes `mdx-notification`, validates, atomically writes a file into `CONFIG_DIR`, applies on its local `AppConfig`, and acks.
- **Each worker**: a `ConfigFileMonitor` watches `CONFIG_DIR` and applies the same file via its own `ConfigApplier`.

This keeps Kafka consumer count at one per main process (multi-replica fan-out still works because each main has a unique `_config_replica_tag = uuid.uuid4().hex` Kafka group suffix) while every worker still picks up updates without going across the wire.

---

## Validation ladder (what `validate()` checks)

The validator runs in both main (on inbound notifications) and workers (defense-in-depth on file content). Stages, in order:

1. **Shape** — payload must be a JSON object (`dict`). Anything else is wholesale `failure`.
2. **Scope** — only `app` and `sensors` are mutable top-level keys. Other keys (`kafka`, `redisStream`, `mqtt`, `coordinateReferenceSystem`, `inference`) become per-section rejections — they don't short-circuit, valid `app` / `sensors` items still apply.
3. **Per-item shape** — each `(name, value)` entry must have a non-empty string `name` and a string `value`.
4. **Allowlist** — `name` must appear in `ALLOWED_APP_KEYS` (for `app[*]`) or `ALLOWED_SENSOR_KEYS` (for `sensors[*].configs[*]`). Names outside the allowlist are rejected with `"not allowlisted for dynamic update"` so operators don't silently expect a captured-at-`__init__` key to take effect.
5. **Value** — the string `value` must satisfy the per-key rule registered in `config_value_validators.py` (type / range / enum / Pydantic schema for JSON-encoded sub-configs). Names absent from the rule registry pass unconditionally so future allowlist additions degrade safely.
6. **Per-sensor all-or-nothing** — if any item under a sensor's `configs` rejects, the entire sensor entry is dropped (other sensors are unaffected).

Result semantics:

| Case | Status | `error` |
|---|---|---|
| All items good, no rejections | `success` | `null` |
| Zero items in input (`{}`, `{"app":[],"sensors":[]}`) | `success` | `null` (legitimate no-op — operator said "no changes" and we did exactly that) |
| Some good items + some rejections | `partial-success` | `"applied N; rejected: ..."` (good items applied, error lists the per-item rejections) |
| Items present in input but every one of them rejected | `failure` | `"rejected: ..."` |
| Payload not a dict / malformed shape | `failure` | `"payload is not a JSON object"` (or similar) |

Note the deliberate split between "zero items in input" (success no-op) and "items present, all rejected" (failure). A heartbeat-style empty patch from the operator's tooling should look distinguishable on the wire from a patch that tried to mutate a restart-required key and was refused.

**Ambiguous shapes are explicitly rejected** rather than silently picking one interpretation. `{"sensors":[{"id":"x","configs":[]}]}` could mean either (a) "no change for sensor x" — in which case the operator should just omit the entry, equivalent to `{}` — or (b) "wipe x's configs" — which would need a separate `delete` event the wire contract doesn't yet support. The validator returns a per-item rejection (`"empty sensor configs not allowed"`) so the operator has to disambiguate themselves — either by omitting the entry (no-op) or by waiting for a future `delete` event.

---

## Known limitations and gotchas

1. **Per-call value-capture has a brief stale window** — sub-objects constructed before the upsert keep their original parameters until naturally rotated. For trajectories that's one frame batch per object; acceptable in practice.
2. **Captured-at-`__init__` consumers require a restart.** A few classes capture config values into instance attributes at `__init__` (e.g. `CollisionDetection` taking `CollisionDetectionConfig`, `SpaceAnalyzer` taking `SpaceAnalyticsConfig`, the embedding downsamplers taking `VideoEmbeddingConfig`, Smart City app's `anomalyCollisionDetection`). For these, dynamic-config updates land in `AppConfig` but do *not* propagate — operators must restart the process. The allowlist explicitly excludes the affected names so the validator rejects them with `"not allowlisted for dynamic update"` rather than letting them silently no-op.
3. **`request-config` failure mode** — if the video analytics api is unreachable at startup, the listener continues with the disk-baseline config after `bootstrap_timeout`. Configs are still consumable through Flow A once the video analytics api comes back online.
4. **Bootstrap is additive** — items present in main's existing config that the bootstrap reply does not mention are preserved. Removing items via bootstrap is intentionally not supported (would require a separate `delete` event type).
5. **Cache invalidation is process-wide** — `AppConfig.invalidate_caches()` calls `cache_clear()` on the `@cache`-wrapped instance methods, which are class-level descriptors. Clearing them affects every `AppConfig` instance in the process, not just the one the applier mutated. In production each main / worker process holds exactly one `AppConfig`, so this is the intended behavior. Tests that construct multiple `AppConfig` instances in one process should be aware that an `invalidate_caches()` on one instance will evict cached values on the others too. (`@cached_property` values are per-instance and are unaffected by this caveat.)

---

## Testing approach

Test files live under `video-search-and-summarization/services/analytics/behavior-analytics/`:

| Layer | Test file | What to add |
|---|---|---|
| Cache invalidation | `tests/unit/mdx/analytics/core/schema/test_config.py::TestAppConfig` | Test that mutating + `invalidate_caches()` flips a cached property's value. |
| Validator | `tests/unit/mdx/analytics/core/transform/config/test_config_validator.py` | Test new error paths or status transitions. |
| Per-key value rules | `tests/unit/mdx/analytics/core/transform/config/test_config_value_validators.py` | Test new entries in `APP_VALUE_VALIDATORS` / `SENSOR_VALUE_VALIDATORS`. |
| Applier (mutator) | `tests/unit/mdx/analytics/core/transform/config/test_config_applier.py` | Test new mutation paths if you change `set_app_config` / `set_sensor_config`. |
| Outgoing envelopes | `tests/unit/mdx/analytics/core/transform/config/test_config_publisher.py` | Test new `event.type` shapes if you add one. |
| Listener dispatch | `tests/unit/mdx/analytics/core/transform/config/test_config_listener.py` | Test new event-type routing. |
| Worker file monitor | `tests/unit/mdx/analytics/core/transform/config/test_config_monitor.py` | Test new file-handling paths. |
| End-to-end | `tests/integration/dynamic_config/dynamic_config_e2e.py` | Add a scenario for new wire-level behavior. See its README. |

Aim for 100% line + branch coverage on new code under `src/mdx/analytics/core/transform/config/`. The six modules there are at 100% today — keep that bar.

---

## Where to find canonical examples

All paths below are under `video-search-and-summarization/services/analytics/behavior-analytics/`:

- Read-at-use consumer: `src/mdx/analytics/core/stream/state/behavior/state_management_base.py` (just stores the `AppConfig` reference; reads at use-time).
- Per-call value-capture: `src/mdx/analytics/core/stream/state/behavior/state_management_e.py::_create_trajectory` (passes values into a per-call sub-object).
- Captured-at-`__init__` (restart-required) consumers: `src/mdx/analytics/core/transform/detection/collision_detection.py`, `src/mdx/analytics/core/utils/space_utilization.py::SpaceAnalyzer`, `src/mdx/analytics/core/stream/state/video_embedding/downsampling/`. Their config keys are intentionally absent from the validator's allowlist.
