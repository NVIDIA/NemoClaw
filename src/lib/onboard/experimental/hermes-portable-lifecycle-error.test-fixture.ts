// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { createHermesPortableLifecycleTestDeps } from "./hermes-portable-lifecycle.test-fixture";

/** Add the pinned server's Error details without changing later lifecycle observations. */
export function withOpenShellErrorFields(
  capture: ReturnType<typeof createHermesPortableLifecycleTestDeps>["captureOpenShell"],
  fields: Record<string, unknown>,
) {
  return vi.fn((args: readonly string[]) => {
    const result = capture(args);
    if (args[0] !== "sandbox" || args[1] !== "list") return result;
    const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
    return {
      ...result,
      stdout: JSON.stringify(
        rows.map((row) =>
          row.phase === "Error" ? { ...row, workspace: "default", ...fields } : row,
        ),
      ),
    };
  });
}
