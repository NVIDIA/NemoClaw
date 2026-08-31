// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import { stripAnsi } from "../adapters/openshell/client";
import { parseGatewayInference, type GatewayInference } from "./config";

const BASE_GATEWAY_NAME = "nemoclaw";

type CaptureLiveInference = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => Pick<CaptureOpenshellResult, "status" | "output" | "error" | "signal">;

export interface LiveGatewayInferenceResult {
  args: string[];
  inference: GatewayInference | null;
  output: string;
  status: number | null;
}

function hasGatewayInferenceSection(output: string): boolean {
  return /^Gateway inference:\s*$/im.test(output);
}

export function getLiveGatewayInference(
  capture: CaptureLiveInference,
  opts: { timeout?: number; gatewayName?: string } = {},
): LiveGatewayInferenceResult {
  const gatewayName = opts.gatewayName ?? BASE_GATEWAY_NAME;
  const attempts = [
    ["inference", "get", "-g", gatewayName],
    ...(gatewayName === BASE_GATEWAY_NAME ? [["inference", "get"]] : []),
  ];
  let last: LiveGatewayInferenceResult = {
    args: attempts[0],
    inference: null,
    output: "",
    status: 1,
  };

  for (const args of attempts) {
    const result = capture(args, { ignoreError: true, timeout: opts.timeout });
    const output = stripAnsi(result.output || "").trim();
    const inference = parseGatewayInference(output);
    last = {
      args,
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
