// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");

const MANAGED_MCP_VALIDATOR_INVOCATION = [
  'managed_mcp_config="$(',
  "  /opt/venv/bin/python3 -I -c \\",
  "    'from deepagents_code._nemoclaw_managed import managed_mcp_config_path; print(managed_mcp_config_path() or \"\")'",
  ')"',
].join("\n");

function writeAutoApprovalCapability(path: string, content?: string): void {
  const configuredContents = content === undefined ? [] : [content];
  for (const configuredContent of configuredContents) {
    fs.writeFileSync(path, configuredContent, { mode: 0o444 });
    fs.chmodSync(path, 0o444);
  }
}

export function makeWrapperFixture(
  tempDir: string,
  autoApprovalContent?: string,
): { wrapperPath: string; ranMarker: string; autoApprovalPath: string } {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const autoApprovalPath = path.join(tempDir, "dcode-auto-approval");
  const envFile = path.join(tempDir, ".env");
  const authFile = path.join(tempDir, "auth.json");
  const codexAuthFile = path.join(tempDir, "chatgpt-auth.json");
  const source = fs.readFileSync(path.join(agentDir, "dcode-wrapper.sh"), "utf8");
  expect(
    source,
    "managed MCP descriptors must be opened by the long-lived Python process",
  ).not.toContain(MANAGED_MCP_VALIDATOR_INVOCATION);
  const fixture = source
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      'readonly DEEPAGENTS_AUTH_FILE="/sandbox/.deepagents/.state/auth.json"',
      `readonly DEEPAGENTS_AUTH_FILE="${authFile}"`,
    )
    .replace(
      'readonly DEEPAGENTS_CODEX_AUTH_FILE="/sandbox/.deepagents/.state/chatgpt-auth.json"',
      `readonly DEEPAGENTS_CODEX_AUTH_FILE="${codexAuthFile}"`,
    )
    .replace(
      'readonly MANAGED_DCODE_AUTO_APPROVAL_FILE="/usr/local/share/nemoclaw/dcode-auto-approval"',
      `readonly MANAGED_DCODE_AUTO_APPROVAL_FILE="${autoApprovalPath}"`,
    )
    .replace(
      "readonly MANAGED_DCODE_AUTO_APPROVAL_OWNER_UID=0",
      `readonly MANAGED_DCODE_AUTO_APPROVAL_OWNER_UID=${process.getuid?.() ?? 0}`,
    )
    .replace('/opt/venv/bin/python3 -I - "$auth_file"', 'python3 -I - "$auth_file"')
    .replace(
      "exec /opt/venv/bin/python3 -I -m deepagents_code",
      `touch "${ranMarker}"; printf 'dcode-tracing=%s,%s,%s,%s,%s,%s,%s,%s,%s analytics=%s openai-proxy=%s shell-allow-list=%s approval-mode=%s startup-mode=%s\\n' "$DEEPAGENTS_CODE_LANGSMITH_TRACING" "$DEEPAGENTS_CODE_LANGSMITH_TRACING_V2" "$DEEPAGENTS_CODE_LANGCHAIN_TRACING" "$DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2" "$LANGSMITH_TRACING" "$LANGSMITH_TRACING_V2" "$LANGCHAIN_TRACING" "$LANGCHAIN_TRACING_V2" "$OTEL_ENABLED" "$LANGGRAPH_CLI_NO_ANALYTICS" "\${OPENAI_PROXY-__unset__}" "\${DEEPAGENTS_CODE_SHELL_ALLOW_LIST-__unset__}" "\${DEEPAGENTS_CODE_APPROVAL_MODE-__unset__}" "\${DEEPAGENTS_CODE_STARTUP_MODE-__unset__}"; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  writeAutoApprovalCapability(autoApprovalPath, autoApprovalContent);
  fs.writeFileSync(wrapperPath, fixture, { mode: 0o755 });
  return { wrapperPath, ranMarker, autoApprovalPath };
}
