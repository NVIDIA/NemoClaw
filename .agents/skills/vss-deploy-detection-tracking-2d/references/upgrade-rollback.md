# Upgrade & Rollback

How to move RTVI-CV between image tags safely while preserving the engine
cache and deployment logs.

---

## Upgrade (new image tag)

```bash
# 1. Stop and remove the running container
docker stop <CONTAINER_NAME> && docker rm <CONTAINER_NAME>

# 2. Pull the new image
export RTVI_CV_IMAGE="nvcr.io/<org>/<repo>:<new-tag>"
docker pull "$RTVI_CV_IMAGE"

# 3. Re-deploy via the skill (Steps 1–5 (Step 6 is the post-deploy menu))
#    Engine cache at ~/rtvicv-storage/engines/ is preserved and reused
#    when ONNX-compatible.
```

---

## Rollback

```bash
# Pin the previous tag
export RTVI_CV_IMAGE="nvcr.io/<org>/<repo>:<previous-tag>"
docker stop <CONTAINER_NAME> && docker rm <CONTAINER_NAME>
docker pull "$RTVI_CV_IMAGE"
# Re-deploy via the skill (Steps 1–5 (Step 6 is the post-deploy menu)). Engine cache survives rollback.
```

---

## What Survives an Upgrade / Rollback

| Item                                                      | Survives? |
|-----------------------------------------------------------|-----------|
| Engine cache (`~/rtvicv-storage/engines/`)                | yes — filename keys on ONNX basename + batch, so it survives image updates as long as the ONNX file is unchanged |
| NGC resources (`~/rtvicv-storage/resources/`)             | yes — re-used until the user explicitly wipes them |
| Deployment logs (`~/rtvicv-storage/logs/*_<ts>.txt`)| yes — never auto-deleted |
| NGC credentials (`~/.ngc/config`, `0600`)                 | yes — never auto-deleted, even on `teardown --full-wipe` |
| Pipeline config edits inside the **previous** container   | no — the new container ships fresh configs; the skill re-applies your settings on the next deploy |

If you need a hard reset, use `teardown` mode and select the
"engine cache + resources" cleanup scope explicitly. See
`teardown-flow.md`.

---

## Cache Invalidation

The engine cache survives upgrades — but a few situations force a rebuild:

- **TRT version bump** (image upgrade brings a newer TRT): TRT rejects the
  old engine; the skill detects the rebuild and announces it.
- **GPU architecture change** (re-deploy on a different host): engines are
  SM-specific.
- **ONNX file change**: a different ONNX produces a different cache key —
  no overlap with the previous engine.
- **Explicit force**: `FORCE_ENGINE_REBUILD=1` or pass `--force` to a setup
  script.
