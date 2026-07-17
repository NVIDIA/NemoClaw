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

    expect(selected).toBe("nemoclaw-8091");
    expect(run).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-8091"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("keeps the bare default gateway name for a default-port sandbox", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8080 } as never);
    const run = vi.fn(() => ({ status: 0 }) as never);

    expect(selectSandboxOwningGateway("alpha", run)).toBe("nemoclaw");
    expect(run).toHaveBeenCalledWith(["gateway", "select", "nemoclaw"], expect.anything());
  });

  it("does not touch the active gateway for an unregistered sandbox", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    const run = vi.fn(() => ({ status: 0 }) as never);

    expect(selectSandboxOwningGateway("ghost", run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
