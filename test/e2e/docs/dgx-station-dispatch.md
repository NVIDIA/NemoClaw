<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station Express dispatch

Before dispatching a candidate that uses the shared entrypoint, deploy the matching Station backend update. Select a candidate that contains `test/e2e/live/dgx-express.test.ts`.

Select `dgx-station-express` by itself in the `jobs` or `targets` input of the E2E workflow. The target is excluded from default runs. Its GitHub-hosted controller runs from the trusted main workflow and sends the candidate commit and selected managed-image publication revision to the operator's Station receiver.

The backend selects only the Station case in `test/e2e/live/dgx-express.test.ts` with `E2E_TARGET_ID=dgx-station-express` and `--selector '^dgx-station-express:'`. The Spark case has its own selector.

Configure the GitHub repository variable `DGX_STATION_DISPATCH_URL` with the receiver's HTTPS origin. Station uses its own queue, OIDC audience, receipt, and artifact namespace. The controller does not use `JETSON_DISPATCH_URL`.

The receiver uses the configured runner account’s normal HOME so its systemd user manager can discover the gateway service. It requires this account’s NemoClaw installation state to be clean between runs. The receiver needs a dedicated Station with prepared host prerequisites, a cached Nemotron 3.5 Super VL NVFP4 model, and the vLLM image selected by the candidate recipe. Each job uses `/tmp/ncs/<job-id>` for temporary files so `tsx` IPC socket paths fit the Linux pathname limit.

## Select Express for CI Qualification

Use `--express-install` for the maintainer-operated Station CI smoke. Prepare non-interactive sudo access for the configured runner account before dispatch. The smoke runs the local candidate installer:

```bash
NEMOCLAW_REPO_ROOT="$(pwd)" bash install.sh --express-install --yes-i-accept-third-party-software
```

`--express-install` selects the existing Station Express recipe without its selection prompt. Station qualification and explicit software acceptance remain required. It rejects conflicting provider, profile, deferred-onboarding, and interactive Station options. Ordinary non-interactive installation retains its existing selection behavior.

The smoke checks the ready sandbox, running managed vLLM with the Super VL serving alias, the independently selected managed-image revision, and an assistant response through `inference.local`.
Before inference, vLLM health requests must succeed on loopback and the private OpenShell gateway and refuse every other assigned IPv4/IPv6 host address.
The candidate's command artifacts retain inspected bindings, probe targets, exit codes and HTTP statuses.
Cleanup attempts to retire installation state left after success or failure. Cleanup uses a fresh signal through the E2E cleanup registry.

Timing evidence records completed smoke phases. Total duration spans installer start through smoke cleanup. Readiness and assertion durations can be absent after failure. vLLM startup remains inside installation. The cache check compares paths, file sizes, and symlink targets. The smoke also checks that the vLLM image remains after uninstall.

Qualify an untouched baseline and the local candidate before drawing performance conclusions. The new controller must be available on the trusted main workflow before a GitHub run can execute it. An unmerged candidate selection does not replace the controller source. Keep local hardware evidence separate from proof of the full GitHub dispatch path.

If installation state remains, CI cleanup validates any available sandbox registry and invokes the product uninstaller. The shared helper then handles an orphaned OpenClaw state volume when it was absent from the pre-install inventory, has the expected ownership labels and local driver without driver options, and is not attached to a container. It rejects unexpected volume changes and checks the final inventory against the baseline. An uninstall failure stops before volume cleanup. The helper does not rewrite session or registry state to make uninstall proceed. This does not establish that the standalone product uninstaller removes every agent state volume.

## DGX Spark extra-arguments dispatch

This controller needs an independently reviewed prerequisite on trusted `main` before it can qualify a candidate.
Adding it to the candidate alone does not make GitHub dispatch available.
The controller requires an explicit `checkout_sha` and the canonical `checkout_repository`.
The selected candidate must contain the extra-arguments scenario.

Deploy a separate Spark receiver before selecting `spark-vllm-extra-arguments` by itself in the workflow's `jobs` or `targets` input.
The trusted main workflow must contain the Spark controller and client before it can dispatch this target.
Configure `DGX_SPARK_DISPATCH_URL` with that receiver's HTTPS origin.
The Spark controller uses its own queue, `nemoclaw-dgx-spark-dispatch` OIDC audience, schema version 4, and `e2e-spark-vllm-extra-arguments` artifact.
It does not send work to the Station receiver.

The receiver must verify the OIDC audience and trusted main workflow identity, then authenticate the requested candidate commit and managed-image revision independently.
It must prepare and build that candidate without exposing controller credentials to candidate code.
Use a dedicated DGX Spark GB10 reporting at least 60 GB and less than 64 GB of unified memory.
Prepare Docker, NVIDIA Container Toolkit, OpenShell, sufficient model storage, and a clean runner account with no unrelated sandbox or `nemoclaw-vllm` container.
Run the candidate's canonical entrypoint with `E2E_TARGET_ID=spark-vllm-extra-arguments`:

```bash
E2E_JOB=1 NEMOCLAW_RUN_LIVE_E2E=1 E2E_TARGET_ID=spark-vllm-extra-arguments npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/dgx-express.test.ts --selector '^spark-vllm-extra-arguments:'
```

The receiver must retain the selected candidate and image identities, hardware identity, target completion, command artifacts, and cleanup result.
The version 4 compatibility vector is `tools/e2e/contracts/v4/dgx-spark-dispatch.json`; Station's version 3 contract is unchanged.
The controller checks the returned job identity and requires an archive for a successful Spark result.
It saves `dgx-spark-dispatch.json` and `dgx-spark-e2e-artifacts.tar.gz` for upload, including the receipt when execution fails.
OIDC tokens stay in controller memory and are not part of the request or saved receipt.

Allow the existing 65-minute scenario deadline, cleanup, and evidence transfer within the controller's 90-minute wait and 95-minute job deadline.
A controller deadline, cancellation, or ambiguous submission requests cancellation of the same job and retains its recovery receipt.
A failed or missing cleanup result cannot become successful qualification.
Local support tests and a standalone hardware run do not prove deployment or successful execution of this trusted dispatch path.

### Receiver acceptance and qualification evidence

Before configuring the receiver URL, retain its reviewed implementation or deployed source revision and acceptance results.
The deployment owner must demonstrate these controls at the receiver boundary:

- Accept an authorized trusted-main workflow request for the selected candidate and managed-image revisions.
- Reject unauthenticated, expired, wrong-audience and wrong-workflow requests before scheduling hardware work.
- Reject unauthorized or mismatched candidate and image revisions independently of client validation.
- Keep controller credentials unavailable during candidate preparation, build and execution.
- Reconcile repeated submissions to the same job; cancel that job after timeout or ambiguous submission.
- Preserve private recovery receipts and report cleanup failure after success, failure, cancellation or interrupted execution.

Client compatibility vectors and mock transport tests do not establish receiver acceptance.
After deployment and candidate publication, retain a passing workflow receipt and archive for the published candidate.
They must identify the candidate, managed-image revision, physical GB10 host, and detected memory from 60 GB to below 64 GB.
The archive must show automatic installation with extra arguments, the inspected Docker recipe and publication restrictions, sandbox chat, unrelated-egress denial, and successful cleanup.
Station, llama.cpp, generic GPU and standalone Spark results cannot replace this dispatch evidence.

Retain the complete hosted risk plan for the published candidate and the results for every required selector it records.
The Spark result supplements cloud-onboard, full-e2e, security-posture, inference-routing, network-policy and focused selections such as dgx-station-express.
The shared entrypoint can select Station even when the change targets Spark.
Preserve those obligations and every additional trusted requirement.
A local plan that omits trusted workflow mappings is incomplete.
Results for another candidate do not qualify the published candidate.
