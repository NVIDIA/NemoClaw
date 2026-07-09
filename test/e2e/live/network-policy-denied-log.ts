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
): DeniedReasonLogProof | null {
  const line = output
    .split(/\r?\n/u)
    .find(
      (candidate) =>
        candidate.includes("NET:OPEN") &&
        candidate.includes("DENIED") &&
        candidate.includes(endpoint),
    );
  if (!line) return null;
  const reason = line.match(/\[reason:([^\]]*)\]/u)?.[1] ?? "";
  return { line, reason };
}

export async function pollDeniedReasonLog(options: {
  attempts: number;
  endpoint: string;
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
        return deniedReasonLogProof(latestLogs, options.endpoint);
      },
      accept: (proof) => proof !== null,
    });
    return result.value as DeniedReasonLogProof;
  } catch (error) {
    if (!(error instanceof PollingError)) throw error;
    throw new Error(
      `denied egress audit event for ${options.endpoint} did not settle into nemoclaw logs --tail 50:\n${latestLogs}`,
    );
  }
}
