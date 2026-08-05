<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contract Audit

Use this reference to prioritize migration risks. Derive concrete files, symbols, fields, and tests
from current upstream and downstream source.

## Risk surfaces

Consider only surfaces that the upstream range or current NemoClaw integration can affect:

- public commands, APIs, schemas, configuration, defaults, and errors;
- credentials, identity, policy, DNS, TLS, SSRF, and network denial;
- create, start, restart, upgrade, rebuild, rollback, and cleanup behavior;
- persisted state, schema migration, caches, and invalidation inputs;
- process, image, mount, socket, port, capability, and helper topology;
- package resolution, transitive dependencies, licenses, notices, and advisories;
- artifact construction, publication, provenance, installation, and runtime selection;
- platform requirements, diagnostics, status, and degraded behavior;
- downstream compatibility code and its removal conditions;
- CI or E2E selection that can omit the changed contract.

Inspect adjacent source when a changed caller delegates to unchanged code. A new caller, default,
or topology can change the effective contract without changing its final implementation.

## Trace downstream behavior

For each material upstream change:

1. Extract stable identifiers from source and tests.
2. Search the complete downstream checkout for direct and indirect consumers.
3. Follow callers and state transitions to the enforcement point.
4. Inspect reliance on upstream defaults where no downstream identifier exists.
5. Compare upstream contract tests with current downstream coverage.
6. Trace artifacts from construction through the executable or image selected at runtime.
7. Trace credentials and policy from input through their final trust boundary.
8. Identify the earliest point at which invalid state must be rejected.

Do not conclude `no-impact` from an empty literal search. Cite both the upstream boundary and the
downstream call path or exclusion.

## Concern record

Record one independently reviewable failure mode per concern:

```text
ID: DEP-<number>
Range: <old>..<new>
Surface: <risk surface>
Severity and confidence: <values>
Upstream contract: <old and new source or test evidence>
Downstream consumer: <current path and symbol, or exclusion evidence>
Failure mode: <observable or silent result>
Disposition: <migration, pin, guard, test, runtime evidence, documentation, or no impact>
Implementation: <change or planned change>
Verification: <revision-bound evidence>
Remaining gate: <none or explicit dependency>
```

An implementation can resolve several concerns. Keep their evidence and failure modes separate.

## Evidence quality

Prefer evidence that directly defines or exercises the changed contract: immutable source and
tests, downstream negative tests, resolved dependency graphs, immutable artifacts, runtime process
or image identity, wire behavior, lifecycle transitions, and affected-platform results.

Aggregate CI, release-note silence, version output, moving tags, or one successful intended-path
request cannot close a material concern by themselves.
