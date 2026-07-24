// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession, summarizeForDebug } from "./onboard-session";

describe("onboard session gateway authority", () => {
  it("summarizes the checkpointed gateway authority without its state directory (#6576)", () => {
    const selected = createSession({ sandboxName: "my-assistant" });
    selected.checkpoint = {
      ...selected.checkpoint!,
      gatewayAuthority: {
        kind: "selected",
        value: {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "externally-supervised",
          source: "declared",
          endpoint: "http://127.0.0.1:8080",
          stateDir: "/var/lib/openshell/private-gateway-state",
          supervisor: {
            kind: "systemd-system",
            serviceName: "openshell-gateway.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: ["gateway.health"],
        },
      },
    };

    const summary = summarizeForDebug(selected);

    expect(summary?.gatewayAuthority).toMatchObject({
      mode: "externally-supervised",
      source: "declared",
      supervisor: { serviceName: "openshell-gateway.service" },
    });
    expect(JSON.stringify(summary?.gatewayAuthority)).not.toContain("private-gateway-state");
  });
});
