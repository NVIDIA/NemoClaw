// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import { stripAnsi } from "../adapters/openshell/client";
import { parseGatewayInference, type GatewayInference } from "./config";
import { buildGatewayInferenceGetArgs } from "./gateway/command-args";

const BASE_GATEWAY_NAME = "nemoclaw";

type CaptureLiveInference = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => Pick<CaptureOpenshellResult, "status" | "output" | "error" | "signal">;

export interface LiveGatewayInferenceResult {
  failure: "execution" | "exit" | "output" | "timeout" | null;
  inference: GatewayInference | null;
  output: string;
  status: number | null;
}

function hasUnconfiguredInferenceSection(output: string): boolean {
  let inInferenceSection = false;
  for (const line of output.split("\n")) {
    if (/^(?:Gateway )?Inference:\s*$/i.test(line)) {
      inInferenceSection = true;
      continue;
    }
    if (inInferenceSection && /^\S.*:$/.test(line)) return false;
    if (inInferenceSection && line.trim() === "Not configured") return true;
  }
  return false;
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
    const parsedInference = parseGatewayInference(output);
    const inference =
      parsedInference?.provider && parsedInference.model ? parsedInference : null;
    const recognizedOutput =
      Boolean(inference) || (!parsedInference && hasUnconfiguredInferenceSection(output));
    const failure = classifyLookupFailure(result);
    last = {
      failure: failure ?? (result.status === 0 && !recognizedOutput ? "output" : null),
      inference,
      output,
      status: result.status,
    };

    if (result.status === 0 && recognizedOutput) {
      return last;
    }
  }

  return last;
}
