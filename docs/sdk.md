# Programmatic access

`nemoclaw-sdk` owns the same operations used by the CLI. Callers supply a verified
runtime bundle, a persistent state directory, and a cancellation token. The SDK
runs bundled OpenTofu and its provider as child processes; it is not an embedded
OpenTofu engine. No Go toolchain or FFI is required.

```rust
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::path::Path;

async fn example() -> Result<(), Box<dyn std::error::Error>> {
let document = Document::parse(std::fs::File::open("deployment.yaml")?)?;
let deployment = Deployment::new(Path::new(".local/deployment"), Path::new("dist/linux_arm64"));
let cancel = CancellationToken::new();
let preview = deployment.plan(&document, &cancel).await?;
let applied = deployment.apply(&document, &cancel).await?;
let observed = deployment.export(&cancel).await?;
Ok(())
}
```

`plan_destroy` and `destroy` operate on retained state without a document.
`with_secrets` supplies an application-owned reference resolver; the default
uses environment variables. `with_progress` receives operation phases. Errors
retain observation uncertainty and redact resolved values. Cancellation leaves
state available for explicit reconciliation; it does not delete resources or
stop the independent Spark memory supervisor.

Keep each selected bundle immutable while operations use it. Use a separate
bundle copy for a running experiment when rebuilding development artifacts.
There is no SDK auto-retry of ambiguous mutations and no background reconciliation
loop. See [lifecycle behavior](usage.md) and [tests](testing.md).

## Docker over SSH

On Unix clients, `docker::Engine::connect("ssh://operator@gpu-box:2222")`
selects Docker through the system OpenSSH client and the remote
`docker system dial-stdio` command. Connection construction is lazy. The remote
user must be able to run Docker against the intended daemon.

Host keys must already be trusted. Authentication is noninteractive and uses
OpenSSH configuration, keys or its agent. Passwords in URLs, remote socket paths,
URL options and IPv6 literals are not supported in this slice; an SSH config
alias can select the host. Each API request has its own SSH connection, with a
10-second connection timeout and a 120-second transport bound. There is no
connection pool or automatic mutation retry. Errors do not include SSH stderr.

SSH engines default to an unavailable remote capacity observer. Supply a typed
`HostObserver` with `with_host_observer` when remote measurements are available;
local `/proc`, GPU and disk data are never substituted. Existing engine ID and
resource ownership checks apply to observations obtained over SSH.

This is an SDK transport boundary. Managed deployment YAML remains restricted
to its qualified local topology. Remote provisioning still needs remote artifact
and capacity observation, a reachable inference publication address, and the
provider subprocess wiring. This transport does not tunnel inference traffic.
