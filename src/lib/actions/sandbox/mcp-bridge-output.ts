// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFull } from "../../security/redact";
import type { McpBridgeEntry } from "../../state/registry";

export type OpenShellCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

const UNSAFE_DISPLAY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MCP_AUTHORIZATION_VALUE =
  /(\bauthorization\b["']?\s*[:=]\s*["']?)(Bearer\s+)?([^"',\s}\]]+)/gi;

function explicitCredentialValues(
  entry: Pick<McpBridgeEntry, "env"> | undefined,
  envValues: Record<string, string>,
): string[] {
  const values = [
    ...(entry?.env.map((name) => envValues[name] ?? process.env[name] ?? "") ?? []),
    ...Object.values(envValues),
  ];
  return [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function redactMcpOutput(
  text: string,
  entry: Pick<McpBridgeEntry, "env"> | undefined,
  envValues: Record<string, string>,
): string {
  let output = redactFull(text || "");
  for (const value of explicitCredentialValues(entry, envValues)) {
    output = output.replaceAll(value, "***REDACTED***");
  }
  return output
    .replace(/(\bBearer\s+)<REDACTED>/gi, "$1***REDACTED***")
    .replace(MCP_AUTHORIZATION_VALUE, (_match, prefix, bearer, value) => {
      const marker = value === "***REDACTED***" || value === "<REDACTED>";
      return `${prefix}${bearer ?? ""}${marker ? value : "***REDACTED***"}`;
    })
    .replace(/(\bBearer\s+)(?!\*{3}REDACTED\*{3}|<REDACTED>)\S+/gi, "$1***REDACTED***")
    .replace(UNSAFE_DISPLAY_CONTROL_CHARS, "");
}

export function redactBridgeSecretsForDisplay(
  text: string,
  entry?: Pick<McpBridgeEntry, "env">,
  envValues: Record<string, string> = {},
): string {
  return redactMcpOutput(text, entry, envValues);
}

export function redactCredentialValuesForDisplay(
  value: string,
  envValues: Record<string, string>,
): string {
  return redactMcpOutput(value, undefined, envValues);
}

export function commandOutput(
  result: OpenShellCommandResult,
  envValues: Record<string, string> = {},
): string {
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const stderr =
    typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? "");
  return redactMcpOutput(`${stderr}${stdout}`, undefined, envValues).replace(/\r/g, "").trim();
}
