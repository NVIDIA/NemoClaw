// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { renderPublicOclifHelp } from "./public-oclif-help";

describe("renderPublicOclifHelp", () => {
  it("renders public usage and oclif metadata without internal command IDs", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    renderPublicOclifHelp("sandbox:logs", "<name> logs [--follow]");
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();
    expect(output).toContain("USAGE");
    expect(output).toContain("$ nemoclaw <name> logs [--follow]");
    expect(output).toContain("FLAGS");
    expect(output).toContain("--follow");
    expect(output).toContain("Stream sandbox logs");
    expect(output).toContain("$ nemoclaw sandbox logs alpha --follow");
    expect(output).not.toContain("sandbox:logs");
  });
});
