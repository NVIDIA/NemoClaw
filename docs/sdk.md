# Programmatic access

`nemoclaw-sdk` owns the same operations used by the CLI. Callers supply a verified
runtime bundle, a persistent state directory, and a cancellation token. The SDK
runs bundled OpenTofu and its provider as child processes; it is not an embedded
OpenTofu engine. No Go runtime or FFI is required.

```rust,no_run
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::path::Path;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let document = Document::parse(std::fs::File::open("deployment.yaml")?)?;
let deployment = Deployment::new(Path::new(".local/deployment"), Path::new("dist/linux_arm64"));
let cancel = CancellationToken::new();
let preview = deployment.plan(&document, &cancel).await?;
let applied = deployment.apply(&document, &cancel).await?;
let observed = deployment.export(&cancel).await?;
# Ok(())
# }
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
