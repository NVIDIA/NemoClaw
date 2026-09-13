# Try managed Ollama

Use the managed Ollama configuration to create an Ollama container and model volume on an existing local Docker network.
It demonstrates a resource-boundary limitation: a stopped server blocks model refresh, so ordinary apply cannot plan its restart.
The CLI also rejects destroy for this combined container/storage resource.
Use the live test to exercise the configuration with explicit cleanup.
On failure, preserve the reported state and refer to [troubleshooting](../reference/troubleshooting.md).

This live test creates two deployments, downloads models, and intentionally stops its owned inference container.
On success it deletes those deployments and their model volumes.
Rebuild the native bundle before running the test.

## Configure managed Ollama

1. Use the [external gateway setup](../get-started/external-services.md#start-the-gateway) and an unused port on its Docker bridge.
   Build the OpenClaw image and bundle, then copy the managed example:

   ```sh
   docker build -t nc-prototype-openclaw:2026.9.4 image
   docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
   docker network inspect nc-prototype-test --format '{{(index .IPAM.Config 0).Gateway}}'
   go run ./tools/bundle
   cp examples/managed-ollama.yaml .local/managed-deployment.yaml
   ```

2. Edit the copied YAML: set `ollama.network` to `nc-prototype-test`, use the printed bridge address in the endpoint, and use the built OpenClaw image digest.
   Keep the selected local engine socket explicit.
   Choose a fresh deployment UUID for interactive use; the live test generates its own UUIDs.

3. Run the live test:

   ```sh
   NEMOCLAW_LIVE_CONFIG="$(pwd)/.local/managed-deployment.yaml" \
   NEMOCLAW_LIVE_ALTERNATE_MODEL=qwen3.5:0.8b \
     go test -tags=live ./internal/engine -run '^TestLivePlanApplyModelExportRecreate$' -count=1 -v
   ```

## Verify results and cleanup

This variant creates six resources and downloads the models into an owned named volume.
It checks an unchanged apply, stops Ollama, and expects planning to fail because the model inventory is unknown.
The test verifies unchanged state and explicitly starts the same container to continue.
It then checks a no-op apply, model change with retained weights, export, and recreation with three agent replies.
The recreated deployment uses another free port on the same host.

On success the harness removes only its two deployments, Ollama containers, and model volumes.
Stop the foreground gateway and remove its test network afterward.
On failure it preserves resources and state for inspection.
Reader tests cover interrupted pull streams and cancellation; a real download interrupted through OpenTofu requires separate qualification.
This setup does not qualify Podman, Docker Desktop, or native macOS/Windows operation.

Downloaded models are retained when the selected model changes.
Observed model digests do not make mutable model tags into desired content pins.
The volume is a model cache, not qualified general application storage.
Its identity checks use engine/container IDs, volume creation time, and operation labels; the timestamp is not a native volume UUID.
