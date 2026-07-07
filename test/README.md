<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw test suite

## Local full-suite performance reference (#6245)

This is the dated acceptance snapshot for the work that restored the complete
non-live local test loop to the two-to-five-minute range. It records a
host-specific result, not a permanent performance budget. Product growth,
dependency changes, and different hardware can change the absolute times.

### Measurement method

The final measurement was taken on 2026-07-07 with:

- Linux 6.17.0-1014-nvidia on arm64;
- 20 logical CPUs available to Node;
- Node.js 22.23.1 and npm 10.9.8;
- the normal contributor and CI file-creation mask, `umask 022`;
- code head `45800b3318079d59524239e0f05026c17a5ea0ac` from PR #6420.

The final record-only Markdown commit does not change the measured test code.
`npm test` removed and rebuilt the CLI and plugin artifacts before Vitest ran.
Dependencies were already installed and operating-system page caches were not
dropped, so this is a clean-build measurement rather than a cold-machine
benchmark.

```bash
umask 022
/usr/bin/time -v npm test -- --reporter=blob
/usr/bin/time -p npx prek run --from-ref origin/main --to-ref HEAD --stage pre-commit
```

### Results

| Measurement | Revision | Wall time | Result |
|---|---|---:|---|
| Original full-suite baseline from #6245 | `54f90a023` plus the #6214 candidate | 14:19.65 | 980 files passed, 2 skipped; 11,109 tests passed, 35 skipped |
| Pre-PR full-suite control | `5552a5ba5` | 13:21.17 | Passed |
| Final complete non-live suite | `45800b331` | **3:52.03** | 1,249 files passed, 2 skipped; 13,879 tests passed, 39 skipped, 1 todo |
| Original static/format/policy/security pre-commit phase | #6245 baseline | about 0:30 | Passed before the old coverage hook |
| Original `test-cli` pre-commit hook | #6245 baseline | 11:43 before exit | Failed on a late unrelated flake; not a completed pass |
| Final diff-scoped routine pre-commit stage | `45800b331` | **0:13.95** | Passed |

The final full suite is 73.0% faster than the issue baseline and 71.0% faster
than the same-machine pre-PR control. Over the longer baseline interval, the
passing-test count grew 24.9% and the measured file count grew 27.4%.

PR #6270 intentionally moved full CLI and plugin coverage from routine
pre-commit to the explicit manual gate while retaining authoritative coverage
in CI. The final pre-commit number therefore describes the current routine
contributor gate; `npm test` above remains the complete non-live behavioral
signal.

### Highest-cost file disposition

The initial profile in #6245 identified these six measured hotspots. The
classification distinguishes process launches used only for test isolation
from launches that are themselves part of the contract.

| Initial hotspot | Initial time | Classification | Final disposition |
|---|---:|---|---|
| `test/onboard-selection.test.ts` | 24.2s | Mixed, dominated by unit-shaped subprocesses | #6276, #6336, and #6383 moved decision branches to typed in-process seams while retaining boundary-sensitive witnesses |
| `test/sandbox-connect-inference/route-swap-repair.test.ts` | 21.4s | Mixed lifecycle decisions and real command boundaries | #6280 moved route-state branches in-process and retained CLI, listener, timeout, security, and cross-command contracts |
| `test/gateway-state-reconcile-2276.test.ts` | 19.8s | Mixed reconciliation logic and process contracts | #6280 moved repeated reconciliation decisions in-process and kept representative gateway process behavior |
| `test/generate-openclaw-config.test.ts` | 18.6s | Unit-shaped configuration generation | #6276 and #6339 replaced process isolation with direct typed configuration and policy seams |
| `test/onboard.test.ts` | 18.0s | Mixed orchestration and genuine CLI/shell boundaries | #6276 moved internal decisions in-process and retained fail-closed, Bash, credential, and argv witnesses |
| `test/nemoclaw-start.test.ts` | 16.4s | Genuine shell and startup process contract | Kept process-shaped; focused direct tests cover internal decisions without replacing the real startup boundary |

The later batches applied the same rule beyond the pilot. PRs #6279 and #6282,
along with #6285, #6339, #6342, #6345, #6360, #6369, #6373, #6383, #6411,
and #6417, removed unit-shaped launches or shared safe harnesses while
preserving the boundary cases.

### Representative retained process contracts

The remaining real-process layer includes at least one representative for each
boundary required by #6245:

| Boundary | Representative coverage |
|---|---|
| CLI argv, exit status, and executable discovery | `test/exit-code-user-error-surfaces.test.ts`; `test/package-contract/cli/command-registry.test.ts`; `test/package-contract/cli/public-argv-translation.test.ts` |
| Environment inheritance and secret isolation | `test/rebuild-credential-preflight.test.ts`; `test/secret-redaction.test.ts`; `test/clean-runtime-shell-env-shim.test.ts` |
| Shell, signal, process-group, and supervisor behavior | `test/nemoclaw-start.test.ts`; `test/runner.test.ts`; `test/gateway-supervisor-control.test.ts` |
| Permissions, symlinks, and atomic filesystem replacement | `test/state-dir-guard.test.ts`; `test/nemoclaw-start-perms.test.ts`; `src/lib/adapters/fs/build-context-fingerprint.test.ts` |
| Security and fail-closed behavior | `test/exit-code-user-error-surfaces.test.ts`; `test/package-contract/ssrf-parity.test.ts` |
| Compiled artifact and package behavior | the disjoint `test/package-contract/` project |

The optimization chain did not add blanket retries, timeout increases, or
stale compiled-output reuse. Process-removal PRs #6276, #6279, #6280, #6282,
and #6285 landed before #6286 addressed #6237's hottest loader graph. The
loader work in #6299 and #6388, followed by #6415, then ratcheted remaining
CommonJS loader and cache seams.

PR #6420 is the final scheduling step. Only the canonical local `npm test`
route runs integration files with bounded parallelism. CI, coverage, focused
integration runs, and direct Vitest invocations remain serialized.
