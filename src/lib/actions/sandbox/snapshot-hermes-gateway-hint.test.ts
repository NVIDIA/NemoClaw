// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { printHermesGatewayRestoreHint } from "./snapshot-hermes-gateway-hint";

describe("printHermesGatewayRestoreHint (#7312)", () => {
  it("recommends a gateway restart after restoring a Hermes SQLite state file", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint(
      "clone-test",
      "hermes",
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      writeLine,
    );

    expect(writeLine).toHaveBeenCalledTimes(1);
    expect(writeLine.mock.calls[0][0]).toContain("clone-test gateway restart");
  });

  it("does not print a restart hint for non-database Hermes state files", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint(
      "clone-test",
      "hermes",
      ["SOUL.md"],
      [
        { path: "SOUL.md", strategy: "copy" },
        { path: "runtime/state.db", strategy: "sqlite_backup" },
      ],
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });

  it("does not print a Hermes restart hint for other agents", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint(
      "clone-test",
      "openclaw",
      ["openclaw.json"],
      [{ path: "openclaw.json", strategy: "copy" }],
      writeLine,
    );
    printHermesGatewayRestoreHint(
      "clone-test",
      undefined,
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });
});
