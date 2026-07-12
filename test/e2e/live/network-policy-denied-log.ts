// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PollingError, pollUntil } from "../fixtures/polling.ts";

export type DeniedReasonLogProof = {
  line: string;
  reason: string;
};

export function deniedReasonLogProof(
  output: string,
  endpoint: string,
  reasonIncludes?: string,
): DeniedReasonLogProof | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes("NET:OPEN") || !line.includes("DENIED") || !line.includes(endpoint)) {
      continue;
    }
    const reason = line.match(/\[reason:([^\]]*)\]/u)?.[1] ?? "";
    if (reasonIncludes && !reason.includes(reasonIncludes)) continue;
    return { line, reason };
  }
  return null;
}

export async function pollDeniedReasonLog(options: {
  attempts: number;
  endpoint: string;
  reasonIncludes?: string;
  readLogs: (attempt: number) => Promise<string>;
  settle: () => Promise<void>;
}): Promise<DeniedReasonLogProof> {
  let latestLogs = "";
  try {
    const result = await pollUntil({
      artifactPrefix: "network-policy-denied-log",
      attempts: options.attempts,
      delayMs: 1,
      sleep: async () => options.settle(),
      probe: async (attempt) => {
        latestLogs = await options.readLogs(attempt);
        return deniedReasonLogProof(latestLogs, options.endpoint, options.reasonIncludes);
      },
      accept: (proof) => proof !== null,
    });
    return result.value as DeniedReasonLogProof;
  } catch (error) {
    if (!(error instanceof PollingError)) throw error;
    const reasonRequirement = options.reasonIncludes
      ? ` with reason containing ${JSON.stringify(options.reasonIncludes)}`
      : "";
    throw new Error(
      `denied egress audit event for ${options.endpoint}${reasonRequirement} did not settle into nemoclaw logs --tail 50:\n${latestLogs}`,
    );
  }
}
