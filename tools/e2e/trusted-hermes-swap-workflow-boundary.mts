// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
};

export const TRUSTED_HERMES_SWAP_STEP_NAME = "Provision trusted Hermes E2E swap";
export const TRUSTED_HERMES_SWAP_STEP_ID = "trusted_hermes_swap";

const TRUSTED_HERMES_SWAP_IF =
  "github.repository == 'NVIDIA/NemoClaw' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.checkout_sha != ''";
const TRUSTED_HERMES_E2E_SELECTION =
  "(contains(format(',{0},', inputs.jobs), ',hermes-e2e,') || contains(format(',{0},', inputs.targets), ',hermes-e2e,'))";
const TRUSTED_HERMES_SWAP_SHELL = "/bin/bash --noprofile --norc -e -o pipefail {0}";
const TRUSTED_HERMES_SWAP_ENV = {
  BASH_ENV: "/dev/null",
  CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
  DISPATCH_SHA: "${{ github.sha }}",
  ENV: "/dev/null",
  EVENT_NAME: "${{ github.event_name }}",
  EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
  LC_ALL: "C",
  REF: "${{ github.ref }}",
  REPOSITORY: "${{ github.repository }}",
  RUNNER_ARCH_KIND: "${{ runner.arch }}",
  RUNNER_ENVIRONMENT_KIND: "${{ runner.environment }}",
  RUNNER_OS_KIND: "${{ runner.os }}",
  WORKFLOW_SHA: "${{ github.workflow_sha }}",
} as const;

export const TRUSTED_HERMES_SWAP_SCRIPT = [
  "set -euo pipefail",
  'readonly swap_dir="/mnt/nemoclaw-hermes-e2e-swap"',
  "readonly required_swap_bytes=34359738368",
  "readonly swap_file_bytes=34359742464",
  "readonly reserve_bytes=17179869184",
  "readonly activation_observation_attempts=5",
  "readonly activation_observation_delay_seconds=1",
  'swap_file=""',
  "swap_activation_succeeded=0",
  "",
  "fail() {",
  "  printf 'Trusted Hermes E2E swap setup failed: %s\\n' \"$1\" >&2",
  "  exit 1",
  "}",
  "",
  'if [[ "${REPOSITORY}" != "NVIDIA/NemoClaw" || "${EVENT_NAME}" != "workflow_dispatch" || "${REF}" != "refs/heads/main" ]]; then',
  '  fail "workflow must run from NVIDIA/NemoClaw main"',
  "fi",
  'if [[ ! "${CHECKOUT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then',
  '  fail "checkout SHA must be lowercase 40-hex"',
  "fi",
  'if [[ ! "${EXPECTED_WORKFLOW_SHA}" =~ ^[0-9a-f]{40}$ || "${WORKFLOW_SHA}" != "${EXPECTED_WORKFLOW_SHA}" || "${WORKFLOW_SHA}" != "${DISPATCH_SHA}" ]]; then',
  '  fail "workflow source must match the trusted dispatch revision"',
  "fi",
  'if [[ "${RUNNER_ENVIRONMENT_KIND}" != "github-hosted" || "${RUNNER_OS_KIND}" != "Linux" || "${RUNNER_ARCH_KIND}" != "X64" ]]; then',
  '  fail "swap fallback requires an ephemeral GitHub-hosted Linux x64 runner"',
  "fi",
  'mnt_metadata="$(/usr/bin/stat -c "%F:%u:%g" -- /mnt)"',
  'if [[ "${mnt_metadata}" != "directory:0:0" ]]; then',
  '  fail "/mnt must be a root-owned directory"',
  "fi",
  "",
  "read_active_swap_bytes() {",
  "  /usr/bin/sudo -n /usr/sbin/swapon --show=SIZE --bytes --noheadings |",
  "    /usr/bin/awk '{ total += $1 } END { printf \"%.0f\", total }'",
  "}",
  "",
  'active_swap_bytes="$(read_active_swap_bytes)"',
  'active_swap_bytes="${active_swap_bytes:-0}"',
  'if [[ ! "${active_swap_bytes}" =~ ^[0-9]+$ ]]; then',
  '  fail "unable to determine active swap capacity"',
  "fi",
  "if (( active_swap_bytes >= required_swap_bytes )); then",
  "  printf 'Hermes E2E swap is already sufficient: %s bytes active\\n' \"${active_swap_bytes}\"",
  "  exit 0",
  "fi",
  "",
  'available_bytes="$(/usr/bin/df --block-size=1 --output=avail /mnt | /usr/bin/tail -n 1 | /usr/bin/tr -d "[:space:]")"',
  'if [[ ! "${available_bytes}" =~ ^[0-9]+$ ]]; then',
  '  fail "unable to determine available disk capacity under /mnt"',
  "fi",
  "required_disk_bytes=$((swap_file_bytes + reserve_bytes))",
  "if (( available_bytes < required_disk_bytes )); then",
  '  fail "insufficient disk capacity: ${available_bytes} bytes available, ${required_disk_bytes} required"',
  "fi",
  "",
  'if /usr/bin/sudo -n /usr/bin/test -e "${swap_dir}" || /usr/bin/sudo -n /usr/bin/test -L "${swap_dir}"; then',
  '  fail "refusing unexpected pre-existing swap path"',
  "fi",
  "",
  "directory_created=0",
  "cleanup_partial_swap() {",
  '  status="$?"',
  "  if (( status != 0 && directory_created == 1 )); then",
  '    if active_swap_names="$(/usr/bin/sudo -n /usr/sbin/swapon --show=NAME --noheadings --raw 2>/dev/null)"; then',
  "      fixed_swap_active=0",
  "      while IFS= read -r active_swap_name; do",
  '        if [[ -n "${swap_file}" && "${active_swap_name}" == "${swap_file}" ]]; then',
  "          fixed_swap_active=1",
  "          break",
  "        fi",
  '      done <<< "${active_swap_names}"',
  "      if (( fixed_swap_active == 1 || swap_activation_succeeded == 1 )); then",
  '        if /usr/bin/sudo -n /usr/sbin/swapoff "${swap_file}" 2>/dev/null; then',
  '          /usr/bin/sudo -n /usr/bin/rm -f -- "${swap_file}" || true',
  '          /usr/bin/sudo -n /usr/bin/rmdir -- "${swap_dir}" || true',
  "        else",
  "          printf 'Preserving active Hermes E2E swap after setup failure: %s\\n' \"${swap_file}\" >&2",
  "        fi",
  "      else",
  '        if [[ -n "${swap_file}" ]]; then',
  '          /usr/bin/sudo -n /usr/bin/rm -f -- "${swap_file}" || true',
  "        fi",
  '        /usr/bin/sudo -n /usr/bin/rmdir -- "${swap_dir}" || true',
  "      fi",
  "    else",
  "      printf 'Preserving Hermes E2E swap because active swap could not be queried: %s\\n' \"${swap_file}\" >&2",
  "    fi",
  "  fi",
  "  trap - EXIT",
  '  exit "${status}"',
  "}",
  "trap cleanup_partial_swap EXIT",
  "",
  '/usr/bin/sudo -n /usr/bin/mkdir -m 0700 -- "${swap_dir}"',
  "directory_created=1",
  'directory_metadata="$(/usr/bin/sudo -n /usr/bin/stat -c "%F:%u:%g:%a" -- "${swap_dir}")"',
  'if [[ "${directory_metadata}" != "directory:0:0:700" ]]; then',
  '  fail "swap directory must be a root-owned mode-0700 directory"',
  "fi",
  'swap_file="$(/usr/bin/sudo -n /usr/bin/mktemp --tmpdir="${swap_dir}" nemoclaw-hermes.XXXXXXXX.swap)"',
  'if ! /usr/bin/sudo -n /usr/bin/test -f "${swap_file}" || /usr/bin/sudo -n /usr/bin/test -L "${swap_file}"; then',
  '  fail "swap file must be a regular non-symlink"',
  "fi",
  'file_metadata="$(/usr/bin/sudo -n /usr/bin/stat -c "%u:%g:%a" -- "${swap_file}")"',
  'if [[ "${file_metadata}" != "0:0:600" ]]; then',
  '  fail "swap file must be root-owned mode 0600"',
  "fi",
  '/usr/bin/sudo -n /usr/bin/fallocate -l "${swap_file_bytes}" "${swap_file}"',
  'file_size_bytes="$(/usr/bin/sudo -n /usr/bin/stat -c "%s" -- "${swap_file}")"',
  'if [[ ! "${file_size_bytes}" =~ ^[0-9]+$ || "${file_size_bytes}" -ne "${swap_file_bytes}" ]]; then',
  '  fail "swap file size does not match the fixed backing allocation"',
  "fi",
  'remaining_bytes="$(/usr/bin/df --block-size=1 --output=avail /mnt | /usr/bin/tail -n 1 | /usr/bin/tr -d "[:space:]")"',
  'if [[ ! "${remaining_bytes}" =~ ^[0-9]+$ || "${remaining_bytes}" -lt "${reserve_bytes}" ]]; then',
  '  fail "swap allocation did not preserve the required disk reserve"',
  "fi",
  '/usr/bin/sudo -n /usr/sbin/mkswap --quiet "${swap_file}"',
  '/usr/bin/sudo -n /usr/sbin/swapon "${swap_file}"',
  "swap_activation_succeeded=1",
  "",
  "observe_provisioned_swap() {",
  "  activation_observation_attempt=1",
  "  while (( activation_observation_attempt <= activation_observation_attempts )); do",
  "    provisioned_swap_active=0",
  '    if active_swap_names="$(/usr/bin/sudo -n /usr/sbin/swapon --show=NAME --noheadings --raw 2>/dev/null)"; then',
  "      while IFS= read -r active_swap_name; do",
  '        if [[ "${active_swap_name}" == "${swap_file}" ]]; then',
  "          provisioned_swap_active=1",
  "          break",
  "        fi",
  '      done <<< "${active_swap_names}"',
  "    fi",
  '    if observed_swap_bytes="$(read_active_swap_bytes 2>/dev/null)"; then',
  '      observed_swap_bytes="${observed_swap_bytes:-0}"',
  '      if [[ "${observed_swap_bytes}" =~ ^[0-9]+$ ]] &&',
  "        (( provisioned_swap_active == 1 && observed_swap_bytes >= required_swap_bytes )); then",
  '        active_swap_bytes="${observed_swap_bytes}"',
  "        return 0",
  "      fi",
  "    fi",
  "    if (( activation_observation_attempt < activation_observation_attempts )); then",
  '      /usr/bin/sleep "${activation_observation_delay_seconds}"',
  "    fi",
  "    activation_observation_attempt=$((activation_observation_attempt + 1))",
  "  done",
  "  return 1",
  "}",
  "",
  "if ! observe_provisioned_swap; then",
  '  fail "unable to verify the required active swap capacity after bounded observation"',
  "fi",
  "",
  "trap - EXIT",
  "printf 'Hermes E2E swap ready: %s bytes active\\n' \"${active_swap_bytes}\"",
  "/usr/bin/sudo -n /usr/sbin/swapon --show",
].join("\n");

const JOB_CONDITIONS = {
  "agent-turn-latency": `\${{ ${TRUSTED_HERMES_SWAP_IF} }}`,
  "bedrock-runtime-compatible-anthropic": `\${{ ${TRUSTED_HERMES_SWAP_IF} && matrix.agent == 'hermes' }}`,
  "hermes-dashboard": `\${{ ${TRUSTED_HERMES_SWAP_IF} }}`,
  "hermes-e2e": `\${{ ${TRUSTED_HERMES_SWAP_IF} && ${TRUSTED_HERMES_E2E_SELECTION} }}`,
  "hermes-inference-switch": `\${{ ${TRUSTED_HERMES_SWAP_IF} }}`,
  "hermes-shields-config": `\${{ ${TRUSTED_HERMES_SWAP_IF} }}`,
  "mcp-bridge": `\${{ ${TRUSTED_HERMES_SWAP_IF} && matrix.agent == 'hermes' }}`,
  "security-posture": `\${{ ${TRUSTED_HERMES_SWAP_IF} && matrix.agent == 'hermes' }}`,
} as const;

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? value.map((step) => asRecord(step) as WorkflowStep) : [];
}

export function validateTrustedHermesSwapWorkflow(workflowValue: unknown): string[] {
  const errors: string[] = [];
  const jobs = asRecord(asRecord(workflowValue).jobs);

  for (const [jobName, jobValue] of Object.entries(jobs)) {
    const job = asRecord(jobValue);
    const expectedCondition = JOB_CONDITIONS[jobName as keyof typeof JOB_CONDITIONS];
    const steps = asSteps(job.steps);
    const provisionSteps = steps.filter(
      (step) =>
        step.name === TRUSTED_HERMES_SWAP_STEP_NAME || step.id === TRUSTED_HERMES_SWAP_STEP_ID,
    );

    if (expectedCondition === undefined) {
      if (provisionSteps.length > 0) {
        errors.push(`${jobName} job must not provision trusted Hermes swap`);
      }
      continue;
    }

    if (job.needs !== "generate-matrix") {
      errors.push(`${jobName} trusted Hermes swap job must depend on controller validation`);
    }
    if (provisionSteps.length !== 1) {
      errors.push(`${jobName} job must contain exactly one trusted Hermes swap step`);
      continue;
    }

    const provision = provisionSteps[0]!;
    if (
      !isDeepStrictEqual(Object.keys(provision).sort(), ["env", "id", "if", "name", "run", "shell"])
    ) {
      errors.push(`${jobName} trusted Hermes swap step must preserve its fail-closed shape`);
    }
    if (provision.id !== TRUSTED_HERMES_SWAP_STEP_ID) {
      errors.push(`${jobName} trusted Hermes swap step must preserve its fixed id`);
    }
    if (provision.name !== TRUSTED_HERMES_SWAP_STEP_NAME) {
      errors.push(`${jobName} trusted Hermes swap step must preserve its fixed name`);
    }
    if (provision.if !== expectedCondition) {
      errors.push(`${jobName} trusted Hermes swap step must preserve the exact-head main guard`);
    }
    if (provision.shell !== TRUSTED_HERMES_SWAP_SHELL) {
      errors.push(`${jobName} trusted Hermes swap step must use the isolated Bash shell`);
    }
    if (!isDeepStrictEqual(asRecord(provision.env), TRUSTED_HERMES_SWAP_ENV)) {
      errors.push(
        `${jobName} trusted Hermes swap step must bind only trusted workflow, checkout, and runner identity`,
      );
    }
    if ((provision.run ?? "").trimEnd() !== TRUSTED_HERMES_SWAP_SCRIPT) {
      errors.push(`${jobName} trusted Hermes swap step must preserve the fixed privileged program`);
    }

    const checkoutIndex = steps.findIndex((step) =>
      (step.uses ?? "").startsWith("actions/checkout@"),
    );
    if (steps.indexOf(provision) !== 0 || checkoutIndex <= 0) {
      errors.push(`${jobName} trusted Hermes swap step must run before candidate checkout`);
    }
  }

  for (const jobName of Object.keys(JOB_CONDITIONS)) {
    if (!(jobName in jobs)) {
      errors.push(`workflow missing trusted Hermes swap job ${jobName}`);
    }
  }

  return errors;
}
