// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { buildRevisionScopedMcpAuthorizationPattern } from "./mcp-provider-rewrite-probe.ts";

export async function assertDeepAgentsMcpConfig(
  sandbox: SandboxClient,
  options: {
    sandboxName: string;
    serverName: string;
    mcpUrl: string;
    hostSecret: string;
  },
): Promise<void> {
  const authorizationPattern = buildRevisionScopedMcpAuthorizationPattern("FAKE_MCP_SECRET");
  const script = [
    "set -eu",
    "python3 - <<'PY'",
    "import json, pathlib, re",
    "path = pathlib.Path('/sandbox/.deepagents/.nemoclaw-mcp.json')",
    "text = path.read_text(encoding='utf-8')",
    "data = json.loads(text)",
    `entry = data['mcpServers'][${JSON.stringify(options.serverName)}]`,
    "assert entry['type'] == 'http'",
    `assert entry['url'] == ${JSON.stringify(options.mcpUrl)}`,
    `assert re.fullmatch(${JSON.stringify(authorizationPattern)}, entry['headers']['Authorization'])`,
    `assert ${JSON.stringify(options.hostSecret)} not in text`,
    "PY",
  ].join("\n");
  const result = await sandbox.execShell(options.sandboxName, trustedSandboxShellScript(script), {
    artifactName: "deepagents-mcp-config-assertions",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [options.hostSecret, Buffer.from(script, "utf8").toString("base64")],
    timeoutMs: 60_000,
  });
  assertExitZero(result, "Deep Agents MCP config contains placeholder and no raw host secret");
}
