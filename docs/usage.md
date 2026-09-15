<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use Desired State

Build a [verified native bundle](build.md) and put its `bin` directory on `PATH`.
Choose a checked-in [example](../examples/), set a fresh deployment UUID and available endpoints, and retain the same state directory for every operation.
NemoClaw supports one provider, sandbox, agent, and route per document.

Examples contain deployment identities and local image pins; replace them before provisioning your own deployment.
Apply creates or changes runtime resources and can download model data and send inference requests.
If you omit `--state-dir`, the CLI uses `.nemoclaw` in the working directory.

```sh
nemoclaw plan --state-dir .local/deployment deployment.yaml
nemoclaw apply --state-dir .local/deployment deployment.yaml
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
nemoclaw apply --state-dir .local/deployment exported-new.yaml
```

Plan and apply require a YAML path.
Pass `-` explicitly to read standard input, for example `cat deployment.yaml | nemoclaw apply -`.
Export writes YAML to standard output, or to a file with `--output exported.yaml`.
`--bundle DIR` selects an explicit private bundle; otherwise the CLI uses the parent of its executable's `bin` directory.

Keep the selected bundle unchanged while an operation runs.
`--bundle-dir` is an alias for `--bundle`.
Export and destroy accept no YAML.
Errors go to stderr with a nonzero exit code.

Successful operations emit JSON, except export, which emits YAML.

Plan observes resources without creating containers, downloading models, preparing data, or invoking inference.
A fresh managed gateway defers the OpenShell graph until apply makes it reachable.
Apply always creates its own checked plan; a previous public plan is not an approval artifact.

Managed inference apply checks an actual agent reply even when the resource change list is empty.

For model-specific preparation supplied by a pinned image, see [inline recipes](recipes.md).
Ordinary models can omit `service.recipe`.

## Configuration and Credentials

Use the [YAML field reference](reference/configuration.md) to check field names, defaults, conditional requirements, and validation limits.

Unknown fields, duplicate keys, inline secrets, and unsupported combinations are rejected.
Images must use immutable SHA-256 references.
Managed DGX Spark declares `inferenceProviders[].service` instead of `endpoint`, with a pinned model, backend, serving settings, and memory policy.

The checked-in [DGX Spark example](../examples/spark-inline.yaml) declares preparation tools in an inline recipe and uses the resident memory supervisor.
Managed Ollama uses `endpoint` plus `ollama`, an existing Docker network, and a local Unix engine socket.
Fabric harnesses other than OpenClaw require external gateway and inference.

Use `credential: {env: INFERENCE_API_KEY}` for an inference provider or gateway.
The caller supplies the referenced environment value.
For gateway mTLS, `tls.ca.env`, `tls.certificate.env`, and `tls.key.env` reference environment variables whose values are local file paths.

Credential values stay out of configuration, plans, state, and export.
OpenShell stores installed provider credentials for routing; removing the local variable does not revoke them.
Rotation under an unchanged reference is not detected automatically.

The SDK and provider child process need access to referenced credentials during operations.
Remove caller-owned environment values and TLS files when no longer needed.
Destroy removes the owned provider registration, but retained gateway storage remains; revoke upstream credentials separately when retiring them.

Credentialed endpoints require HTTPS.
Uncredentialed inference HTTP endpoints must be literal private or loopback addresses; plaintext gateway addresses must be loopback.
The isolated policy permits inference routing without general network egress.

Filesystem enforcement uses OpenShell's `best_effort` Landlock mode and depends on the host kernel.
Unavailable Landlock restrictions are not enforced.
The [validation evidence](validation/README.md) records policy tests, not a security qualification.

## Editor Schema Assistance

The maintained examples select their schema with a comment:

```yaml
# yaml-language-server: $schema=../schemas/nemoclaw-v1alpha1.schema.json
```

An editor using [YAML Language Server](https://github.com/redhat-developer/yaml-language-server) can provide field completion, hover descriptions, and schema diagnostics.
The path is relative to the YAML file.
When copying an example elsewhere, update the path to the matching schema file.
Use the schema from the same source revision as your CLI; the API version alone does not identify that revision.
For an installed bundle, select its `schemas/nemoclaw-v1alpha1.schema.json` file.

Keep `$schema` in the comment; a YAML field named `$schema` is an unknown configuration field and is rejected.
Exported YAML omits comments, so add the association again if you want editor assistance for an export.

Editor validation does not replace SDK parsing or deployment checks.
See [validation beyond the schema](reference/configuration.md#validation-beyond-the-schema) for those limits.

## Updates and Recovery

Change the route's `overrides.model` to update inference without replacing the sandbox.
Ordinary apply rejects removal and most replacement.
Managed DGX Spark allows explicit process-specification changes only after independently verifying retained storage bindings.

Changing an established gateway endpoint is rejected.
There is no lost-state adoption, migration, pruning, or purge command.

After an interrupted apply, keep the original YAML and entire state directory, including `runtime/`, and explicitly reapply.
If readiness fails after resource creation, established identities remain recorded.
Authentication, transport, incomplete observations, ownership drift, or changed durable identity stop planning; they never authorize recreation.

Export requires complete observations and agent configuration checks, but does not invoke inference.
It preserves references and desired settings, not model weights, histories, native settings, or agent files.
Shell redirection can leave an empty file on failure; check the exit status before using a new export.

When Ollama is stopped, plan previews only service recovery and explicitly defers model inventory and the complete deployment plan.
Apply repairs the verified service, waits for its API, and then obtains a fresh full plan.
Failed inventory still stops normal planning and export; it never becomes confirmed model absence.

Destroy verifies the container and storage without requiring model inventory, because it retains all model data.

## Destroy

Destroy removes the bound sandbox, route, provider registration, and managed process containers.
**Sandbox files and conversation history are deleted.** Back up native agent data separately when needed.
The workspace, model downloads, prepared data, gateway database and keys, bridge, stopped initializer, images, and local deployment state remain.
Retained resources stay tracked.

Preview deletion, then destroy only the deployment bound to this state directory:

```sh
nemoclaw plan --destroy --state-dir .local/deployment
nemoclaw destroy --state-dir .local/deployment
```

Review the preview before running destroy.
Destroy does not prompt for confirmation.

Destroy validates both saved resource graphs before deletion and removes OpenShell workloads before its gateway.
Repeating completed destroy has no changes.
An interrupted destroy resumes from its recorded graph boundary; other operations refuse unfinished teardown.

Reapply the original configuration to recreate workloads using retained storage.
Managed Ollama retains an independent model-volume binding while deleting its container and releasing the model installation binding.
Model files are not deleted.

For an older deployment, apply its original YAML once to establish the storage binding before destroy.

The local lock excludes other NemoClaw operations on the same state directory, not other gateway clients.
OpenShell deletes by name without an ID/version condition, so a concurrent replacement between the final identity check and delete cannot be eliminated by this client.

## Remote Model Service

Use [the SSH model service guide](remote-service.md) for placement, publication, host prerequisites, and qualification limits.
