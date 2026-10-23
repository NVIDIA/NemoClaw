// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAVE_AGENT_BOUNDARY, BRAVE_SHELL_BOUNDARY } from "../live/brave-search-helpers.ts";

import { startBraveBackend, writeBraveEgressPreload } from "../fixtures/brave-backend.ts";

import { REQUIRED_OPENSHELL_MCP_FEATURES } from "../../../src/lib/onboard/openshell-feature-gate.ts";

const directories: string[] = [];
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brave-isolation-"));
  directories.push(directory);
  return directory;
}

function runWithBravePreload(preload: string, binary: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--require",
      preload,
      "--input-type=module",
      "-e",
      `import { spawn } from "node:child_process";
const child = spawn(process.argv[1], JSON.parse(process.argv[2]), { stdio: "inherit" });
child.on("close", code => process.exit(code ?? 91));`,
      binary,
      JSON.stringify(args),
    ],
    { encoding: "utf8" },
  );
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("Brave runtime credential boundary probes", () => {
  it.each([
    ["", 0],
    ["BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY", 0],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEY", 0],
    [`BRAVE_API_KEY=openshell:resolve:env:s${"a".repeat(64)}_BRAVE_API_KEY`, 0],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEYraw-secret", 98],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_NVIDIA_API_KEY", 98],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEY\n", 98],
    ["BRAVE_API_KEY=synthetic-raw-key", 98],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEY\0BRAVE_API_KEY=synthetic-raw-key", 98],
  ])("classifies a running agent environment without exposing %s", (environment, status) => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "123"));
    fs.writeFileSync(path.join(root, "123/cmdline"), "node\0/app/openclaw.mjs\0agent\0");
    fs.writeFileSync(path.join(root, "123/environ"), environment);
    const result = spawnSync(
      "python3",
      ["-c", BRAVE_AGENT_BOUNDARY, "--inspect-process", path.join(root, "123")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("fails closed when no agent exists", () => {
    const result = spawnSync("python3", [
      "-c",
      BRAVE_AGENT_BOUNDARY,
      "--inspect-process",
      temporaryDirectory(),
    ]);
    expect(result.status).toBe(97);
  });

  it.each(["FileNotFoundError", "ProcessLookupError", "PermissionError"])(
    "fails closed without output when the agent environment raises %s",
    (errorType) => {
      const processDirectory = temporaryDirectory();
      fs.writeFileSync(path.join(processDirectory, "cmdline"), "node\0/app/openclaw.mjs\0agent\0");
      const injectReadFailure = `import pathlib, sys
from unittest.mock import patch
probe = sys.argv.pop(1)
read_bytes = pathlib.Path.read_bytes
def read(path):
    if path.name == "environ":
        raise ${errorType}()
    return read_bytes(path)
with patch.object(pathlib.Path, "read_bytes", read):
    exec(probe)
`;
      const result = spawnSync(
        "python3",
        ["-c", injectReadFailure, BRAVE_AGENT_BOUNDARY, "--inspect-process", processDirectory],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(97);
      expect(result.stdout + result.stderr).toBe("");
    },
  );

  it.each([
    ["node\0/app/openclaw/openclaw.mjs\0agent\0", "", 0],
    [
      "node\0/app/openclaw/openclaw.mjs\0agent\0",
      "BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEY",
      0,
    ],
    ["node\0/app/openclaw/openclaw.mjs\0agent\0", "BRAVE_API_KEY=synthetic-raw-key", 98],
    ["sh\0-c\0openclaw agent\0", "", 97],
    ["openclaw-gateway\0", "", 97],
  ])("inspects only the selected agent child: %s / %s", (command, environment, status) => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "123"));
    fs.writeFileSync(path.join(root, "123/cmdline"), command);
    fs.writeFileSync(path.join(root, "123/environ"), environment);
    fs.mkdirSync(path.join(root, "456"));
    fs.writeFileSync(path.join(root, "456/cmdline"), "node\0/app/openclaw.mjs\0agent\0");
    fs.writeFileSync(path.join(root, "456/environ"), "BRAVE_API_KEY=another-process-raw-key");
    const result = spawnSync(
      "python3",
      ["-c", BRAVE_AGENT_BOUNDARY, "--inspect-process", path.join(root, "123")],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toBe("");
  });

  it.each([
    ["unavailable environment", "node\0/app/openclaw/openclaw.mjs\0agent\0"],
    ["shell wrapper only", "sh\0-c\0openclaw agent\0"],
  ])("fails closed with %s", (_condition, command) => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "123"));
    fs.writeFileSync(path.join(root, "123/cmdline"), command);
    const result = spawnSync("python3", [
      "-c",
      BRAVE_AGENT_BOUNDARY,
      "--inspect-process",
      path.join(root, "123"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it.each([
    ["", 0],
    ["openshell:resolve:env:BRAVE_API_KEY", 0],
    ["openshell:resolve:env:v1_BRAVE_API_KEY", 0],
    [`openshell:resolve:env:s${"a".repeat(64)}_BRAVE_API_KEY`, 0],
    ["openshell:resolve:env:v1_BRAVE_API_KEYraw-secret", 98],
    ["openshell:resolve:env:v1_NVIDIA_API_KEY", 98],
    ["openshell:resolve:env:v1_BRAVE_API_KEY\n", 98],
    ["synthetic-raw-key", 98],
  ])("classifies fresh shell environment %s", (value, status) => {
    const result = spawnSync("sh", ["-c", BRAVE_SHELL_BOUNDARY], {
      env: { PATH: process.env.PATH, BRAVE_API_KEY: String(value) },
      encoding: "utf8",
    });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("blocks the optional Brave egress request", () => {
    const directory = temporaryDirectory();
    const real = path.join(directory, "real-openshell");
    fs.writeFileSync(
      real,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const preload = writeBraveEgressPreload(directory, real);
    const prefix = ["sandbox", "exec", "--name", "test", "--"];
    const egress = [
      ...prefix,
      "sh",
      "-lc",
      "'curl' '-sS' '--compressed' '--max-time' '20' '-G' 'https://api.search.brave.com/res/v1/web/search' '--data-urlencode' 'q=NVIDIA'",
    ];
    expect(runWithBravePreload(preload, real, egress).status).toBe(69);
    expect(fs.readFileSync(path.join(directory, "brave-egress-blocked"), "utf8")).toBe("blocked\n");
  });

  it.each([
    ["version", ["--version"]],
    ["creation", ["sandbox", "create", "--name", "test"]],
    [
      "running process",
      ["sandbox", "exec", "--name", "test", "--", "python3", "-c", BRAVE_AGENT_BOUNDARY],
    ],
    ["login shell", ["sandbox", "exec", "--name", "test", "--", "sh", "-lc", BRAVE_SHELL_BOUNDARY]],
    [
      "production guard",
      ["sandbox", "exec", "--name", "test", "--", "sh", "-c", "printenv BRAVE_API_KEY"],
    ],
    [
      "configuration",
      ["sandbox", "exec", "--name", "test", "--", "cat", "/sandbox/.openclaw/openclaw.json"],
    ],
  ])("delegates %s to real OpenShell", (_label, args) => {
    const directory = temporaryDirectory();
    const real = path.join(directory, "real-openshell");
    fs.writeFileSync(
      real,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const preload = writeBraveEgressPreload(directory, real);
    const result = runWithBravePreload(preload, real, args as string[]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.each([
    {
      label: "startup port",
      source: "setInterval(() => {}, 1000);",
      observe: async (backend: ReturnType<typeof startBraveBackend>) => await backend,
    },
    {
      label: "request report",
      source:
        'require("node:worker_threads").parentPort.postMessage(1234); setInterval(() => {}, 1000);',
      observe: async (backend: ReturnType<typeof startBraveBackend>) => (await backend).requests(),
    },
  ])("cleans up when the worker never reports $label", async ({ label, source, observe }) => {
    const root = temporaryDirectory();
    const backend = startBraveBackend(200, false, {
      messageTimeoutMs: 500,
      workerSource: source,
      temporaryRoot: root,
    });
    await expect(observe(backend)).rejects.toThrow(`did not report ${label} within 500ms`);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it.each([
    ["capable CLI", REQUIRED_OPENSHELL_MCP_FEATURES, true],
    ["missing CLI features", ["allow_all_known_mcp_methods"], false],
  ])("preserves the component integrity preflight for %s", (_label, cliMarkers, expected) => {
    const realDirectory = temporaryDirectory();
    const mockDirectory = temporaryDirectory();
    const real = path.join(realDirectory, "openshell");
    const gateway = path.join(realDirectory, "openshell-gateway");
    const sandbox = path.join(realDirectory, "openshell-sandbox");
    const version = "#!/bin/sh\nprintf 'openshell 0.0.116\\n'\n";
    // Match the pinned release: rewrite markers are in the CLI, while the
    // gateway and supervisor contain only the MCP policy marker.
    const component = `${version}# allow_all_known_mcp_methods\n`;
    fs.writeFileSync(real, `${version}# ${cliMarkers.join(" ")}\n`, { mode: 0o700 });
    fs.writeFileSync(gateway, component, { mode: 0o700 });
    fs.writeFileSync(sandbox, component, { mode: 0o700 });
    const preload = writeBraveEgressPreload(mockDirectory, real);
    const options = { openshellBin: real, gatewayBin: gateway, sandboxBin: sandbox };
    const gate = path.resolve("src/lib/onboard/openshell-feature-gate.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        "tsx/cjs",
        "--require",
        preload,
        "-e",
        `const { hasRequiredOpenshellMessagingFeatures } = require(${JSON.stringify(gate)});
process.stdout.write(JSON.stringify(hasRequiredOpenshellMessagingFeatures(${JSON.stringify(options)})));`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(expected);
  });
});
