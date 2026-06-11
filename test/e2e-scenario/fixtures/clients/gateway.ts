// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { assertExitZero } from "./command.ts";
import type { HostCliClient } from "./host.ts";

export class GatewayClient {
  private readonly host: HostCliClient;

  constructor(host: HostCliClient) {
    this.host = host;
  }

  status(options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.host.nemoclaw(["gateway", "status"], {
      artifactName: "gateway-status",
      ...options,
    });
  }

  async expectHealthy(options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    const result = await this.status(options);
    assertExitZero(result, "nemoclaw gateway status");
    return result;
  }
}
