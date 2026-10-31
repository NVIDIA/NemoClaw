// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractShellFunction } from "../../support/hermes-shell-harness";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { dockerfileInstructions } from "../../../src/lib/onboard/dockerfile-tool-disclosure-contract";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "OPENAI_PROXY",
  "grpc_proxy",
  "GRPC_PROXY",
  "NODE_USE_ENV_PROXY",
  "NEMOCLAW_PROXY_HOST",
  "NEMOCLAW_PROXY_PORT",
];

describe("Hermes native network environment", () => {
  it("resolves certifi to the OpenShell 0.1.5 workload CA bundle", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-certifi-"));
    try {
      const dockerfile = fs.readFileSync(path.join(ROOT, "agents/hermes/Dockerfile"), "utf8");
      const instructions = dockerfileInstructions(dockerfile).map(({ text }) => text);
      const target = instructions
        .find((line) => line.startsWith("ARG SSL_CERT_FILE="))!
        .slice("ARG SSL_CERT_FILE=".length);
      // OpenShell v0.1.5 installs CA material here before it starts the workload.
      const bundle = path.join(directory, "run/openshell-supervisor-ca/material/ca-bundle.crt");
      fs.mkdirSync(path.dirname(bundle), { recursive: true });
      fs.writeFileSync(bundle, "supervisor CA bundle\n");
      const certifi = path.join(directory, "cacert.pem");
      fs.writeFileSync(certifi, "packaged certifi bundle\n");
      const python = path.join(directory, "python");
      fs.writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(certifi)}\n`, {
        mode: 0o755,
      });
      const link = instructions
        .find((line) => line.startsWith("RUN _hermes_certifi="))!
        .slice("RUN ".length)
        .replace("/opt/hermes/.venv/bin/python", shellQuote(python));
      execFileSync("sh", ["-eu", "-c", link], {
        env: { ...process.env, SSL_CERT_FILE: path.join(directory, target) },
      });
      expect(fs.readFileSync(certifi, "utf8")).toBe("supervisor CA bundle\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears startup proxy inputs and retains TLS trust", () => {
    const source = fs.readFileSync(path.join(ROOT, "agents/hermes/start.sh"), "utf8");
    const start = source.indexOf("unset HTTP_PROXY HTTPS_PROXY NO_PROXY");
    const end = source.indexOf("# Corporate proxy CA merge", start);
    const output = execFileSync(
      "bash",
      [
        "-c",
        source.slice(start, end) +
          PROXY_NAMES.map((name) => `printf '%s=%s\\n' '${name}' "\${${name}+set}"`).join("\n") +
          '\nprintf "CA=%s\\n" "$SSL_CERT_FILE"',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries(PROXY_NAMES.map((name) => [name, "obsolete-proxy-value"])),
          SSL_CERT_FILE: "/trusted/ca file.pem",
        },
      },
    );
    expect(output).toBe(
      PROXY_NAMES.map((name) => `${name}=\n`).join("") + "CA=/trusted/ca file.pem\n",
    );
  });

  it.each(["sh", "bash"])("clears proxy inputs in %s and retains TLS trust", (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-native-env-"));
    try {
      const source = fs.readFileSync(path.join(ROOT, "agents/hermes/start.sh"), "utf8");
      const envFile = path.join(directory, "connect.sh");
      const caFile = path.join(directory, "trusted ca.pem");
      const probe =
        PROXY_NAMES.map((name) => `printf '%s=%s\\n' '${name}' "\${${name}+set}"`).join("\n") +
        '\nprintf "CA=%s\\n" "$SSL_CERT_FILE"';
      const seed = {
        ...process.env,
        ...Object.fromEntries(PROXY_NAMES.map((name) => [name, "obsolete-proxy-value"])),
        SSL_CERT_FILE: caFile,
      };
      execFileSync(
        "bash",
        [
          "-c",
          [
            'emit_sandbox_sourced_file() { cat >"$1"; chmod 444 "$1"; }',
            `_PROXY_ENV_FILE=${shellQuote(envFile)}`,
            "HERMES_DIR=/sandbox/.hermes",
            "HERMES_SANDBOX_LAZY_INSTALL_TARGET=/sandbox/.hermes/lazy-packages",
            extractShellFunction(source, "write_runtime_shell_env"),
            "write_runtime_shell_env",
          ].join("\n"),
        ],
        { encoding: "utf8", env: seed },
      );
      const output = execFileSync(mode, ["-c", `. ${shellQuote(envFile)}\n${probe}`], {
        encoding: "utf8",
        env: seed,
      });
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o444);
      expect(output).toBe(PROXY_NAMES.map((name) => `${name}=\n`).join("") + `CA=${caFile}\n`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Hermes Browser Use TLS connection", () => {
  it.each([false, true])("uses the remote host and propagates TLS failure=%s", (rejectTls) => {
    const output = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import ast
import json
import pathlib
import ssl
import sys
from unittest.mock import patch

tree = ast.parse(pathlib.Path(sys.argv[1]).read_text())
script = next(ast.literal_eval(node.value) for node in tree.body
    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
    and target.id == "_BROWSER_USE_CDP_TUNNEL_SCRIPT" for target in node.targets))
reject_tls = sys.argv[2] == "true"
events = []
class Socket:
    def close(self):
        events.append("close")
    def sendall(self, _data):
        raise AssertionError("HTTP CONNECT must not be used")
raw = Socket()
def connect(address, timeout):
    events.append(["connect", list(address), timeout])
    return raw
class Context:
    def wrap_socket(self, sock, server_hostname):
        assert sock is raw
        events.append(["tls", server_hostname])
        if reject_tls:
            raise ssl.SSLCertVerificationError("untrusted peer")
        return "verified stream"
def context():
    events.append("default trust")
    return Context()
namespace = {}
with patch.object(sys, "argv", ["bridge", "wss://session.browser-use.com:8443/cdp?capability=fixture"]), \\
     patch("socket.create_connection", connect), patch("ssl.create_default_context", context):
    exec(script.split("listener = socket.socket", 1)[0], namespace)
    try:
        result = namespace["_connect_remote"]()
    except ssl.SSLCertVerificationError:
        result = "certificate rejected"
print(json.dumps({"events": events, "result": result, "path": namespace["target_path"]}))
`,
        path.join(ROOT, "agents/hermes/plugin/__init__.py"),
        String(rejectTls),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HTTPS_PROXY: "http://retired.invalid:3128" },
      },
    );
    expect(JSON.parse(output)).toEqual({
      events: [
        ["connect", ["session.browser-use.com", 8443], 15],
        "default trust",
        ["tls", "session.browser-use.com"],
        ...(rejectTls ? ["close"] : []),
      ],
      result: rejectTls ? "certificate rejected" : "verified stream",
      path: "/cdp?capability=fixture",
    });
  });
});
