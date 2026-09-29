# openshell-sdk

`openshell-sdk` is the shared async Rust client for OpenShell gateways. It owns
gRPC channel setup, TLS, OIDC refresh, and the Cloudflare Access tunnel so the
CLI, the TUI, and language bindings share one client implementation. Callers
pass an explicit bearer token; the SDK does no filesystem access and no
gateway-name resolution.

## Two layers

- `OpenShellClient` — the curated, sandbox-focused surface: health, sandbox
  CRUD, reusable sandbox template CRUD, readiness/deletion waits, and
  non-streaming exec.
- `raw` — direct access to the generated tonic clients for RPCs the curated
  surface doesn't yet cover (providers, policy, logs, settings, SSH,
  forwarding).

## Auth and refresh

The curated surface drives OIDC refresh automatically: proactively before a
request and reactively on `Unauthenticated`. Refreshes are single-flight, so
only one is in flight at a time.

The plain `raw_grpc` accessor does not refresh; it returns a client bound to
the current token. When a refresher is wired, use `raw_grpc_fresh` to refresh before the call, and
`force_refresh` to recover after a raw RPC returns `Unauthenticated`.

The SDK consumes a `Refresh` trait that the caller implements; it does not run
the OIDC browser flow itself. Its non-interactive refresh-token exchange also
accepts scopes that identity providers may require to select the API resource
for the refreshed access token.

## Transport modes

- Plaintext (local development)
- Server-authenticated TLS (system roots, or a pinned private CA via `ca_cert`)
- OIDC bearer over HTTPS (gateways behind an OAuth2/OIDC IdP)
- Cloudflare Access tunnel (hosted gateways)
- Insecure TLS (development/debug; certificate verification disabled)

mTLS (client certificates) is not supported.

## Public surface

`OpenShellClient::connect(ClientConfig)` returns a connected client exposing
`health`, `create_sandbox`, `get_sandbox`, `list_sandboxes`, `list_all_sandboxes`, `delete_sandbox`,
`create_sandbox_from_template`, `create_sandbox_template`,
`get_sandbox_template`, `list_sandbox_templates`, `delete_sandbox_template`,
`list_sandboxes_all_workspaces`, `list_sandbox_templates_all_workspaces`,
`wait_ready`, `wait_deleted`, and `exec`. Curated types (`SandboxSpec`,
`SandboxRef`, `Health`, `ListOptions`, `SandboxTemplateListOptions`,
`ExecOptions`, `SandboxPhase`) use SDK-shaped enums rather than raw proto
integers where practical. Reusable template resources are exposed as
`SandboxWorkloadTemplate` proto aliases so callers can populate the full
portable workload shape and driver config. Failures map to a typed `SdkError`
with a discriminable kind.

Set `SandboxSpec::service_exposures` to register named or unnamed loopback HTTP
services during creation. Each `ServiceExposure` contains a service name and a
target port; an empty name selects the unnamed endpoint. The returned
`SandboxRef::service_urls` map contains each routed URL under the same name.

Curated calls without a workspace argument explicitly select the `default`
workspace. Cross-workspace listing uses the separate `*_all_workspaces`
methods and requires Platform Admin access.

For an accepted sandbox deletion, pass its original ID to `wait_deleted` so a
same-name replacement does not extend the wait. Both the default and
workspace-scoped clients accept the optional third argument; pass `None` to wait
for name absence instead.

```rust
let deletion = client.delete_sandbox(name, openshell_sdk::DeleteOptions::default()).await?;
if deletion.outcome == openshell_sdk::DeletionOutcome::Accepted {
    client.wait_deleted(
        name,
        std::time::Duration::from_secs(60),
        deletion.sandbox_id.as_deref(),
    ).await?;
}
```

Curated `list_*` methods return a lazy `Pager<T>`. Each `next_page()` call
fetches one logical page and returns a `Page<T>` with its opaque continuation
token. OIDC authentication can retry that page once after an `Unauthenticated`
response. The explicit `list_all_*` conveniences exhaust that pager;
`page_size` always controls one gateway request, and `page_token` resumes a
saved traversal.

```rust
let mut pages = client.list_sandboxes(ListOptions {
    page_size: 100,
    ..Default::default()
});
while let Some(page) = pages.next_page().await? {
    for sandbox in page.items {
        println!("{}", sandbox.name);
    }
}
```

```rust
use openshell_sdk::{
    ClientConfig, OpenShellClient, SandboxTemplateCreateSpec,
    SandboxWorkloadConfig, SandboxWorkloadTemplate, SandboxWorkloadTemplateSpec,
};

# async fn run() -> Result<(), openshell_sdk::SdkError> {
let client = OpenShellClient::connect(ClientConfig::new("http://127.0.0.1:8080")).await?;
client
    .create_sandbox_template(SandboxWorkloadTemplate {
        metadata: Some(openshell_sdk::raw::proto::datamodel::v1::ObjectMeta {
            name: "python".to_string(),
            ..Default::default()
        }),
        spec: Some(SandboxWorkloadTemplateSpec {
            workload: Some(SandboxWorkloadConfig {
                image: "registry.example.com/agents/python:latest".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        }),
    })
    .await?;

let _sandbox = client
    .create_sandbox_from_template(SandboxTemplateCreateSpec {
        template_name: "python".to_string(),
        policy: Some(openshell_sdk::raw::proto::SandboxPolicy {
            version: 1,
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;
# Ok(())
# }
```

## Wait for a provider change

Provider attach, detach, and update responses include a `ProviderMutationReceipt`: a saved record identifying the exact change requested for one sandbox. Pass that record to `provider_readiness::wait_for_provider` to wait until the current sandbox runtime confirms it applied the change. Detach completes with `Revoked`; attach and update complete with `Ready`.

```rust
use std::time::Duration;
use openshell_sdk::{OpenShellClient, raw::ProviderMutationReceipt};
use openshell_sdk::provider_readiness::{
    ProviderWaitOutcome, wait_for_provider,
};

async fn wait_for_change(
    client: &OpenShellClient,
    change: &ProviderMutationReceipt,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut grpc = client.raw_grpc_fresh().await?;
    let result = wait_for_provider(&mut grpc, change, Duration::from_secs(30)).await?;
    match result.outcome {
        ProviderWaitOutcome::Complete => println!("The sandbox applied the change."),
        ProviderWaitOutcome::TimedOut => println!("Still waiting; check the same change again."),
        ProviderWaitOutcome::Terminal => println!("The change failed, was withheld, or was replaced."),
    }
    Ok(())
}
```

The result preserves the last known status when the deadline expires. A later change cannot satisfy a wait for the original request. `provider_status` queries once, and `wait_for_provider_until` accepts a shared deadline for waiting on the sandboxes selected by one provider update. Status responses contain configuration identities and safe reason categories, without credentials or raw installation errors.

For ordinary static credentials, launch a new client after update readiness to receive the updated reference. Existing processes keep their revision-scoped references; a successful wait does not retarget them or prove that the old upstream key can be retired. After detach completes, retained references cannot resolve and new processes do not receive them.

The status's `operation` field is the common operation's historical outcome, keyed by the receipt ID. These helpers complete from the live provider state and its matching evidence; a historical applied operation cannot override a disconnected, expired, or superseded live result.

These helpers use the raw client's authentication slot. They do not perform OIDC refresh themselves. Follow the raw-client refresh guidance above if a request returns `Unauthenticated`, then resume waiting for the same change ID.

## Modules

| Module | Purpose |
|---|---|
| `client` | High-level `OpenShellClient` and the curated sandbox surface. |
| `config` | `ClientConfig`, `AuthConfig`. |
| `transport` | Channel construction, TLS resolution, request interceptors. |
| `auth` | `EdgeAuthInterceptor` for bearer-token attachment. |
| `oidc` | OIDC token handling at the transport layer. |
| `refresh` | `Refresh` trait and single-flight refresh coalescing. |
| `edge_tunnel` | Cloudflare Access tunnel dialer. |
| `error` | `SdkError` taxonomy. |
| `pagination` | Lazy `Pager<T>` and response `Page<T>`. |
| `types` | Curated request/response types and proto conversions. |
| `raw` | Escape hatch re-exporting the generated tonic clients. |
| `provider_readiness` | Check and wait for an exact provider change to take effect. |

## Notes

- Async-only. Tonic is async-native; callers needing a blocking call can wrap
  with their own runtime.
- The curated surface will grow as more RPCs graduate from `raw`.
