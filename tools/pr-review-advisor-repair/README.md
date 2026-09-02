<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# PR Review Advisor repair

This directory implements the manual Phase 1 flow from [issue #10791](https://github.com/NVIDIA/NemoClaw/issues/10791). A maintainer can bind one already-produced PR Review Advisor result to an exact same-repository PR head, let Pi propose one offline patch, validate that patch independently, and publish a GitHub-verified commit through deterministic code. The workflow is default-disabled, manual-only, and has no automatic trigger.

## Trust boundaries

The `collect` job re-fetches an open, non-draft, maintainer-editable, same-repository PR into `main`; records its author; requires both the original and triggering actors to have maintain or admin permission; verifies the maintainer-supplied exact head SHA and successful `pull_request_target` Advisor run; and requires exactly its context artifact plus all nine specialist artifacts by immutable artifact ID. Finding text, PR metadata, specialist output, and repository contents remain untrusted data. Validation and publication recheck the recorded author and PR identity. The exact head, base, Advisor run and attempt, and sorted selected finding IDs form the attempt identity.

The `claim` job has only read permissions plus `checks: write`. It creates one neutral check run whose external ID is the attempt identity and rejects an existing identical claim. It does not execute PR code, receive a model credential, or publish source changes.

Trusted selection permits only explicitly named source, test, or documentation paths. It excludes workflow, agent-instruction, security-policy, dependency, lockfile, tooling, and E2E paths, along with findings that need credentials, attestations, external mutation, product decisions, DCO, or commit-verification work.

The `repair` job exports the exact PR tree without `.git` metadata or symbolic links. Pi runs once inside an offline OpenShell sandbox with only `read`, `edit`, `write`, `grep`, `find`, and `ls`. It receives no GitHub token, model credential, shell, Git, test runner, package manager, commit capability, or publication tool. Trusted host code compares the returned tree with the original export and creates the Git patch itself. Changes outside the selected exact-path allowlist fail closed.

The `validate` job reconstructs the exact head independently, rechecks that the live PR head and base have not changed, applies the bounded patch with hermetic Git settings, and rejects special Git objects, binary content, dependency/control paths, credential-shaped content, and receipt mismatches. It also refuses any PR whose original diff changes workflows, agent instructions, security policy, dependency inputs, lockfiles, tooling, CI controls, or E2E files. Host code may install only base-controlled dependencies with lifecycle scripts disabled and an explicit public registry. All repository checks then run inside a second pinned, offline OpenShell sandbox with no model or GitHub credential. The candidate checkout is writable, while its `.git` metadata and installed dependency trees are mounted read-only. Validation must not mutate the approved candidate. The job deletes the sandbox and gateway before rechecking the live PR identity and emitting a trusted receipt and validated patch artifact. The patch-containing validation bundle expires after one day; a receipt-only copy remains for 14 days.

The `publish` job is the only source-writing job and is protected by the `advisor-repair-publication` environment. It never receives the model credential or untrusted Advisor artifacts. Trusted code re-parses the selection and validation receipts, reconstructs the validated Git tree, creates a one-parent GitHub commit, waits for GitHub verification, checks that the verified commit still has the exact approved message, tree, and parent, rechecks the live PR, and atomically updates the head with the recorded old OID and `force: false`. It then explicitly dispatches the normal required workflows, CodeQL, and a validation-only Advisor run at the new SHA. The Advisor specialist fetch is independently pinned to that generated head and base. A final read-only job accepts only the required `changes`, `checks`, `commit-lint`, `dco-check`, and `check-hash` contexts plus CodeQL and Advisor runs bound to that exact commit and attempt.

## Maintainer setup and dispatch

Before enabling Phase 1, configure `advisor-repair-publication` as a protected GitHub environment that requires maintainer approval. The workflow's `environment` field selects that environment; it does not configure the repository protection rules. Set the repository variable `ADVISOR_REPAIR_PHASE1_ENABLED` to `true` only after confirming those rules.

Start an attempt through **Automation / PR Review Advisor Repair** with:

- the PR number and its full current head SHA;
- the successful Advisor run ID for that head;
- the accepted product-scope evidence;
- an eligible findings array whose entries follow the `finding` definition in [`selection-input.schema.json`](schemas/selection-input.schema.json); and
- `repository_egress_authorized` set to `true` for this dispatch.

Do not rerun the workflow. A rerun fails closed. A new PR head requires a new maintainer dispatch and creates a different attempt identity.

## Rollout and kill switch

The repository variable `ADVISOR_REPAIR_PHASE1_ENABLED` is the emergency switch. Each dispatch must also set the boolean `repository_egress_authorized` input to explicitly authorize sending repository-derived context to the configured Advisor model endpoint. Repository maintain/admin permission does not imply that data-egress authorization. A disabled switch or missing egress acknowledgment records a disabled attempt receipt and stops before GitHub discovery, artifact download, OpenShell installation, or model use. Every dispatch records both the original and triggering actors without retaining raw finding text. Workflow reruns fail closed after the audit step, and the neutral attempt claim prevents a separate dispatch from repeating the same exact attempt.

- **Phase 1 — protected manual publication:** implemented here behind an explicit exact-head maintainer dispatch, durable one-shot claim, protected environment, atomic publication, and exact-SHA validation.
- **Phase 2 — narrow automatic publication:** intentionally not implemented. It requires a stable repair-root identity that survives head changes, staging evidence for the complete flow, and a separate maintainer decision.

A generated-head CI failure stops the attempt. It does not trigger an automatic revert, retry Pi, or start a second repair attempt.

Local contract tests exercise real Git patch application and tree reconstruction through the deterministic publisher while mocking GitHub authority. That is not the required staging-repository evidence. Keep the kill switch disabled until a staging run proves the verified GitHub commit, atomic branch update, exact-generated-head checks, and absence of a second repair turn.

The accepted maintainer decision on #10791 defines the manual opt-in, eligible finding and path classes, limits, one-shot identity, publisher boundary, and exact-SHA validation. #9774 closed without a stable cross-head repair-root contract, so a new PR head always requires a new manual decision and Phase 2 remains blocked.

The current Advisor artifacts contain nine independent Markdown reviews and native session traces; they intentionally do not contain a combined machine-readable finding ledger or canonical finding IDs. The Phase 1 `findings_json` input is therefore a maintainer-authored exact-head selection, not proof of a canonical open-finding state. Keep the production kill switch disabled until the Advisor emits a deterministic ledger and trusted selection can bind every supplied finding to that ledger and current review-thread state. Do not parse free-form model prose to create that authority.

## Artifacts

Each workflow dispatch can emit:

- `attempt-receipt.json`, including the emergency-switch decision and a digest of the supplied findings;
- `selection.json`, `artifact-manifest.json`, and `repair-context.json`, bound to the live PR and exact Advisor artifacts;
- `proposal.json` and the trusted-host-generated `repair.patch`;
- `validation-receipt.json` and, only after successful validation, `validated.patch`;
- `publication-receipt.json`, including the source head, validated tree, verified commit, branch, and dispatched exact-head workflows.

Downstream jobs consume the exact `artifact-id` outputs from their producers. Artifact names are labels for humans, not trust anchors.

After a stage produces its trusted result, it attempts to append a bounded job summary made only from trusted outcomes, hashes, numeric identities, and counts. The summary never renders finding prose, PR text, branch names, paths, or failure diagnostics supplied by untrusted content. If the summary file cannot be written, the stage logs a fixed warning and continues. Receipts, bound artifacts, and live GitHub state remain the authority.
