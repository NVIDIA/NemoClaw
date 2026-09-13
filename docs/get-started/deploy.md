# Deploy an agent

Apply a YAML document to create a direct OpenClaw deployment on an existing gateway.
For Fabric, follow [Deploy a Fabric runtime](../guides/fabric.md).

## Before you begin

- [Build the bundle](build.md) with the [pinned Go toolchain](../reference/dependencies.md).
- Provide an OpenShell gateway matching the [dependency pins](../reference/dependencies.md) with one Docker or Podman compute driver.
- Provide an OpenAI-compatible inference endpoint reachable from OpenShell's inference execution environment.
- For the tested Linux Docker topology, complete [external service setup](external-services.md).
- Read the [configuration limits and credential rules](../reference/configuration.md).

Podman is accepted by the schema but has no native runtime qualification here.
Each apply sends a bounded inference probe, even if there are no resource changes.
That request can load a local model or incur inference usage.

## Create the deployment

1. Build the OpenClaw image and obtain its immutable reference:

   ```sh
   docker build -t nc-prototype-openclaw:local image
   docker image inspect nc-prototype-openclaw:local --format '{{index .RepoDigests 0}}'
   ```

   The image adds supervisor network tools and disables an inherited health check outside the agent's network namespace.
   NemoClaw checks readiness through OpenShell execution.
   The image is available only on the engine where you built it.
   If your gateway uses another engine, publish the image to a registry that engine can reach before proceeding.

2. Copy [the local example](../../examples/local.yaml):

   ```sh
   cp examples/local.yaml deployment.yaml
   ```

3. Edit `deployment.yaml` to set a fresh deployment UUID, the gateway endpoint, inference endpoint, model, and printed image digest.
   The endpoint must be reachable from the gateway and sandbox supervisor, which can differ from your CLI host.

4. Preview and apply the configuration with one explicit state directory:

   ```sh
   dist/linux_arm64/bin/nemoclaw plan --state-dir .local/deployment --file deployment.yaml
   dist/linux_arm64/bin/nemoclaw apply --state-dir .local/deployment --file deployment.yaml
   ```

## Verify the deployment

A successful apply completes configuration and readiness checks.
Apply the same YAML again; its change list should be empty.
This check verifies deployment readiness, not general agent task quality.
Use the [live test](../validation/run-tests.md#run-the-direct-openclaw-live-test) to check actual agent replies.

If apply fails, keep the state directory and follow [recovery guidance](../reference/troubleshooting.md).
Use the [lifecycle guide](../guides/lifecycle.md) for model updates, export, and teardown.
