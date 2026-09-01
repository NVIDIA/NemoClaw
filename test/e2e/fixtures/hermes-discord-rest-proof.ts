// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type DiscordRestResult = {
  statusCode?: unknown;
  error?: unknown;
};

export function requireHermesDiscordRestProof(stdout: string): number {
  const resultLine = stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .at(-1);
  if (resultLine === undefined) {
    throw new Error("Discord API call did not return a JSON result");
  }

  const result = JSON.parse(resultLine) as DiscordRestResult;
  if (Object.hasOwn(result, "error")) {
    throw new Error(
      `Discord API call failed: ${typeof result.error === "string" ? result.error : "invalid error result"}`,
    );
  }
  if (result.statusCode !== 200 && result.statusCode !== 401) {
    throw new Error(`Unexpected Discord users/@me response: ${String(result.statusCode)}`);
  }
  return result.statusCode;
}
