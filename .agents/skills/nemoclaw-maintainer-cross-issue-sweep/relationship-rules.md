<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Relationship Classification Rules

Use these four classes for candidate issues.

## Contents

- ADJACENT_FIX
- CONTRADICTING
- SAME_ISSUE_DIFF
- UNRELATED

## ADJACENT_FIX

The PR resolves the issue or enables follow-up work on the changed code.

### Example A — incidental closure (direct evidence)

PR description: "fix EACCES when shields-down user writes config"
PR diff: adds `chmod g+w` to `.openclaw` directory at startup
Candidate issue #2810: "Telegram preset writes fail intermittently after sandbox rebuild"
Issue body cites: "EPERM on `.openclaw/credentials/telegram.json`"

**Classification:** ADJACENT_FIX, high confidence
**Direct evidence:** The PR changes permissions at `Dockerfile.base:97`. Issue line 14 reports an `EPERM` error in the same directory.

### Example B — follow-on hardening on PR-introduced code

PR #2696 introduced `scripts/rcf_patch.py` with regex-based property matching.
Candidate issue #2875: "Harden rcf_patch.py against property-order drift" — issue says PR #2696 is "a real improvement... one follow-on hardening gap: the regex still assumes `snapshot` before `nextConfig`."

**Classification:** ADJACENT_FIX, high confidence (boosted by reverse-link)
**Follow-on evidence:** The PR adds `scripts/rcf_patch.py`. The issue asks for a change to that file's regular expression.

## CONTRADICTING

The PR prevents the requested behavior or leaves another instance of the bug.

### Example A — direct contradiction

PR description: "remove silent EACCES swallow from Patch 4b"
PR diff: deletes try/catch around `mutateConfigFile`
Candidate issue #4187: "Allow opt-in error suppression for sandbox config writes during shutdown"

**Classification:** CONTRADICTING, medium confidence
**Direct evidence:** The PR removes error suppression at `Dockerfile:142`. Issue line 8 requests optional suppression for shutdown errors.

### Example B — partial-fix gap (evidence by omission)

PR #2700 changed 5 env-var validations from `return 1` to `return 0` in `scripts/nemoclaw-start.sh`.
Candidate issue #2762: "PR #2700 changed validations... However... NEMOCLAW_CONTEXT_WINDOW and NEMOCLAW_MAX_TOKENS with invalid values still cause the container to exit with code 1."

**Classification:** CONTRADICTING, high confidence (boosted by reverse-link)
**By-omission evidence:** Invalid environment values cause an exit under `set -euo pipefail`.
The PR fixes five variables, including `NEMOCLAW_MODEL_OVERRIDE` and `NEMOCLAW_REASONING`.
It does not fix `NEMOCLAW_CONTEXT_WINDOW` or `NEMOCLAW_MAX_TOKENS`.
The issue reports the same error for those two variables.

## SAME_ISSUE_DIFF

The candidate describes the same bug as the linked issue. Remove it to prevent duplicate results.

**Example:**

PR's primary issue: #2681 ("Enable Dreaming permission error")
Candidate issue #2895: "Toggle in OpenClaw UI fails with EACCES"

Both describe the same EACCES failure on the same toggle.
**Classification:** SAME_ISSUE_DIFF. Do not include it in the output.

## UNRELATED

The issue and PR do not have a meaningful relationship. The search found a shared token only.

**Example:**

PR description: "extract sandbox-gateway-state helpers"
Candidate issue #4523: "Sandbox gateway timeout on first connect"

The search matched `gateway`. The PR does not change behavior, and the issue reports a timing problem.
**Classification:** UNRELATED.

## Decision rule

Classify the issue as UNRELATED unless the evidence meets one type in `checks/relationship-judgment.md`.
