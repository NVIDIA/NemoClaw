// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import { runSandboxSnapshot } from "./snapshot";

afterEach(() => {
  vi.restoreAllMocks();
});

it("prints create, list, and restore usage for the bare help branch", async () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  await runSandboxSnapshot("alpha", { kind: "help" });

  const output = consoleLog.mock.calls.flat().join("\n");
  expect(output).toContain("Usage:");
  expect(output).toContain("alpha snapshot create");
  expect(output).toContain("alpha snapshot list");
  expect(output).toContain("alpha snapshot restore");
});
