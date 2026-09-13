# NemoClaw documentation

Use NemoClaw to manage a deployment's infrastructure and desired state.
Use the agent runtime's existing interfaces to interact with it.
Start with a local Linux ARM64 deployment; other bundle targets have cross-build evidence only.

## Set up

- [Build the bundle](get-started/build.md).
- [Set up external services](get-started/external-services.md).
- [Deploy an agent](get-started/deploy.md).
- [Deploy a Fabric runtime](guides/fabric.md).
- [Try managed Ollama](guides/managed-ollama.md).
- [Deploy on DGX Spark](guides/dgx-spark.md).

## Operate

- [Update, export, and destroy a deployment](guides/lifecycle.md).
- [Use native agent and messaging interfaces](guides/native-access.md).
- [Troubleshoot a deployment](reference/troubleshooting.md).

## Look up behavior

- [CLI commands and flags](reference/cli.md).
- [Configuration and credentials](reference/configuration.md).
- [Fabric runtime recipes](reference/fabric-harnesses.md).
- [Third-party components](reference/third-party.md).

## Understand and validate

- [Architecture and ownership](architecture/overview.md).
- [Scope and decisions](architecture/decisions.md).
- [Validation results and limits](validation/index.md).
- [Run automated and live tests](validation/run-tests.md).
- [Test Fabric adapters](validation/fabric.md).
- [Test native messaging](validation/native-messaging.md).

## Contribute and research

- [Writing guide](contributing/writing.md).
- [Documentation migration map](contributing/documentation-map.md).
- [Historical proposals and evidence](archive/index.md).
