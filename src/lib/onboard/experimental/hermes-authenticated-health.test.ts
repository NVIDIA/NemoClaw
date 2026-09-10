// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import { hermesPortableLifecycleInternals } from "./hermes-portable-lifecycle";

// Execute the shipped probes with a real credential file and loopback listener.
// Redirect only the sandbox path and fixed observer port to isolated test resources.
const HARNESS = String.raw`
import contextlib, http.client, http.server, io, json, pathlib, sys, tempfile, threading
from unittest.mock import patch
case = json.load(sys.stdin)
key = "a" * 64
requests = []
class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        authorized = self.headers.get("Authorization") == "Bearer " + key
        requests.append({"authorized": authorized, "path": self.path})
        self.send_response(case["status"] if authorized else 401)
        if case["redirect"]:
            self.send_header("Location", "http://127.0.0.1:1/stolen")
        self.end_headers()
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(("127.0.0.1", 0), Health)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
stdout, stderr = io.StringIO(), io.StringIO()
read_text = pathlib.Path.read_text
connection = http.client.HTTPConnection
connections = []
def connect(host, port, timeout):
    connections.append({"host": host, "port": port})
    return connection(host, server.server_port, timeout=timeout)
try:
    with tempfile.TemporaryDirectory() as directory:
        env = pathlib.Path(directory) / ".env"
        if case["env"] is not None:
            env.write_bytes(case["env"].encode("utf-8") if case["env"] != "invalid-utf8" else b"\xff")
        def read(path, *args, **kwargs):
            return read_text(env if str(path) == "/sandbox/.hermes/.env" else path, *args, **kwargs)
        sys.argv = ["health", str(server.server_port), str(case["successStatus"]), "80", "10"]
        code = 0
        with patch.object(pathlib.Path, "read_text", read), patch.object(http.client, "HTTPConnection", connect):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                try:
                    exec(compile(case["program"], "health", "exec"), {})
                except SystemExit as result:
                    code = result.code
finally:
    server.shutdown()
    server.server_close()
    thread.join()
print(json.dumps({"code": code, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "requests": requests, "connections": connections}))
`;
const KEY = "a".repeat(64);
const PROBES = [
  { name: "waiter", program: hermesPortableLifecycleInternals.healthWaitProgram },
  { name: "final observer", program: hermesPortableContainerInternals.authenticatedHealthScript },
];
function runProbe(
  program: string,
  env: string | null,
  status = 200,
  redirect = false,
  successStatus = 200,
) {
  const result = spawnSync("python3", ["-I", "-c", HARNESS], {
    input: JSON.stringify({ program, env, status, redirect, successStatus }),
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as {
    code: number;
    stdout: string;
    stderr: string;
    requests: { authorized: boolean; path: string }[];
    connections: { host: string; port: number }[];
  };
  expect(output.stderr).toBe("");
  expect(output.stdout).not.toContain(KEY);
  return output;
}

describe.each(PROBES)("Hermes authenticated health $name", ({ name, program }) => {
  it.each([KEY, `'${KEY}'`, `"${KEY}"`])("accepts the persisted credential format %s", (key) => {
    const output = runProbe(program, `export API_SERVER_KEY=${key}\n`);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain(name === "waiter" ? "result=ready" : "200");
    expect(output.requests).toEqual([{ authorized: true, path: "/health" }]);
    expect(output.connections).toEqual([{ host: "127.0.0.1", port: expect.any(Number) }]);
  });

  it("accepts successful responses with Location without following the header", () => {
    const output = runProbe(program, `API_SERVER_KEY=${KEY}\n`, 200, true);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain(name === "waiter" ? "result=ready" : "200");
    expect(output.requests).toEqual([{ authorized: true, path: "/health" }]);
    expect(output.connections).toHaveLength(1);
  });

  it.each([
    ["missing file", null],
    ["invalid encoding", "invalid-utf8"],
    ["missing key", "OTHER=value\n"],
    ["malformed key", "API_SERVER_KEY=invalid\n"],
    ["duplicate key", `API_SERVER_KEY=${KEY}\nAPI_SERVER_KEY=${KEY}\n`],
    ["malformed duplicate", `API_SERVER_KEY=${KEY}\nAPI_SERVER_KEY=invalid\n`],
    ["mismatched quotes", `API_SERVER_KEY='${KEY}"\n`],
  ])("rejects %s before opening a connection", (_label, env) => {
    const output = runProbe(program, env);
    expect(output).toMatchObject({ code: 64, stdout: "", requests: [], connections: [] });
  });

  it.each([
    ["wrong credential", "b".repeat(64), 200, false],
    ["wrong response status", KEY, 204, false],
    ["redirect status", KEY, 302, true],
  ])("rejects %s", (_label, key, status, redirect) => {
    const output = runProbe(program, `API_SERVER_KEY=${key}\n`, status, redirect);
    expect(output.code).toBe(name === "waiter" ? 75 : 0);
    expect(output.stdout).toContain(
      name === "waiter" ? "result=not-ready" : key !== KEY ? "401" : String(status),
    );
    expect(output.requests.length).toBeGreaterThan(0);
    expect(output.requests.every((request) => request.path === "/health")).toBe(true);
  });
});

it("honors a non-default configured success status", () => {
  const output = runProbe(
    hermesPortableLifecycleInternals.healthWaitProgram,
    `API_SERVER_KEY=${KEY}\n`,
    204,
    false,
    204,
  );
  expect(output.code).toBe(0);
  expect(output.stdout).toContain("result=ready");
  expect(output.requests).toEqual([{ authorized: true, path: "/health" }]);
});
