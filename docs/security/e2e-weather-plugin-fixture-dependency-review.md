<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Weather Plugin Fixture Dependency Review

Review date: 2026-07-08

Scope: `test/e2e/fixtures/plugins/weather/package-lock.json` and the secret-free OpenClaw custom-plugin lifecycle regression lane.

## Checked-in Fixture Waiver

The following fixture lockfile is intentionally committed and covered by this review:

- `test/e2e/fixtures/plugins/weather/package-lock.json`

The fixture reproduces a real, version-matched OpenClaw plugin build.
Its lockfile must remain committed so the release-matched peer and development dependency graph is deterministic; generating the lockfile during E2E would allow registry state to change the build without a repository diff.
Automated dependency updates are not enabled for this fixture because its OpenClaw version must move with NemoClaw's reviewed runtime pin rather than independently.

This waiver is limited to test fixture code.
It does not waive review for production dependencies, and it must be revalidated whenever the fixture manifest or lockfile changes.

## Accepted Residual Risk

Registry packages can later be found vulnerable or compromised, and downloaded package code still participates in fixture compilation and the test plugin runtime despite integrity verification and lifecycle-script suppression.
The accepted residual risk is limited to this secret-free E2E lane with read-only contents permission and must be reconsidered on every fixture manifest or lockfile change.
The release-matched `openclaw@2026.5.27` development graph currently has known advisories, but upgrading it independently would stop this fixture from testing the documented NemoClaw `v0.0.71` runtime contract.

## Compensating Controls

- `typebox`, `openclaw`, and `typescript` use exact installed versions in `package.json`; the OpenClaw peer range expresses runtime compatibility but is not the lockfile's install selector.
- The committed npm lockfile records registry integrity for the resolved dependency graph.
- Every fixture install uses `npm ci --ignore-scripts`; the Docker build also uses `--no-audit --no-fund` and prunes development and peer dependencies before staging the plugin.
- The image build fails if a private `node_modules/openclaw` remains, then verifies that OpenClaw creates the expected link to the stock global runtime.
- The GitHub Actions job has read-only `contents` permission, uses full-SHA-pinned actions, and disables checkout credential persistence.
  Trusted runs use Docker Hub credentials only to pre-pull the digest-pinned builder image; the workflow then removes Docker auth, and the release-pinned fixture execution receives no repository secrets or Docker credential environment variables.
- The historical NemoClaw `v0.0.71` exercise uses that tagged CLI's onboarding preflight as its OpenShell compatibility boundary instead of applying current-release capability markers to the older stack.
- The lane is isolated to deterministic test data and uploads only its path-scoped E2E artifact directory.

## Advisory Audit

Run from `test/e2e/fixtures/plugins/weather`:

```bash
npm audit --package-lock-only --ignore-scripts --json
```

Revalidated on 2026-07-08: npm audit exited `1` and reported 9 vulnerable packages (3 moderate and 6 high; 0 info, low, or critical) across 374 total dependencies.
The affected packages are `@earendil-works/pi-coding-agent`, `@openclaw/fs-safe`, `hono`, `linkify-it`, `markdown-it`, `openclaw`, `protobufjs`, `tar`, and `undici`.
The point-in-time advisory set is GHSA-22p9-wv53-3rq4, GHSA-2gcr-mfcq-wcc3, GHSA-35p6-xmwp-9g52, GHSA-38rv-x7px-6hhq, GHSA-3hrh-pfw6-9m5x, GHSA-6v5v-wf23-fmfq, GHSA-7v5m-pr3q-6453, GHSA-88fw-hqm2-52qc, GHSA-94rc-8x27-4472, GHSA-9c3v-684m-579c, GHSA-f38q-mgvj-vph7, GHSA-f577-qrjj-4474, GHSA-g8m3-5g58-fq7m, GHSA-j6c9-x7qj-28xf, GHSA-jfgx-wxx8-mp94, GHSA-mqxh-6gq7-558m, GHSA-p88m-4jfj-68fv, GHSA-pr7r-676h-xcf6, GHSA-r95r-rj6r-c39x, GHSA-rv63-4mwf-qqc2, GHSA-vmf3-w455-68vh, GHSA-vmh5-mc38-953g, GHSA-vxpw-j846-p89q, GHSA-wcpc-wj8m-hjx6, GHSA-wgpf-jwqj-8h8p, GHSA-wwfh-h76j-fc44, and GHSA-xrhx-7g5j-rcj5.
The advisories are in the release-pinned OpenClaw development graph; the Docker build suppresses lifecycle scripts and prunes development and peer dependencies before copying the plugin into the runtime image.
The reviewed lockfile has SHA-256 `1fa44d136d4bf5396f592dbf901da2c43740b38f1ebe52d23efc01ca0ba6f3da`, and every non-root package entry records both its resolved registry URL and integrity value.

The audit is a point-in-time advisory check, not a substitute for the exact lockfile, lifecycle-script suppression, or secret-free workflow boundary.
Rerun it whenever `package.json` or `package-lock.json` changes and again before merge if npm advisory state changes.

## Enforcement and Removal

`test/e2e-fixture-dependency-review.test.ts` fails if any committed `test/e2e/fixtures/**/package-lock.json` is absent from this review and binds the weather fixture to the controls above.
Remove this waiver when the fixture is deleted or when repository-wide automated dependency review explicitly covers E2E fixture lockfiles while preserving the release-matched OpenClaw pin.
