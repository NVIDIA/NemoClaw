// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesDiscordHttpProxyWebSocketUrl(host: string, port: number | string): string {
  return `http://${host}:${port}/gateway`;
}

export function isDiscordExternalAccessDenial(statusCode: number, body: string): boolean {
  return statusCode === 403 && /^error code:\s*1010\s*$/iu.test(body.trim());
}

export async function verifyDiscordRestBoundary(
  stdout: string,
  recordUnavailable: (reason: string) => Promise<unknown>,
): Promise<void> {
  const rows = stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map(
      (line) => JSON.parse(line) as { statusCode?: number; body?: string; error?: string },
    );
  const result = rows.at(-1) ?? {};
  switch (result.error ?? "") {
    case "timeout":
      await recordUnavailable("Discord API timed out, matching legacy skip behavior");
      return;
    case "":
      if (isDiscordExternalAccessDenial(result.statusCode ?? 0, result.body ?? "")) {
        await recordUnavailable("Discord edge denied this runner before the API boundary (error 1010)");
        return;
      }
      if ([200, 401].includes(result.statusCode ?? 0)) return;
      throw new Error(
        `Unexpected Discord users/@me response (got ${String(result.statusCode)}): ${stdout}`,
      );
    default:
      throw new Error(`Discord API call failed: ${result.error}`);
  }
}

export const HERMES_DISCORD_REST_PROOF_SOURCE = String.raw`
import json
import os
import re
import socket
import urllib.error
import urllib.request

token = os.environ.get("DISCORD_BOT_TOKEN", "")
if not re.fullmatch(r"openshell:resolve:env:v[0-9]{1,20}_DISCORD_BOT_TOKEN", token):
    print(json.dumps({"error": "missing_current_revision_scoped_token"}))
    raise SystemExit(0)

request = urllib.request.Request(
    "https://discord.com/api/v10/users/@me",
    method="GET",
    headers={"Authorization": "Bot " + token},
)
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        status = response.status
        body = response.read().decode("utf-8", errors="replace")
except urllib.error.HTTPError as error:
    status = error.code
    body = error.read().decode("utf-8", errors="replace")
except (TimeoutError, socket.timeout):
    print(json.dumps({"error": "timeout"}))
    raise SystemExit(0)
except Exception as error:
    print(json.dumps({"error": str(error)}))
    raise SystemExit(0)
print(json.dumps({"statusCode": status, "body": body[:200]}))
`;
