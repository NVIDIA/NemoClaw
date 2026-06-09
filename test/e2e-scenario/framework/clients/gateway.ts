// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "../shell-probe.ts";
import { assertExitZero } from "./command.ts";
import type { HostCliClient } from "./host.ts";

export class GatewayClient {
  private readonly host: HostCliClient;

  constructor(host: HostCliClient) {
    this.host = host;
  }

  status(): Promise<ShellProbeResult> {
    return this.host.nemoclaw(["gateway", "status"], { artifactName: "gateway-status" });
  }

  async expectHealthy(): Promise<ShellProbeResult> {
    const result = await this.status();
    assertExitZero(result, "nemoclaw gateway status");
    return result;
  }
}
