<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell 0.0.85 to 0.0.99 Migration Review

> Internal engineering evidence. This file is not part of the public documentation set.

Shields retirement addendum date: September 1, 2026.

Shields was retired from NemoClaw after this review was written. Every Shields reference below is retained as historical evidence of the ownership regression, compatibility correction, and exact-version qualification performed for the OpenShell 0.0.99 migration; none describes a current command, supported runtime posture, live lane, or merge gate. The Docker recreation identity correction, workspace-qualified container authority, exact metadata checks, and mutable runtime lifecycle guarantees remain active independently of the retired Shields ownership transition.

## Status and Decision

This review covers the complete public source boundary from the previously supported OpenShell
`v0.0.85` commit `3dee5570a46076a57a3b056f35f35ebc0861ac85` through the published
`v0.0.99` commit `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032`. The range contains 117
commits and 515 distinct changed paths. Source review, release publication, consumed artifact
identity, credential-boundary review, and NemoClaw runtime qualification are separate gates.

The source and artifact review supports selecting `0.0.99`. Runtime qualification is complete only
after the exact pinned artifacts pass NemoClaw's managed activation and live E2E lanes. The
previously observed `0.0.85` activation mismatch remains part of this upgrade's completion. It is
not a waived unrelated failure.

Historical Shields lifecycle evidence later found an escaped compatibility regression in upstream commit `537805568d8ebed1f057e035e09dbc4a71976d2c`.
When OCI image-user metadata is present, OpenShell prepares its default `/sandbox` working directory by changing the directory owner to the policy-selected process identity.
This preparation runs before OpenShell exposes SSH and starts the workload.
It broke the then-supported, now-retired Shields-up requirement that `/sandbox` remain `root:sandbox` with mode `1775`.

## Audit Method and Exact Boundary

The repository-owned release-ledger collector enumerated every adjacent tag, commit, and changed
path from a full clone of the canonical `NVIDIA/OpenShell` repository. All 14 adjacent source ranges
resolve into the target ancestry. Tags `v0.0.87`, `v0.0.93`, `v0.0.94`, and `v0.0.95` have no
published GitHub release; they are review boundaries, not consumed release artifacts.

| Adjacent range | Commits | Paths | Material review result |
| --- | ---: | ---: | --- |
| `v0.0.85 -> v0.0.86` | 12 | 109 | Policy prover removal, persistent labels, Docker discovery, AWS STS refresh, and supervisor middleware/egress were reviewed. |
| `v0.0.86 -> v0.0.87` | 5 | 12 | Upload symlink handling, Kubernetes naming, and build-tool changes were reviewed. |
| `v0.0.87 -> v0.0.88` | 15 | 169 | TTY exec, GitHub provider behavior, workspace authorization, and inode-specific Landlock rights were reviewed. |
| `v0.0.88 -> v0.0.89` | 9 | 49 | OPA deny reasons and sandbox deletion-event isolation were reviewed. |
| `v0.0.89 -> v0.0.90` | 9 | 24 | Read-only mount ownership and internal-IP policy proposal behavior were reviewed. |
| `v0.0.90 -> v0.0.91` | 3 | 33 | Auth status and explicit proposal-state propagation were reviewed. |
| `v0.0.91 -> v0.0.92` | 11 | 55 | Corporate proxy routing, structured output, L7 validation, and parser hardening were reviewed. |
| `v0.0.92 -> v0.0.93` | 7 | 24 | Listener-before-resume ordering, proxy retry, exec stderr, and Podman shutdown handling were reviewed. |
| `v0.0.93 -> v0.0.94` | 12 | 68 | Policy-first OCI identity, gateway-owned readiness, and host-environment isolation were reviewed. |
| `v0.0.94 -> v0.0.95` | 7 | 107 | IPv6 SSH, workspace authorization, and gateway listener isolation were reviewed. |
| `v0.0.95 -> v0.0.96` | 5 | 38 | Atomic policy notification, OTLP export, and dependency/base-image changes were reviewed. |
| `v0.0.96 -> v0.0.97` | 12 | 144 | Callback listener negotiation, proxy-pipeline consolidation, Podman lifecycle, and nft quoting were reviewed. |
| `v0.0.97 -> v0.0.98` | 3 | 50 | VM tracing and build graph changes were reviewed. |
| `v0.0.98 -> v0.0.99` | 7 | 79 | System CA mode, OCI working-directory support, and TCP_NODELAY were reviewed. |

The complete audited commit set, grouped by adjacent range, is:

- `85->86`: dd3f27c8 077adb79 008193a2 cf4deccd 1a0c1013 fe7135a2 d0961cdb aa483ecb 32f05244 54025517 d70adafe d5567487
- `86->87`: 06062027 98f253b8 1fd4d2b9 8cf2673c 9a4f8a80
- `87->88`: 339eae5a 80987e91 a2cd5f8e a9f71313 f32c46d4 2575585b 9377e0d5 745512e3 ad29ab96 5952a5a2 f1690849 8d9502d9 e9ac0ee6 744a65d5 3ff15a16
- `88->89`: dae92616 472e23f9 bdd1ce87 396a3b7b d35d52d4 8b0e54b2 2d5652b2 ac3d5c96 cbdeb4d5
- `89->90`: fd1d3de8 5432d01d ca318058 cd9a0bf2 7b444bd8 0674a00b 8a14b3a4 541b97f0 1d4ac708
- `90->91`: 75d24688 59f7839f 21da343c
- `91->92`: f7cd9108 b422b678 850bd42e 77e5c322 01daf3a5 deced871 d4cd37be afb462f3 516be602 76a5397e 2d108818
- `92->93`: 39bf94e5 79bcf296 2022d537 0d5e5c53 52f9e9e9 24d491a0 f00ad23a
- `93->94`: 7e9a7f51 b78c8615 efb2d9c2 b1c7ff68 2b7f04fe 7955c830 bc14018c 101cbc97 8d252f47 662dee68 d0f9301c 1221b586
- `94->95`: eb380d71 0cecb542 1cbfc0d5 9c019a93 7f53f78b fe15caa8 df698042
- `95->96`: 28f3bee0 fa242990 02e890cc 596d729e 5541398c
- `96->97`: 1a25439c d220d894 489bb0d5 770d4e6b 905b554c 06c2db75 584f7dbf c42268ba e7533177 736e431d 1959ea19 fde96f04
- `97->98`: 704880e5 0a3ec7a1 83284129
- `98->99`: b9818619 0e9a44cf 4d55265f d063751c 53780556 490f66f4 8c7dd148

## Consumed Release Artifacts

NemoClaw consumes only the published `v0.0.99` release and pins both archive and extracted-binary
identities. Archive SHA-256 values are:

| Artifact | linux-amd64 | linux-arm64 | darwin-arm64 |
| --- | --- | --- | --- |
| CLI | `35725a358e42ef7f0f0393035536da317706b0febcc459a2011e0555f6c2b71c` | `d00cbf0d8779c01ddea6453ead2ad4db3d89a1f14eb6f0785f7919f42813a279` | `e31cac5360e2adf3c971d5742a516626c58acf2fd3db4dcb0e45804def3dc844` |
| Gateway | `640d204dc3c6bc28bffa1f3d870897fc23bbc5ec0151a6c642083e958455cb49` | `3a5d3092ae34356beb0ff2a920f9a87af4233c7a1086a53cd9429d48358f5c09` | `4340619292ecb565f90eb2250db504baa37dd410361b366b42e174d34512cb6c` |
| Sandbox | `84caed3dec4390e0938e89b38b1256d31e8970b4bfd85437bf92ed79f5b1ff05` | `c758e7dc2b8c904baa01e2ccce0f08daf96ede0c648478b23346d8c4dd16f432` | not published |

Extracted binary SHA-256 values are:

| Binary | linux-amd64 | linux-arm64 | darwin-arm64 |
| --- | --- | --- | --- |
| CLI | `5c0dabb90152a3cfae9005731771da99f00a22403080c81952c7be8ba4b5728f` | `9390eac019d2bcabec1cac950ca97982fb3d7bce2560ae00e9c3f237d50b8481` | `578048e527b8fbb6741bbdacd55ac65bf0cb0776964ea8f18cd24cc979a1006f` |
| Gateway | `05bd6c982dd72b73364b91ab694487c026bc56d0cd869f4289b44cc392a5c2ba` | `35c1e1be9c8766de2bfd457e54918d6b2019c16da815ec4c45ce9ebb45aaa571` | `e53b0788d1fdc3e933bb11f13b02c5c1d8c6635bfb3166264558ac3272426113` |
| Sandbox | `a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214` | `f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e` | not published |

The supervisor is pinned by multi-platform index digest
`sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6`;
its amd64 and arm64 child digests are respectively
`sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9`
and `sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38`.

## Credential and Policy Boundary

The reviewed credential sources are `google_cloud.rs`, `provider_credentials.rs`, and
`secrets.rs`. The only credential-relevant behavioral delta is safer expiry handling: expired
provider credentials are skipped and expiry subtraction saturates instead of panicking. The
child-visible credential key classes are unchanged. `OPENSHELL_OCI_IMAGE_USER` is new driver
metadata, is covered by NemoClaw's existing `OPENSHELL_` runtime-control prefix, and is overwritten
by the driver rather than accepted as user authority. The regenerated manifest
`openshell-child-visible-credentials.v0.0.99.json` records the exact target commit.

Policy-first OCI identity, atomic watcher notification, pending internal-IP proposals, callback
listener negotiation, proxy consolidation, Landlock changes, and system CA mode all affect a
security boundary. NemoClaw retains its stricter explicit policy and runtime validation rather
than enabling optional upstream behavior implicitly.

## Downstream Concern Ledger

| ID | Concern | Disposition |
| --- | --- | --- |
| `OS99-01` | Release/tag substitution | Exact source commit, archives, extracted binaries, formula, manifests, and supervisor index are pinned. |
| `OS99-02` | Credential leakage or key-class expansion | Regenerated manifest shows no child-visible key-class expansion; expiry behavior is safer. |
| `OS99-03` | Policy-first OCI image identity | `Config.Image` may contain only the exact reviewed `repository@manifestDigest` or its exact immutable runtime content ID. Separate Docker image-inspect evidence must prove that the reviewed manifest digest resolves to that same content ID. |
| `OS99-04` | Workspace authorization | No NemoClaw authority is inferred from the new workspace model. |
| `OS99-05` | Supervisor middleware/egress | Optional middleware is not enabled by the selector update. |
| `OS99-06` | Corporate proxy and consolidated egress | Existing endpoint and allowed-IP checks remain authoritative. |
| `OS99-07` | Internal allowed-IP proposal state | Pending proposals are not treated as effective policy. |
| `OS99-08` | Listener/readiness lifecycle changes | Managed activation, start, stop, rebuild, and gateway health require live evidence. |
| `OS99-09` | Docker activation spec representation | Attach markers and empty port maps are normalized; non-empty port bindings are rejected. |
| `OS99-10` | OCI working-directory preparation can change the protected `/sandbox` owner before workload startup | The reviewed Docker recreation omits only `OPENSHELL_OCI_IMAGE_USER` at the exact NemoClaw startup boundary. It preserves empty `OPENSHELL_SANDBOX_UID` and `OPENSHELL_SANDBOX_GID`, the explicit `sandbox:sandbox` policy identity, and the `/sandbox` runtime contract. |
| `OS99-11` | System CA root mode | Not enabled implicitly; current CA-policy tests remain required. |
| `OS99-12` | Podman lifecycle changes | Podman exact-version live coverage remains an acceptance gate. |
| `OS99-13` | Inference status heading changed from `Gateway inference:` to `Inference:` | The parser accepts both headings, with focused regression coverage for the exact v0.0.99 output. |
| `OS99-14` | Routable sandbox names are capped at 19 characters and cannot contain consecutive hyphens | NemoClaw's canonical validation enforces both constraints. Before any CLI preparation, backup, gateway retirement, OpenShell install, or sandbox recreation, the installer lists incompatible registered names for the selected gateway and stops. `upgrade-sandboxes --check` lists incompatible names and returns without gateway inspection or rebuild. `upgrade-sandboxes --auto` lists them and exits with a nonzero status before gateway inspection or rebuild. Generated activation names fit the constraint, and exact all-agent activation remains a final acceptance gate. |
| `OS99-15` | The Docker driver records the immutable image content ID in `Config.Image` | Managed bootstrap accepts either the reviewed `repository@manifestDigest` or its exact runtime content ID, while separately requiring Docker to prove that the manifest resolves to that content ID. |
| `OS99-16` | The Docker driver appends `--workdir /sandbox` to the supervisor command | Managed bootstrap requires that exact v0.0.99 supervisor argv. The managed clone preserves only that tuple, or the empty v0.0.85 migration form, and rejects other supervisor arguments before mutation. |
| `OS99-17` | Overlapping endpoint selectors with conflicting connection or request metadata are rejected before policy activation | The OpenClaw baseline npm route remains GET-only in Restricted and temporarily adopts the reviewed npm preset's L4 metadata while that preset is active. An approved baseline exclusion remains absent, and unexpected live drift stops the npm change. Homebrew's overlapping GitHub routes use automatic TLS, and Outlook matches Microsoft Teams' request-body credential-rewrite setting on shared Microsoft endpoints. Focused composition coverage protects each compatibility decision. |
| `OS99-18` | Docker and Podman container identity is workspace-qualified | Podman mutation requires the exact v0.0.99 labels, empty namespace, `default` workspace, full immutable container ID, and matching container name. Privileged Docker lifecycle routing recognizes `openshell-default--<sandbox>-<id>` only when the trusted labels and resolved owner agree; it rejects another workspace qualifier or ambiguous ownership. Final-destroy cleanup scans all OpenShell container names and applies the same resolver to the live sandbox list, so a matching v0.0.99 container or failed Docker probe preserves the gateway. The historical, now-retired Shields live lane discovered its sandbox from the OpenShell management and sandbox-name labels instead of a legacy name prefix. The resolver retains the v0.0.85 forms for migration. |
| `OS99-19` | The Podman gateway must use the prepared rootless socket | The portable gateway writes the normalized absolute socket path into the OpenShell Podman driver configuration. The pinned Ubuntu 26.04 live lane disables Docker and keeps the production `pasta` helper. Before activation, it adds the upstream-recommended `signal (receive) peer=podman,` rule at the packaged profile's expected abstraction boundary and reloads only that AppArmor profile. The workflow fails closed if the profile shape or rule count differs. This preserves AppArmor enforcement while permitting confined Podman to terminate the shared rootless network helper. The lane then verifies `pasta`, authenticated gateway health, sandbox creation, and repeated lifecycle operations. |
| `OS99-20` | A failed v0.0.99 status probe omits the selected gateway name | Gateway reuse scopes the status probe to the requested gateway. It classifies a connection failure as stale only when the requested or reported active gateway matches; other status failures remain non-reusable. |
| `OS99-21` | Sandbox SSH aliases include the workspace | NemoClaw selects only an exact alias declared by the captured OpenShell SSH configuration. It prefers the v0.0.99 default-workspace alias `openshell-<sandbox>.default` and otherwise accepts the exact legacy alias `openshell-<sandbox>`. The upgrade uses that fallback to back up a pre-upgrade sandbox. Wildcard, negated, and unrelated declarations cannot authorize it. |
| `OS99-22` | Sandbox activation requires an effective non-root process identity and proxy namespace tooling | The rootless Podman proof uses the immutable sandbox-base from the NemoClaw v0.0.89 fixture that runs OpenShell v0.0.85, pinned at `sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1`. Exact live activation must prove that it supplies the `ip` prerequisite that v0.0.99 uses before workload startup. The proof also supplies `run_as_user: "1000"` and `run_as_group: "1000"` so activation does not depend on OCI `Config.User`. |
| `OS99-23` | A successful delete can precede v0.0.99 status convergence | Sandbox recreation polls the exact journaled gateway within a bounded interval and continues only after OpenShell explicitly reports the source sandbox absent. Timeouts, transport failures, gateway errors, and ambiguous output do not prove absence. |

An unresolved critical or high concern blocks the upgrade. Test selection cannot waive a concern;
conditional skips and expected failures do not count as qualification evidence.

## Escaped Working Directory Ownership Finding

OpenShell commit `537805568d8ebed1f057e035e09dbc4a71976d2c` made the OCI image working directory part of the process identity preparation path.
For NemoClaw images, the supervisor runs as root while the explicit policy selects the `sandbox:sandbox` workload identity.
The new preparation interpreted `OPENSHELL_OCI_IMAGE_USER` as a request to change `/sandbox` to that identity before the workload started.
The then-supported, now-retired Shields-up startup check rejected startup because the untrusted workload user owned its protected parent directory.

The compatibility correction applies only when the inspected Docker workload matches all reviewed NemoClaw boundaries:

- root supervisor user `0`;
- Docker working directory `/`;
- entrypoint `/opt/openshell/bin/openshell-sandbox`;
- empty arguments or the exact `--workdir /sandbox` arguments;
- label `openshell.ai/managed-by=openshell`; and
- a `nemoclaw-start` workload command.

At that boundary, Docker recreation omits only `OPENSHELL_OCI_IMAGE_USER`.
It preserves empty `OPENSHELL_SANDBOX_UID` and `OPENSHELL_SANDBOX_GID` metadata.
The explicit OpenShell policy continues to select `sandbox:sandbox` for workload processes.
This restores the earlier workspace preparation behavior without changing the `/sandbox` home, working directory, or Landlock contract.
The helper preserves the legacy state when all three identity entries are absent.
When any entry is present, a missing or duplicate entry, an empty OCI user, or a nonempty UID or GID stops recreation before the replacement workload starts.

## The 0.0.85 Activation Failure

The failing activation compared Docker inspect output produced through different clients. The
OpenShell API-created held workload serialized `AttachStdout=false`, `AttachStderr=false`, and
`PortBindings=null`; the Docker CLI-created equivalent serialized `true`, `true`, and `{}`. Those
values are creation-client markers or equivalent empty defaults, not durable workload identity.
NemoClaw now normalizes them before hashing. It still refuses any non-empty port binding because
the managed clone cannot reproduce that behavior exactly. The v0.0.99 held workload also appends
`--workdir /sandbox` to the supervisor command. The managed clone preserves only that exact tuple
or the empty v0.0.85 form and rejects other supervisor arguments before mutation. Unit tests prove
the accepted forms and rejection paths. Exact `0.0.85 -> 0.0.99` live activation remains required.

OpenShell 0.0.99 also validates the complete effective network policy before activation. Several
previously accepted overlaps used incompatible metadata: the OpenClaw baseline and npm preset
selected different TLS/L7 handling for `registry.npmjs.org`; Homebrew conflicted with agent routes
on `github.com` and `raw.githubusercontent.com`; and Microsoft Teams and Outlook disagreed on
request-body credential rewriting for shared Microsoft endpoints. NemoClaw preserves the GET-only
npm baseline in Restricted. While the preset is active, NemoClaw temporarily applies the npm
preset's reviewed L4 metadata to that baseline route and restores the exact baseline on removal.
An approved `npm_registry` baseline exclusion remains absent through both operations. NemoClaw
refuses the change if the live baseline differs from its reviewed GET-only entry, compatibility
overlay, or approved excluded state. Homebrew's overlapping GitHub routes remain plain L4 endpoints
with automatic TLS, while Outlook now matches Microsoft Teams' rewrite setting. The npm baseline
keeps its OpenClaw-only binary scope, but its GET method and path inspection is intentionally
unavailable until npm is removed. The other routes retain their separate binary allowlists and
authorization rules.

## Automated Exact-Head Qualification Gate

The required `check-hash` pull request check runs the OpenShell qualification verifier from the
pull request's base revision. It treats the candidate checkout as inspected data and does not
execute candidate verifier code.

The verifier requires qualification when either side of a changed or renamed path touches one of
these surfaces:

- OpenShell selectors, installer pins, release identities, or trust manifests.
- Agent manifests, blueprint runtime configuration, or credential-boundary manifests.
- Gateway, supervisor, managed activation, command transport, or lifecycle implementation.
- OpenShell E2E workflows, trusted preparation and artifact actions, or qualification code.

An authenticated exact-revision dispatch creates a strict
`nemoclaw-e2e-dispatch-v2` receipt in the trusted main workflow. The workflow uploads the receipt
before candidate checkout or candidate-controlled commands can run. The receipt binds the
repository, pull request, candidate repository and SHA, base SHA, trusted workflow SHA, run ID and
attempt, event, selectors, and optional-runner flags.

The base-trusted verifier derives the baseline and target versions independently from the base and
candidate trees. It then requires the trusted receipt, the matching upgrade fixture, the workflow
run link and ID, and each executed job's successful conclusion. Every default qualification job
must succeed. Before candidate checkout, the trusted controller also pins the complete live-target
and shared-test matrices; candidate planning must reproduce the exact shared-test IDs, files, and
projects. Reviewed condition-only jobs may be skipped when the empty-selector dispatch does not
select them, including Launchable, Jetson, DGX Spark, retired-selector compatibility, reporting,
and scorecard jobs.

Changes that can affect managed activation also require the current head's exact all-agent managed
runtime activation check. Changes that can affect rootless Podman also require the current head's
rootless Podman CPU lifecycle check with Docker disabled.

The gate fails closed for missing, expired, duplicate, or malformed evidence. It also rejects a
stale head or base, a workflow mismatch, nonempty selectors, an unreviewed skipped job, an
incomplete job, or an unsuccessful or cancelled run. A later push changes the head SHA and
invalidates every earlier receipt and proof check.

## Final Acceptance Gates

- All active CLI, blueprint, installer, Brev, workflow, supervisor, and sandbox selectors agree on
  `0.0.99` and exact reviewed identities.
- The `v0.0.99` credential-boundary manifest is the active manifest and its source commit is exact.
- Static checks, focused lifecycle tests, CLI and plugin builds, and documentation checks pass.
- The reviewed Docker recreation omits only `OPENSHELL_OCI_IMAGE_USER` at the exact NemoClaw startup boundary and rejects every unreviewed metadata shape.
- Historical acceptance evidence required the now-retired OpenClaw and Hermes Shields lanes to restart successfully under Shields up; those lanes and that posture are not current merge gates.
  The historical OpenClaw lane verified that `/sandbox` remained `1775 root:sandbox` after restart.
- Default OpenClaw policy composition activates without endpoint-metadata ambiguity while retaining
  the reviewed binary scopes for npm, Homebrew, and pricing traffic.
- Managed Docker and Podman activation, lifecycle, policy, credential, inference, and MCP E2E run
  against the exact pinned release without conditional skips or expected failures.
- Default-workspace SSH access after upgrade uses `openshell-<sandbox>.default`.
  The resolver uses `openshell-<sandbox>` only when the captured configuration declares it and omits the current alias.
- Privileged Docker lifecycle routing accepts `openshell-default--<sandbox>-<id>` only when its
  labels and owner agree.
- The rootless Podman proof uses the immutable NemoClaw v0.0.89 sandbox-base fixture that runs OpenShell v0.0.85.
  It proves the `ip` prerequisite, supplies an explicit non-root process identity, and activates every registered agent against OpenShell v0.0.99.
- Sandbox recreation continues only after the exact journaled gateway explicitly reports the
  source sandbox absent within the bounded convergence interval.
- On a supported host that starts with no NemoClaw state, the activation lane creates the `0.0.85`
  state and completes its `0.0.99` transition, including the previously failing Docker-spec comparison.
