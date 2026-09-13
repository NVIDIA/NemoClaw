# Test the Spark lifecycle

These tests exercise an existing managed Spark deployment and retain its data.
Complete [Spark deployment](../guides/dgx-spark.md) first.
The lifecycle test intentionally stops inference through the watchdog and then reapplies the deployment.

Deterministic fixtures cover download/preparation interruption, authentication and transport failures, partial observations, ownership/configuration drift, capacity rejection, immediate startup exit, and supervised child shutdown.
Run the native OpenTofu/provider integration suite with `go test -tags=integration ./internal/engine -count=1`.
Retained Spark live evidence is identified in the [validation summary](index.md); fixture success alone does not establish GPU inference success.

## Test packed data without a GPU

The packed-data fixtures execute the actual packaged upstream preparation tool and verifier on tiny safetensors, without GPU access or downloads:

```sh
docker run --rm --runtime=runc --network none --entrypoint python3 \
  --mount "type=bind,source=$PWD/test/spark_preparation_test.py,target=/test.py,readonly" \
  nc-prototype-qwen38:spark-v1 /test.py
```

## Test retained-state recovery

The retained-deployment Spark qualification can run against the explicit YAML and state directory from the [Spark guide](../guides/dgx-spark.md).
It applies, checks an unchanged apply and export/reapply, rejects excessive reserved capacity, trips the watchdog with `SIGUSR1`, verifies a read-only restart plan, and explicitly recovers the same container.
It checks all eight resource IDs and artifact receipt hashes and modification times.
It leaves the running deployment and model data intact, and retains JSON evidence and exported YAML in the selected state directory, including on failure.

Run the retained-deployment lifecycle check:

```sh
NEMOCLAW_LIVE_SPARK_CONFIG="$(pwd)/.local/spark.yaml" \
NEMOCLAW_LIVE_SPARK_STATE="$(pwd)/.local/spark-deployment" \
  go test -tags=live ./internal/engine -run '^TestLiveSparkLifecycle$' -count=1 -timeout=3h -v
```

## Test an artifact change

This test replaces the inference container while preserving its model and preparation volumes.
Start from a previously successful deployment and change only the pinned runtime image in its YAML.
The new image must already be available on the deployment engine.
The test checks the replacement plan, retained storage and OpenShell identities, actual inference, unchanged apply, and export/reapply.

```sh
NEMOCLAW_LIVE_SPARK_CONFIG="$(pwd)/.local/spark.yaml" \
NEMOCLAW_LIVE_SPARK_STATE="$(pwd)/.local/spark-deployment" \
  go test -tags=live ./internal/engine -run '^TestLiveSparkArtifactChange$' -count=1 -timeout=3h -v
```

Confirm that the test passes and retains the expected identities and artifact receipts in its JSON evidence.
On failure, inspect the retained state and evidence before rerunning; do not remove either data volume.

## Interpret startup failures

The early sandbox token-path failure exposed a separate OpenShell limit: OpenShell 0.0.116 treats sandbox `Error` as terminal and has no public recovery operation for that phase.
Apply records the configured sandbox identity before checking readiness and reports failure without recreating it.
The initial experiment required a controlled offline repair; fresh creation with the corrected layout passed without repairs.
This is recorded in the [validation summary](index.md), and is not an automatic recovery feature.
