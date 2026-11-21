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

Spark dispatch is not available through the workflow's `jobs` or `targets` input.
Both Spark variants remain standalone hardware tests.
Use a dedicated DGX Spark GB10 reporting at least 60 GB and less than 64 GB for the extra-arguments scenario.
Prepare Docker, NVIDIA Container Toolkit, OpenShell, sufficient model storage, and a clean runner account with no unrelated sandbox or `nemoclaw-vllm` container.
The schema-4 compatibility vector and target-specific client settings define the proposed receiver protocol; they do not establish deployment.

Before adding a selectable controller, the deployment owner must provide a reviewed immutable receiver revision and the acceptance evidence below.
The controller must then land independently on trusted `main` and report candidate-bound results to the PR.
Standalone results do not replace this hosted qualification.

### Select managed-image authority

Both Spark variants require independently verified managed-image authority before execution, including standalone runs.
Set `verified_image_revision` to the publication's 40-character source commit and `verified_cohort_receipt_file` to its complete cohort receipt JSON file.
Do not construct the expected authority from the sandbox under test.
Export the selected revision and the receipt's JSON contents, not its filename:

```bash
export E2E_MANAGED_IMAGE_REVISION="$verified_image_revision"
export E2E_MANAGED_IMAGE_COHORT_RECEIPT="$(cat "$verified_cohort_receipt_file")"
```

A trusted candidate catalog is an alternative in the GitHub Actions live-E2E context, where `GITHUB_ACTIONS=true` and `NEMOCLAW_RUN_LIVE_E2E=1`.
Clear `E2E_MANAGED_IMAGE_REVISION` and `E2E_MANAGED_IMAGE_COHORT_RECEIPT` before selecting this alternative.
For a file catalog, set `NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG` to its filename and `NEMOCLAW_E2E_MANAGED_IMAGE_REVISION` to the verified publication source commit.
For inline JSON, set `NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON` to the catalog contents instead; do not set both catalog variables.
Verify that the catalog source revision matches the requested managed-image revision.
On a standalone host outside that Actions context, use the cohort receipt above.

After successful onboarding and resource-identity capture, both Spark variants require the durable OpenClaw sandbox workload receipt to match the selected authority before runtime and inference probes.
Missing authority, missing workload receipts, wrong revisions, and wrong image digests fail qualification.

### Run the Spark scenario

Run the candidate's canonical entrypoint with the selected authority exported and `E2E_TARGET_ID=spark-vllm-extra-arguments`:

```bash
E2E_JOB=1 NEMOCLAW_RUN_LIVE_E2E=1 E2E_TARGET_ID=spark-vllm-extra-arguments npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/dgx-express.test.ts --selector '^spark-vllm-extra-arguments:'
```

The proposed receiver must retain candidate and managed-image identities, hardware identity, command artifacts, and cleanup results.
The compatibility vector is `tools/e2e/contracts/v4/dgx-spark-dispatch.json`; Station's version 3 contract is unchanged.

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
