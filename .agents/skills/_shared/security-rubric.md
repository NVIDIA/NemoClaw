<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Rubric

Use these nine categories to identify security risks, controls, and evidence throughout a change.
Planning names the applicable risks, trust boundaries, intended controls, and expected evidence.
Implementation records the controls that changed and focused negative evidence that proves forbidden
behavior remains denied. Independent review evaluates the completed change against every category.

Current code, tests, workflows, and active `AGENTS.md` files remain authoritative for implementation
details. This rubric owns category names, meanings, reusable questions, and evidence expectations only.

## Category 1: Secrets and Credentials

### Meaning

Keep credentials and sensitive authentication material inside the named credential trust boundary.

### Questions

- Can a secret, token, password, key, certificate, connection string, or credential file enter source,
  configuration, logs, errors, artifacts, process arguments, or model-visible context?
- Does credential flow cross a sandbox, workflow, process, provider, or repository trust boundary?
- Are credentials scoped, stored, passed, rotated, and removed through the intended trusted mechanism?

### Expected evidence

- Positive evidence traces required credential flow through the intended credential mechanism without widening access.
- Negative evidence proves credentials and representative secret values are absent or redacted at each named
  boundary that does not permit credential access.

## Category 2: Input Validation and Data Sanitization

### Meaning

Treat external, user-controlled, model-controlled, repository-controlled, and cross-boundary data as
untrusted until it is constrained for its use.

### Questions

- Are type, length, format, range, path, URL, host, protocol, and ownership constraints enforced before use?
- Can data reach shell execution, filesystem access, parsing, rendering, network access, or policy decisions
  with a different interpretation than the validator used?
- Can encoding, redirects, aliases, traversal, injection, or parser behavior bypass the intended constraint?

### Expected evidence

- Positive evidence covers accepted canonical input at the boundary that owns validation.
- Negative evidence covers malformed, ambiguous, encoded, traversal, injection, and SSRF-shaped input that
  must be rejected without reaching the protected operation.

## Category 3: Authentication and Authorization

### Meaning

Verify identity and permission at the trusted boundary before allowing an action or resource access.

### Questions

- Is authentication required before processing, and are signature, expiry, audience, issuer, and scope checked?
- Is authorization enforced for the resource and action rather than inferred from client behavior?
- Can horizontal or vertical privilege escalation bypass ownership, role, tenant, sandbox, or workflow checks?

### Expected evidence

- Positive evidence proves an authenticated and authorized principal can perform the intended action.
- Negative evidence proves unauthenticated, expired, wrong-scope, wrong-owner, and lower-privilege principals
  are denied at the authoritative boundary.

## Category 4: Dependencies and Third-Party Libraries

### Meaning

Limit supply-chain exposure to external code and artifacts required by a named consumer. Obtain them from a
source accepted by repository policy and resolve them reproducibly.

### Questions

- Is each new dependency or downloaded artifact necessary, maintained, license-compatible, and obtained from a
  trusted source?
- Are production versions, image digests, checksums, lockfiles, and registries constrained against substitution?
- Do install hooks, transitive dependencies, generated files, or runtime loading expand execution or network trust?

### Expected evidence

- Positive evidence identifies the current consumer, trusted source, resolved version, integrity control, and
  relevant vulnerability or license assessment.
- Negative evidence proves untrusted registries, floating or substituted artifacts, and unintended install or
  runtime execution are not accepted.

## Category 5: Error Handling and Logging

### Meaning

Propagate security failures without exposing sensitive state, suppressing the failure, or continuing after a
required control fails.

### Questions

- Can errors, logs, traces, diagnostics, or artifacts disclose credentials, personal data, internal paths, policy,
  or protected system state?
- Are security failures propagated to a caller that can act, rather than suppressed, downgraded, or retried unsafely?
- Can interruption or partial failure leave permissions, resources, files, credentials, or processes outside
  their required restrictions?

### Expected evidence

- Positive evidence shows actionable errors and deterministic cleanup or recovery at the owning boundary.
- Negative evidence proves sensitive values are redacted and security-critical failures cannot become success,
  silent continuation, or unsafe partial state.

## Category 6: Cryptography and Data Protection

### Meaning

Protect sensitive data with established protocols and algorithms appropriate to its lifetime and trust boundaries.

### Questions

- Is sensitive data protected in transit and at rest where required, with certificate and peer verification enabled?
- Are standard current algorithms, modes, key sizes, randomness, nonce handling, and key lifecycle mechanisms used?
- Is custom cryptography, obsolete hashing, reversible masking, or insecure fallback treated as protection?

### Expected evidence

- Positive evidence identifies the standard mechanism, protected data, trust boundary, key owner, and verification path.
- Negative evidence proves plaintext, invalid peers, weak algorithms, reused nonces, insecure fallback, and unintended
  data retention are rejected where applicable.

## Category 7: Configuration and Security Headers

### Meaning

Make deployed defaults restrictive. Prevent configuration from weakening required process, container, browser,
and network controls.

### Questions

- Do defaults minimize privileges, capabilities, ports, filesystem access, network egress, origins, and debug exposure?
- Can environment variables, manifests, headers, policy merges, images, or runtime overrides disable a required control?
- Are container users, image provenance, CORS, CSP, TLS, file modes, and policy precedence appropriate to the surface?

### Expected evidence

- Positive evidence proves the restrictive default and the final effective configuration at the boundary that
  enforces each required control.
- Negative evidence proves omitted, malformed, permissive, conflicting, and override configurations fail closed
  or preserve every required control.

## Category 8: Security Testing

### Meaning

Keep automated evidence that allowed behavior succeeds and forbidden behavior remains denied at the boundary
that enforces the control.

### Questions

- Does coverage include malicious input, boundary values, unauthorized actions, bypass attempts, and prior regressions?
- Does the test include the component that enforces the control, or does mocking bypass that component?
- Does the change remove, weaken, skip, or make nondeterministic existing security evidence?

### Expected evidence

- Positive evidence exercises authorized behavior at the narrowest boundary that includes the enforcing component.
- Negative evidence exercises representative attacks and forbidden actions against the component that enforces the
  control. Use runtime or E2E evidence when process, sandbox, container, filesystem, workflow, or network enforcement
  is the behavior under test.

## Category 9: System Security

### Meaning

Preserve the security of the whole state transition when individually valid checks interact across time, concurrency,
recovery, composition, or trust boundaries.

### Questions

- Does the change weaken, duplicate, bypass, reorder, or move an existing control away from its authoritative boundary?
- Can TOCTOU, concurrency, retries, stale state, recovery, fallback, alternate entry points, or partial rollout bypass checks?
- Does least privilege hold for code, services, workflows, sandboxes, users, and data throughout the complete operation?

### Expected evidence

- Positive evidence traces the complete security-relevant state transition and identifies the authoritative control at each
  trust-boundary crossing.
- Negative evidence covers bypass routes, races, stale or partial state, recovery and fallback paths, and composition with
  adjacent controls without replacing required real-system validation.
