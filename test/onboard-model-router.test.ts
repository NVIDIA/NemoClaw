// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
};

type SandboxInferenceConfig = {
  providerKey: string;
  primaryModelRef: string;
  inferenceBaseUrl: string;
  inferenceApi: string;
  inferenceCompat: unknown;
};

function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

const MODEL_ROUTER_FINGERPRINT_FILE = ".nemoclaw-source-fingerprint";
const MODEL_ROUTER_TEST_SOURCE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("onboard Model Router setup", () => {
  it("configures Model Router as a host provider while sandboxes keep inference.local", testTimeoutOptions(60_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-inference-"));
    const fakeBin = path.join(tmpDir, "bin");
    const venvDir = path.join(tmpDir, "model-router-venv");
    const venvBin = path.join(venvDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-router-check.js");
    const routerPort = 44000 + (process.pid % 10000);
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(venvBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(venvBin, "model-router"),
      [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        'const http = require("http");',
        'const path = require("path");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "proxy-config") {',
        '  const output = args[args.indexOf("--output") + 1];',
        "  fs.mkdirSync(path.dirname(output), { recursive: true });",
        '  fs.writeFileSync(output, "model_list: []\\n");',
        "  process.exit(0);",
        "}",
        'if (args[0] === "proxy") {',
        '  const port = Number(args[args.indexOf("--port") + 1] || "4000");',
        "  const server = http.createServer((req, res) => {",
        '    if (req.url === "/health") { res.statusCode = 200; res.end("ok"); return; }',
        "    res.statusCode = 404;",
        "    res.end();",
        "  });",
        '  server.listen(port, "127.0.0.1");',
        "  setTimeout(() => process.exit(0), 10000);",
        "} else {",
        "  process.exit(1);",
        "}",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE),
      `git:${MODEL_ROUTER_TEST_SOURCE_SHA}\n`,
      { mode: 0o600 },
    );

    const script = String.raw`
const fs = require("fs");
const path = require("path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const routerPort = ${routerPort};
const blueprintPath = path.join(${JSON.stringify(repoRoot)}, "nemoclaw-blueprint", "blueprint.yaml");
const routerPyproject = path.join(${JSON.stringify(repoRoot)}, "nemoclaw-blueprint", "router", "llm-router", "pyproject.toml");
const originalReadFileSync = fs.readFileSync;
const originalExistsSync = fs.existsSync;
fs.existsSync = (filePath) => {
  if (filePath === routerPyproject || String(filePath) === routerPyproject) return true;
  return originalExistsSync(filePath);
};
fs.readFileSync = (filePath, ...args) => {
  const raw = originalReadFileSync(filePath, ...args);
  if (filePath === blueprintPath || String(filePath) === blueprintPath) {
    return String(raw)
      .replace('endpoint: "http://localhost:4000/v1"', 'endpoint: "http://localhost:' + routerPort + '/v1"')
      .replace("port: 4000", "port: " + routerPort);
  }
  return raw;
};

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  if (cmd.startsWith("python3 -m venv") || cmd.includes("/bin/python -m pip")) {
    throw new Error("unexpected managed-router reinstall in reuse test: " + cmd);
  }
  if (/(^|[\/\s])pip3(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected pip3 invocation in test harness: " + cmd);
  }
  if (cmd.includes("git -C") || /^git(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected git invocation in test harness: " + cmd);
  }
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  if (
    cmd.includes("gateway select") ||
    cmd.includes("provider create") ||
    cmd.includes("provider update") ||
    cmd.includes("inference set")
  ) {
    return { status: 0, stdout: "", stderr: "" };
  }
  throw new Error("unexpected command in managed-router reuse test: " + cmd);
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("git -C") && cmd.includes("rev-parse HEAD")) {
    return ${JSON.stringify(MODEL_ROUTER_TEST_SOURCE_SHA)};
  }
  if (cmd.includes("command -v") && /model-router$/.test(cmd)) {
    return ${JSON.stringify(path.join(fakeBin, "model-router"))};
  }
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-router",
      "  Model: nvidia-routed",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-router-secret";

const { setupInference, getSandboxInferenceConfig } = require(${onboardPath});

(async () => {
  await setupInference(
    "router-box",
    "nvidia-routed",
    "nvidia-router",
    "http://host.openshell.internal:" + routerPort + "/v1",
    "NVIDIA_API_KEY",
  );
  console.log(JSON.stringify({
    commands,
    sandboxConfig: getSandboxInferenceConfig("nvidia-routed", "nvidia-router", "openai-completions"),
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_MODEL_ROUTER_VENV: venvDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      commands: CommandEntry[];
      sandboxConfig: SandboxInferenceConfig;
    }>(result.stdout);
    const providerCommand = payload.commands.find((entry) =>
      /provider create/.test(entry.command),
    );
    assert.ok(providerCommand, JSON.stringify(payload.commands));
    assert.match(providerCommand.command, /--name nvidia-router/);
    assert.match(providerCommand.command, /--credential NVIDIA_API_KEY/);
    assert.match(
      providerCommand.command,
      new RegExp(`OPENAI_BASE_URL=http:\\/\\/host\\.openshell\\.internal:${routerPort}\\/v1`),
    );
    assert.doesNotMatch(providerCommand.command, /nvapi-router-secret/);
    assert.equal(providerCommand.env?.NVIDIA_API_KEY, "nvapi-router-secret");

    const inferenceCommand = payload.commands.find((entry) =>
      /inference set/.test(entry.command),
    );
    assert.ok(inferenceCommand, JSON.stringify(payload.commands));
    assert.match(inferenceCommand.command, /--provider nvidia-router/);
    assert.match(inferenceCommand.command, /--model nvidia-routed/);

    assert.deepEqual(payload.sandboxConfig, {
      providerKey: "inference",
      primaryModelRef: "inference/nvidia-routed",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    });
  });

  it("prepares managed Model Router dependencies instead of using PATH when managed command is absent", testTimeoutOptions(30_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-venv-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-router-venv-check.js");
    const fakeRouterSource = path.join(tmpDir, "model-router-source.js");
    const setupLog = path.join(tmpDir, "router-setup.log");
    const venvDir = path.join(tmpDir, "model-router-venv");
    const routerPort = 45000 + (process.pid % 10000);
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    try {
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(fakeBin, "model-router"),
        [
          "#!/usr/bin/env bash",
          `printf "path-router %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          "exit 89",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "python3"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf "python3 %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
          '  venv_dir="$3"',
          '  mkdir -p "$venv_dir/bin"',
          '  cat > "$venv_dir/bin/python" <<\'PY\'',
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf "venv-python %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          'if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then',
          '  venv_bin="$(cd "$(dirname "$0")" && pwd)"',
          `  cp ${JSON.stringify(fakeRouterSource)} "$venv_bin/model-router"`,
          '  chmod +x "$venv_bin/model-router"',
          "  exit 0",
          "fi",
          "exit 97",
          "PY",
          '  chmod +x "$venv_dir/bin/python"',
          "  exit 0",
          "fi",
          "exit 96",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "pip3"),
        [
          "#!/usr/bin/env bash",
          'printf "pip3 %s\\n" "$*" >> "$ROUTER_SETUP_LOG"',
          "exit 88",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        fakeRouterSource,
        [
          `#!${process.execPath}`,
          'const fs = require("fs");',
          'const http = require("http");',
          'const path = require("path");',
          "const args = process.argv.slice(2);",
          'if (args[0] === "proxy-config") {',
          '  const output = args[args.indexOf("--output") + 1];',
          "  fs.mkdirSync(path.dirname(output), { recursive: true });",
          '  fs.writeFileSync(output, "model_list: []\\n");',
          "  process.exit(0);",
          "}",
          'if (args[0] === "proxy") {',
          '  const port = Number(args[args.indexOf("--port") + 1] || "4000");',
          "  const server = http.createServer((req, res) => {",
          '    if (req.url === "/health") { res.statusCode = 200; res.end("ok"); return; }',
          "    res.statusCode = 404;",
          "    res.end();",
          "  });",
          '  server.listen(port, "127.0.0.1");',
          "  setTimeout(() => process.exit(0), 10000);",
          "} else {",
          "  process.exit(1);",
          "}",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const script = String.raw`
const fs = require("fs");
const path = require("path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const routerPort = ${routerPort};
const repoRoot = ${JSON.stringify(repoRoot)};
const blueprintPath = path.join(repoRoot, "nemoclaw-blueprint", "blueprint.yaml");
const routerPyproject = path.join(repoRoot, "nemoclaw-blueprint", "router", "llm-router", "pyproject.toml");
const originalReadFileSync = fs.readFileSync;
const originalExistsSync = fs.existsSync;
const originalRun = runner.run;
fs.existsSync = (filePath) => {
  if (filePath === routerPyproject || String(filePath) === routerPyproject) return true;
  return originalExistsSync(filePath);
};
fs.readFileSync = (filePath, ...args) => {
  const raw = originalReadFileSync(filePath, ...args);
  if (filePath === blueprintPath || String(filePath) === blueprintPath) {
    return String(raw)
      .replace('endpoint: "http://localhost:4000/v1"', 'endpoint: "http://localhost:' + routerPort + '/v1"')
      .replace("port: 4000", "port: " + routerPort);
  }
  return raw;
};

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  if (cmd.startsWith("python3 -m venv") || cmd.includes("/bin/python -m pip")) {
    return originalRun(command, opts);
  }
  if (/(^|[\/\s])pip3(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected pip3 invocation in test harness: " + cmd);
  }
  if (cmd.includes("git -C") || /^git(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected git invocation in test harness: " + cmd);
  }
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("git -C") && cmd.includes("rev-parse HEAD")) {
    return ${JSON.stringify(MODEL_ROUTER_TEST_SOURCE_SHA)};
  }
  if (cmd.includes("command -v") && /model-router$/.test(cmd)) {
    return ${JSON.stringify(path.join(fakeBin, "model-router"))};
  }
  if (cmd.includes("command -v") && /python3$/.test(cmd)) {
    return ${JSON.stringify(path.join(fakeBin, "python3"))};
  }
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-router",
      "  Model: nvidia-routed",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-router-secret";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "router-box",
    "nvidia-routed",
    "nvidia-router",
    "http://host.openshell.internal:" + routerPort + "/v1",
    "NVIDIA_API_KEY",
  );
  console.log(JSON.stringify({ commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          HOME: tmpDir,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          FAKE_ROUTER_SOURCE: fakeRouterSource,
          ROUTER_SETUP_LOG: setupLog,
          NEMOCLAW_MODEL_ROUTER_VENV: venvDir,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const log = fs.readFileSync(setupLog, "utf-8");
      assert.ok(log.includes(`python3 -m venv ${venvDir}`), log);
      assert.ok(
        log.includes(
          `venv-python -m pip install --quiet --upgrade ${path.join(repoRoot, "nemoclaw-blueprint", "router", "llm-router")}[prefill,proxy]`,
        ),
        log,
      );
      assert.doesNotMatch(log, /path-router/);
      assert.doesNotMatch(log, /pip3 /);
      const payload = parseStdoutJson<{ commands: CommandEntry[] }>(result.stdout);
      assert.ok(payload.commands.some((entry) => /provider create/.test(entry.command)));
      assert.ok(payload.commands.some((entry) => /inference set/.test(entry.command)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefers the managed Model Router command over PATH", testTimeoutOptions(60_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-managed-"));
    const fakeBin = path.join(tmpDir, "bin");
    const venvDir = path.join(tmpDir, "model-router-venv");
    const venvBin = path.join(venvDir, "bin");
    const setupLog = path.join(tmpDir, "router-managed.log");
    const scriptPath = path.join(tmpDir, "setup-router-managed-check.js");
    const routerPort = 46000 + (process.pid % 10000);
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    try {
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(venvBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(fakeBin, "model-router"),
        [
          "#!/usr/bin/env bash",
          `printf "path-router %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          "exit 89",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(venvBin, "model-router"),
        [
          `#!${process.execPath}`,
          'const fs = require("fs");',
          'const http = require("http");',
          'const path = require("path");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(setupLog)}, \`managed \${args[0]}\\n\`);`,
          'if (args[0] === "proxy-config") {',
          '  const output = args[args.indexOf("--output") + 1];',
          "  fs.mkdirSync(path.dirname(output), { recursive: true });",
          '  fs.writeFileSync(output, "model_list: []\\n");',
          "  process.exit(0);",
          "}",
          'if (args[0] === "proxy") {',
          '  const port = Number(args[args.indexOf("--port") + 1] || "4000");',
          "  const server = http.createServer((req, res) => {",
          '    if (req.url === "/health") { res.statusCode = 200; res.end("ok"); return; }',
          "    res.statusCode = 404;",
          "    res.end();",
          "  });",
          '  server.listen(port, "127.0.0.1");',
          "  setTimeout(() => process.exit(0), 10000);",
          "} else {",
          "  process.exit(1);",
          "}",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE),
        `git:${MODEL_ROUTER_TEST_SOURCE_SHA}\n`,
        { mode: 0o600 },
      );

      const script = String.raw`
const fs = require("fs");
const path = require("path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const routerPort = ${routerPort};
const repoRoot = ${JSON.stringify(repoRoot)};
const blueprintPath = path.join(repoRoot, "nemoclaw-blueprint", "blueprint.yaml");
const routerPyproject = path.join(repoRoot, "nemoclaw-blueprint", "router", "llm-router", "pyproject.toml");
const originalReadFileSync = fs.readFileSync;
const originalExistsSync = fs.existsSync;
fs.existsSync = (filePath) => {
  if (filePath === routerPyproject || String(filePath) === routerPyproject) return true;
  return originalExistsSync(filePath);
};
fs.readFileSync = (filePath, ...args) => {
  const raw = originalReadFileSync(filePath, ...args);
  if (filePath === blueprintPath || String(filePath) === blueprintPath) {
    return String(raw)
      .replace('endpoint: "http://localhost:4000/v1"', 'endpoint: "http://localhost:' + routerPort + '/v1"')
      .replace("port: 4000", "port: " + routerPort);
  }
  return raw;
};

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  if (cmd.startsWith("python3 -m venv") || cmd.includes("/bin/python -m pip")) {
    throw new Error("unexpected managed-router reinstall in reuse test: " + cmd);
  }
  if (/(^|[\/\s])pip3(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected pip3 invocation in test harness: " + cmd);
  }
  if (cmd.includes("git -C") || /^git(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected git invocation in test harness: " + cmd);
  }
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  if (
    cmd.includes("gateway select") ||
    cmd.includes("provider create") ||
    cmd.includes("provider update") ||
    cmd.includes("inference set")
  ) {
    return { status: 0, stdout: "", stderr: "" };
  }
  throw new Error("unexpected command in managed-router reuse test: " + cmd);
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("git -C") && cmd.includes("rev-parse HEAD")) {
    return ${JSON.stringify(MODEL_ROUTER_TEST_SOURCE_SHA)};
  }
  if (cmd.includes("command -v") && /model-router$/.test(cmd)) {
    return ${JSON.stringify(path.join(fakeBin, "model-router"))};
  }
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-router",
      "  Model: nvidia-routed",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-router-secret";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "router-box",
    "nvidia-routed",
    "nvidia-router",
    "http://host.openshell.internal:" + routerPort + "/v1",
    "NVIDIA_API_KEY",
  );
  console.log(JSON.stringify({ commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          HOME: tmpDir,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          ROUTER_SETUP_LOG: setupLog,
          NEMOCLAW_MODEL_ROUTER_VENV: venvDir,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const log = fs.readFileSync(setupLog, "utf-8");
      assert.match(log, /managed proxy-config/);
      assert.doesNotMatch(log, /path-router/);
      const payload = parseStdoutJson<{ commands: CommandEntry[] }>(result.stdout);
      assert.ok(payload.commands.some((entry) => /provider create/.test(entry.command)));
      assert.ok(payload.commands.some((entry) => /inference set/.test(entry.command)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refreshes stale managed Model Router command when source fingerprint changes", testTimeoutOptions(60_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-refresh-"));
    const fakeBin = path.join(tmpDir, "bin");
    const venvDir = path.join(tmpDir, "model-router-venv");
    const venvBin = path.join(venvDir, "bin");
    const fakeRouterSource = path.join(tmpDir, "model-router-source.js");
    const setupLog = path.join(tmpDir, "router-refresh.log");
    const scriptPath = path.join(tmpDir, "setup-router-refresh-check.js");
    const routerPort = 47000 + (process.pid % 10000);
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    try {
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(venvBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(fakeBin, "model-router"),
        [
          "#!/usr/bin/env bash",
          `printf "path-router %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          "exit 89",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "python3"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf "python3 %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
          '  venv_dir="$3"',
          '  mkdir -p "$venv_dir/bin"',
          '  cat > "$venv_dir/bin/python" <<\'PY\'',
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf "venv-python %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          'if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then',
          '  venv_bin="$(cd "$(dirname "$0")" && pwd)"',
          `  cp ${JSON.stringify(fakeRouterSource)} "$venv_bin/model-router"`,
          '  chmod +x "$venv_bin/model-router"',
          "  exit 0",
          "fi",
          "exit 97",
          "PY",
          '  chmod +x "$venv_dir/bin/python"',
          "  exit 0",
          "fi",
          "exit 96",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(venvBin, "model-router"),
        [
          "#!/usr/bin/env bash",
          `printf "stale-managed %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
          "exit 89",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE), "git:stale\n", {
        mode: 0o600,
      });
      fs.writeFileSync(
        fakeRouterSource,
        [
          `#!${process.execPath}`,
          'const fs = require("fs");',
          'const http = require("http");',
          'const path = require("path");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(setupLog)}, \`fresh \${args[0]}\\n\`);`,
          'if (args[0] === "proxy-config") {',
          '  const output = args[args.indexOf("--output") + 1];',
          "  fs.mkdirSync(path.dirname(output), { recursive: true });",
          '  fs.writeFileSync(output, "model_list: []\\n");',
          "  process.exit(0);",
          "}",
          'if (args[0] === "proxy") {',
          '  const port = Number(args[args.indexOf("--port") + 1] || "4000");',
          "  const server = http.createServer((req, res) => {",
          '    if (req.url === "/health") { res.statusCode = 200; res.end("ok"); return; }',
          "    res.statusCode = 404;",
          "    res.end();",
          "  });",
          '  server.listen(port, "127.0.0.1");',
          "  setTimeout(() => process.exit(0), 10000);",
          "} else {",
          "  process.exit(1);",
          "}",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const script = String.raw`
const fs = require("fs");
const path = require("path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const routerPort = ${routerPort};
const repoRoot = ${JSON.stringify(repoRoot)};
const blueprintPath = path.join(repoRoot, "nemoclaw-blueprint", "blueprint.yaml");
const routerPyproject = path.join(repoRoot, "nemoclaw-blueprint", "router", "llm-router", "pyproject.toml");
const originalReadFileSync = fs.readFileSync;
const originalRun = runner.run;
const originalExistsSync = fs.existsSync;
fs.existsSync = (filePath) => {
  if (filePath === routerPyproject || String(filePath) === routerPyproject) return true;
  return originalExistsSync(filePath);
};
fs.readFileSync = (filePath, ...args) => {
  const raw = originalReadFileSync(filePath, ...args);
  if (filePath === blueprintPath || String(filePath) === blueprintPath) {
    return String(raw)
      .replace('endpoint: "http://localhost:4000/v1"', 'endpoint: "http://localhost:' + routerPort + '/v1"')
      .replace("port: 4000", "port: " + routerPort);
  }
  return raw;
};

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  if (cmd.startsWith("python3 -m venv") || cmd.includes("/bin/python -m pip")) {
    return originalRun(command, opts);
  }
  if (/(^|[\/\s])pip3(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected pip3 invocation in test harness: " + cmd);
  }
  if (cmd.includes("git -C") || /^git(?:\s|$)/.test(cmd)) {
    throw new Error("unexpected git invocation in test harness: " + cmd);
  }
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("git -C") && cmd.includes("rev-parse HEAD")) {
    return ${JSON.stringify(MODEL_ROUTER_TEST_SOURCE_SHA)};
  }
  if (cmd.includes("command -v") && /model-router$/.test(cmd)) {
    return ${JSON.stringify(path.join(fakeBin, "model-router"))};
  }
  if (cmd.includes("command -v") && /python3$/.test(cmd)) {
    return ${JSON.stringify(path.join(fakeBin, "python3"))};
  }
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-router",
      "  Model: nvidia-routed",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-router-secret";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "router-box",
    "nvidia-routed",
    "nvidia-router",
    "http://host.openshell.internal:" + routerPort + "/v1",
    "NVIDIA_API_KEY",
  );
  console.log(JSON.stringify({ commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          HOME: tmpDir,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          FAKE_ROUTER_SOURCE: fakeRouterSource,
          ROUTER_SETUP_LOG: setupLog,
          NEMOCLAW_MODEL_ROUTER_VENV: venvDir,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const log = fs.readFileSync(setupLog, "utf-8");
      assert.ok(log.includes(`python3 -m venv ${venvDir}`), log);
      assert.ok(
        log.includes(
          `venv-python -m pip install --quiet --upgrade ${path.join(repoRoot, "nemoclaw-blueprint", "router", "llm-router")}[prefill,proxy]`,
        ),
        log,
      );
      assert.match(log, /fresh proxy-config/);
      assert.doesNotMatch(log, /stale-managed/);
      assert.doesNotMatch(log, /path-router/);
      const payload = parseStdoutJson<{ commands: CommandEntry[] }>(result.stdout);
      assert.ok(payload.commands.some((entry) => /provider create/.test(entry.command)));
      assert.ok(payload.commands.some((entry) => /inference set/.test(entry.command)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
