// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { captureHostCommand } from "./doctor-host-command";

describe("captureHostCommand", () => {
  it("treats signal-terminated processes as failed", () => {
    const result = captureHostCommand(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);

    expect(result.status).not.toBe(0);
  });
});
