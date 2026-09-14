// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatLlamaCppSandboxUnreachableMessage } from "./sandbox-reachability";

describe("formatLlamaCppSandboxUnreachableMessage", () => {
  it("names loopback-only Docker publish and the dual bind (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
      subnet: "172.18.0.0/16",
      gatewayIp: "172.18.0.1",
    });
    expect(message).toContain("host.openshell.internal:8081");
    expect(message).toContain("-p 127.0.0.1:8081:8081");
    expect(message).toContain("-p 172.18.0.1:8081:8081");
    expect(message).toContain(
      "sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 8081 proto tcp",
    );
  });

  it("keeps a placeholder gateway bind when inspect did not return an IP (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
    });
    expect(message).toContain("-p <docker-gateway-ip>:8081:8081");
    expect(message).toContain("docker network inspect openshell");
  });
});
