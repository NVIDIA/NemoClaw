// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import { stripAnsi } from "../adapters/openshell/client";
import { buildGatewayInferenceGetArgs } from "../actions/sandbox/connect-inference-gateway";
import { parseGatewayInference, type GatewayInference } from "./config";

const BASE_GATEWAY_NAME = "nemoclaw";

type CaptureLiveInference = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => Pick<CaptureOpenshellResult, "status" | "output" | "error" | "signal">;

export interface LiveGatewayInferenceResult {
  failure: "execution" | "exit" | "timeout" | null;
  inference: GatewayInference | null;
  output: string;
  status: number | null;
}

function hasGatewayInferenceSection(output: string): boolean {
  return /^Gateway inference:\s*$/im.test(output);
}

function classifyLookupFailure(
  result: Pick<CaptureOpenshellResult, "status" | "error" | "signal">,
): LiveGatewayInferenceResult["failure"] {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ETIMEDOUT") return "timeout";
  if (result.status === null) return "execution";
  if (result.status !== 0 || result.error || result.signal) return "exit";
  return null;
}

export function getLiveGatewayInference(
  capture: CaptureLiveInference,
  opts: { timeout?: number; gatewayName?: string } = {},
): LiveGatewayInferenceResult {
  const gatewayName = opts.gatewayName ?? BASE_GATEWAY_NAME;
  const attempts = [
    buildGatewayInferenceGetArgs(gatewayName),
    ...(gatewayName === BASE_GATEWAY_NAME ? [["inference", "get"]] : []),
  ];
  let last: LiveGatewayInferenceResult = {
    failure: "execution",
    inference: null,
    output: "",
    status: 1,
  };

  for (const args of attempts) {
    const result = capture(args, { ignoreError: true, timeout: opts.timeout });
    const output = stripAnsi(result.output || "").trim();
    const inference = parseGatewayInference(output);
    last = {
      failure: classifyLookupFailure(result),
      inference,
      output,
      status: result.status,
    };

    if (result.status === 0 && (inference || hasGatewayInferenceSection(output))) {
      return last;
    }
  }

  return last;
}
