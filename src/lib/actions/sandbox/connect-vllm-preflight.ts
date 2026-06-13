// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { preflightVllmModelEnv } from "../../inference/vllm-models";

// Managed-vLLM env vars only steer the express-vLLM install path, but users
// often re-export them in the same shell they later run `connect` in. Run the
// installer's validators up-front so typos, malformed extra args, or a gated
// model with no `HF_TOKEN` fail fast on the host — before any sandbox readiness
// probe, inference-route reset, or SSH attach — instead of being silently
// ignored.
export function preflightVllmModelEnvOrExit(): void {
  const result = preflightVllmModelEnv();
  if (result.ok) return;
  console.error("");
  console.error(`  Error: ${result.message}`);
  console.error(
    `  Hint: NEMOCLAW_VLLM_MODEL is consumed by the managed-vLLM install path, and NEMOCLAW_VLLM_EXTRA_ARGS_JSON is consumed there too; neither is used by \`${CLI_NAME} <name> connect\`.`,
  );
  console.error(
    "  Unset the managed-vLLM env var before reconnecting, or fix the value and re-run the install path that serves the model.",
  );
  process.exit(1);
}
