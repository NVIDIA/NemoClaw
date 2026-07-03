// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    latestLogs = await options.readLogs(attempt);
    const proof = deniedReasonLogProof(latestLogs, options.endpoint);
    if (proof) return proof;
    await options.settle();
  }
  throw new Error(
    `denied egress audit event for ${options.endpoint} did not settle into nemoclaw logs --tail 50:\n${latestLogs}`,
  );
}
