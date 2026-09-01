<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# PR Review Advisor repair

This directory implements Phase 0 of [issue #10791](https://github.com/NVIDIA/NemoClaw/issues/10791): an explicitly dispatched, default-disabled experiment that can turn already-produced PR Review Advisor feedback into a patch and validate that patch without publishing it. Phase 0 has no publisher job, no repository write permission, and no automatic trigger.

## Trust boundaries

The `collect` job re-fetches an open, non-draft, same-repository PR into `main`; binds the attempt to its exact head and base SHAs; verifies the successful `pull_request_target` Advisor run; and requires exactly its context artifact plus all nine specialist artifacts by immutable artifact ID. Finding text, PR metadata, specialist output, and repository contents remain untrusted data. Because #9774 has not supplied stable finding identities, Phase 0 accepts provisional finding IDs only through the manual dispatch and records that limitation in `selection.json`.

Trusted selection permits only explicitly named source, test, or documentation paths. It excludes workflow, agent-instruction, security-policy, dependency, lockfile, tooling, and E2E paths, along with findings that need credentials, attestations, external mutation, product decisions, DCO, or commit-verification work.

The `repair` job exports the exact PR tree without `.git` metadata or symbolic links. Pi runs once inside an offline OpenShell sandbox with only `read`, `edit`, `write`, `grep`, `find`, and `ls`. It receives no GitHub token, model credential, shell, Git, test runner, package manager, commit capability, or publication tool. Trusted host code compares the returned tree with the original export and creates the Git patch itself. Changes outside the selected exact-path allowlist fail closed.

The `validate` job reconstructs the exact head independently, rechecks that the live PR head and base have not changed, applies the bounded patch with hermetic Git settings, and rejects special Git objects, binary content, dependency/control paths, credential-shaped content, and receipt mismatches. It also refuses a PR head that changed dependency manifests, lockfiles, or project npm configuration relative to the recorded base. Host code may install only those base-controlled dependencies with lifecycle scripts disabled and an explicit public registry. All repository checks then run inside a second pinned, offline OpenShell sandbox with no model or GitHub credential. The candidate checkout is writable, while its `.git` metadata and installed dependency trees are mounted read-only. Validation must not mutate the approved candidate. The job deletes the sandbox and gateway before rechecking the live PR identity and emitting a trusted receipt and validated patch artifact; it does not commit, push, comment, approve, or rerun Pi.

## Rollout and kill switch

The repository variable `ADVISOR_REPAIR_PHASE0_ENABLED` is the emergency switch. Anything other than the exact value `true` records a disabled attempt receipt and stops before GitHub discovery, artifact download, OpenShell installation, or model use. Every dispatch records both the original and triggering actors without retaining raw finding text. GitHub workflow reruns also fail closed after the audit step, so an incomplete run cannot silently start a second Pi turn; a maintainer must make a new explicit dispatch. Selection, proposal, and validation receipts preserve the identities needed for audit. Durable deduplication across separate dispatches is not claimed until the opt-in and #9774 identity decisions are accepted.

- **Phase 0 — patch only:** Pi generates one candidate; trusted code validates it; artifacts are retained; nothing is pushed.
- **Phase 1 — protected publication:** a future publisher may be added only after maintainer approval and must run behind a protected GitHub environment. It is not implemented here.
- **Phase 2 — narrow automatic publication:** automatic publication may be considered only after staging proves the complete flow and maintainers approve a narrow finding/path allowlist. It is not implemented here.

Any future generated-head CI failure must stop the attempt. It must not trigger an automatic revert, retry Pi, or start a second repair attempt.

Four product decisions remain prerequisites for Phase 1 or Phase 2: the durable opt-in signal, production-eligible finding and path classes, the stable finding identity contract from #9774, and the exact-SHA required-CI mechanism for bot-generated commits. Until those decisions are accepted and `needs:design` is removed from #10791, this implementation remains Phase 0 only.

## Artifacts

Each workflow dispatch can emit:

- `attempt-receipt.json`, including the emergency-switch decision and a digest of the supplied findings;
- `selection.json`, `artifact-manifest.json`, and `repair-context.json`, bound to the live PR and exact Advisor artifacts;
- `proposal.json` and the trusted-host-generated `repair.patch`;
- `validation-receipt.json` and, only after successful validation, `validated.patch`.

Downstream jobs consume the exact `artifact-id` outputs from their producers. Artifact names are labels for humans, not trust anchors.
