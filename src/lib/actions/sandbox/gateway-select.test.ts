// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as registry from "../../state/registry";
import { selectSandboxOwningGateway } from "./gateway-select";

describe("selectSandboxOwningGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the owning non-default gateway for a registered sandbox", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const run = vi.fn(() => ({ status: 0 }) as never);

    const selected = selectSandboxOwningGateway("beta", run);

    expect(selected).toEqual({ outcome: "selected", gatewayName: "nemoclaw-8091" });
    expect(run).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-8091"],
      expect.objectContaining({
        ignoreError: true,
        stdio: ["inherit", "pipe", "inherit"],
      }),
    );
  });

  it("replays selection output through the stdio adapter", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8080 } as never);
    const output = "\u001b[32m✓ Active gateway set to 'nemoclaw'\u001b[0m\n";
    const run = vi.fn(() => ({ status: 0, stdout: output }) as never);
    const write = vi.fn();

    expect(selectSandboxOwningGateway("alpha", run, write)).toEqual({
      outcome: "selected",
      gatewayName: "nemoclaw",
    });
    expect(write).toHaveBeenCalledWith(output);
  });

  it("keeps the bare default gateway name for a default-port sandbox", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8080 } as never);
    const run = vi.fn(() => ({ status: 0 }) as never);

    expect(selectSandboxOwningGateway("alpha", run)).toEqual({
      outcome: "selected",
      gatewayName: "nemoclaw",
    });
    expect(run).toHaveBeenCalledWith(["gateway", "select", "nemoclaw"], expect.anything());
  });

  it("does not touch the active gateway for an unregistered sandbox", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    const run = vi.fn(() => ({ status: 0 }) as never);

    expect(selectSandboxOwningGateway("ghost", run)).toEqual({
      outcome: "unregistered",
      gatewayName: null,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports failure when the gateway select command exits nonzero", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const run = vi.fn(() => ({ status: 1 }) as never);

    expect(selectSandboxOwningGateway("beta", run)).toEqual({
      outcome: "failed",
      gatewayName: "nemoclaw-8091",
    });
  });

  it("reports failure when the gateway select command errors on spawn", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const run = vi.fn(() => ({ status: null, error: new Error("spawn failed") }) as never);

    expect(selectSandboxOwningGateway("beta", run)).toEqual({
      outcome: "failed",
      gatewayName: "nemoclaw-8091",
    });
  });
});
