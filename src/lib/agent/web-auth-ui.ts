// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "./defs";

export function printBearerTokenApiAccess(
  sandboxName: string,
  agent: AgentDefinition,
  cliName: string,
  apiPort?: number,
): void {
  if (agent.webAuth.method !== "bearer_token") return;
  const effectiveApiPort =
    typeof apiPort === "number" && Number.isInteger(apiPort) && apiPort >= 1024 && apiPort <= 65535
      ? apiPort
      : (agent.healthProbe?.port ?? agent.forwardPort);
  console.log("");
  console.log("  OpenAI-compatible API (bearer auth)");
  console.log(
    `  Port ${effectiveApiPort} must be forwarded; clients send an Authorization header:`,
  );
  console.log("    Authorization: Bearer <API key>");
  console.log(`  Get the key: ${cliName} ${sandboxName} gateway-token --quiet`);
}
