<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Programmatic Access

`nemoclaw-sdk` owns the same operations used by the CLI.
Callers supply a verified runtime bundle, a persistent state directory, and a cancellation token.
The SDK runs bundled OpenTofu and its provider as child processes; it is not an embedded OpenTofu engine.

```rust
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::path::Path;

async fn example() -> Result<(), Box<dyn std::error::Error>> {
    let document = Document::parse(std::fs::File::open("deployment.yaml")?)?;
    let deployment = Deployment::new(Path::new(".local/deployment"), Path::new("dist/linux_arm64"));
    let cancel = CancellationToken::new();
    let _preview = deployment.plan(&document, &cancel).await?;
    let _applied = deployment.apply(&document, &cancel).await?;
    let _observed = deployment.export(&cancel).await?;
    Ok(())
}
```

`plan_destroy` and `destroy` operate on retained state without a document.
`with_secrets` supplies an application-owned reference resolver; the default uses environment variables.
`with_progress` receives operation phases.
Errors retain observation uncertainty and redact resolved values.
Cancellation leaves state available for explicit reconciliation; it does not delete resources or stop the independent DGX Spark memory supervisor.

Keep each selected bundle immutable while operations use it.
Use a separate bundle copy for a deployment operation when rebuilding development artifacts.
There is no SDK auto-retry of ambiguous mutations and no background reconciliation loop.

See [lifecycle behavior](usage.md) and [tests](testing.md).

## Docker Over SSH

On Unix clients, `docker::Engine::connect("ssh://operator@gpu-box:2222")` selects Docker through the system OpenSSH client and the remote `docker system dial-stdio` command.
Connection construction is lazy.
The remote user must be able to run Docker against the intended daemon.

Host keys must already be trusted.
Authentication is noninteractive and uses OpenSSH configuration, keys or its agent.
Passwords in URLs, remote socket paths, URL options and IPv6 literals are not supported in this slice; an SSH config alias can select the host.

Each API request has its own SSH connection, with a 10-second connection timeout and a 120-second transport bound.
There is no connection pool or automatic mutation retry.
Errors do not include SSH stderr.

SSH engines default to an unavailable remote capacity observer.
Supply a typed `HostObserver` with `with_host_observer` when remote measurements are available; local `/proc`, GPU and disk data are never substituted.
Existing engine ID and resource ownership checks apply to observations obtained over SSH.

Managed service placement now selects this transport independently of the OpenShell gateway.
For an explicit SSH service, both SDK preflight and the provider subprocess use the fixed `SshHost` collector, unless an in-process SDK caller supplies its own observer.
Plain `Engine::connect` retains the unavailable default.

The collector reads the SSH host's Linux memory, NVIDIA inventory and Docker storage filesystem, rejects a Docker context pointing to another host, and tags measurements with the daemon identity for comparison.
Python 3, Docker and `nvidia-smi` must already be available on that host.
No packages are installed.

This transport does not tunnel inference traffic.

## Package Distribution and API Reference

The public Rust API is exported from [the SDK crate](../crates/nemoclaw-sdk/src/lib.rs).
The [deployment implementation](../crates/nemoclaw-sdk/src/deployment/mod.rs) defines the lifecycle methods used above.
See [the provider guide](provider.md) for the bundled OpenTofu boundary and [CLI reference](reference/cli.md) for terminal access.

Published package installation and version-selection instructions: **TBD**.
Complete SDK API reference and compiled application examples for custom secret resolution, progress, and cancellation: **TBD**.
Compatibility policy across SDK releases and migration from the earlier TypeScript lifecycle package: **TBD**.
