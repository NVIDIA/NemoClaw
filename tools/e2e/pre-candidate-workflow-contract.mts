// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Reviewed environment identities prevent inherited shell or action initialization overrides.
export const PRE_CANDIDATE_WORKFLOW_ENV = {
  NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.checkout_sha }}",
  NEMOCLAW_E2E_CORRELATION_ID: "${{ inputs.correlation_id }}",
  NEMOCLAW_E2E_SHARD: "default",
  NEMOCLAW_GATEWAY_RUNTIMES: "${{ inputs.gateway_runtimes || inputs.gateway_runtime || 'docker' }}",
};
export const PRE_CANDIDATE_STEP_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "Build trusted larger-runner routing": {
    CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
    LARGER_RUNNER_LABEL: "${{ vars.E2E_LARGER_RUNNER_LABEL }}",
    REF: "${{ github.ref }}",
    REPOSITORY: "${{ github.repository }}",
  },
  "Authenticate manual PR dispatch": {
    ALLOW_JETSON_DISPATCH: "${{ inputs.allow_jetson_dispatch && 'true' || 'false' }}",
    BASE_SHA: "${{ inputs.base_sha }}",
    CHECKOUT_REPOSITORY: "${{ inputs.checkout_repository }}",
    CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
    EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
    GITHUB_TOKEN: "${{ github.token }}",
    INCLUDE_LAUNCHABLE: "${{ inputs.include_staging_brev_launchable && 'true' || 'false' }}",
    JOBS: "${{ inputs.jobs }}",
    PR_NUMBER: "${{ inputs.pr_number }}",
    TARGETS: "${{ inputs.targets }}",
    WORKFLOW_EVENT: "${{ github.event_name }}",
    WORKFLOW_REF: "${{ github.ref }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  },
  "Record trusted E2E dispatch receipt": {
    ACTOR: "${{ github.actor }}",
    ALLOW_JETSON_DISPATCH: "${{ inputs.allow_jetson_dispatch && 'true' || 'false' }}",
    ALLOW_JETSON_RUNNER_QUEUE: "false",
    BASE_SHA: "${{ inputs.checkout_sha != '' && inputs.base_sha || github.sha }}",
    CANDIDATE_REPOSITORY: "${{ inputs.checkout_repository || github.repository }}",
    CANDIDATE_SHA: "${{ inputs.checkout_sha || github.sha }}",
    DISPATCH_JOBS: "${{ inputs.jobs }}",
    DISPATCH_RECEIPT_DIR: "${{ runner.temp }}/nemoclaw-e2e-dispatch",
    DISPATCH_TARGETS: "${{ inputs.targets }}",
    EVENT_NAME: "${{ github.event_name }}",
    INCLUDE_STAGING_BREV_LAUNCHABLE:
      "${{ inputs.include_staging_brev_launchable && 'true' || 'false' }}",
    PR_NUMBER: "${{ inputs.checkout_sha != '' && inputs.pr_number || '' }}",
    REPOSITORY: "${{ github.repository }}",
    RUN_ATTEMPT: "${{ github.run_attempt }}",
    RUN_ID: "${{ github.run_id }}",
    TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  },
  "Upload trusted E2E dispatch receipt": {},
  "Authorize Launchable E2E maintainer dispatch": {
    ACTOR: "${{ github.actor }}",
    GITHUB_TOKEN: "${{ github.token }}",
    TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
  },
  "Check out trusted E2E planner": {},
  "Set up Node for trusted E2E planning": {},
  "Install reviewed npm for trusted E2E planning": {},
  "Install trusted E2E planner dependencies": {},
  "Generate E2E target matrix": {
    INFERENCE_MODE: "${{ inputs.inference_mode || 'mock' }}",
    NEMOCLAW_GATEWAY_RUNTIMES:
      "${{ inputs.gateway_runtimes || inputs.gateway_runtime || 'docker' }}",
    JOBS: "${{ inputs.jobs }}",
    TARGETS: "${{ inputs.targets }}",
    EVENT_NAME: "${{ github.event_name }}",
    BEFORE_SHA: "${{ github.event.before }}",
    CANDIDATE_SHA: "${{ github.sha }}",
    NEMOCLAW_E2E_CREDENTIALS_ALLOWED:
      "${{ (inputs.checkout_sha == '' || steps.candidate_authorization.outputs.nvidia_owned == 'true') && 'true' || 'false' }}",
    NEMOCLAW_E2E_BRAVE_API_KEY_AVAILABLE: "${{ secrets.BRAVE_API_KEY != '' && 'true' || 'false' }}",
  },
  "Stage immutable native Podman E2E toolchains": {},
};

export const PRE_CANDIDATE_STEP_CONDITIONS: Readonly<Record<string, string | undefined>> = {
  "Authenticate manual PR dispatch":
    "${{ inputs.pr_number != '' || inputs.checkout_sha != '' || inputs.checkout_repository != '' || inputs.base_sha != '' || inputs.workflow_sha != '' }}",
  "Record trusted E2E dispatch receipt": "${{ github.event_name == 'workflow_dispatch' }}",
  "Upload trusted E2E dispatch receipt": "${{ github.event_name == 'workflow_dispatch' }}",
  "Authorize Launchable E2E maintainer dispatch":
    "${{ github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '' && ((inputs.jobs == 'staging-brev-launchable' && inputs.targets == '') || (inputs.jobs == 'staging-brev-launchable-identity' && inputs.targets == '') || (inputs.include_staging_brev_launchable && inputs.jobs == '' && inputs.targets == '')) }}",
};

// The two omitted shells intentionally retain the Ubuntu runner's default invocation.
export const PRE_CANDIDATE_STEP_SHELLS: Readonly<Record<string, string | undefined>> = {
  "Build trusted larger-runner routing": "bash",
  "Authenticate manual PR dispatch": "bash",
  "Record trusted E2E dispatch receipt": "bash",
  "Authorize Launchable E2E maintainer dispatch": "bash",
  "Install trusted E2E planner dependencies": undefined,
  "Generate E2E target matrix": undefined,
};
