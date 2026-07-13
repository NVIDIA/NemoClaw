<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contract audit

Use this reference to find migration risk that version searches and existing tests miss.

## Risk surfaces

| Surface | Inspect upstream | Trace downstream | Silent failure examples |
|---|---|---|---|
| CLI | commands, flags, argument order, output formats, errors, exit codes | command builders, parsers, shell scripts, docs, fixtures | success parsed as failure; ignored new default |
| Configuration | schemas, keys, defaults, precedence, paths, migrations | generated config, environment assembly, recovery, doctor checks | valid config selects different driver or endpoint |
| API and protocol | protobuf, JSON, REST, headers, enums, pagination | clients, status probes, mocks, recorded fixtures | unknown field discarded; state misclassified |
| Security and identity | auth, credentials, secret rewriting, certificates, policy | provider mutation, redaction, child env, network policy | credential bypass, stale identity reuse, false green status |
| Lifecycle | create, start, restart, update, rebuild, destroy, cleanup | onboarding, rollback, retries, locks, crash recovery | orphan resources, double mutation, incomplete teardown |
| Network | DNS, TLS, CONNECT, proxying, SSRF, timeouts | policy generation, probes, tunnels, error classification | fail-open route, re-resolution, misleading transport error |
| Runtime topology | processes, sidecars, drivers, images, sockets, ports | gateway launch, supervisor config, PID identity, cleanup | wrong binary/image runs while version check passes |
| Packaging | asset names, archive layout, hashes, libc, architectures | installers, Brev, workflows, sibling-binary discovery | correct version with missing binary or unsupported host |
| Dependency content | base images, lockfiles, build stages, SBOM, licenses, vulnerabilities | accepted images, extraction paths, security scans, allowlists | trusted digest adds an unaudited OS or executable surface |
| Platform support | declared minimums, kernel features, capabilities, runtime versions | supported-host matrix, preflight, fallbacks, affected hardware | upstream CI passes on a newer runtime than the supported user host |
| Observability | status fields, logs, warnings, health semantics | doctor, status UI, automated recovery, troubleshooting | unhealthy runtime reported ready |
| Compatibility | deprecations, removals, fallback rules, feature gates | version selection, old fixtures, upgrade/recovery paths | workaround masks new contract or blocks recovery |

Inspect adjacent source when a changed file delegates to an apparently unchanged contract. A new
caller, default, or topology can change the effective behavior of byte-identical code.

## Downstream tracing method

For each upstream change:

1. Extract stable identifiers from source and tests: symbols, strings, keys, commands, paths,
   image names, labels, status values, and errors.
2. Search the entire downstream repository, including hidden workflows and generated-input
   sources. Exclude only vendored/build output deliberately.
3. Follow each result to its callers and state transitions. Do not stop at the first wrapper.
4. Search for semantic aliases when literals differ, such as a downstream helper that emits an
   upstream config key indirectly.
5. Inspect negative space: downstream paths that rely on upstream defaults and therefore contain
   no explicit key.
6. Compare downstream tests with upstream tests. Identify which new upstream behavior has no
   downstream assertion.

## Concern schema

Use one record per independently reviewable risk:

```text
ID: DEP-<number>
Range: <old-tag>..<new-tag>
Surface: <risk surface>
Severity: <critical|high|medium|low>
Confidence: <high|medium|low>
Upstream old contract: <source/test citation>
Upstream new contract: <source/test citation>
Downstream consumer: <path/symbol/call chain, or exclusion evidence>
Failure mode: <specific observable or silent failure>
Disposition: <migrate|pin|guard|test|runtime-proof|document|no-impact>
Implementation: <diff or planned change>
Verification: <test/source comparison/runtime artifact>
Remaining gate: <none or explicit external dependency>
```

## Disposition standards

- `migrate`: change downstream behavior or data to the new contract and test the transition.
- `pin`: bind an immutable artifact or selector; also resolve the semantic concern separately.
- `guard`: reject or diagnose an invalid state before it crosses the dependency boundary.
- `test`: add deterministic coverage for a contract already implemented correctly.
- `runtime-proof`: exercise process, network, credential, hardware, or lifecycle behavior that
  static tests cannot establish.
- `document`: update current operational truth; never use docs to compensate for broken behavior.
- `no-impact`: cite the upstream boundary and downstream call path or exclusion that proves the
  change cannot affect supported behavior.

A concern can need several dispositions. List the primary disposition and every supporting gate.

## Evidence quality

Strong evidence directly exercises or defines the contract:

- exact-tag source and upstream tests;
- downstream tests that fail on the old assumption;
- immutable runtime artifacts with exact process/image identities;
- wire-level behavior for network and credential boundaries;
- affected-platform proof for platform-specific migrations.

Weak evidence cannot close a material concern by itself:

- an aggregate test suite passed;
- no literal version string was found;
- release notes did not mention a breaking change;
- the CLI printed the expected version;
- a moving development tag worked once;
- source compiled without errors.

Use aggregate CI only after every material concern has direct evidence.
