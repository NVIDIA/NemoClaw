<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Rotate Credentials

This page describes how to rotate each credential a deployment uses.
NemoClaw doesn't detect a new value behind an unchanged credential reference, and it doesn't revoke upstream keys; revoking an old key is the key owner's job.

## Running Agents Keep the Key They Started With

OpenShell gives each process the credential revision current when the process started.
After a key is updated, a running agent keeps using the old key, and only processes started afterwards receive the new one.
An agent restarts only when its sandbox is replaced, for example when its configuration changes.
Keep the old upstream key valid until every sandbox that uses it has been replaced, then revoke it.
See OpenShell's [runtime limitations](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/how-it-works/providers/profiles.mdx#runtime-limitations).

## Inference, Web Search, and API Keys You Supply

These keys are named by a credential reference: `credential.env` in YAML, or `credential_env` in HCL.
Changing only the value behind the same variable makes no plan change, so rotate through a new variable:

1. Create the new key with the upstream service, keeping the old one valid.
2. Put the new key in a new environment variable, and point the credential reference at it.
3. Plan. The provider registration shows an in-place update; for inference, web search, and API registrations, this doesn't replace sandboxes.
4. Apply.
5. Wait until each sandbox using the key has been replaced, then revoke the old key upstream.

In hand-written HCL, `tofu apply -replace=openshell_sandbox.NAME` replaces a sandbox, and its agent, so it picks up the new key at once.

## Generated Keys and Managed Gateway Keys

NemoClaw generates these keys and keeps them in retained storage:

- the key for a managed vLLM service with `authentication: bearer`;
- the key for a managed Ollama proxy;
- a managed Docker or Podman gateway's signing keys and TLS material.

They can't be rotated in place: apply refuses a state directory whose gateway storage or credentials were removed.
To rotate them, destroy the deployment, [remove its retained resources](usage.md#remove-retained-resources), and create a new deployment with a fresh `metadata.uid` and state directory.

## A Key You Supply to a Model Server on Another Platform

On Kubernetes and other platforms, the vLLM runtime can take its key from `NEMOCLAW_INFERENCE_KEY`, supplied by the platform ([inference](inference.md)):

1. Update the platform's secret and restart the model server, as the platform does.
2. Rotate the key that registrations send, through a new variable, as for [keys you supply](#inference-web-search-and-api-keys-you-supply).

Requests fail between these two steps, until both sides use the same key.

## Gateway Connections

| Credential | How to rotate |
|---|---|
| External gateway bearer token or mTLS files | The gateway operator issues new ones; update the referenced environment values or files. NemoClaw reads them on every run. |
| OIDC token for a managed Kubernetes gateway | Refresh it with the issuer's tooling into the variable `token.env` names; NemoClaw reads it on every run, and an expired token fails as an authentication error. |
| Development credentials for a managed Kubernetes gateway | Their certificates are valid for 365 days and aren't rotated in place. Create a new deployment before they expire, or use the [OIDC profile](kubernetes.md). |

## Platform Credentials

| Credential | How to rotate |
|---|---|
| Registry login for Docker or Podman | Log in again with the engine host's `docker login` or `podman login`; the next pull uses it. |
| Image pull Secret for Kubernetes | Update the Secret in the deployment's namespace; the next pull uses it. |
| kubeconfig | The cluster administrator issues a new one; update the file the reference names. |
| A literal application-container environment value | Change it in the configuration and apply. The value enters plans and state, so prefer a credential reference. |
