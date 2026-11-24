<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Rotating Credentials

This page describes how to rotate each credential a deployment uses.
Apply detects a new value behind an unchanged reference to an inference, web search, or API key, and registers it.
NemoClaw does not revoke upstream keys.
Revoking an old key is the key owner's job.

## Running Agents Keep the Key They Started With

NVIDIA OpenShell gives each process the credential revision current when the process started.
After a key is updated, a running agent keeps using the old key, and only processes started afterwards receive the new one.
An agent restarts only when its sandbox is replaced, for example when its configuration changes.
When apply registers a new inference, web search, or API key, it replaces each sandbox that attaches that registration, so the sandbox's agent starts with the new key.
Replacing a sandbox deletes its files and conversations, except those on mounted volumes.
Keep the old upstream key valid until every sandbox that uses it has been replaced, then revoke it.
Refer to OpenShell's [runtime limitations](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/providers/profiles.mdx#runtime-limitations).

## Inference, Web Search, and API Keys You Supply

These keys are named by a credential reference: `credential.env` in YAML, or `credential_env` in HCL.
When the provider registers a key, it records an Argon2id digest of the key in OpenTofu state as the registration's `credential_digest`, never the key itself.
A plan that can read the variable checks its value against that digest.
Rotate one of these keys as follows:

1. Create the new key with the upstream service, keeping the old one valid.
2. Put the new key in the same environment variable, or in a new one that the credential reference names.
3. Apply.
   The changes it reports show the registration updated in place, with the reason `credential changed`, and each sandbox that attaches the registration replaced together with its agent, with the reason `attached credential changed:` and the registration's address.
   Sandboxes that don't attach the registration keep running.
4. Revoke the old key upstream.

`nemoclaw plan` doesn't read inference or integration credentials, so it shows no change for a new value; only apply reads them.
An apply that finds the same value changes nothing.

In hand-written HCL, a `tofu plan` whose environment holds the new value shows the registration's in-place update.
The provider doesn't replace sandboxes.
To replace a sandbox, and its agent, when the key changes, list the registration's `credential_digest` in the sandbox's `lifecycle.replace_triggered_by`, as NemoClaw's own deployments do, or run `tofu apply -replace=openshell_sandbox.NAME`.
A registration that an earlier provider release created has no `credential_digest`.
The first plan or apply that can read its variable records the digest of the value the variable then holds, without updating the registration or replacing sandboxes.
If that value differs from the registered one, rotate it once through a new variable.

## Generated Keys and Managed Gateway Keys

NemoClaw generates these keys and keeps them in retained storage:

- The key for a managed vLLM service with `authentication: bearer`
- The key for a managed Ollama proxy
- A managed Docker or Podman gateway's signing keys and TLS material

They cannot be rotated in place: apply refuses a state directory whose gateway storage or credentials were removed.
To rotate them, destroy the deployment, [remove its retained resources](../build-deploy/usage.md#removing-retained-resources), and create a new deployment with a fresh `metadata.uid` and state directory.

## A Key You Supply to a Model Server on Another Platform

On Kubernetes and other platforms, the vLLM runtime can take its key from `NEMOCLAW_INFERENCE_KEY`, supplied by the platform ([inference](../agents-inference/inference.md)):

1. Update the platform's secret and restart the model server, as the platform does.
2. Rotate the key that registrations send, through a new variable, as for [keys you supply](#inference-web-search-and-api-keys-you-supply).

Requests fail between these two steps, until both sides use the same key.

## Gateway Connections

Rotate the credential with the component that issues it.
Changing a reference in YAML alone does not revoke an old value.
Rotate each gateway connection credential as follows:

| Credential | How to Rotate |
|---|---|
| External gateway bearer token or mTLS files | The gateway operator issues new ones. Update the referenced environment values or files. NemoClaw reads them on every run. |
| OIDC token for a managed Kubernetes gateway | Refresh it with the issuer's tooling into the variable `token.env` names. NemoClaw reads it on every run, and an expired token fails as an authentication error. |
| Development credentials for a managed Kubernetes gateway | Their certificates are valid for 365 days and are not rotated in place. Create a new deployment before they expire, or use the [OIDC profile](../build-deploy/kubernetes.md). |

## Platform Credentials

Replace the platform-issued value at its source, then refresh any client or workload that still uses the old value.
Rotate each platform credential as follows:

| Credential | How to Rotate |
|---|---|
| Registry login for Docker or Podman | Log in again with the engine host's `docker login` or `podman login`. The next pull uses it. |
| Image pull Secret for Kubernetes | Update the Secret in the deployment's namespace. The next pull uses it. |
| kubeconfig | The cluster administrator issues a new one. Update the file the reference names. |
| A literal application-container environment value | Change it in the configuration and apply. The value enters plans and state, so prefer a credential reference. |
