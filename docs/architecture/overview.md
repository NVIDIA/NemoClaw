# Architecture and ownership

NemoClaw owns deployment infrastructure and desired state; Fabric owns the selected agent runtime's lifecycle.
Agent-specific interfaces own interaction and messaging.
The CLI delegates resource graph execution to OpenTofu and backend operations to its Go provider.

| Component | Owns |
| --- | --- |
| Go CLI | Strict YAML, compilation, deployment lock, ownership, unfinished intent |
| OpenTofu | Dependency graph, refresh, diff, saved plan, resource state |
| Go provider | OpenShell resources and optional Ollama service/model resources |
| OpenShell SDK and shared resource reader | Configuration observations, mutation reconciliation, conditional writes, sandbox execution |
| Shared Docker/model API readers | Managed runtime configuration, storage identity, and complete model inventory |

Provider refresh and export call the same OpenShell resource reader directly for workspaces, inference providers, routes, and sandboxes.
The provider reuses its gateway client for observations and mutations; export opens one gateway client for its configuration reads and agent checks.
Reads have bounded deadlines and contain only non-secret resource attributes.

A complete successful read returns the resource's observed configuration.
Only an explicit OpenShell NotFound for the object, or its parent workspace for a route, establishes absence.
A policy-status NotFound is an observation failure, not evidence that the sandbox disappeared.
Incomplete responses, missing required attributes, mismatched names, authentication, permission, and transport failures stop planning with a diagnostic and preserve the last known state.
Only confirmed absence permits the provider's `Resource.Read` to remove an object from OpenTofu state.

Export uses observed values, verifies ownership, generation, durable identities, launch configuration, and the active policy, and checks the agent's configuration.
It writes YAML only after all required observations and checks succeed.
Export rejects absence as well as failure; it does not require a healthy inference result.

Managed Ollama uses Docker's API for identity/configuration and Ollama's `/api/tags` for complete model inventory.
Refresh and export share those readers too.
The same owning APIs support gateway capability discovery, ownership preflight, mutation reconciliation, readiness waits, and active agent/inference probes.
Local intent, OpenTofu state, bundle manifests, and credential references use local sources.
Host observations describe that host; guest and remote resources are read through the owning API or inside the environment being observed.

## Fabric runtime boundary

Fabric and its persistent adapter run inside the sandbox.
The runtime host selects `/opt/fabric/bin/python` explicitly for Python adapters.
NemoClaw supplies the stable `primary` model alias at `https://inference.local/v1`; OpenShell owns upstream credentials.
A private Unix socket at `/sandbox/fabric.sock` reports readiness and accepts no invocations or channel operations.

Fabric's `Fabric.run` starts and stops a new runtime; it cannot attach to the hosted runtime.
The host does not replay failed invocations.
The local OpenClaw adapter owns one gateway and sends RPC calls with an invocation idempotency key and stable session key.
It waits for terminal results and normalizes tool history.
An uncertain RPC failure stops the gateway and quarantines the adapter without retry or fallback.
SDK turns are timeout-bound and use the fixed OpenShell primary route.

Hermes runs from the source revision pinned by Fabric, retained under `/opt/hermes` for bundled assets.
Lazy dependency installation is disabled; relay metadata propagation is not configured.
Recipe pins and protocols belong to the [runtime reference](../reference/fabric-harnesses.md).
Native OpenClaw configuration and message ownership belong to the [native interface guide](../guides/native-access.md).

## Managed runtime graph

Managed Spark separates gateway and inference processes from retained storage.
Before the gateway exists, plan reports the OpenShell graph as deferred.
Apply establishes runtime infrastructure first, then plans OpenShell resources against the live gateway.
The selected state directory includes a `runtime/` child for this graph.

A resident supervisor protects memory after the CLI exits.
Docker restart is disabled; explicit apply performs capacity checks before restarting a stopped inference container.
The [Spark guide](../guides/dgx-spark.md) owns build, deployment, and watchdog verification procedures.

The managed Ollama resource boundary combines its container and volume and uses a separate model resource.
A stopped service prevents model inventory refresh and blocks a restart plan.
This is an unresolved resource-boundary limitation, documented in [troubleshooting](../reference/troubleshooting.md).
