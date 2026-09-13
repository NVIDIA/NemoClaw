# Update, export, and destroy a deployment

Use the same state directory and deployment identity for every operation on an existing deployment.
Keep the entire directory, including `runtime/` for managed Spark.
It contains bindings and unfinished intent needed to reconcile partial effects.

The commands below assume the bundle's `bin` directory is on your `PATH`.
For flag defaults, refer to the [CLI reference](../reference/cli.md).

## Update a model

1. Change `overrides.model` in the deployment YAML to a model available at the selected endpoint.
2. Preview and apply the change:

   ```sh
   nemoclaw plan --state-dir .local/deployment --file deployment.yaml
   nemoclaw apply --state-dir .local/deployment --file deployment.yaml
   ```

3. Confirm that the result updates the route without replacing the sandbox.
   The agent uses the stable `primary` alias.
   Apply checks inference even when the resource change list is empty.

Ordinary apply rejects resource removal and most replacement.
Changing a Fabric harness requires explicit teardown and reapply.
Managed Spark allows narrowly checked replacement of its inference container after an explicit service-specification change, or its gateway after a versioned launch-layout correction.
Both require verified retained storage bindings.
If an update fails, follow [troubleshooting](../reference/troubleshooting.md) before changing the YAML again.

## Export observed configuration

Export writes YAML only after all required observations and configuration checks succeed.
It preserves secret references and desired settings, not conversation history, model weights, or native agent files.
It does not require a healthy inference response.

1. Choose a new output filename so shell redirection cannot truncate a previous export:

   ```sh
   nemoclaw export --state-dir .local/deployment > .local/exported-new.yaml
   ```

2. Check that the command succeeds before using the file.
   On failure, the shell can leave an empty file; keep the original deployment YAML and state.

3. Apply the export to the same deployment and confirm an empty change list:

   ```sh
   nemoclaw apply --state-dir .local/deployment --file .local/exported-new.yaml
   ```

To create a separate deployment, choose a fresh deployment UUID and state directory and check endpoint, name, and port availability.
Changing an established deployment's gateway endpoint is rejected.
There is no lost-state adoption or migration command.

## Destroy a deployment

Destroy deletes sandbox files and conversation history.
Back up native agent state separately before proceeding if you need to keep it.
Select the intended state directory; destroy accepts no YAML.

Destroy handles external inference endpoints and managed Spark.
It rejects the combined Ollama container/storage resource before effects.
An unfinished apply with potentially unbound effects must first be reconciled with its original YAML.
Keep the gateway reachable until its workloads are removed.

1. Preview teardown:

   ```sh
   nemoclaw plan --destroy --state-dir .local/deployment
   ```

2. Review the workloads to remove and resources to retain, then run:

   ```sh
   nemoclaw destroy --state-dir .local/deployment
   ```

3. Confirm that the result lists the retained resources.
   Repeating a completed destroy returns no changes without contacting the removed gateway.

Destroy removes the bound sandbox, route, provider registration, and managed process containers.
It retains the workspace, model and prepared data, gateway database and keys, bridge, stopped initializer, images, and local state.
There is no purge option.
Workspace deletion is excluded because the upstream operation can also delete untracked routes and memberships.
Retained resources stay tracked.
Reapply the original YAML to recreate workloads using those bindings.

Destroy checks both resource graphs before effects and removes OpenShell workloads before the managed gateway.
It checks ownership, generation, configuration, and durable identity without requiring healthy inference or its API credential.
If deletion or observation fails, keep state and explicitly rerun destroy to reconcile.
Other operations refuse an unfinished teardown.

OpenShell 0.0.116 deletes by name without an ID/version condition.
Identity checks immediately before deletion cannot eliminate replacement by another client between the check and the request.
The local deployment lock does not lock other gateway clients.
