// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "../../state/registry";
import { selectSandboxOwningGateway } from "./gateway-select";

describe("selectSandboxOwningGateway", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    [8080, "nemoclaw"],
    [8091, "nemoclaw-8091"],
  ] as const)("selects the recorded gateway on port %d", async (gatewayPort, gatewayName) => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort } as never);
    const selectGateway = vi.fn().mockResolvedValue({ ok: true, state: "completed" });
    expect(await selectSandboxOwningGateway("alpha", { selectGateway })).toEqual({
      outcome: "selected",
      gatewayName,
    });
    expect(selectGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName },
    });
  });
  it("does not change selection for an unregistered sandbox", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    const selectGateway = vi.fn();
    expect(await selectSandboxOwningGateway("ghost", { selectGateway })).toEqual({
      outcome: "unregistered",
      gatewayName: null,
    });
    expect(selectGateway).not.toHaveBeenCalled();
  });
  it("propagates a typed selection failure without retrying", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const selectGateway = vi.fn().mockResolvedValue({
      ok: false,
      error: { kind: "authentication", message: "Access denied." },
      unsupported: false,
      ambiguous: false,
    });
    expect(await selectSandboxOwningGateway("beta", { selectGateway })).toEqual({
      outcome: "failed",
      gatewayName: "nemoclaw-8091",
    });
    expect(selectGateway).toHaveBeenCalledTimes(1);
  });
});
