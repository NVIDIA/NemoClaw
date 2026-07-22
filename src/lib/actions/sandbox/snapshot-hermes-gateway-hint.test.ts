// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { printHermesGatewayRestoreHint } from "./snapshot-hermes-gateway-hint";

describe("printHermesGatewayRestoreHint (#7312)", () => {
  it("recommends a gateway restart after restoring state files into a Hermes sandbox", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint("clone-test", "hermes", 2, writeLine);

    expect(writeLine).toHaveBeenCalledTimes(1);
    expect(writeLine.mock.calls[0][0]).toContain("clone-test gateway restart");
  });

  it("stays quiet when no state files were restored", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint("clone-test", "hermes", 0, writeLine);

    expect(writeLine).not.toHaveBeenCalled();
  });

  it("stays quiet for non-Hermes agents", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint("clone-test", "openclaw", 2, writeLine);
    printHermesGatewayRestoreHint("clone-test", undefined, 2, writeLine);

    expect(writeLine).not.toHaveBeenCalled();
  });
});
