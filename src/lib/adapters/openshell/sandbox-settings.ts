// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget, OpenShellSandboxResult } from "./sandbox-observer";

export interface OpenShellSandboxSettings {
  enableAuditLogs(
    request: Readonly<{
      target: OpenShellGatewayTarget;
      sandboxName: string;
      timeoutMs: number;
    }>,
  ): Promise<OpenShellSandboxResult<void>>;
}
