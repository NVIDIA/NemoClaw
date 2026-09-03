<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell 0.0.101 Migration and Security Review

> Internal engineering evidence. This file is not part of the public documentation set.

Shields retirement addendum date: September 1, 2026.

Shields was retired from NemoClaw after this review was written. Every Shields reference below is retained as historical evidence of the ownership regression, compatibility correction, and exact-version qualification carried forward from the OpenShell 0.0.99 review; none describes a current command, supported runtime posture, live lane, or merge gate. The exact Docker recreation correction, process identity, working-directory and Landlock roots, workspace-qualified ownership, and mutable runtime lifecycle guarantees remain active independently of the retired Shields ownership transition.

## Status and Decision

This review covers two exact source boundaries:

- the complete product delta from OpenShell `v0.0.99` commit
  `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032` to `v0.0.101` commit
  `8ddd98c3dff62619a3963f99ba1e055b67650e72`; and
- the complete public-user upgrade boundary from `v0.0.85` commit
  `3dee5570a46076a57a3b056f35f35ebc0861ac85` to that same `v0.0.101` commit.

The review was performed against NemoClaw worktree base
`9f7c278af6068bc39455ca6ab495c2236d07d75e`. It carries forward the OpenShell
0.0.99 review whose repository baseline is
`02398f3433f8c8d4cc329328229854bde7f4ce77`; it does not rebase its conclusions
onto later `main` changes.

The source decision is **conditionally compatible** with the Docker recreation correction recorded in `OS101-I15`.
OpenShell v0.0.101 retains the v0.0.99 default workspace preparation that later historical Shields evidence identified as an escaped compatibility regression.
The correction preserves NemoClaw's existing user-visible runtime contract and does not change a command or default.
OpenShell v0.0.101 also changes upstream credential-storage behavior, and source compatibility is not release acceptance.
The final `#8598` identity and trust handoff has been consumed below and passes independent exact-commit review.
Acceptance remains conditional until both of the following are true.
This completed review belongs to the parent epic `#8590`; that epic also retains its later selector, qualification, and final-candidate gates.

1. issue `#8600` lands the base-trusted qualification descriptor, orchestration workflow, and
   fail-closed receipt checks; and
2. issues `#8601` through `#8605` produce successful exact-version evidence for every required
   transport, policy, credential, runtime-identity, Podman, upgrade, recovery, and isolation
   invariant.

There is no waiver or exception path. A missing, skipped, expected-failure, stale, or
non-exact-version result is not qualification evidence.

## Audit Method and Exact Boundary

The review used an isolated full clone of the canonical OpenShell repository, detached at the
exact `v0.0.101` commit. Each tag was resolved to a commit before the range was enumerated. The
repository-owned release-ledger format recorded every adjacent tag, commit, and changed path with
owner-only permissions.

The `v0.0.99...v0.0.101` range contains 9 commits and 170 changed paths (41,611 insertions and 410
deletions). The direct public-user range `v0.0.85...v0.0.101` contains 126 commits, 628 distinct
changed paths, and 16 adjacent tag ranges.

## Independent Release Identity Dependency

The final `#8598` identity and trust handoff was independently cross-checked against the release
API and container registry before being recorded here. Its public NemoClaw consumer baseline is
annotated `v0.0.104`
tag object `fc9b7ecee4e81048ab0f2c73c513cd606313797a`, which peels to verified commit
`f389c9d872775006ae069473f58250fa8f3ad40f`. The lightweight OpenShell tag `v0.0.101` resolves to
verified commit `8ddd98c3dff62619a3963f99ba1e055b67650e72`.
The OpenShell release was published on August 7, 2026.
All 26 published release assets matched their API digest fields, all 20
checksum-manifest entries were verified, and all 11 archives passed path-safety inspection.
The downloaded formula's syntax and version matched the release, and every candidate-declared pin
matched the downloaded bytes.
The artifact enumeration found no byte or release metadata mismatch, but those checks do not
establish a base-trusted enforcement root.

The base-trusted checksum-manifest SHA-256 anchors are:

| Manifest | SHA-256 |
| --- | --- |
| `openshell-checksums-sha256.txt` | `9c90869d00b109b5ac1062b1a9808a592c2311d3c0c4926bae44d136b979d8a9` |
| `openshell-gateway-checksums-sha256.txt` | `dcb3f1917713bf2a8e8e1803ac42c5e39d9dd41e644136b05def32b077082777` |
| `openshell-sandbox-checksums-sha256.txt` | `d16f7d369c54d74d36c7df036565267a960e7ce6fb143012fe9d77f257d6e8b3` |

The exact archive SHA-256 values in those manifests for the production platform mapping are:

| Artifact | linux-x86_64 | linux-aarch64 | darwin-aarch64 |
| --- | --- | --- | --- |
| CLI | `7d49ab2a5ff0b826bd2bdca5e0244010f832dfc6901c808ea8c8467004c26913` | `b553d3bfc08e9354b990a10fb8abd976e039afeec2d3947f8a112018be40d296` | `9daaccdb9e30e220d56dd6d6bf4bd00ccca8ae4ad2845f5f0d9b9da3eb8ee881` |
| Gateway | `eaeb094ccf7dcb1fe00c7e926e6aa9aaaefb89ecbef8343720628b0fd2d84654` | `ac842ccc2ab8b5682f7479d71532cc650839250a8a41dbfae2b871cbbdfd3279` | `0f9e195b7cde57f4c2080df95159c5e7e72b0248306abc242ae00a3bb6f07f14` |
| Sandbox | `953b90eaa7d2fc1bb7bdf38eb0ada6fad7902b13f9f895ca20b89caeac483a9e` | `c39b7ba3cf212b88712a00d2a0e3d28e2c1e0e9f47a9a6ca818a8f06ed2140aa` | not published |

The Homebrew formula SHA-256 is
`87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2`.
The supervisor reference `ghcr.io/nvidia/openshell/supervisor:0.0.101` resolves to multi-platform
index `sha256:b58be5e40c788977ffa0e8305a8cad9c656efdf1a3fe182582a00ca870bb0edb`;
its linux/amd64 manifest is
`sha256:44aecbbbf4a4b46e88de3fea28476ca2abf043f543d1e9cb9089bcec1ee3aa74`
and its linux/arm64 manifest is
`sha256:d30bb067e4769c743cdf020e736cf88f090dc2d66cc01cbaf18f0098cfb90da1`.
The later selector change must pin the immutable parent index and retain platform-child coherence.

### Resolved #8598 Trust-Enforcement Findings

Independent review of `#8598` commit `7651ff32c31189b84c554cf275829c27049dd196`
found that `openshell.rb` is not covered by any of the three checksum manifests. The verified
v0.0.101 formula digest appears only in candidate-controlled test fixture data, while base-trusted
code allowlists only the three manifest digests. Because the upstream release currently reports
`immutable: false`, a later pin change could replace both its candidate formula pin and test
fixture with the then-current live formula digest. The checker would compare two candidate/live
values without an independent base-trusted formula identity. This was a high-severity
release-integrity finding, not an artifact-byte mismatch.

Signed correction commit `6ace3b8d657d3d65589d9ce61fe4672400f30955`, whose sole parent is the
initial commit above, closes that finding. The base-trusted checker now carries an exact
version, `openshell.rb` asset, canonical GitHub release URL, and SHA-256 tuple for every already
allowlisted OpenShell version. It validates tuple shape and URL, requires exactly one tuple for the
selected version, downloads from the trusted URL, and compares both downloaded bytes and the
candidate pin with the trusted digest. Missing, duplicate, malformed, stale,
candidate-self-authorized, or URL-substituted entries fail closed.

The same review found a second candidate-controlled identity binding. The unchanged trusted parser
strictly validates the grammar of `pinned_sandbox_build_version`, but it normalizes that entire
function out of the trusted installer template and requires only that the candidate map contain at
least one digest for the selected version. The candidate test explicitly permits structurally valid
release-data additions. At runtime this map becomes the version authority for a standalone sandbox
executable when the host cannot execute its `--version` probe. Therefore syntactic validation does
not prove that an accepted digest identifies a reviewed v0.0.101 sandbox artifact.

That sandbox identity finding was medium severity in isolation and high severity in the executable
fallback. The correction roots exact standalone binary version/digest pairs in the base-trusted
parser, retains every required prior fallback identity, permits the reviewed v0.0.101 pairs only as
a dormant prerequisite, and requires the selected release's complete trusted set with no
unexpected or remapped identity. The independently recomputed v0.0.101 inner-binary SHA-256 values
are `a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920` for linux-x86_64 and
`88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4` for linux-aarch64.

The correction commit has a raw SSH signature and exact contributor `Signed-off-by` trailer. Its
independent exact-commit review passed every security category, 90 focused trust tests, the
repository integrity checks, and type-checking. Both findings are closed with no new blocker.
Because the formula asset remains mutable upstream, a replacement now causes a fail-closed
availability failure instead of silently changing trusted identity. The dormant v0.0.101 sandbox
identities still require the later selector and qualification workflow; this handoff does not
activate them.

| Adjacent range | Commits | Paths | Review disposition |
| --- | ---: | ---: | --- |
| `v0.0.85 -> v0.0.86` | 12 | 109 | Inherited from the 0.0.99 review; policy, persistent identity, Docker discovery, refresh, and middleware concerns remain live. |
| `v0.0.86 -> v0.0.87` | 5 | 12 | Inherited; upload symlink, naming, and build-tool conclusions remain live. |
| `v0.0.87 -> v0.0.88` | 15 | 169 | Inherited; exec, provider, workspace-authorization, and Landlock conclusions remain live. |
| `v0.0.88 -> v0.0.89` | 9 | 49 | Inherited; OPA reason and deletion-event isolation conclusions remain live. |
| `v0.0.89 -> v0.0.90` | 9 | 24 | Inherited; mount ownership and proposed allowed-IP conclusions remain live. |
| `v0.0.90 -> v0.0.91` | 3 | 33 | Inherited; auth-status and proposal-state conclusions remain live. |
| `v0.0.91 -> v0.0.92` | 11 | 55 | Inherited; proxy, L7 validation, structured output, and parser conclusions remain live. |
| `v0.0.92 -> v0.0.93` | 7 | 24 | Inherited; readiness, retry, exec stderr, and Podman shutdown conclusions remain live. |
| `v0.0.93 -> v0.0.94` | 12 | 68 | Inherited; policy-first OCI identity, readiness, and host-environment isolation conclusions remain live. |
| `v0.0.94 -> v0.0.95` | 7 | 107 | Inherited; IPv6 SSH, workspace authorization, and listener isolation conclusions remain live. |
| `v0.0.95 -> v0.0.96` | 5 | 38 | Inherited; atomic policy notification, telemetry, and dependency conclusions remain live. |
| `v0.0.96 -> v0.0.97` | 12 | 144 | Inherited; callback negotiation, proxy consolidation, Podman lifecycle, and nft conclusions remain live. |
| `v0.0.97 -> v0.0.98` | 3 | 50 | Inherited; VM tracing and build-graph conclusions remain live. |
| `v0.0.98 -> v0.0.99` | 7 | 79 | Inherited; system CA, OCI working directory, and TCP behavior conclusions remain live. |
| `v0.0.99 -> v0.0.100` | 7 | 158 | Credential storage, Go SDK, egress RFC, HTTP/2 keepalive, dependency, and non-runtime documentation/build changes reviewed. |
| `v0.0.100 -> v0.0.101` | 2 | 13 | Bazel credential-driver and VM-runtime build targets reviewed; NemoClaw does not select the new drivers. |

The complete new commit set is:

| Commit | Subject | Security and compatibility result |
| --- | --- | --- |
| `5548405fcbfeb97964bbe429fb5cc6b823bd16de` | `feat(credentials): add provider credential storage drivers (#2437)` | Material. Default encrypted database storage, optional external drivers, handle-backed provider state, refresh, redaction, migration, and cleanup were reviewed. |
| `f383ee1038f91921e104405cd01e4150d533fdbe` | `feat(mise): run fmt as part of pre-commit (#2621)` | Tooling only; no runtime contract. |
| `284da54de5c7710482c553eb15a8aa020744e223` | `docs(readme): add theme-aware banner (#2619)` | Documentation assets only. |
| `c5f8366cd31860e5d6f00480d4fc01f8cc3b3c0f` | `feat(sdk/go): add Go SDK foundation, types, and sandbox client (A) (#2271)` | New client surface, but NemoClaw neither imports nor executes it. |
| `85d992f768bf2152fc5b815fc4031c61eae1ac52` | `RFC 0005: Sandbox proxy egress adapter model (#2155)` | Design documents only; there is no new runtime adapter to select. |
| `d2c44b0e5393e3746eae5783aa99ac31be08daae` | `fix(supervisor-middleware): configure HTTP/2 keepalive on middleware gRPC channel (#2608)` | Material transport change; exact idle-channel and policy-path proof is required. |
| `0c7e59a95355cabc15ccaddb86fcbe6a1d30eaaa` | `fix(deps): bump russh, jsonwebtoken, tar and npm lint deps (#2617)` | Production OIDC logic is unchanged; SSH forwarding validation is explicit and stricter. Exact auth/SSH behavior remains required. |
| `d85339d621e0e96697499a9d4c8780ee9b9c1324` | `build(bazel): add credential driver targets (#2649)` | Build graph only for drivers NemoClaw does not select. |
| `8ddd98c3dff62619a3963f99ba1e055b67650e72` | `feat(bazel): build vm driver and pull runtime from Github (#2650)` | Makes the VM target buildable; NemoClaw continues to select exactly Docker or Podman. |

The 170-path delta was dispositioned by producer and consumer rather than by filename count:

| Path class | Reviewed paths | Disposition |
| --- | --- | --- |
| Credential configuration, runtime, and provider state | `crates/openshell-core/src/config.rs`, `crates/openshell-server/src/config_file.rs`, `credentials.rs`, `grpc/provider.rs`, `provider_refresh.rs`, `inference.rs`, `lib.rs`, and credential proto/data-model changes | Material default-store, handle, redaction, refresh, legacy-inline, transaction, and cleanup contracts are represented in `OS101-I04` through `OS101-I09`. |
| Credential store and external drivers | `crates/openshell-driver-db-credstore/`, `openshell-driver-kubernetes-secrets/`, `openshell-driver-vault/`, Helm templates/values/tests, and Kubernetes E2E support | The database store is the omitted-field default. Kubernetes, Vault, and UDS-backed external drivers remain unselected. |
| CLI, TUI, and server RPC propagation | CLI provider/run tests, `crates/openshell-tui/src/lib.rs`, `grpc/auth_rpc.rs`, `grpc/policy.rs`, `grpc/sandbox.rs`, `grpc/validation.rs`, and server integration tests | Credential handles propagate and displayed values remain redacted. Sandbox/validation edits do not change the inherited runtime-identity contracts. |
| Go SDK | `sdk/go/`, generated Go proto files, `buf.yaml`, and Go task/build configuration | New but wholly unconsumed by NemoClaw. |
| Egress adapter proposal | `rfc/0005-sandbox-proxy-egress-adapter/` | Documentation only; no executable producer exists. |
| Supervisor transport | `crates/openshell-supervisor-middleware/src/remote.rs` | Material HTTP/2 keepalive delta assigned only to `#8601`. |
| Authentication, SSH, archives, and lint dependencies | `crates/openshell-server/src/auth/oidc.rs`, `crates/openshell-supervisor-process/src/ssh.rs`, Cargo/npm locks, and lint tooling | OIDC production selection is preserved with stronger RS256 tests; loopback forwarding validation is explicit; no new NemoClaw consumer is introduced. |
| VM and Bazel release graph | `crates/openshell-driver-vm/BUILD.bazel`, `bazel/vm-runtime/`, `bazel/vm_runtime.bzl`, sandbox/network/VFIO Bazel targets, and release targets | VM becomes buildable but remains outside the exact Docker/Podman selection. |
| CI, documentation, banner, and repository tooling | OpenShell workflows, contributor/architecture/reference docs, banner assets, mise tasks, and build metadata | No NemoClaw runtime producer or consumer; reviewed for hidden selector, install, or execution changes and none were found. |

The following inherited contract producers are byte-unchanged from v0.0.99 to v0.0.101:
the Docker driver, Podman container and driver sources, shared driver utilities, CLI SSH source,
Google Cloud child-environment source, provider-credential key source, secrets source, and compute
driver dispatch. Their live evidence is still required; source stability is not a test waiver.

## Invariant, Producer, Consumer, and Proof Inventory

This table is the authoritative v0.0.101 contract inventory. “Producer” names the upstream state or
behavior that creates the value. “Consumer” names the NemoClaw code that relies on it. A static
review can establish selection and source shape, but every live row remains conditional on the
listed qualification owner.

| ID | Invariant | Upstream producer | NemoClaw consumer | Required evidence and owner |
| --- | --- | --- | --- | --- |
| `OS101-I01` | The reviewed source is exactly `v0.0.101` commit `8ddd98c3dff62619a3963f99ba1e055b67650e72`, descended from the reviewed 0.0.85 and 0.0.99 commits. | OpenShell Git tags and commit graph. | Version selectors and release trust consumers owned outside this issue. | Independent source/release identity handoff from `#8598`; base-trusted enforcement from `#8600`. |
| `OS101-I02` | Every consumed archive, formula, extracted executable, supervisor index, and platform manifest resolves to the independently reviewed v0.0.101 release identity. | OpenShell release publication and container registry. | Installer, manifest, blueprint, and workflow selectors. | Final `#8598` identity/trust set at correction `6ace3b8d657d3d65589d9ce61fe4672400f30955`; trust prerequisite satisfied. Later selector receipt/coherence remains owned by `#8600`. |
| `OS101-I03` | NemoClaw selects exactly one compute driver, `docker` or `podman`; it never selects `vm`. | `crates/openshell-core/src/config.rs` and the OpenShell driver registry. | `src/lib/onboard/docker-driver-gateway-config.ts` and `src/lib/onboard/docker-driver-gateway-env.ts`. | Behavioral TOML contract test here; exact runtime identity/coherence proof in `#8604`. |
| `OS101-I04` | Omitting external credential drivers does not disable credential storage. It selects OpenShell's default encrypted database credential store. An explicit empty `credential_drivers = []` is rejected. | `crates/openshell-core/src/config.rs:779-807`, `crates/openshell-server/src/config_file.rs:306-316`, and `crates/openshell-server/src/credentials.rs:617-633,857-883`. | NemoClaw gateway TOML generation, which emits neither `credential_drivers` nor `credential_storage`. | Static selection test here; creation, restart, retry, diagnostics, and cleanup proof in `#8602`. |
| `OS101-I05` | The default store keeps a 32-byte owner-only KEK, random handles and DEKs, AES-256-GCM ciphertext, and AAD bound to credential identity. | `crates/openshell-driver-db-credstore/src/lib.rs:444-773`. | Provider creation/update/refresh/delete reached through NemoClaw inference and MCP flows. | Wrong-key/plaintext-negative, restart, update, refresh, delete, and cleanup evidence in `#8602`. |
| `OS101-I06` | Provider APIs reject user-supplied handles, return redacted values, and use handle-backed storage for new or touched credentials. | `crates/openshell-server/src/grpc/provider.rs:38-53,142-231,330-460`. | Inference configuration and MCP provider operations. | Provider ownership, redaction, duplicate/retry, and crash-consistency evidence in `#8602`. |
| `OS101-I07` | A direct 0.0.85 or 0.0.99 upgrade preserves legacy inline credentials. Untouched legacy keys are not falsely reported as migrated; new or touched keys become handle-backed. | `crates/openshell-server/src/grpc/provider.rs:920-1015` and `crates/openshell-server/src/inference.rs:1153-1192`. | Upgrade/rebuild state and provider consumers. | Direct public-upgrade, restart, and mixed inline/handle evidence in `#8602` and recovery continuity in `#8605`. |
| `OS101-I08` | Credential update/refresh cleanup is transactional around CAS, but a gateway crash after CAS and before finish can leave an unreachable encrypted handle. It must not become visible or reusable. | `crates/openshell-server/src/grpc/provider.rs:676-825` and `crates/openshell-server/src/provider_refresh.rs:510-665`. | Gateway restart/retry, diagnostics, and provider lifecycle. | Crash injection, retry, no-plaintext/no-cross-provider reuse, and bounded cleanup diagnostics in `#8602`; no waiver for the upstream orphan window. |
| `OS101-I09` | Child-visible credential key classes are unchanged from v0.0.99 and no runtime-control key becomes user authority. | `crates/openshell-core/src/google_cloud.rs`, `provider_credentials.rs`, and `secrets.rs`. | `src/lib/subprocess-env.ts`, `src/lib/actions/sandbox/mcp-bridge-validation.ts`, and `agents/hermes/mcp-config-transaction.py`. | Regenerated v0.0.101 manifest and digest contract here; live child-boundary and policy proof in `#8602`. |
| `OS101-I10` | The new Kubernetes, Vault, and UDS credential drivers are not configured. Their identities, sockets, namespaces, tokens, commands, and mounts are not added to NemoClaw. | OpenShell credential driver registry and new driver crates. | Gateway TOML and managed environment allowlist. | Absence contract here plus runtime config/mount/egress negatives in `#8602`. |
| `OS101-I11` | The new Go SDK is not linked, imported, invoked, or exposed by NemoClaw. | `sdk/go/`. | NemoClaw CLI, plugin, agents, and images. | Component-coherence and image/runtime negative proof in `#8602`. |
| `OS101-I12` | RFC 0005 adds no executable egress adapter; NemoClaw's existing network-policy producers remain authoritative. | `rfc/0005-sandbox-proxy-egress-adapter/`. | NemoClaw policy composition and MCP bridge restrictions. | Policy/credential and egress-negative evidence in `#8602`. |
| `OS101-I13` | Supervisor middleware uses a 5-second connect timeout, 10-second HTTP/2 keepalive interval, 20-second timeout, keepalive while idle, and adaptive windows without bypassing policy. | `crates/openshell-supervisor-middleware/src/remote.rs:18-39`. | Long-lived inference/MCP connections through the managed supervisor. | Idle, reconnect, long-running, and proxy/policy-path proof in `#8601`. |
| `OS101-I14` | The russh update accepts loopback forwarding and rejects non-loopback or out-of-range targets; OIDC RS256 validation still rejects tampering, wrong keys, expiry, issuer, audience, and `kid` mismatches. | `crates/openshell-supervisor-process/src/ssh.rs:300-404` and `crates/openshell-server/src/auth/oidc.rs`. | NemoClaw SSH alias transport and authenticated gateway operations. | Runtime identity/SSH evidence in `#8604`; authenticated policy/credential operations in `#8602`. |
| `OS101-I15` | Docker recreation retains the root supervisor, Docker working directory `/`, exact `--workdir /sandbox` supervisor arguments, explicit `sandbox:sandbox` process policy, and the effective `/sandbox` home, workload working directory, and Landlock root. At the exact NemoClaw startup boundary, it omits only `OPENSHELL_OCI_IMAGE_USER` so OpenShell does not change the protected `/sandbox` owner. Podman contracts remain unchanged. | OpenShell commit `537805568d8ebed1f057e035e09dbc4a71976d2c` uses OCI image-user metadata presence to prepare the default working directory. The producer is byte-unchanged from v0.0.99 to v0.0.101. | Managed bootstrap, ownership resolution, privileged execution, SSH host resolution, and Podman adapter. | Focused metadata and replacement-delta tests plus historical OpenClaw and Hermes Shields restart evidence in `#8662`; that lane and posture are retired, while rootless Podman proof remains in `#8603`. |
| `OS101-I16` | Upgrade, deletion convergence, activation, restart, rebuild, rollback journal, and same-name isolation preserve source state and never reuse ambiguous ownership. | OpenShell gateway lifecycle plus the inherited 0.0.99 behavior. | NemoClaw upgrade preflight/recovery and managed lifecycle. | Clean and direct 0.0.85 upgrades, recovery injection, and same-name isolation in `#8605`. |

## Credential and Security Verdicts

### Escaped Default Workspace Ownership Finding

OpenShell commit `537805568d8ebed1f057e035e09dbc4a71976d2c` made the OCI image working directory part of process identity preparation.
When `OPENSHELL_OCI_IMAGE_USER` is present, OpenShell changes `/sandbox` ownership to the policy-selected process identity before it exposes SSH and starts the workload.
NemoClaw's explicit policy selected `sandbox:sandbox`, but the then-supported, now-retired Shields-up posture required `/sandbox` to remain `root:sandbox` with mode `1775`.
The ownership change historically caused OpenClaw and Hermes startup to fail after a Shields-up stop and start.

The reviewed compatibility path applies only to Docker recreation that has all of these properties:

- root supervisor user `0`;
- Docker working directory `/`;
- entrypoint `/opt/openshell/bin/openshell-sandbox`;
- empty arguments or the exact `--workdir /sandbox` arguments;
- label `openshell.ai/managed-by=openshell`; and
- a `nemoclaw-start` workload command.

At that boundary, NemoClaw omits only `OPENSHELL_OCI_IMAGE_USER`.
It preserves empty `OPENSHELL_SANDBOX_UID` and `OPENSHELL_SANDBOX_GID` entries.
The explicit OpenShell policy remains the workload process-identity authority.
The correction therefore preserves `/sandbox` as the home, working directory, and Landlock root without triggering this OpenShell ownership change.
The compatibility helper preserves the legacy state when all three identity entries are absent.
When any entry is present, an incomplete, duplicate, or unexpected metadata shape stops recreation before the replacement workload starts.

### Default Storage Is Active, Not Disabled

The reviewed NemoClaw target configuration for OpenShell v0.0.101 selects no external credential
driver, Go SDK, egress adapter, or VM compute driver. OpenShell's default encrypted database
credential store is active when external credential drivers are omitted; qualification must prove
its key lifecycle, handle-backed provider behavior, migration, restart, retry, cleanup,
child-visible boundary, and diagnostics do not expand credentials, egress, privileges, mounts, or
compute-driver access.

This is a security finding and evidence requirement, not a compatibility exception. Writing an
explicit empty driver list would fail OpenShell configuration validation and is not a valid way to
disable the feature.

### Handle and Migration Behavior

New provider credentials are stored behind opaque handles and returned values are redacted.
Updates use compare-and-swap state transitions. Refresh stages new handles, validates them, and
cleans staged handles on validation or CAS failure. The source contains a known crash window after
successful CAS and before finish cleanup where replaced or removed handles can remain orphaned in
the encrypted store. The orphan must remain unreachable and encrypted, and qualification must
exercise restart/retry and diagnostics around that window.

OpenShell v0.0.101 accepts legacy inline provider credentials. It does not perform an automatic
wholesale at-rest migration at startup. A correct upgrade therefore proves three different states:

1. old inline state survives the upgrade;
2. newly created or touched keys transition to handle-backed encrypted storage; and
3. untouched keys are neither lost nor falsely claimed to have migrated.

### Other Upstream Security Surfaces

- Kubernetes and Vault drivers contain ownership, namespace, path, token, and timeout checks; UDS
  drivers require absolute paths and bounded startup/socket handling. They remain unselected, so
  NemoClaw must not add their configuration, sockets, commands, mounts, or egress.
- The Go SDK is a new client library with no NemoClaw producer or consumer.
- RFC 0005 is documentation only; it cannot justify a runtime egress path.
- The VM target is newly buildable and release-visible, but the generated gateway configuration
  still selects exactly Docker or Podman.
- The russh change makes forwarding acceptance explicit and rejects non-loopback and invalid-port
  requests. The jsonwebtoken update changes the cryptographic backend while adding real RS256
  positive and negative tests; production OIDC selection logic is unchanged. The tar update does
  not alter a reviewed NemoClaw contract.

The escaped v0.0.99 default workspace ownership regression is recorded above.
No additional critical or high source-level regression was found in the v0.0.99-to-v0.0.101 range.
That verdict remains conditional on the exact live evidence above.
It does not establish that an unselected surface can be enabled without a new review.

## Regenerated Child-Visible Credential Manifest

`src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.101.json` was generated as a new
manifest from the detached v0.0.101 source; it was not created by renaming the v0.0.99 file. The
reproducible review method was:

1. resolve `v0.0.101^{commit}` and require
   `8ddd98c3dff62619a3963f99ba1e055b67650e72`;
2. inspect the exact Git blobs for `google_cloud.rs`, `provider_credentials.rs`, and `secrets.rs`;
3. enumerate raw child values, rewritten child values, runtime-control keys, and
   runtime-control prefixes from those sources and from the three downstream sanitizers;
4. record each upstream blob identity and SHA-256 plus each downstream source SHA-256 in the new
   manifest; and
5. compare the resulting arrays with the v0.0.99 manifest only after generation.

The three upstream source files are byte-identical between v0.0.99 and v0.0.101. Consequently the
generated arrays are unchanged: 8 raw child-value keys, 3 rewritten child-value keys, 52 exact
runtime-control keys, and 24 runtime-control prefixes. The new manifest remains review evidence;
issue `#8606`, not this review, owns changing active consumers.

## Inherited 0.0.99 Concern Ledger

All 23 concerns from the 0.0.99 review remain applicable to the direct 0.0.85-to-0.0.101 user
upgrade. Each concern has one evidence owner. The existing middleware/egress concern `OS99-05`
stays with `#8602`; the new HTTP/2 keepalive delta is separately owned by `#8601`.

| ID | Inherited invariant | NemoClaw producer/consumer and focused evidence | Evidence owner |
| --- | --- | --- | --- |
| `OS99-01` | Release/tag substitution is fail-closed. | Independent identities from `#8598`; base-trusted descriptor and receipt from `#8600`. | `#8602` |
| `OS99-02` | Child credential key classes do not expand or leak. | New v0.0.101 manifest; `mcp-bridge-input-validation.test.ts`, `mcp-provider-ownership.test.ts`, and live MCP evidence. | `#8602` |
| `OS99-03` | Policy-first OCI image identity remains exact. | Managed bootstrap image reference/content-ID checks and `docker-spec.test.ts`. | `#8604` |
| `OS99-04` | Workspace metadata grants no new authority. | Ownership resolver and workspace-qualified identity tests. | `#8604` |
| `OS99-05` | Optional supervisor middleware/egress is not implicitly enabled. | Gateway config absence plus policy/MCP live negatives. | `#8602` |
| `OS99-06` | Corporate proxy and consolidated egress retain endpoint and allowed-IP checks. | `personal-open-internet-policy.test.ts`, policy composition, and live MCP policy proof. | `#8602` |
| `OS99-07` | Pending allowed-IP proposals are not effective policy. | Policy state and MCP bridge negative paths. | `#8602` |
| `OS99-08` | Listener/readiness lifecycle converges before use. | Managed start/stop/rebuild health and `openshell-gateway-upgrade-workflow-boundary.test.ts`. | `#8605` |
| `OS99-09` | Docker activation spec normalizes only reviewed empty defaults. | `docker-spec.test.ts`; non-empty port bindings remain rejected. | `#8604` |
| `OS99-10` | Docker recreation prevents OCI image-user metadata from changing the protected `/sandbox` owner at the exact NemoClaw startup boundary. | `docker-gpu-patch-clone.test.ts`, managed-bootstrap replacement-delta tests, and historical, now-retired Shields restart evidence verify the narrow omission and preserved runtime identity. | `#8662` |
| `OS99-11` | System CA mode is not enabled implicitly. | Policy/CA configuration negatives and exact live policy proof. | `#8602` |
| `OS99-12` | Podman lifecycle remains exact-version qualified. | `podman-cpu-lifecycle.test.ts` and `podman-cpu-proof.yaml`. | `#8603` |
| `OS99-13` | Both reviewed inference status headings parse without broadening authority. | `parseGatewayInference` regression coverage. | `#8604` |
| `OS99-14` | Sandbox names obey the 19-character and consecutive-hyphen constraints before mutation. | Canonical validation and `upgrade-sandboxes-preflight.test.ts`. | `#8604` |
| `OS99-15` | Docker `Config.Image` is the reviewed manifest reference or its proven immutable content ID. | Managed-bootstrap image resolution and content-ID tests. | `#8604` |
| `OS99-16` | Supervisor argv contains only the reviewed `--workdir /sandbox` tuple or the legacy migration form. | `docker-startup-command-patch.test.ts` and managed launch tests. | `#8604` |
| `OS99-17` | Conflicting overlapping endpoint metadata is rejected before activation. | Policy composition regression tests and live policy proof. | `#8602` |
| `OS99-18` | Docker and Podman identity is workspace-qualified and bound to trusted labels and full IDs. | `sandbox-container-owner.test.ts`, `privileged-exec.test.ts`, and lifecycle identity tests. | `#8604` |
| `OS99-19` | Podman uses only the prepared absolute rootless socket. | `socket-authority.test.ts`, gateway environment/runtime tests, and live Podman proof. | `#8603` |
| `OS99-20` | Failed status probes cannot reuse a different or ambiguous gateway. | Gateway runtime identity and reuse tests. | `#8604` |
| `OS99-21` | SSH uses only exact captured workspace-qualified or declared legacy aliases. | `sandbox-ssh-host.test.ts` and `snapshot-ssh-host.test.ts`. | `#8604` |
| `OS99-22` | Sandbox execution has effective non-root identity and required proxy namespace tooling. | Runtime identity tests and exact Docker/Podman live activation. | `#8604` |
| `OS99-23` | Delete success is followed by bounded explicit absence convergence before recreation. | `upgrade-sandboxes-recovery.test.ts` and injected live recovery. | `#8605` |

## Qualification Contract

Issue `#8600` owns the accepted descriptor path
`ci/openshell-0.0.101-qualification-v1.json` and trusted orchestration workflow
`.github/workflows/openshell-0.0.101-qualification.yaml`. The underlying live evidence continues
to run through `.github/workflows/e2e.yaml`; rootless Podman also uses
`.github/workflows/podman-cpu-proof.yaml`. Its receipt source binds the exact job display name
`Rootless Podman CPU lifecycle with Docker disabled` with `aggregation: all`; the YAML job ID
`podman-cpu-lifecycle` is navigation only.

At scaffold time, only the controlled Podman selector can point at existing executable evidence.
Every other selector remains explicitly pending with no source until its child owner lands the
required case. Pending or missing source state is non-qualifying and must fail closed.

The full accepted selector set is exactly:

1. `openshell-00101-docker-clean-install`
2. `openshell-00099-to-00101-docker-upgrade`
3. `openshell-00085-to-00101-docker-upgrade`
4. `openshell-00101-rootless-podman-controlled`
5. `openshell-00101-rootless-podman-clean-install`
6. `openshell-00099-to-00101-rootless-podman-upgrade`
7. `openshell-00085-to-00101-rootless-podman-upgrade`
8. `openshell-00101-keepalive`
9. `openshell-00101-policy-credentials`
10. `openshell-00101-credential-store-lifecycle`
11. `openshell-00101-component-coherence`
12. `openshell-00101-runtime-identity`
13. `openshell-00101-upgrade-recovery`
14. `openshell-00101-same-name-isolation`

The exact final acceptance subset contains 11 selectors:

1. `openshell-00101-docker-clean-install`
2. `openshell-00085-to-00101-docker-upgrade`
3. `openshell-00101-rootless-podman-clean-install`
4. `openshell-00085-to-00101-rootless-podman-upgrade`
5. `openshell-00101-keepalive`
6. `openshell-00101-policy-credentials`
7. `openshell-00101-credential-store-lifecycle`
8. `openshell-00101-component-coherence`
9. `openshell-00101-runtime-identity`
10. `openshell-00101-upgrade-recovery`
11. `openshell-00101-same-name-isolation`

The two v0.0.99 upgrade selectors and controlled Podman selector remain useful development evidence,
but they are not substitutes for the final clean and direct-public-v0.0.85 paths.

## Compatibility Correction Assignments

The original review made the following recommendations and implemented none of them.
Each original correction remains assigned to one child issue.
Issue `#8662` owns only the later escaped working-directory correction and does not change these assignments.

| Correction | Required correction | Sole implementation owner |
| --- | --- | --- |
| `OS101-C01` | Qualify the exact HTTP/2 keepalive, idle-channel, reconnect, long-running, and policy-path behavior. | `#8601` |
| `OS101-C02` | Qualify default encrypted credential storage, legacy/handle migration, key and cleanup lifecycle, policy/egress negatives, child visibility, and component coherence. | `#8602` |
| `OS101-C03` | Qualify rootless Podman clean install and direct 0.0.85 upgrade with the prepared socket and no Docker fallback. | `#8603` |
| `OS101-C04` | Qualify exact runtime identity, full IDs, labels, aliases, supervisor argv/workdir, image identity, non-root execution, and VM non-selection. | `#8604` |
| `OS101-C05` | Qualify Docker clean install and direct 0.0.85 upgrade, deletion convergence, rollback/retry, interruption recovery, and same-name isolation. | `#8605` |

## Final Acceptance Checklist

- The final `#8598` handoff at correction `6ace3b8d657d3d65589d9ce61fe4672400f30955`
  binds the formula, standalone sandbox digest-to-version map, every checksum manifest, and
  supervisor identity in base-trusted code; this prerequisite is satisfied.
- The `#8600` descriptor and trusted workflow contain the exact 14-selector set and require the
  exact 11-selector final subset.
- The v0.0.101 child-visible credential manifest retains its reviewed source identities and
  downstream digests. Activation is owned by `#8606`.
- Every inherited `OS99-01` through `OS99-23` invariant remains represented by exact-version
  behavior or live evidence.
- The reviewed Docker recreation omits only `OPENSHELL_OCI_IMAGE_USER` at the exact NemoClaw startup boundary and rejects every unreviewed metadata shape.
- Historical acceptance evidence required the now-retired OpenClaw and Hermes Shields lanes to restart successfully under Shields up; those lanes and that posture are not current merge gates.
  The historical OpenClaw lane verified that `/sandbox` remained `1775 root:sandbox` after restart.
- Each `OS101-C01` through `OS101-C05` correction is implemented by only its named owner.
- Clean and direct v0.0.85 upgrade lanes exercise both Docker and rootless Podman. The public
  v0.0.85 path cannot be replaced by a v0.0.99-only upgrade.
- Credential tests distinguish omitted external drivers from disabled storage and distinguish
  untouched inline keys from new or touched handle-backed keys.
- No external Kubernetes, Vault, or UDS credential driver, Go SDK, egress adapter, VM driver, new
  socket, mount, privilege, or network route appears in the resulting runtime. OpenShell's in-tree
  default encrypted database credential driver is active and remains subject to exact `#8602`
  lifecycle and child-visibility evidence.
- Every required evidence result is bound to the commit under review and exact version, concludes
  successfully without skipping, and is authenticated by a base-trusted receipt. An unresolved
  critical or high finding blocks the upgrade.
