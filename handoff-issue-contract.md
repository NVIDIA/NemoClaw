<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Issue closure contract: #10380

## Scope authority and sources

- GitHub issue #10380 defines the reported Deep Agents Code workflow, Linux environments, expected local denial, and observed upstream GitHub response.
- The reporter's issue body requires managed `raw.githubusercontent.com` access to permit only GET and HEAD.
- The maintainer comment identifies the `brew` preset as the balanced-tier permissive route. It requires OpenShell rule-enforcement verification and Homebrew regression evidence before the shared preset is narrowed.
- The copied `issue-10380.md` analysis requires GET, HEAD, local POST denial, and a real Homebrew install through a balanced managed-proxy sandbox.
- The current user instruction authorizes the shared-policy change. It also requires coverage for an equivalent permissive policy entry when that entry represents the same Homebrew route.
- The current GitHub timeline has no linked issue or pull request. GitHub search found no existing pull request for #10380. Therefore, this contract closes only #10380.

## Reporter workflow and environment

- Agent: LangChain Deep Agents Code.
- Platform: Linux. The reporter reproduced the defect on Jetson Thor and Ubuntu 22.04, 24.04, 24.04 GPU, and 26 GPU runners.
- Reported versions: Node.js 22.22.x-22.23.x, npm 10.9.x, Docker Engine 29.x, OpenShell 0.0.106, and NemoClaw 0.0.114.
- Required local environment: the current Linux and GPU host, a uniquely named issue-10380 sandbox, and per-worktree NemoClaw state when supported.
- Entry path: build this checkout, run `./bin/nemoclaw.js`, onboard Deep Agents Code with the balanced tier and managed proxy, then execute the probe through the user-facing sandbox command.
- Probe setup: source `/tmp/nemoclaw-proxy-env.sh` inside the sandbox and use its configured HTTP or HTTPS proxy.
- Reported request: POST `https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/README.md`.

## Expected behavior

- GET to an approved raw GitHub path succeeds.
- HEAD to an approved raw GitHub path succeeds.
- POST to the same path is denied by the local managed policy or proxy before the request reaches GitHub.
- The denial response does not contain the GitHub Unicorn HTML page or other upstream GitHub HTML.
- Formula metadata, bottle metadata, bottle downloads, and `brew install` continue to work through the Homebrew policy routes.

## Observed behavior before the fix

- GET succeeds through the managed proxy.
- POST reaches GitHub and returns HTTP 403 with the GitHub Unicorn HTML page.
- The `brew` preset grants `raw.githubusercontent.com` with `access: full` and no method rules.
- Balanced and open tiers select the shared `brew` preset.
- Deep Agents Code already declares a separate host-wide GET/HEAD route. The permissive overlapping `brew` route defeats the intended read-only result.

## Closure requirements and acceptance evidence

1. Verify OpenShell 0.0.106 enforces an existing REST rule before changing policy files.
   - Source: maintainer comment and copied analysis.
   - Evidence: a real sandbox request that an existing rule allows with GET or HEAD and denies with POST locally.
   - Stop condition: if OpenShell forwards the disallowed request, NemoClaw policy changes cannot close #10380.

2. Reproduce the reporter workflow before editing policy code.
   - Source: issue body and current user instruction.
   - Evidence: a worktree CLI onboard of a uniquely named Deep Agents Code sandbox with balanced managed proxy, followed by the exact raw GitHub POST through the user-facing sandbox workflow.
   - Required result: upstream HTTP 403 and GitHub HTML prove the defect is present.

3. Make the shared Homebrew raw GitHub route read-only.
   - Source: issue expected result, maintainer root-cause comment, copied analysis, and current user instruction.
   - Required policy: host-wide GET and HEAD rules with REST enforcement; no `access: full` on this endpoint.
   - Composition requirement: every checked-in permissive `brew` policy entry that represents the same Homebrew route must use the same method limit. A remaining equivalent full-access entry would leave the failure class reachable.

4. Preserve intended raw GitHub reads.
   - Source: issue expected result and copied analysis.
   - Evidence: GET returns HTTP 200 with the NemoClaw README. HEAD returns an accepted success response without a body.

5. Preserve Homebrew formula and bottle workflows.
   - Source: maintainer comment, copied analysis, and current user instruction.
   - Evidence: the Deep Agents balanced sandbox accepts the formula, raw-content, and GHCR routes that its shared `brew` preset opens.
   - Evidence: a balanced OpenClaw sandbox, the supported runtime whose base policy and image provide the Homebrew prefix, completes `brew --prefix` and installs a small bottle such as `hello` through the same shared `brew` preset.
   - Runtime boundary: the Deep Agents base policy does not grant `/home/linuxbrew`, and its v0.0.114 base image does not contain `brew`. Therefore, an actual `brew install` in that agent is not a supported Homebrew consumer and is not valid regression evidence for the shared preset.

6. Deny the reported mutation locally after the fix.
   - Source: issue expected result and current user instruction.
   - Evidence: repeat the same user-facing POST after rebuilding and recreating or updating the sandbox policy.
   - Required result: local policy or method denial, no upstream GitHub HTML, and no successful mutation request.

7. Add durable policy regression coverage.
   - Source: repository QA-escaped-defect requirements and current user instruction.
   - Evidence: policy-consumer tests assert GET and HEAD are the only methods for the shared Homebrew raw GitHub route and all equivalent checked-in policy copies.
   - The test must fail against the pre-fix policy and pass after the fix.

8. Complete repository and publication gates.
   - Source: current user instruction and repository contributor workflow.
   - Evidence: before-fix, pre-commit, post-commit, and pre-push handoff gates; focused tests; `npm test`; fresh-context reviews; signed commit; verified GitHub commit; current-head PR checks.

## Explicit non-goals

- Do not claim support or validation for non-Linux platforms. The issue body excludes them from the confirmed platform scope.
- Do not change OpenShell code. If OpenShell 0.0.106 does not enforce declared REST rules, stop because a NemoClaw-only change cannot close #10380.
- Do not narrow raw GitHub paths. Deep Agents Code must follow repository, revision, and file paths that vary by task, so the existing agent policy intentionally uses `/**`.
- Do not remove GET or HEAD access required for raw content, formulae, or bottles.
- Do not broaden POST access on another GitHub host or policy to compensate for this denial.
- Do not change the personal tier's explicit broad L4 internet posture. It is a separate user-selected policy contract.
- Do not change unrelated service-specific raw GitHub routes, such as the pinned OpenClaw pricing file or WhatsApp version lookup.
- Do not add a Homebrew binary or change package provisioning. The `brew` preset states that the base image already provides the binary.
- Do not change Git-based Homebrew operations. The preset explicitly routes those operations through the separate `github` preset.
- Do not claim that a unit test, helper invocation, raw OpenShell command, or CI job replaces the required worktree CLI E2E evidence.
