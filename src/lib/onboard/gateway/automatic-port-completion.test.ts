// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { completeAutomaticGatewayPortAfterOnboard } from "./automatic-port-completion";

describe("direct onboarding automatic gateway port completion", () => {
  it("promotes the trusted pending marker after direct onboarding succeeds (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-onboard-port-"));
    try {
      const root = path.join(home, ".nemoclaw");
      const gateways = path.join(root, "gateways");
      const stateDir = path.join(gateways, "8990");
      const pending = path.join(stateDir, "automatic-gateway-port.pending");
      const completed = path.join(stateDir, "automatic-gateway-port");
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(root, 0o700);
      fs.chmodSync(gateways, 0o700);
      fs.chmodSync(stateDir, 0o700);
      fs.writeFileSync(pending, "8990\n", { mode: 0o600 });

      expect(
        completeAutomaticGatewayPortAfterOnboard({
          HOME: home,
          NEMOCLAW_GATEWAY_PORT: "8990",
          _NEMOCLAW_AUTOMATIC_GATEWAY_PORT: "1",
        }),
      ).toBe(true);
      expect(fs.existsSync(pending)).toBe(false);
      expect(fs.readFileSync(completed, "utf8")).toBe("8990\n");
      expect(
        completeAutomaticGatewayPortAfterOnboard({
          HOME: home,
          NEMOCLAW_GATEWAY_PORT: "8990",
          _NEMOCLAW_AUTOMATIC_GATEWAY_PORT: "1",
        }),
      ).toBe(true);
      expect(
        completeAutomaticGatewayPortAfterOnboard({
          HOME: home,
          NEMOCLAW_GATEWAY_PORT: "8990",
          _NEMOCLAW_AUTOMATIC_GATEWAY_PORT: "1",
        }),
      ).toBe(true);
      expect(fs.readFileSync(completed, "utf8")).toBe("8990\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not touch pending state for an explicit gateway port", () => {
    expect(
      completeAutomaticGatewayPortAfterOnboard({
        NEMOCLAW_GATEWAY_PORT: "8990",
      }),
    ).toBe(false);
  });
});
