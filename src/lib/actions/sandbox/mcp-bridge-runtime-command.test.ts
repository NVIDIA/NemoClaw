// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { buildMcpBridgePolicyYaml } from "./mcp-bridge-policy-render";
import { buildCredentialResolutionProbeCommand } from "./mcp-bridge-resolution-probe";
import {
  buildMcpAdapterHttpProbeCommand,
  mcpAdapterHttpProbeSource,
} from "./mcp-bridge-runtime-command";

const SECRET_BODY = "ghp_super-secret-probe-body-1234567890";
const HTTP_MARKER = "NEMOCLAW_MCP_PROBE_HTTP_CODE=test:";
const PYTHON3_AVAILABLE =
  spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;

const ADAPTERS = [
  {
    adapter: "openclaw-config" as const,
    binaries: ["/usr/local/bin/openclaw", "/usr/local/bin/node", "/usr/bin/node"],
    runtime: "nemoclaw-start node -e",
  },
  {
    adapter: "hermes-config" as const,
    binaries: ["/usr/local/bin/hermes", "/usr/bin/python3*", "/opt/hermes/.venv/bin/python*"],
    runtime: "/opt/hermes/.venv/bin/python -I -c",
  },
  {
    adapter: "deepagents-config" as const,
    binaries: ["/usr/local/bin/dcode", "/opt/venv/bin/python3*"],
    runtime: "/opt/venv/bin/python3 -I -c",
  },
] as const;

const PYTHON_ADAPTERS = [ADAPTERS[1], ADAPTERS[2]] as const;

function policyAndProbeContract(spec: (typeof ADAPTERS)[number]): void {
  const request = {
    authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    httpMarker: HTTP_MARKER,
    timeoutSeconds: 3,
    url: "https://api.githubcopilot.com/mcp/",
  };
  const parsed = YAML.parse(
    buildMcpBridgePolicyYaml(
      "github",
      request.url,
      spec.adapter,
      { addresses: ["8.8.8.8"] },
      "alpha-mcp-github",
    ),
  ) as {
    network_policies: Record<string, { binaries: Array<{ path: string }> }>;
  };
  const policyBinaries = parsed.network_policies.mcp_bridge_github.binaries.map(({ path }) => path);
  const managedCommand = buildCredentialResolutionProbeCommand(
    {
      server: "github",
      url: request.url,
      env: ["GITHUB_TOKEN"],
    },
    spec.adapter,
    "v11",
  )?.command;
  const launched = buildMcpAdapterHttpProbeCommand(spec.adapter, request);

  expect(policyBinaries).toEqual([...spec.binaries]);
  expect(policyBinaries).not.toContain("/usr/bin/curl");
  expect(policyBinaries).not.toContain("/usr/local/bin/curl");
  expect(managedCommand).toContain(spec.runtime);
  expect(managedCommand).not.toMatch(/(?:^|[\s'"=/])curl(?:[\s'"-]|$)/u);
  expect(launched).toContain(spec.runtime);
  expect(launched).not.toMatch(/(?:^|[\s'"=/])curl(?:[\s'"-]|$)/u);
}

function pythonProbeRequest() {
  return {
    authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    httpMarker: HTTP_MARKER,
    timeoutSeconds: 3,
    url: "http://127.0.0.1:9/mcp/",
  };
}

function expectProbeStatusWithoutBody(result: ReturnType<typeof spawnSync>, status: string): void {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`${HTTP_MARKER}${status}`);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(SECRET_BODY);
}

function runNodeProbeWithLocalServer(
  authorization: string,
  status = 200,
  responseMode: "complete" | "headers-only" = "complete",
): ReturnType<typeof spawnSync> {
  const probeSource = mcpAdapterHttpProbeSource("openclaw-config", {
    authorization,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    httpMarker: HTTP_MARKER,
    timeoutSeconds: 3,
    url: "http://127.0.0.1:9/mcp/",
  }).replace(/^const url = .*;$/m, "");
  const script = [
    'const http = require("node:http");',
    `const secret = ${JSON.stringify(SECRET_BODY)};`,
    "const server = http.createServer((req, res) => {",
    "  req.resume();",
    '  req.on("end", () => {',
    `    res.writeHead(${String(status)}, { "content-type": "application/json" });`,
    '    res.on("close", () => server.close());',
    responseMode === "headers-only" ? "    res.flushHeaders();" : "    res.end(secret);",
    "  });",
    "});",
    'server.listen(0, "127.0.0.1", () => {',
    "  const port = server.address().port;",
    '  const url = "http://127.0.0.1:" + String(port) + "/mcp/";',
    probeSource,
    "});",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
}

function runPythonProbeWithLocalServer(source: string, status = 200): ReturnType<typeof spawnSync> {
  const script = [
    "from http.server import BaseHTTPRequestHandler, HTTPServer",
    "import threading",
    "class Handler(BaseHTTPRequestHandler):",
    "    def do_POST(self):",
    "        length = int(self.headers.get('Content-Length', '0'))",
    "        self.rfile.read(length)",
    `        self.send_response(${String(status)})`,
    "        self.send_header('Content-Type', 'application/json')",
    "        self.end_headers()",
    `        self.wfile.write(${JSON.stringify(SECRET_BODY)}.encode())`,
    "    def log_message(self, *_args):",
    "        pass",
    "httpd = HTTPServer(('127.0.0.1', 0), Handler)",
    "port = httpd.server_address[1]",
    "threading.Thread(target=httpd.handle_request, daemon=True).start()",
    "url = 'http://127.0.0.1:%s/mcp/' % port",
    source.replace(/^url = .*$/m, ""),
  ].join("\n");
  return spawnSync("python3", ["-I", "-c", script], { encoding: "utf8", timeout: 10_000 });
}

describe("MCP adapter HTTP probe client", () => {
  it.each(ADAPTERS)(
    "lets the $adapter runtime succeed while generated policy keeps interactive curl denied (#12065)",
    policyAndProbeContract,
  );

  it("emits a Node probe status after headers without buffering the body (#12065)", () => {
    expectProbeStatusWithoutBody(
      runNodeProbeWithLocalServer("Bearer openshell:resolve:env:v11_GITHUB_TOKEN"),
      "200",
    );
  });

  it("flushes the Node probe status before cancelling a headers-only response (#12065)", () => {
    expectProbeStatusWithoutBody(
      runNodeProbeWithLocalServer(
        "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
        200,
        "headers-only",
      ),
      "200",
    );
  });

  it.skipIf(!PYTHON3_AVAILABLE).each(PYTHON_ADAPTERS)(
    "emits a $adapter Python probe status after headers without buffering the body (#12065)",
    (spec) => {
      expectProbeStatusWithoutBody(
        runPythonProbeWithLocalServer(
          mcpAdapterHttpProbeSource(spec.adapter, pythonProbeRequest()),
        ),
        "200",
      );
    },
  );

  it.skipIf(!PYTHON3_AVAILABLE)(
    "emits a Python probe status for HTTP errors without buffering the body (#12065)",
    () => {
      expectProbeStatusWithoutBody(
        runPythonProbeWithLocalServer(
          mcpAdapterHttpProbeSource("hermes-config", pythonProbeRequest()),
          401,
        ),
        "401",
      );
    },
  );

  it("maps a refused adapter HTTP connection to the transport failure exit (#12065)", () => {
    const source = mcpAdapterHttpProbeSource("openclaw-config", {
      authorization: "Bearer probe",
      body: "{}",
      httpMarker: HTTP_MARKER,
      timeoutSeconds: 1,
      url: "http://127.0.0.1:1/",
    });
    const result = spawnSync(process.execPath, ["-e", source], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(56);
    expect(result.stdout).not.toContain(HTTP_MARKER);
  });
});
