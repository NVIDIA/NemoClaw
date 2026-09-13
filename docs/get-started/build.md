# Build the private bundle

Build the bundle before running NemoClaw or its provider integration tests.
Run commands from the repository root.

Install Go 1.27.1, then run:

```sh
go run ./tools/bundle
```

The builder downloads a checksum-pinned OpenTofu artifact and builds two Go executables.
It does not install global tools or contact a provider registry during deployment.
Runtime artifacts are under `dist/OS_ARCH`:

```text
bin/nemoclaw
libexec/tofu
providers/registry.opentofu.org/nvidia/nemoclaw/VERSION/OS_ARCH/
  terraform-provider-nemoclaw_vVERSION
manifest.json
```

Windows executables have `.exe` suffixes.
The provider version includes a source digest so rebuilt development binaries cannot silently reuse an old checksum.
The manifest verifies bundle contents before each operation.
It is an integrity check against the local manifest, not a signed distribution mechanism.

Cross-build with `go run ./tools/bundle --platform windows_amd64`.
The other targets are `linux_amd64`, `linux_arm64`, `darwin_amd64`, and `darwin_arm64`.
Native execution qualification is recorded in [validation results](../validation/index.md).

## Verify the build

Confirm that `dist/OS_ARCH/manifest.json` and the three executables listed above exist.
A deployment command verifies their hashes before performing its operation.
If an artifact is missing or fails verification, rebuild the bundle and use that bundle's CLI.
Do not mix executables from different builds.

Continue with [external service setup](external-services.md) and [deployment](deploy.md).

## Dependency pins

[versions.json](../../versions.json) records executable versions, download URLs, and hashes.
[go.mod](../../go.mod) and [go.sum](../../go.sum) pin Go dependencies.
The OpenShell SDK is pinned to release 0.0.116, Go revision `d1155aa70042`, for the inference API used by NemoClaw.
SDK upgrades must preserve that API contract or include corresponding integration changes.
The [dated SDK research](../archive/validation-log.md#historical-build-availability-and-remaining-limits) records the compatibility investigation.
The Fabric source revision and per-recipe dependency locks are documented in the [runtime reference](../reference/fabric-harnesses.md) and [third-party inventory](../reference/third-party.md).
