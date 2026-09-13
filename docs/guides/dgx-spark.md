# Deploy on DGX Spark

Provision a managed gateway, pinned Qwen3.8 Flash Next inference service, and direct OpenClaw agent on a GB10 Spark.
Fabric is not part of this managed recipe.

## Prerequisites

This experiment requires Linux ARM64, a GB10 Spark with at least 118 GiB RAM, NVIDIA driver 580 or newer, a working Docker GPU runtime, and adequate local disk.
Capacity checks account for remaining snapshot and preparation bytes plus a 16 GiB disk reserve.
No host package installation or kernel tuning is performed.
`hostReserveGiB` constrains the requested GPU budget; the available/free memory thresholds govern the resident watchdog.

The model snapshot is about 99 GiB, and the packed PLE table is about 27 GiB, in addition to the disk reserve.
Initial deployment downloads and prepares these artifacts.

## Build and deploy

Build the pinned model-specific artifact with Go 1.27.1:

```sh
go run ./tools/spark-runtime
docker image inspect nc-prototype-qwen38:spark-v1 --format '{{index .RepoDigests 0}}'
go run ./tools/bundle
```

The builder verifies the recipe archive, patches its pinned vLLM base, and packages preparation tools and a static supervisor.
It retains the recipe's AGPL license, model source notices, original and patched source, and the supervisor's source.
It exports a timestamp-normalized OCI archive to `.build/spark/runtime.tar` and loads it locally.
It does not publish the image.
The checked-in YAML contains the resolved image digest for this source revision; compare the printed digest before using a locally changed build.
Build the direct OpenClaw image using the [deployment guide](../get-started/deploy.md#create-the-deployment).
Use the resulting digest in your copied Spark YAML.

The gateway port and subnet must be unused.
Copy [the Spark example](../../examples/spark.yaml) to `.local/spark.yaml`, choose a fresh UUID, and update both image references if your build digests differ.
Choose an unused export filename; shell redirection overwrites an existing file before export runs.
For your copied configuration:

```sh
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/spark-deployment --file .local/spark.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/spark-deployment --file .local/spark.yaml
dist/linux_arm64/bin/nemoclaw export --state-dir .local/spark-deployment > .local/spark-export.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/spark-deployment --file .local/spark-export.yaml
```

Downloads use four resumable streams with exact sizes and hashes.
Only interrupted response bodies get a bounded four-attempt retry, retaining progress between attempts.
Preparation verifies packed rows against the pinned source tensors before atomic publication.
The 30-minute inference startup budget starts after preparation; downloads have their own eight-hour limit.
Keep the state directory and both Docker volumes.
CLI interruption leaves the runtime supervisor and data intact.

## Verify the deployment

Managed Spark apply succeeds only after an actual OpenClaw reply through OpenShell.
Check the successful result's `agentResponse` and confirm an empty resource change list on unchanged apply and export/reapply.
If startup fails, preserve the state directory and volumes and follow [troubleshooting](../reference/troubleshooting.md).

Names derive from the deployment UID.
For `examples/spark.yaml`, the inference container is `nc-68d203b0c7e6083f-inference`; its data volume adds `-data`.
The gateway is `nc-68d203b0c7e6083f-gateway`, with its own data volume.
Inspect only those owned resources with `docker logs` and `docker inspect`.
Ordinary apply retains data.
For teardown, follow the [lifecycle guide](lifecycle.md#destroy-a-deployment).
Keep the state directory to reapply using its retained bindings.

## Verify watchdog recovery

To qualify the watchdog shutdown without creating memory pressure, after a successful apply, identify the inference container for your deployment UID.
The following command intentionally stops inference; replace `OWNED_INFERENCE_CONTAINER` with that container name:

```sh
docker kill --signal=USR1 OWNED_INFERENCE_CONTAINER
```

The supervisor gracefully stops its inference process group and exits.
Confirm that the container stays stopped with restart policy `no`.
Plan performs no restart; explicit apply checks capacity and restarts the same container, reusing verified model and preparation receipts.
Runtime memory sampling continues after a successful CLI exit, independently of health polling.

Run the [Spark validation procedures](../validation/spark.md) for retained-identity and artifact-change checks.
