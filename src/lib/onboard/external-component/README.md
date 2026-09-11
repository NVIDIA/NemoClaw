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
The current shared runtime pin does not contain all required behavior.
Qualify the accepted behavior against a released runtime before claiming integration support.
Keep runtime qualification and shared version pins in their existing owner.
Dynamic registration is the accepted v2 contract. Do not add an insecure transport fallback.

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

NemoClaw revalidates declaration, socket, CA files, generated configuration, gateway keys, and bridge addressing.
OpenShell performs authenticated registration after successful preparation and rejects missing or incompatible services.
NemoClaw does not install or supervise those services.

## Validation

`connections.test.ts` covers declaration restrictions, trust files, generated configuration, drift, and preparation.
Existing activation and gateway-handler tests cover bounded transport, incomplete activation, and unchanged v1 behavior.
Real OpenShell registration, policy and profile delivery, sandbox identity, and middleware outcomes require live evidence.
Record NemoClaw, OpenShell, and combined #11486 revisions separately. Mocked results do not qualify the integration.
