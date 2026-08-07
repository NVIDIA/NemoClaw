#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_name="${1:-tm}"
if [[ ! "$sandbox_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid sandbox name: %s\n' "$sandbox_name" >&2
  exit 2
fi

printf 'Running the standalone Jetson OpenRM policy proof for sandbox %s.\n' "$sandbox_name"
printf 'This bypasses onboarding and its resume checkpoints.\n'
printf 'The current container is preserved as a rollback backup before the production recreation and policy matrix run.\n'
printf 'The matrix briefly widens only the replacement sandbox policy, restores the baseline policy, then restores the original container.\n'

npm run build:cli
exec node - "$sandbox_name" <<'NODE'
const {
  createDockerGpuDiagnosticRedactor,
} = require("./dist/lib/onboard/docker-gpu-diagnostic-redaction");
const {
  runStandaloneJetsonOpenRmPolicyProof,
} = require("./dist/lib/onboard/diagnostics/jetson-openrm-standalone");

runStandaloneJetsonOpenRmPolicyProof(process.argv[2]).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = createDockerGpuDiagnosticRedactor()
    .redactText(message)
    .replace(/[\r\n]+/gu, " ");
  console.error(`Error: ${redacted}`);
  process.exitCode = 1;
});
NODE
