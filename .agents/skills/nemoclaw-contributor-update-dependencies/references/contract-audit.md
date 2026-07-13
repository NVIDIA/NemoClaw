<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contract audit

Use this reference to find migration risk that version searches and existing tests miss.

## Risk surfaces

| Surface | Inspect upstream | Trace downstream | Silent failure examples |
|---|---|---|---|
| CLI | commands, flags, argument order, output formats, errors, exit codes | command builders, parsers, shell scripts, docs, fixtures | success parsed as failure; ignored new default |
| Configuration provenance | schemas, keys, defaults, precedence, empty/presence semantics, base-image environment, templates, specs, paths, migrations | final image/config inspection, driver request, engine-materialized state, process environments, recovery | inherited image value selects a weaker mode before the downstream can enforce it |
| API and protocol | protobuf, JSON, REST, headers, enums, pagination | clients, status probes, mocks, recorded fixtures | unknown field discarded; state misclassified |
| Security and identity | auth, credentials, secret rewriting, certificates, policy | provider mutation, redaction, child env, network policy | credential bypass, stale identity reuse, false green status |
| Lifecycle | create, start, restart, update, rebuild, destroy, cleanup | onboarding, rollback, retries, locks, crash recovery | orphan resources, double mutation, incomplete teardown |
| Persisted state and caches | materialization inputs, cache keys, snapshots, schema versions, invalidation | prepared roots, generated config, UID/GID, driver, platform, policy, recovery | same-version config change reuses stale identity or rootfs |
| Network | DNS, TLS, CONNECT, proxying, SSRF, timeouts | policy generation, probes, tunnels, error classification | fail-open route, re-resolution, misleading transport error |
| Runtime topology | processes, sidecars, drivers, images, `Config.Healthcheck`, `Config.Volumes`, hooks, sockets, ports | build, publish, download, store, extract, install, engine-scheduled execs, mount overlap, execute, cleanup | inherited healthcheck runs with credentials; anonymous volume shadows a trusted mount |
| Component selection and identity | binary/image precedence, fallbacks, version output, content digests | sibling discovery, driver config, registry state, gateway reuse, live PID 1 | matching CLI version hides different supervisor bytes or a mutable image tag |
| Packaging | asset names, archive layout, hashes, libc, architectures | installers, Brev, workflows, sibling-binary discovery | correct version with missing binary or unsupported host |
| Dependency graph | resolved versions, sources, checksums, features, build scripts, native or unsafe code | lockfiles, notices, SBOM, advisories, allowlists, direct callers | transitive security implementation is absent from notices or review |
| Build and image content | base digests, package repositories, package pins, build stages, provenance, full image contents | accepted images, extraction paths, security scans, runtime selectors | mutable base or unpinned package changes behind a trusted product version |
| Platform support | declared minimums, kernel features, capabilities, runtime versions | supported-host matrix, preflight, fallbacks, affected hardware | upstream CI passes on a newer runtime than the supported user host |
| Observability | status fields, logs, warnings, health semantics | doctor, status UI, automated recovery, troubleshooting | unhealthy runtime reported ready |
| Evidence pipeline | producer run state, workflow path/event/attempt, credentials, checkout order, tool resolution | base-owned verification workflows, artifact staging, provenance records | PR code poisons verification tools or an artifact from a failed run is accepted |
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
7. For persisted or cached results, derive the complete behavior-changing input set from the
   materialization code and compare it with the cache key and cache-hit validation.
8. For images and archives, trace each content set through build, publication, download, storage,
   verification, extraction, installation, and execution. Do not collapse these into one surface.
9. For multi-component runtimes, derive selection precedence and compare the selected artifact's
   content identity with persisted state and the live executable. Vary bytes while holding the
   reported version constant.
10. For proof workflows, identify the first checked-out-code execution, every credential lifetime,
    how tools are resolved, and whether producer workflow/event/attempt/conclusion are machine-bound.
11. For configuration that controls security or topology, enumerate every input layer and the exact
    merge order, then identify when the value is first consumed. Require prevention before that
    point and bind any final-artifact inspection to the immutable artifact actually launched.
12. Materialize and compare expected-versus-observed manifests for the final artifact, driver
    request, engine state before first execution, PID 1, every helper/sidecar, and intended workload
    descendants. Require final-image and engine-materialized `Config.Healthcheck` to be disabled or
    explicitly secured, inventory engine-scheduled healthchecks, hooks, and auxiliary execs, and
    compare `Config.Volumes` with realized mount destinations. Reject equal or normalized
    ancestor/descendant overlaps that can shadow trusted mounts. Verify executable identity,
    ancestry, namespaces, security settings, and exact driver-owned replacements and mount sources;
    never select a workload as the first or sole child.
13. Keep upstream required-fix SHAs, audit target and producer identity, and downstream PR-head
    proof identity in separate fields. Prove ancestry and manifest bindings between domains rather
    than comparing unrelated repository SHAs for equality.
14. For an untagged GitHub target, bind the exact canonical repository and an advertised branch ref
    that equals the audit target. Inventory remote semantic-version tag refs before trusting local
    adjacent ranges. Raw object lookup does not prove upstream-ref membership because fork and pull
    request objects can be visible through the base repository object network.

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
- exact resolved dependency graph entries tied to notices, SBOM, advisory, and provenance review;
- cache invalidation proofs that vary one material input while holding the dependency version fixed;
- wire-level behavior for network and credential boundaries;
- affected-platform proof for platform-specific migrations.
- a base-trusted verifier that runs before proposed code, binds a successful producer run, and
  revokes credentials before proposed code executes.

Weak evidence cannot close a material concern by itself:

- an aggregate test suite passed;
- no literal version string was found;
- release notes did not mention a breaking change;
- the CLI printed the expected version;
- one component printed the expected version while a sibling binary or image was selected;
- artifact metadata matched a source SHA but the producer run ultimately failed;
- a moving development tag worked once;
- source compiled without errors.

Use aggregate CI only after every material concern has direct evidence.
