// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const config = require("./config") as typeof import("./config");

describe("recorded sandbox configuration target", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the same runtime selection when restarting after a config write", async () => {
    const selection = { gatewayName: "nemoclaw-9090", workspace: "default" };
    const restart = vi.fn(async () => ({ ok: true }));
    await config.restartSandboxAgentAfterConfigSet("alpha", "openclaw", restart, selection);
    expect(restart).toHaveBeenCalledExactlyOnceWith("alpha", { runtimeSelection: selection });
  });
});
