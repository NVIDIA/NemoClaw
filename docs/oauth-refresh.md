<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use an OpenShell OAuth-Refresh Provider

Register an OAuth-refresh provider directly with OpenShell when a sandbox needs an API on behalf of a signed-in user.
OpenShell holds the refresh material and rotates the access token; NemoClaw does not perform OAuth sign-in or refresh.
Gateway users authenticating through an OIDC issuer is separate; see [Authenticate Through an Existing OIDC Issuer](kubernetes.md#authenticate-through-an-existing-oidc-issuer).
NemoClaw's [`api` integration](agents.md#key-authenticated-apis) declares a key-authenticated API, not an OAuth-refresh profile.

This guide uses Microsoft Graph with Entra as the example supported by OpenShell's [provider-refresh tutorial](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/tutorials/microsoft-graph-provider-refresh.mdx).
An Okta-backed API needs its own provider profile, token endpoint, scopes, and initial sign-in flow; the Graph profile is not an Okta configuration.
This procedure is not yet qualified against a live Entra or Okta tenant with v1; native agent login and tool use need separate [platform and integration qualification](https://github.com/NVIDIA/NemoClaw/issues/12641).

## Prepare the Gateway and Credentials

Use the pinned OpenShell CLI and [select the deployment's authenticated gateway and workspace](interfaces.md#select-the-gateway-and-workspace).
Run the following commands from a private working directory on the client host.
You need permission to import a workspace profile, create a provider, and change the selected sandbox's provider attachments.
Keep the original deployment YAML and state directory.

Complete the initial Entra sign-in using an OAuth client approved by your tenant, as described in the upstream tutorial.
It must return a delegated Graph access token, refresh token, and access-token expiry for the required permission, such as `Mail.Read`.
Load these into the client process environment from your approved credential source:

| Variable | Meaning |
|---|---|
| `MS_TENANT_ID` | Entra tenant identifier |
| `MS_CLIENT_ID` | Entra application identifier |
| `MS_GRAPH_ACCESS_TOKEN` | Current delegated access token |
| `MS_GRAPH_REFRESH_TOKEN` | Refresh token from initial sign-in |
| `MS_GRAPH_ACCESS_TOKEN_EXPIRES_AT` | Absolute expiry, RFC3339 or epoch milliseconds |

Do not place token values in deployment YAML, a committed profile, shell history, or diagnostics.
The commands below resolve secret values from environment-variable names rather than expanding them into command arguments.
Disable shell tracing while handling credentials.
OpenShell stores the provider and its refresh material at the gateway; the CLI and gateway operator control access to that state.

## Register and Check Refresh

Create `microsoft-graph-mail.yaml` from the profile in the pinned [upstream tutorial](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/tutorials/microsoft-graph-provider-refresh.mdx#create-a-microsoft-graph-provider-profile).
Review its Graph endpoint, delegated scopes, refresh strategy, and allowed executables before importing it.
The example permits `curl`; it does not grant every native agent tool access.
Use a provider name that does not collide with any registration owned by the deployment.

```sh
openshell profile lint -f microsoft-graph-mail.yaml
openshell profile import -f microsoft-graph-mail.yaml
openshell provider create --name microsoft-mail --type microsoft-graph-mail \
  --credential MS_GRAPH_ACCESS_TOKEN
openshell provider refresh configure microsoft-mail \
  --credential-key MS_GRAPH_ACCESS_TOKEN \
  --strategy oauth2-refresh-token \
  --material tenant_id="$MS_TENANT_ID" \
  --material client_id="$MS_CLIENT_ID" \
  --secret-material-env refresh_token=MS_GRAPH_REFRESH_TOKEN \
  --credential-expires-at "$MS_GRAPH_ACCESS_TOKEN_EXPIRES_AT"
openshell provider refresh rotate microsoft-mail --credential-key MS_GRAPH_ACCESS_TOKEN
openshell provider refresh status microsoft-mail --credential-key MS_GRAPH_ACCESS_TOKEN
```

The profile selects the refresh contract; `--secret-material-env` resolves the refresh token locally and marks that material secret.
`rotate` records a refresh request; inspect status for its outcome rather than treating command acceptance as completed refresh.
Status reports timing, expiry, and refresh state without printing credential values or refresh material.
If registration succeeded but refresh configuration failed, retain the provider and correct that step instead of creating another registration.
An expired or revoked refresh grant can require signing in again; follow the issuer and OpenShell instructions rather than changing NemoClaw state.

## Attach to an Existing Sandbox

Attaching this provider to a NemoClaw-managed sandbox is an out-of-band change.
NemoClaw checks its authored attachment list: export and apply can refuse the changed sandbox as drift.
Use this as an operator-managed attachment, and detach it before returning to NemoClaw plan, export, or apply.
Before destroy, also remove the manually created provider, refresh state and workspace profile as described below.
Do not delete or edit deployment state to bypass the check.
For a sandbox managed entirely outside NemoClaw, follow the upstream tutorial's sandbox-creation procedure instead.

Copy the existing sandbox name from the deployment result, then attach and wait for OpenShell to apply the change:

```sh
SANDBOX=REPLACE_WITH_DEPLOYED_SANDBOX
openshell sandbox provider attach "$SANDBOX" microsoft-mail --wait
openshell sandbox provider list "$SANDBOX"
openshell sandbox provider status "$SANDBOX" microsoft-mail --wait
```

A wait failure does not mean the attachment was rolled back; inspect status before retrying or detaching it.
New sandbox processes receive the provider's stable access-token placeholder.
Refresh material is not injected into the sandbox.
Already-running processes keep their existing environment, so attaching a provider does not add the placeholder to an already-started native agent.
Use a new process to verify the API route:

```sh
openshell sandbox exec -n "$SANDBOX" --no-tty -- /bin/sh -c \
  'curl --fail --silent --show-error -H "Authorization: Bearer $MS_GRAPH_ACCESS_TOKEN" "https://graph.microsoft.com/v1.0/me/messages?\$select=id&\$top=1"'
```

The single quotes keep token expansion inside the sandbox; the gateway proxy replaces the placeholder with the current credential.
Successful Graph JSON verifies this selected user's permission and request path, not a native harness integration or general identity support.
Treat mailbox metadata as private; do not upload the response to a public issue.
If the API refuses access, check refresh status, delegated permissions, attachment readiness, and the profile's executable/network policy.
Do not disable policy or TLS verification to make the request succeed.

## Return to NemoClaw Operations

Detach the manually added provider and wait for that change before running the deployment's normal operations:

```sh
openshell sandbox provider detach "$SANDBOX" microsoft-mail --wait
openshell sandbox provider list "$SANDBOX"
```

Confirm that the remaining attachments match the deployment's original set.
Keep any other operator changes separate; detaching this provider does not repair unrelated drift.
Then use the original YAML, bundle, state directory and credential environment for [unchanged reapply or export](usage.md#verify-an-unchanged-reapply).

| Operation | What it keeps |
|---|---|
| OpenShell credential refresh | Updates the independently registered provider; it does not add an OAuth declaration to NemoClaw YAML |
| NemoClaw export | Exports checked authored deployment configuration, not this profile, refresh material, or manual attachment; attachment drift is refused |
| NemoClaw reapply | Uses the authored attachment set; it does not recreate this manual registration or attach it after sandbox replacement |
| Sandbox replacement | Requires a new manual attachment and a new process if this API is still needed |
| Deployment destroy | Deletes the OpenShell workspace; first remove manual refresh records, providers and workspace profiles |
| Credential retirement | Belongs to the operator and issuer; deployment teardown is not OAuth revocation |

Destroy now deletes the deployment's OpenShell workspace.
OpenShell refuses workspace deletion while a provider, custom profile or credential refresh record remains, even after its sandbox attachments are gone.
Before destroy, stop use of the manual registration, detach it from every consumer, and remove the resources you created in that workspace:

```sh
openshell provider refresh delete microsoft-mail --credential-key MS_GRAPH_ACCESS_TOKEN
openshell provider delete microsoft-mail
openshell profile delete microsoft-graph-mail
```

These commands do not revoke the issuer's grant or remove your client credential source.
Delete the custom profile only after its last provider is removed.
If other consumers still need these workspace-scoped resources, defer deployment destroy until they have an operator-approved replacement; do not force deletion or edit state.
If destroy has already reported remaining resources, retain the deployment state, remove only the identified operator-owned resources, and retry destroy with the same state.
Revoke the grant through the issuer and retire the local token material when retiring access; deleting gateway records alone is not revocation.
The [security guide](security.md#credentials-and-authentication) describes the separate deployment credential boundaries.
