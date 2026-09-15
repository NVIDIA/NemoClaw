# Use desired state

Build a [verified native bundle](build.md) and put its `bin` directory on PATH.
Choose a checked-in [example](../examples/), set a fresh deployment UUID and
available endpoints, and retain the same state directory for every operation.
The prototype supports one provider, sandbox, agent, and route per document.

```sh
nemoclaw plan --state-dir .local/deployment --file deployment.yaml
nemoclaw apply --state-dir .local/deployment --file deployment.yaml
nemoclaw export --state-dir .local/deployment > exported-new.yaml
nemoclaw apply --state-dir .local/deployment --file exported-new.yaml
nemoclaw plan --destroy --state-dir .local/deployment
nemoclaw destroy --state-dir .local/deployment
```

Plan and apply also read YAML from standard input. Use `--file` on PowerShell.
`--bundle DIR` selects an explicit private bundle; otherwise the CLI uses the
parent of its executable's `bin` directory. Keep the selected bundle unchanged
while an operation runs. `--bundle-dir` remains an alias for early Rust builds.
Export and destroy accept no YAML. Errors go to stderr with a nonzero exit code.
Successful operations emit JSON, except export, which emits YAML.

Plan observes resources without creating containers, downloading models,
preparing data, or invoking inference. A fresh managed gateway defers the
OpenShell graph until apply makes it reachable. Apply always creates its own
checked plan; a previous public plan is not an approval artifact. Apply checks
inference even when the resource change list is empty.

## Configuration and credentials

Unknown fields, duplicate keys, inline secrets, and unsupported combinations are
rejected. Images must use immutable SHA-256 references. Managed Spark declares
`inferenceProviders[].service` instead of `endpoint`, with a pinned model,
backend, serving settings, and memory policy. The checked-in Spark example uses
the qualified recipe's fixed preparation tools and resident memory supervisor.
Managed Ollama uses `endpoint` plus `ollama`, an existing Docker network, and a
local Unix engine socket. Fabric requires external gateway and inference.

Use `credential: {env: INFERENCE_API_KEY}` for an inference provider or gateway.
The caller supplies the referenced environment value. For gateway mTLS,
`tls.ca.env`, `tls.certificate.env`, and `tls.key.env` reference environment
variables whose values are local file paths. Credential values stay out of
configuration, plans, state, and export. OpenShell stores installed provider
credentials for routing; removing the local variable does not revoke them.
Rotation under an unchanged reference is not detected automatically.

Credentialed endpoints require HTTPS. Uncredentialed inference HTTP endpoints
must be literal private or loopback addresses; plaintext gateway addresses must
be loopback. The isolated policy permits inference routing without general
network egress. Filesystem enforcement uses OpenShell's `best_effort` Landlock
mode and depends on the host kernel. This is not security qualification.

## Updates and recovery

Change the route's `overrides.model` to update inference without replacing the
sandbox. Ordinary apply rejects removal and most replacement. Managed Spark
allows explicit process-specification changes only after independently verifying
retained storage bindings. Changing an established gateway endpoint is rejected.
There is no lost-state adoption, migration, pruning, or purge command.

After an interrupted apply, keep the original YAML and entire state directory,
including `runtime/`, and explicitly reapply. If readiness fails after resource
creation, established identities remain recorded. Authentication, transport,
incomplete observations, ownership drift, or changed durable identity stop
planning; they never authorize recreation.

Export requires complete observations and agent configuration checks, but does
not invoke inference. It preserves references and desired settings, not model
weights, histories, native settings, or agent files. Shell redirection can leave
an empty file on failure; check the exit status before using a new export.

## Destroy

Destroy removes the bound sandbox, route, provider registration, and managed
process containers. **Sandbox files and conversation history are deleted.** Back
up native agent data separately when needed. The workspace, model downloads,
prepared data, gateway database and keys, bridge, stopped initializer, images,
and local deployment state remain. Retained resources stay tracked.

Destroy validates both saved resource graphs before deletion and removes
OpenShell workloads before its gateway. Repeating completed destroy has no
changes. An interrupted destroy resumes from its recorded graph boundary; other
operations refuse unfinished teardown. Reapply the original configuration to
recreate workloads using retained storage. Managed Ollama destroy is explicitly
unsupported because its service and storage still share one resource.

The local lock excludes other NemoClaw operations on the same state directory,
not other gateway clients. OpenShell deletes by name without an ID/version
condition, so a concurrent replacement between the final identity check and
delete cannot be eliminated by this client.

## Remote model service

[remote-vllm.yaml](../examples/remote-vllm.yaml) manages a Docker inference service
through SSH while an existing native OpenShell gateway owns Podman sandboxes.
`service.placement` selects the SSH engine and its private Docker network.
`service.publication` declares the private host address and inference URL that
OpenShell can reach. Existing `providerRef` routes remain unchanged. No engine
registry or per-sandbox placement override is required.

Replace the example SSH alias, gateway endpoint, and private publication address
with your hosts. Publication currently requires a private IPv4 address, the
service's port and `/v1` path. It uses HTTP without model credentials. The remote
host must meet the existing Linux ARM64 Spark hardware profile and have Docker,
Python 3 and `nvidia-smi`. Configure SSH authentication and host trust beforehand.
Managed volume observation uses that daemon's reported data root, including a
non-default root; it never substitutes the client host's storage path.
Load the pinned runtime image into the selected Docker daemon; the example's
experiment image has not been published. Load the sandbox image into Podman.

Run `nemoclaw apply < examples/remote-vllm.yaml`. Apply creates retained model
storage and the inference network/container on the SSH target, checks preparation
receipts and readiness there, then configures the sandbox's OpenShell route.
Plan reads remote capacity and resource state without creating runtime resources.
Changing a bound engine endpoint requires migration and is rejected. Failed
observations never authorize recreation. Destroy retains model data and network.

The bundled fixture lifecycle and a live two-daemon Spark test are qualified.
The live test used a second Docker daemon in a network namespace, SSH control,
rootless Podman sandboxes, and actual OpenClaw replies through OpenShell.
See [the validation evidence](validation/rust-dual-daemon-linux-arm64.json).
Both daemons shared the physical host and GPU; a separate-host deployment and
other hardware remain qualification gates.
