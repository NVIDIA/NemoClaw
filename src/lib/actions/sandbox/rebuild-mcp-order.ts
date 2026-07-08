// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Keep local inference available until MCP preservation has fully succeeded. */
export async function prepareMcpBeforeBestEffortNimStop<T>(options: {
  prepareMcp(): Promise<T | null>;
  afterPrepare?(preparation: T): Promise<void>;
  stopNim(): void;
  log(message: string): void;
}): Promise<T | null> {
  const preparation = await options.prepareMcp();
  if (preparation === null) return null;
  await options.afterPrepare?.(preparation);

  try {
    options.stopNim();
  } catch (error) {
    // NIM stop already uses ignoreError. Preserve that best-effort contract if
    // the local runtime still throws; recreate force-removes the old name.
    options.log(
      `Best-effort NIM stop failed; continuing rebuild: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return preparation;
}
