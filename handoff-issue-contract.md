<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Issue closure contract for #10369 and #10386

## Scope authority

- The current maintainer handoff groups #10369 and #10386 and requires one complete macOS upgrade and install fix. It requires safe legacy OpenShell gateway retirement and a version-specific trusted Homebrew formula checksum. This direction establishes the accepted scope for this implementation.
- #10369 is open, assigned to `yimoj`, and has the `NV QA` and `UAT` labels. #10386 is open and has the `NV QA` label. Neither issue has a linked implementation PR or existing PR review feedback as of 2026-08-27.

## Reporter workflow and environment

### #10369: split-version upgrade

Source: #10369 body and reporter comments.

- Platform: two Apple Silicon macOS machines, arm64, Node.js 23.10.0, npm 11.3.0, Docker through Colima 27.x.
- Baseline: NemoClaw v0.0.90 with OpenShell 0.0.85 and at least one onboarded sandbox.
- Reporter workflow:
  1. Run `curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=v0.0.90 bash` on a fresh macOS host and onboard a sandbox.
  2. Confirm `openshell --version` reports 0.0.85.
  3. Run `curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=v0.0.114 bash`.
  4. Inspect the OpenShell gateway retirement result and command status, then repeat the same upgrade command.
- Observed behavior: sandbox backup succeeds, OpenShell gateway retirement fails, NemoClaw reaches v0.0.114 while OpenShell remains 0.0.85, and the repeated upgrade fails at the same step. A valid gateway PID file can exist while the macOS fallback rejects or ignores it.
- Reporter follow-up: deleting only the local gateway registration lets the installer pass the first failure but leaves the OpenShell gateway process running and exposes the #10386 Homebrew checksum failure. The suggested repeated installer command is circular.

### #10386: older pinned release install

Source: #10386 body.

- Platform: Apple Silicon macOS, arm64. The failure occurs before Node.js, npm, Docker, OpenShell, NemoClaw, or OpenClaw version reporting completes.
- Reporter workflow: with the live `nvidia/openshell` tap newer than the formula expected by a previously released pinned NemoClaw version, run `curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG={older-pinned-version} bash`.
- Observed behavior: install or onboarding rejects the installed Homebrew formula because its live tap checksum differs from the frozen checksum used by the pinned release.

## Expected behavior and acceptance paths

### Safe macOS OpenShell gateway retirement

Sources: #10369 expected result, reporter comments, and the current maintainer handoff.

1. Upgrading the v0.0.90 baseline with the first newer NemoClaw release tag that contains this fix backs up existing sandboxes, retires the running OpenShell 0.0.85 gateway on macOS, installs the required OpenShell release, recreates or recovers the gateway, and completes without a split-version state. The v0.0.114 command remains the before-fix reproduction; published tags are immutable.
2. Retirement handles the NemoClaw-managed macOS service and PID-file process paths when the OpenShell 0.0.85 lifecycle command cannot retire the gateway.
3. Process retirement proves ownership and identity before sending a signal. It does not terminate an unrelated process when a PID file is stale, malformed, or points to a different executable.
4. Service retirement targets only the expected NemoClaw/OpenShell user service and confirms that the service stopped.
5. A failed upgrade returns a nonzero Bash status and preserves sandbox backups with actionable output.
6. Repeating the complete upgrade after an interruption finishes or gives an actionable recovery path; it does not repeat the same unrecoverable retirement failure.

### Version-specific Homebrew formula trust

Sources: #10386 expected result and actual result, #10369 reporter follow-up, and the current maintainer handoff.

1. A version-pinned macOS install uses the OpenShell formula that matches the requested trusted release, not the mutable live tap formula.
2. NemoClaw validates that formula against the SHA-256 value recorded for the same trusted release before Homebrew reads or installs it.
3. The installer and the Docker-driver OpenShell gateway service use the matching release-specific trust data. They do not compare an older pinned formula with a checksum for a different release.
4. Starting with the release that contains this fix, an upgrade from a previously released baseline installs the formula pinned by the fixed release even after the live tap advances. Immutable historical installers are not changed retroactively.
5. Missing, malformed, mismatched, or untrusted release checksum data fails closed. The change does not introduce an unverified production path or accept the live tap without verification.
6. The complete #10369 upgrade passes both the retirement step and the formula trust step without the circular `pinned checksum and temporary trust contract` recovery error.

### Required local and live evidence

Sources: current maintainer handoff and both issue workflows.

- Before changes, run `.handoff-tools/handoff-local-gate.py run --phase before-fix` and capture both failures through the actual installer and worktree CLI path on `h7yr45lq41.dyn.nvidia.com`.
- After changes, exercise the same v0.0.90 baseline upgrade through the patched worktree installer as the implementation of the next release tag. Do not require the immutable v0.0.114 tag to contain the fix.
- Build this worktree, use `./bin/nemoclaw.js` or `node ./bin/nemoclaw.js`, and create required sandbox and gateway state through the worktree CLI. Helper calls and raw OpenShell commands are supporting evidence only.
- Before-fix evidence must include the v0.0.90/OpenShell 0.0.85 split-version upgrade and the non-latest pinned formula checksum failure.
- After changes, rebuild and repeat the same complete workflows on the same macOS host. Evidence must show the final installed versions, live gateway status, preserved or recovered sandbox state, successful user-visible CLI result, and command status.
- Write ignored `handoff-e2e-before.md` and `handoff-e2e-after.md` receipts with hostname, exact revision, exact commands, relevant bounded output, and result.
- Run targeted installer, gateway service, checksum extraction, dependency pin, and Docker-driver tests. Then run `npm test` because the change crosses installer, runtime service, and security verification boundaries.
- Run the required pre-commit, post-commit, and pre-push handoff gates and obtain clean fresh-context reviewer results for contract closure, correctness, regressions, tests, validation, simplicity, and maintainability.

## Source-backed non-goals

- Do not change the Linux direct-download installation path to solve these macOS-only reports. Sources: both issue platform statements.
- Do not infer macOS behavior from Linux evidence or use Linux E2E as closure evidence. Sources: both issue environments and the current maintainer handoff.
- Do not weaken, skip, or replace formula SHA-256 verification with trust in the mutable live Homebrew tap. Sources: #10386 trust failure and the current maintainer handoff.
- Do not terminate an arbitrary process, delete another session's runtime state, use the shared alpha sandbox, or reuse another live session's ports or sandbox names. Source: current maintainer handoff.
- Do not treat removal of only the local OpenShell gateway registration as gateway retirement. Source: #10369 reporter follow-up.
- Do not expand this fix into unrelated OpenShell lifecycle, installer, or documentation changes. Sources: the two issue bodies and the current maintainer handoff.
- Do not absorb the separately tracked CPU-only upgrade recovery failure into this group. Issue #10389 owns preservation of CPU-only intent through GPU/CDI recovery. The macOS+Colima receipt bind-mount defect in #10348 is also separate unless its exact missing bind-source diagnostic reproduces. Source: current maintainer direction after comparison with #10348 and #10389.
