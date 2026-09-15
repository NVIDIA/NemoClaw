# Execution-engine assumptions

This inventory describes the Rust implementation at `dfc5d40d8b`. It is a map for
preparation, not a declaration of Podman or remote-engine support. “Client host”
means the process running the SDK, CLI, provider or collector. “Engine host” means
the daemon's execution and storage namespace. They currently must coincide for the
managed Spark topology. A Unix socket can be forwarded, so its syntax alone does
not prove locality.

| Boundary and owner | Current assumption | Observation host and implication |
|---|---|---|
| `docker/mod.rs`: `Engine::connect` | Explicit Unix socket, Bollard Docker API; no environment auto-discovery | Socket resolves on the client host. API objects belong to the selected daemon. HTTP/TLS/SSH engine transports are not implemented. |
| `managed/backend.rs`; `deployment/runtime.rs` | Resource specs choose connections inside read, ensure, remove, preflight, readiness and export | Each caller can reconnect independently. Connection selection needs an injectable boundary shared by these operations. |
| `provider/provider.rs`; `deployment/ollama.rs`; `ollama/backend.rs` | Ollama already receives an engine, selected separately from managed gateway resources | Provider and SDK must select the same daemon. Ollama's HTTP API is a separate connection. |
| `config/mod.rs`, `config/validation.rs` | Managed gateway defaults to and validates `/var/run/docker.sock`; local Linux topology | YAML cannot select arbitrary managed-engine transports yet. Preserve schema and serialized identities in preparation. |
| `managed/spec.rs`: gateway launch and config | Host networking, host volume mountpoint, fixed Docker socket bind, driver `docker`, mounted supervisor and SSH paths | Socket, supervisor, signing files and relay paths must exist in the gateway and sandbox daemon's shared host namespace. A remote daemon cannot use the client's paths. |
| `managed/spec.rs`; `managed/mutation.rs`; `managed/observation.rs` | Docker bridge/IPAM, predictable bridge gateway, published inference port; exact launch configuration | Network identity and bind addresses belong to the engine host. A bridge IP is not a general cross-host inference address. |
| `managed/observation.rs`; `managed/gateway_storage.rs` | `local` volumes under `/var/lib/docker/volumes/.../_data`; exact labels, creation time, network and image identity | Mountpoints are daemon-host paths. Podman storage paths differ. Never stat a remote mountpoint locally. |
| `managed/storage.rs`; `managed/observation.rs`; `ollama/service.rs` | Durable bindings include daemon `/info` ID plus resource identity | Identical names and labels on another daemon must not authorize adoption or deletion. Qualify Podman's ID stability and rootless namespace behavior separately. |
| `managed/mutation.rs`; `managed/artifacts.rs`; `docker/mod.rs` | Image digests/labels, pulls and archive reads/writes use the selected daemon | Image availability and receipts belong to that daemon. Registry downloads and model metadata are distinct network clients. Failed reads are not absence. |
| `managed/capacity.rs`; `hardware/linux.rs`; `hardware/nvidia.rs` | Local `/proc/meminfo`, local `nvidia-smi`, compile-host architecture, local `statvfs` of daemon-reported Docker root | This mixes client-host and engine-host observations. Extract collection from typed capacity rules; reject unavailable remote observations. |
| `nemoclaw-runtime/src/hardware.rs`; `supervisor.rs` | Container-side `/proc` and `nvidia-smi`, process groups, signals and watchdog | These execute beside inference. Their host/PID/cgroup visibility must be qualified for another engine; keep immediate checks resident and direct. |
| `process.rs` | Local process groups and Linux `/proc/<pid>/stat` for child cleanup | These identify local CLI/provider helper processes, not remote runtime resources. Keep this separate from engine placement. |
| `config/mod.rs`: `inference_endpoint`; `compile.rs`; `openshell/probes.rs` | Managed inference endpoint is derived from bridge and serving port; sandbox probes use `inference.local` | Resolve the upstream connection from the gateway/sandbox routing perspective. A CLI-side successful request does not prove sandbox reachability. Credentials remain references; active inference and agent probes remain direct. |
| `openshell/transport.rs`; `state/`; `bundle/` | Gateway credentials, local state locks, bundle binaries and subprocesses | Credential lookup and state are client-side. OpenShell RPC observes the gateway's resources. Do not move local credentials into an engine collector. |
| `nemoclaw-build`; `runtimes/*` | Local Docker/Buildx artifact builds and Docker-format image loading | Build-engine choice is separate from runtime placement. A local image digest does not mean another engine has that artifact. |

Paths without a crate prefix refer to `crates/nemoclaw-sdk/src`. Provider paths
refer to `crates/nemoclaw-provider/src`. Provider refresh and export retain their
shared typed query path; connection injection must reach the underlying collector
without introducing direct-refresh shortcuts.
