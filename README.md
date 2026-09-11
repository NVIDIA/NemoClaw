# NemoClaw desired-state prototype

This local experiment creates an OpenClaw agent from YAML using Go, OpenTofu,
OpenShell, and osquery. It has an independent Git root and contains no source
from the previous NemoClaw implementation. See [DESIGN.md](DESIGN.md) for scope.

The supported prototype commands are:

```sh
nemoclaw config plan < deployment.yaml
nemoclaw config apply < deployment.yaml
nemoclaw config export > exported.yaml
```

Each command accepts `--state-dir DIR`, which defaults to `.nemoclaw` in the
current directory. Keep this directory: it contains deployment identity,
unfinished intent, the OpenTofu state, and the provider lock file.
On PowerShell, use `--file deployment.yaml` for input.

## Build

Install Go 1.27.1, then run:

```sh
go run ./tools/bundle
```

The builder downloads checksum-pinned OpenTofu and osquery artifacts and builds
three Go executables. It does not install global tools or contact a provider
registry during deployment. Runtime artifacts are under `dist/OS_ARCH`:

```text
bin/nemoclaw
libexec/tofu
libexec/osqueryi
libexec/nemoclaw-osquery.ext
providers/registry.opentofu.org/nvidia/nemoclaw/VERSION/OS_ARCH/
  terraform-provider-nemoclaw_vVERSION
manifest.json
```

Windows executables have `.exe` suffixes. The provider version includes a source
digest so rebuilt development binaries cannot silently reuse an old checksum.
The manifest verifies bundle contents before each operation. It is an integrity
check against the local manifest, not a signed distribution mechanism.

Cross-build with `go run ./tools/bundle --platform windows_amd64`.
The other targets are `linux_amd64`, `linux_arm64`, `darwin_amd64`, and
`darwin_arm64`. Native execution qualification is recorded in
[VALIDATION.md](VALIDATION.md).

## Run the slice

For a complete Linux Docker test setup, follow [LOCAL_TEST.md](LOCAL_TEST.md).

Provide an OpenShell 0.0.116 gateway with one Docker or Podman compute driver,
and an existing OpenAI-compatible inference endpoint. Gateway provisioning,
engine installation, and model downloads are outside this slice.

The OpenClaw image needs the network tools used by OpenShell's supervisor.
Its inherited Docker health check is disabled because it runs outside the
agent's network namespace. NemoClaw checks health through OpenShell execution.
Build the small image layer and obtain its immutable reference:

```sh
docker build -t nc-prototype-openclaw:2026.9.4 image
docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
```

For a remote gateway, publish your image to a registry it can reach. The local
image in the example is available only on the Docker engine where it was built.
The base image is pinned; rebuilding the apt layer can produce a different digest.
Always use the resulting digest in your YAML.

Copy [examples/local.yaml](examples/local.yaml), choose a new deployment UUID,
and set the gateway, inference endpoint, image reference, runtime, and model.
The inference endpoint must be reachable from OpenShell's inference execution
environment, which can differ from the CLI's host.

```sh
dist/linux_arm64/bin/nemoclaw config plan --file deployment.yaml
dist/linux_arm64/bin/nemoclaw config apply --file deployment.yaml
dist/linux_arm64/bin/nemoclaw config export > exported.yaml
```

Change `overrides.model` and apply again to update the inference route. The
OpenClaw configuration uses a stable `primary` model alias, so this does not
replace the sandbox.

Every apply also sends a one-token inference probe through the sandbox. This
can load a local model or incur inference usage even when the plan is empty.
It does not add to the OpenClaw conversation history.

For credentials, use `credential: {env: INFERENCE_API_KEY}` on the inference
provider, or `credential: {env: GATEWAY_TOKEN}` on the gateway. Values are resolved
at runtime. They do not enter YAML, plans, or OpenTofu state. HTTPS is required
when credentials are configured. Gateway mTLS uses `tls.ca.env`,
`tls.certificate.env`, and `tls.key.env`; those environment values are file paths.
Without credentials, inference HTTP endpoints may use literal private or
loopback addresses. Plaintext gateways must use literal loopback addresses.

## Responsibility boundaries

| Component | Owns |
| --- | --- |
| Go CLI | Strict YAML, compilation, deployment lock, ownership, unfinished intent |
| OpenTofu | Dependency graph, refresh, diff, saved plan, resource state |
| Go provider | Workspace, provider registration, inference route, sandbox resources |
| OpenShell SDK | Authoritative reads, mutations, policy status, sandbox execution |
| osquery extension | Explicit tables backed by the same Go readers |
| osqueryi | SQL execution and export observations |

Export queries `openshell_workspaces`, `openshell_providers`,
`openshell_inference_routes`, and `openshell_sandboxes`. For example:

```sql
SELECT name, provider_name, model
FROM openshell_inference_routes
WHERE workspace = 'nc-8bb56695710753e3' AND name = 'primary';
```

Every table requires an equality constraint on `name`; nested tables also
require `workspace`. There is no document table. Export uses observed resource
values, verifies durable identities and the active policy, and checks the agent's
configuration and health. Missing observations produce an error and no YAML.

The gateway connection is supplied to the private extension by the CLI.
Host CPU and process inventory remain available in osquery's built-in tables;
they are not needed to manage this externally provisioned first slice.

## Recovery and limits

An apply records intent before external effects. If interrupted, retain the state
directory and apply the same YAML. Reads reconcile resources using deployment
UIDs, random generation labels, and recorded resource IDs. Mutations have no
automatic retry loop. A lost response requires another explicit apply.

Ordinary apply cannot delete or replace resources. Unknown fields, inline
credentials, foreign ownership, missing managed resources, and unsupported
combinations stop the operation. There is no adoption, pruning, migration,
automatic rollback, or lost-state recovery command.

This schema permits one provider, one sandbox, one OpenClaw agent, and one route.
It is a `v1alpha1` subset of the #10904 analysis. The isolated policy allows no
ordinary network egress; OpenShell handles inference routing separately.
Landlock uses upstream `best_effort` mode, so filesystem enforcement depends on
the host kernel. This is not a platform or security qualification release.

Credential rotation under an unchanged environment reference is not detected.
The gateway endpoint is bound to local state; moving a deployment requires a
fresh target and state directory. Export preserves secret references and
portable desired settings, not conversation history, model weights, or agent files.
Windows process cleanup and native macOS/Windows runtime behavior still require
live qualification. Podman support is accepted in the schema but requires its
own live runtime test.

## Verify

```sh
go test ./...
go vet ./...
go run ./tools/bundle
go test -tags=integration ./internal/engine -count=1
```

Integration tests execute the real OpenTofu, provider, and osquery binaries
against a gRPC fixture. They cover no-op apply, model changes, export/recreate,
lost responses, cancellation, ownership, policy/configuration drift, and secrets.
The fixture does not implement a sandbox or prove inference works.

To run the opt-in live test, set `NEMOCLAW_LIVE_CONFIG` to an absolute YAML path
and `NEMOCLAW_LIVE_ALTERNATE_MODEL` to another model already available at that
endpoint. Then run `go test -tags=live ./internal/engine -run TestLive -count=1 -v`.
It creates two deployments with fresh UUIDs, exercises real agent replies, and
removes only those deployments after success. A failure retains resources and
recovery state under `.local/live-UUID`. Test credentials and model costs are
those of the explicitly selected gateway and inference endpoint.

Versions were checked on 2026-09-11: Go 1.27.1, OpenTofu 1.12.6, osquery 5.23.1,
OpenShell 0.0.116, OpenClaw 2026.9.4, and Ollama 0.34.0. Binary hashes and URLs
are in [versions.json](versions.json); Go dependencies are pinned in `go.mod`
and `go.sum`. The OpenShell SDK is pinned to the stable gateway's release commit:
the newer unreleased SDK has already removed the inference API used here.
