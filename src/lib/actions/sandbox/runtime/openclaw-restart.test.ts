// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildOpenClawGatewayRestartCommand } from "./openclaw-restart";

function runRestart(responses: unknown[], commandStatus = 0) {
  const command = buildOpenClawGatewayRestartCommand();
  const script = command.slice(command.indexOf("\n") + 1, command.lastIndexOf("\nPY"));
  const fixture = `import http.client, json, subprocess, time, types
responses = iter(json.loads(${JSON.stringify(JSON.stringify(responses))}))
clock = [100.0]
probes = []
sleeps = []
time.monotonic = lambda: clock[0]
def sleep(seconds):
    sleeps.append(seconds)
    clock[0] += seconds
time.sleep = sleep
subprocess.run = lambda argv, **kwargs: types.SimpleNamespace(returncode=${commandStatus})
class Connection:
    def __init__(self, host, port, timeout):
        assert (host, port, timeout) == ("127.0.0.1", 18789, 2)
    def request(self, method, target):
        assert (method, target) == ("GET", "/readyz")
    def getresponse(self):
        value = next(responses)
        probes.append(value)
        return types.SimpleNamespace(status=200, read=lambda size: json.dumps(value).encode())
    def close(self):
        pass
http.client.HTTPConnection = Connection
try:
    exec(${JSON.stringify(script)})
except SystemExit as error:
    print(json.dumps({"exit": error.code, "probes": probes, "sleeps": sleeps}))
else:
    print(json.dumps({"exit": 0, "probes": probes, "sleeps": sleeps}))
`;
  const result = spawnSync("python3", ["-c", fixture], { encoding: "utf8", timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("OpenClaw restart readiness", () => {
  it("waits through old healthy responses until a new gateway becomes ready", () => {
    const responses = [
      { ready: true, uptimeMs: 60000 },
      { ready: true, uptimeMs: 61000 },
      { ready: false, uptimeMs: 500 },
      { ready: true, uptimeMs: 1500 },
    ];
    expect(runRestart(responses)).toEqual({ exit: 0, probes: responses, sleeps: [1, 1, 1] });
  });

  it("does not probe or report success after the native restart fails", () => {
    expect(runRestart([], 7)).toEqual({ exit: 7, probes: [], sleeps: [] });
  });

  it("times out when the old gateway stays healthy", () => {
    const result = runRestart(
      Array.from({ length: 200 }, () => ({ ready: true, uptimeMs: 999999 })),
    );
    expect(result.exit).toContain("new gateway runtime");
    expect(result.probes).toHaveLength(200);
  });
});
