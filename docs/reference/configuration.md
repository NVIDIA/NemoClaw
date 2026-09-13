# Configuration and credentials

NemoClaw accepts a strict `nemoclaw.nvidia.com/v1alpha1` document with one provider, one sandbox, one agent, and one inference route.
Start from a checked-in example; the broader [historical RFC](../archive/desired-state-rfc.md) includes fields and behavior that are not implemented.

## Choose a deployment shape

| Shape | Example | Prerequisites |
| --- | --- | --- |
| Direct OpenClaw | [local.yaml](../../examples/local.yaml) | External gateway and OpenAI-compatible inference |
| Fabric runtime | [Runtime examples](fabric-harnesses.md#choose-an-example) | External gateway and protocol-compatible inference |
| Managed Ollama | [managed-ollama.yaml](../../examples/managed-ollama.yaml) | External gateway, local Unix engine socket, existing Docker network |
| Managed DGX Spark | [spark.yaml](../../examples/spark.yaml) | Local Linux ARM64 Docker on GB10 with GPU and capacity prerequisites |

Unknown fields, duplicate keys, inline secrets, and unsupported combinations are rejected.
The deployment UID is explicit.
The gateway endpoint is bound to local state; it cannot be changed to move an established deployment.
The schema uses versioned defaults and rejects ordinary resource removal.

`type: openclaw` selects the direct deployment.
`type: fabric` and `harness` select an immutable Fabric launch specification.
The [runtime reference](fabric-harnesses.md) defines recipe and inference-provider compatibility.
Use immutable image references from the corresponding builder.
An image on your CLI host is not automatically available on a remote gateway's engine.

## Credential references

Use environment references for inference and gateway credentials:

```yaml
credential:
  env: INFERENCE_API_KEY
```

Place this block on an inference provider, or use a gateway credential reference such as `GATEWAY_TOKEN`.
Resolve the environment variables in the process that runs NemoClaw.
Values do not enter YAML, plans, or OpenTofu state.
The provider resolves the inference key and sends it to OpenShell's provider credential API.
OpenShell retains the installed credential for inference routing; the sandbox uses the `primary` route without receiving that upstream key.
Removing your local environment variable does not revoke the installed credential.
[Destroy](../guides/lifecycle.md#destroy-a-deployment) removes the provider registration; revoke source keys through their issuer when retiring them.
Retained gateway data and backups are not securely erased by destroy.

Gateway login credentials authenticate the API client for the operation.
The caller controls their original environment and lifetime.
Gateway mTLS references `tls.ca.env`, `tls.certificate.env`, and `tls.key.env`; those environment values are file paths.
Protect the referenced key files and gateway storage with access restricted to the operating user.
The [local gateway setup](../get-started/external-services.md) creates a private directory for its keys and database.

Credential rotation under an unchanged environment reference is not detected.
The RFC's `credential.version` field is not implemented.
Export preserves references; it does not prove that a current environment value matches the installed key.

## Network and state boundaries

HTTPS is required when credentials are configured.
Without credentials, inference HTTP endpoints must use literal private or loopback addresses.
Plaintext gateway endpoints must use literal loopback addresses.
The ordinary isolated policy allows no general network egress; OpenShell routes inference separately.
Landlock uses upstream `best_effort`, so filesystem enforcement depends on the host kernel.
These checks do not establish security qualification.
Refer to the [validation evidence](../validation/index.md) for the scope of platform and runtime checks.

Keep the complete state directory for [lifecycle operations](../guides/lifecycle.md).
Native agent settings and files are outside deployment YAML and export.
The OpenShell deployment deletes sandbox storage during teardown.
[Native messaging](../guides/native-access.md) requires generic egress, secret, and retained-storage facilities for real service use.
