// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesDiscordHttpProxyWebSocketUrl(host: string, port: number | string): string {
  return `http://${host}:${port}/gateway`;
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
