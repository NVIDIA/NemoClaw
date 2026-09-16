// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Native restart can return while the previous listener still serves requests. */
export function buildOpenClawGatewayRestartCommand(port = 18789): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("OpenClaw gateway port is invalid");
  }
  return `python3 - <<'PY'
import http.client
import json
import subprocess
import time

requested_at = time.monotonic()
deadline = requested_at + 200
result = subprocess.run(["openclaw", "gateway", "restart"], timeout=180, check=False)
if result.returncode != 0:
    raise SystemExit(result.returncode)
while time.monotonic() < deadline:
    probe_started = time.monotonic()
    connection = http.client.HTTPConnection("127.0.0.1", ${port}, timeout=2)
    try:
        connection.request("GET", "/readyz")
        response = connection.getresponse()
        ready = json.loads(response.read(65537))
        uptime = ready.get("uptimeMs")
        if (response.status == 200 and ready.get("ready") is True
                and isinstance(uptime, (int, float)) and not isinstance(uptime, bool)
                and uptime >= 0 and probe_started - uptime / 1000 >= requested_at):
            break
    except (OSError, ValueError, http.client.HTTPException):
        pass
    finally:
        connection.close()
    time.sleep(min(1, max(0, deadline - time.monotonic())))
else:
    raise SystemExit("OpenClaw did not become ready in a new gateway runtime after restart")
PY`;
}
