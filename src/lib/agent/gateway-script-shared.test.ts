// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { gatewayLaunchCommand } from "./gateway-script-shared";

describe("gatewayLaunchCommand", () => {
  it("uses setpriv for a requested root-to-user transition", () => {
    const command = gatewayLaunchCommand("agent gateway run --port 19000", "gateway");

    expect(command).toContain(
      "/usr/bin/setpriv --reuid='gateway' --regid='gateway' --init-groups -- agent gateway run --port 19000",
    );
    expect(command).not.toContain("gosu");
  });

  it("fails closed instead of launching as root when setpriv or the target user is unavailable", () => {
    const command = gatewayLaunchCommand("agent gateway run", "gateway");

    expect(command).toContain("setpriv or target user unavailable; refusing root gateway launch");
    expect(command).toContain("exit 1");
  });

  it("does not add an identity transition when no user is requested", () => {
    const command = gatewayLaunchCommand("agent gateway run");

    expect(command).not.toContain("setpriv");
    expect(command).toContain('nohup agent gateway run >> "$_GATEWAY_LOG" 2>&1 &');
  });
});
