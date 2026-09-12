<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# External component connections

Issue #11507 extends the existing component contract for fresh Linux onboarding.
The v1 declaration and `/v1/activate` protocol retain their existing behavior.
NemoClaw writes the generated OpenShell configuration and owns the gateway lifecycle.
The component supplies policy. OpenShell validates effective policy and enforces it.

## Runtime dependency

This v2 implementation requires authenticated interceptor and middleware APIs,
and interceptor-backed provider profiles.
The shared runtime pin is OpenShell 0.0.116.
Qualify the accepted behavior against that release before claiming integration support.
Keep runtime qualification and shared version pins in their existing owner.
Dynamic registration is the accepted v2 contract. Do not add an insecure transport fallback.

## Agent selection

Providerless onboarding accepts OpenClaw and Hermes through the existing agent definitions and startup adapters.
Reject other agents before preflight effects, component preparation, or gateway startup.
The requested agent and resolved agent must agree before sandbox creation.
Provider, model, endpoint, credential, and messaging inputs remain incompatible with this path.
Do not discover stored messaging credentials during providerless creation.

Both agents use the same preparation, externally supplied policy, identity proof, and bounded activation lifecycle.
Each agent retains its managed image, configuration generator, and startup integration.
Providerless onboarding does not create an ordinary inference provider; the agent still requires a managed inference route.
This path does not add a requirement to configure that route before sandbox creation.
Verify agent startup and inference after activation with real OpenShell before claiming live qualification.
Failed or ambiguous activation retains incomplete state and does not retry.

## Declaration

The operator installs the existing `external-component.json` file with mode `0600`.
Existing declaration ownership, parent-directory, and activation-socket checks apply.
V2 contains these fields only:

```json
{
  "schemaVersion": 2,
  "componentId": "generic/policy",
  "activationSocketPath": "/run/user/1000/component/activation.sock",
  "interceptor": {
    "endpoint": "https://127.0.0.1:9443",
    "caCertificatePath": "/run/user/1000/component/ca.pem",
    "audience": "urn:generic:admission"
  },
  "middleware": {
    "name": "generic/middleware",
    "endpoint": "https://host.openshell.internal:9444",
    "caCertificatePath": "/run/user/1000/component/ca.pem",
    "audience": "urn:generic:middleware"
  },
  "providerProfileSource": "generic/policy"
}
```

`componentId` is also the interceptor registration name. Names cannot use the reserved `openshell/` prefix.
The middleware endpoint must use the fixed `host.openshell.internal` selector with an explicit port.
NemoClaw resolves this selector to the inspected Docker bridge address and writes an IP endpoint.
It does not perform a DNS lookup or accept arbitrary host addresses.

The authenticated component's manifest owns callback selection and callback failure behavior.
NemoClaw configures `binding_policy = "dynamic"` with no binding or failure-policy overrides.
New supported callbacks are trusted. Missing callbacks do not trigger a strict-registration failure.
A callback's explicit failure policy can override the manifest's service default, including a `fail_closed` default.
Tests must verify the component's required checks and their allowed and denied outcomes.
OpenShell validates supported RPCs, phases, manifests, and middleware bindings, and retains enforcement authority.

`providerProfileSource` is optional. When present, it must name this interceptor.
It selects the interceptor as the sole profile source; unresolved profiles cannot fall back to built-in or user profiles.
NemoClaw does not distribute profiles or evaluate profile content.

## Preparation

Issue #11606 authorizes NemoClaw to provision a missing Docker bridge before authenticated v2 preparation.
NemoClaw resolves the selected local Docker connection and configured network name through its runtime adapter.
A successful, complete network listing must establish absence before NemoClaw creates one attachable bridge.
Existing compatible networks retain their identity and configuration. NemoClaw does not start a temporary gateway or sandbox.
OpenShell reuses the inspected network and retains sandbox lifecycle and policy enforcement.
Ordinary onboarding, v1 components, and non-Docker paths do not use this provisioning operation.

Preparation requires one local, non-internal bridge with exactly one private IPv4 subnet and a usable gateway in that subnet.
Missing identities, multiple networks, ambiguous IPAM, incompatible drivers, inspection failures, replacement, and address drift stop onboarding.
Network commands use the selected Unix socket. Generated v2 gateway configuration pins that socket so OpenShell cannot select another daemon.
TCP and SSH Docker endpoints remain unsupported. A changed Docker connection stops preparation or startup.

Read operations have a 10-second deadline; creation has a 30-second deadline. Each command has a 16 KiB output limit and a forced-kill deadline.
NemoClaw attempts creation once. After a failure, timeout, or competing creation, it inspects the retained network to reconcile the result.
Only a compatible inspected network can proceed. A successful creation must return the same identity as inspection.
An unresolved result stops onboarding with `preparation_failed`; service diagnostics are not forwarded.
NemoClaw never deletes, repairs, or recreates the network during preparation or failure handling.
The network also remains after rejected component preparation, authentication failure, or a later startup failure.

This path does not depend on an OpenShell network-preparation command. Runtime pins are unchanged.
Other authenticated component compatibility requirements still apply; network reuse alone does not qualify the full integration.
Issue #11606 retains the follow-up to agree on network ownership, compatibility, and a long-term preparation interface with OpenShell maintainers.
No upstream agreement or delivery date is assumed. Evaluate any agreed interface in a separate reviewed change.

The component must create its CA files and protected activation socket before onboarding.
CA files must contain currently valid CA certificates only, with protected parents and no symlinks or hardlinks.
Root or the current user must own the files. Group and other users must not have write access.
NemoClaw checks file identity and content again before startup and activation.
The component may create its listener certificates after receiving the bridge address; it must retain the pinned CA files.

After writing configuration and generating gateway keys, NemoClaw sends `POST /v2/prepare` on the activation socket.
The JSON request has `schemaVersion: 2`, a random `preparationId`, `componentId`, and these objects:

- `gateway`: `name`, `id`, `issuer`, `publicKeyPem`, `kid`, and `extensionTokenTtlSecs: 900`.
- `network`: the inspected `gatewayIp` and `subnet`.
- `interceptor` and `middleware`: the validated declaration settings, including ports, CA paths and audiences.
- `providerProfileSource`: included only when declared.

The component uses the public key to verify OpenShell's EdDSA extension credentials.
It must check the issuer, audience, key ID, token type, expiration, and caller identity.
The gateway signing key stays in NemoClaw's protected state directory. It is never sent to the component.
OpenShell mints and refreshes extension credentials; they expire after 900 seconds with the existing gateway settings.
Restarting the gateway without component registration removes future delivery. Existing credentials remain valid until their expiration.

The component replies with HTTP 200 and exactly four JSON fields:
`schemaVersion: 2`, the matching `preparationId`, the matching `componentId`, and `result: "prepared"`.
It may return `result: "rejected"` to refuse preparation.
The existing transport requires a bounded `Content-Length`, rejects ambiguous framing, and closes after each request.
The response limit is 1 MiB, with a 16 KiB header limit and a 30-second total deadline. NemoClaw does not retry.
Any preparation error prevents gateway startup. Preparation errors contain no service diagnostics.

The listener must retain the same protected socket inode through preparation and activation.
The component associates the later activation with the prepared `componentId` and `gateway.name`.
It verifies the sandbox against the prepared gateway identity before acknowledging activation.
The existing activation UUID, effective-policy proof, failure classification, and incomplete-activation state remain unchanged.

NemoClaw revalidates declaration, socket, CA files, generated configuration, gateway keys, and bridge identity and addressing.
OpenShell performs authenticated registration after successful preparation and rejects missing or incompatible services.
NemoClaw does not install or supervise those services.

## Validation

`connections.test.ts` covers declaration restrictions, trust files, generated configuration, drift, and preparation.
Existing activation and gateway-handler tests cover bounded transport, incomplete activation, and unchanged v1 behavior.
The creation and finalization tests share an OpenClaw/Hermes matrix for image identity, startup configuration, policy proof, and activation failures.
Real OpenShell registration, policy and profile delivery, sandbox identity, and middleware outcomes require live evidence.
Record exact NemoClaw and OpenShell revisions and both agents’ results separately. Mocked results do not qualify the integration.
