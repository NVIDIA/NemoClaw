<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell TypeScript SDK 0.0.106 dependency review

> Internal engineering evidence. This file is not part of the public documentation set.

## Status and scope

Issue #9872 permits `@nvidia/openshell-sdk@0.0.106` for one bounded public gateway-health call.
The slice reads no machine credential and makes no authenticated or mutating call.

This review applies only to the exact source, package, and runtime graph below.
It does not qualify a Runner image or approve machine authentication.

## Source and package identity

| Evidence | Reviewed value |
| --- | --- |
| OpenShell tag | `v0.0.106` |
| Source commit | `c4b500a7de64d0b66e3ee8098f58d14299092162` |
| Package | `@nvidia/openshell-sdk@0.0.106` |
| Registry | GitHub Packages |
| Package version ID | `1134230109` |
| Package SHA-512 integrity | `sha512-dB4mLex23Pnw61caGMR2CMHQihy9bj7IK2elJJd718k3yevm+fOt/vG6dJg8/5us4la2BwcOdRwLvOia3tdwFw==` |
| Observed package SHA-256 | `30ae4c4749a610cc6e9b22067ece61f6137ba858acf5102c23cb81c37c4cc3fb` |
| Producer run | `31809093046`, attempt 2, job `94864069197` |

The registry metadata and the OpenShell tag identify the same source commit.
The package has no registry signature or provenance attestation.
The root package lock binds the exact registry URL and SHA-512 integrity.
A later SDK version requires a new dependency review.

## Selected runtime graph

| Package | Version | Declared license |
| --- | --- | --- |
| `@nvidia/openshell-sdk` | `0.0.106` | Apache-2.0 |
| `@bufbuild/protobuf` | `2.12.1` | Apache-2.0 AND BSD-3-Clause |
| `@connectrpc/connect` | `2.1.2` | Apache-2.0 |
| `@connectrpc/connect-node` | `2.1.2` | Apache-2.0 |

The root manifest records all four packages as exact optional dependencies.
The package lock pins each version and package integrity for source installs.
None of these packages defines an install lifecycle script.

## API and security contract

NemoClaw uses `OpenShellClient.connect({ gateway, caCert })` from the official SDK. It calls the
SDK-documented `client.raw.health()` operation over the shared transport created and owned by that
client. NemoClaw does not import ConnectRPC, create a generated client, or create an HTTP/2 session.

The health adapter:

- Accepts only the validated HTTPS endpoint and CA.
- Gives the endpoint and a copy of the CA bytes to the official SDK without an authentication token,
  client certificate, client key, or insecure TLS option.
- Retains the SDK's normal TLS certificate and hostname verification.
- Starts one five-second deadline before local SDK loading and bounds adapter return through SDK
  client creation and public health.
- Passes that same deadline signal to the SDK health operation.
- Passes no token, client certificate, client key, CLI state, or insecure TLS option.
- Replaces SDK import and transport details with fixed messages.
- Uses no direct transport or fallback.

The SDK does not expose a DNS lookup hook or transport close handle. It uses the platform resolver
when the explicit endpoint contains a hostname. The configured CA and TLS hostname check still
authenticate the remote endpoint, but NemoClaw cannot pin one DNS answer set through this SDK API.
Under the accepted initial contract, cluster and storage administrators are trusted infrastructure
actors, and this operation sends only unauthenticated public health. A later change that sends a
credential or accepts a broader trust model must revisit DNS rebinding and transport ownership.

The SDK client is lazy.
Public health is the first network request.
Identity, workspace inventory, provider inventory, authentication, and mutation remain outside this slice.

## Installation and redistribution

The root NemoClaw package records the SDK and its three runtime dependencies as exact optional dependencies.
Installations that do not use external gateway status can omit private-registry access.
The root package exposes the Blueprint Runner executable.
The OpenClaw plugin package and lock do not contain the SDK.
The reviewed package workflow from PR #10368 supplies exact SDK bytes to untrusted CI without package credentials.

If the runtime omits the SDK or exposes an incompatible client, external gateway status returns a fixed package-unavailable error before a network request.
The result exposes no import detail and starts no fallback.

The SDK and its three runtime dependency archives omit license and notice files.
Before a Runner image distributes this graph, the image release must include the applicable Apache-2.0 and BSD-3-Clause license texts.
The image software bill of materials and third-party notice must bind to the installed graph.

## Concern records

### DEP-1: Package substitution

- Severity and confidence: high, high confidence.
- Failure mode: another package or transitive version executes in the Runner.
- Control: pin the SDK and each runtime dependency exactly in the published root manifest, and pin each package URL and integrity in the source lock.
- Verification: compiled package installation and Runner package-contract tests.

### DEP-2: Package credential exposure

- Severity and confidence: high, high confidence.
- Failure mode: candidate code or an unreviewed dependency receives the package credential.
- Control: use the reviewed base-controlled package workflow from PR #10368.
- Verification: workflow and integration tests owned by that merged change.

### DEP-3: Optional dependency absence or initialization failure

- Severity and confidence: medium, high confidence.
- Failure mode: package failure looks like a gateway outage, or import detail reaches output.
- Control: validate the official SDK client export and generated service-status enum before network
  access, then return a fixed package-unavailable error.
- Verification: focused adapter tests and the compiled package contract.

### DEP-4: DNS rebinding or local-target substitution

- Severity and confidence: high, high confidence.
- Failure mode: a validated hostname resolves or rebinds to a local service when the request starts.
- Control: the [accepted read-only slice decision](https://github.com/NVIDIA/NemoClaw/issues/9872#issuecomment-5417049313)
  treats cluster and storage administrators as trusted infrastructure actors. The configured
  endpoint and CA come from those administrators. The
  operation sends only unauthenticated public health and retains TLS certificate and hostname
  verification.
- Residual: SDK 0.0.106 does not expose a pinned lookup. A hostname can resolve differently between
  validation and connection, including to a local address. TLS identity verification prevents an
  unrelated local service from impersonating the configured gateway, but it does not prevent the
  connection attempt. Restrict deployment authority to the trusted administrators named in issue
  #9872.
- Verification: wrong-CA and wrong-hostname package tests protect TLS identity. The live test uses
  an administrator-selected private gateway address. Independent security review must keep this
  accepted trust boundary visible.

### DEP-5: Transport outlives the bounded observation

- Severity and confidence: high, high confidence.
- Failure mode: request cancellation returns, but the HTTP/2 session keeps the Runner process alive.
- Control: pass the one total deadline signal to the official SDK health operation and retain the
  bounded Kubernetes Job deadline as the outer control. A late local SDK import cannot start a
  network request because health begins only after the bounded load returns.
- Residual: SDK 0.0.106 exposes no transport close handle.
- Verification: adapter deadline tests and a packaged Runner test against a stalled TLS peer prove
  that the Runner returns and the process exits within the package boundary.

### DEP-6: Redistribution evidence

- Severity and confidence: medium, high confidence.
- Failure mode: a Runner image omits license evidence or claims unavailable provenance.
- Control: bind the image software bill of materials and license inventory to the installed graph.
- Verification: future Runner image release evidence.

## Remaining gates

- The feature must pass focused, package, type, build, and repository checks on its final commit.
- The final security review must explicitly assess the SDK's standard DNS resolution and lack of a
  transport close handle; this review does not claim address pinning or session ownership.
- The future Runner image must prove the exact SDK runtime identity, software bill of materials, and license inventory.
- A separate accepted decision must define machine authentication before credential reads or authenticated calls start.
