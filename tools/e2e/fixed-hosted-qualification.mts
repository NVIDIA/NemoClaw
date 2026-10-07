// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Explicit protocol/credential representatives, not a vendor/platform matrix.
export const FIXED_HOSTED_QUALIFICATIONS = [
  {
    id: "hermes-fixed-bearer-inference-switch",
    agent: "hermes",
    provider: "hermes-provider",
    credential: "NOUS_API_KEY",
    protocol: "openai-completions",
  },
  {
    id: "hermes-fixed-anthropic-inference-switch",
    agent: "hermes",
    provider: "anthropic-prod",
    credential: "ANTHROPIC_API_KEY",
    protocol: "anthropic-messages",
  },
  {
    id: "hermes-fixed-openrouter-inference-switch",
    agent: "hermes",
    provider: "openrouter-api",
    credential: "OPENROUTER_API_KEY",
    protocol: "openai-completions",
  },
  {
    id: "openclaw-fixed-openai-inference-switch",
    agent: "openclaw",
    provider: "openai-api",
    credential: "OPENAI_API_KEY",
    protocol: "openai-completions",
  },
  {
    id: "openclaw-fixed-anthropic-inference-switch",
    agent: "openclaw",
    provider: "anthropic-prod",
    credential: "ANTHROPIC_API_KEY",
    protocol: "anthropic-messages",
  },
] as const;

export function fixedHostedQualification(id: string) {
  return FIXED_HOSTED_QUALIFICATIONS.find((row) => row.id === id);
}

export function validateFixedHostedModel(model: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(model)) {
    throw new Error(
      "Fixed hosted qualification requires an explicit model ID without whitespace or shell syntax",
    );
  }
}

export function validateFixedHostedSelection(
  ids: readonly string[],
  model: string,
  event: string,
): void {
  const selected = ids.filter((id) => fixedHostedQualification(id));
  if (selected.length === 0) {
    if (model !== "")
      throw new Error("hosted_model requires one fixed hosted qualification target");
    return;
  }
  if (event !== "workflow_dispatch" || ids.length !== 1) {
    throw new Error("Fixed hosted qualification requires one explicitly selected manual target");
  }
  validateFixedHostedModel(model);
}

// Executed by the trusted reusable workflow before candidate checkout. No candidate
// metadata chooses the credential name, provider, protocol, or model validation.
export const FIXED_HOSTED_PLAN_SCRIPT = `hosted_credential=""
case "$CATALOGUE_ID" in
${FIXED_HOSTED_QUALIFICATIONS.map((row) => `  ${row.id}) [[ "$TARGET_ID" == "${row.agent}-inference-switch" && "$TEST_FILE" == "test/e2e/live/${row.agent}-inference-switch.test.ts" && "$SHARD" == "${row.provider}" ]] || fail "fixed hosted identity"; hosted_credential=${row.credential} ;;`).join("\n")}
  *) [[ -z "\${HOSTED_MODEL:-}" ]] || fail "unexpected hosted model" ;;
esac
if [[ -n "$hosted_credential" ]]; then
  [[ "$RUNTIME_PROVIDER" == "docker" ]] || fail "fixed hosted runtime"
  [[ "$HOSTED_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$ ]] || fail "hosted model"
fi
printf 'hosted_credential=%s\n' "$hosted_credential" >>"$GITHUB_OUTPUT"`;

export const FIXED_HOSTED_RUN_SCRIPT = `if [[ -n "$HOSTED_CREDENTIAL_NAME" ]]; then
  [[ -n "$HOSTED_PROVIDER_API_KEY" ]] || { echo "::error::Selected hosted provider credential is unavailable" >&2; exit 1; }
  printf -v "$HOSTED_CREDENTIAL_NAME" '%s' "$HOSTED_PROVIDER_API_KEY"
  export "$HOSTED_CREDENTIAL_NAME"
  export NEMOCLAW_SWITCH_MODEL="$HOSTED_MODEL"
fi
unset HOSTED_PROVIDER_API_KEY`;
