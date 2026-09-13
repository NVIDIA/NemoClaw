# NemoClaw desired-state prototype

NemoClaw provisions an OpenClaw agent or a Fabric-managed agent runtime from YAML.
It uses Go, OpenTofu, and OpenShell to plan, apply, export, and destroy a deployment.
This branch is a local prototype with native Linux ARM64 evidence; it is not a platform or security qualification release.

## Get started

1. [Build the private bundle](docs/get-started/build.md).
2. [Set up a local gateway and inference service](docs/get-started/external-services.md), or provide existing services.
3. [Deploy an agent](docs/get-started/deploy.md), or [select a Fabric runtime](docs/guides/fabric.md).

The CLI has four top-level commands:

```sh
nemoclaw plan --file deployment.yaml
nemoclaw apply --file deployment.yaml
nemoclaw export > exported.yaml
nemoclaw plan --destroy
nemoclaw destroy
```

Keep the selected state directory, which defaults to `.nemoclaw`.
Before teardown, read [what destroy removes and retains](docs/guides/lifecycle.md#destroy-a-deployment).
Runtime interaction and messaging use native agent interfaces or Fabric's existing SDK.

## Explore the prototype

- [Documentation](docs/index.md): setup, operations, reference, and architecture.
- [Validation evidence](docs/validation/index.md): tested behavior and remaining limits.
- [Contributing](CONTRIBUTING.md): development, tests, and documentation standards.
- [License](LICENSE) and [third-party components](docs/reference/third-party.md).
