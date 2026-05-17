// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

const repoRoot = path.join(import.meta.dirname, "..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

describe("onboard custom Dockerfile", () => {
  it("uses the custom Dockerfile parent directory as build context when --from is given", testTimeoutOptions(60_000), async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-dockerfile-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-from.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    // Create a minimal custom Dockerfile in a temporary directory
    const customBuildDir = path.join(tmpDir, "custom-image");
    fs.mkdirSync(customBuildDir, { recursive: true });
    fs.writeFileSync(
      path.join(customBuildDir, "Dockerfile"),
      [
        "FROM ubuntu:22.04",
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-super-49b-v1",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-super-49b-v1",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
        "RUN echo done",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(customBuildDir, "extra.txt"), "extra build context file");
    fs.writeFileSync(path.join(customBuildDir, "large.bin"), "small file with large mocked stat");
    fs.mkdirSync(path.join(customBuildDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(customBuildDir, "node_modules", "pkg", "ignored.txt"), "skip me");
    fs.mkdirSync(path.join(customBuildDir, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(customBuildDir, ".ssh", "id_ed25519"), "fake test key");
    fs.mkdirSync(path.join(customBuildDir, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(customBuildDir, ".aws", "credentials"), "fake test credentials");
    fs.mkdirSync(path.join(customBuildDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(customBuildDir, "secrets", "token.txt"), "fake test token");
    fs.writeFileSync(path.join(customBuildDir, ".env.local"), "EXAMPLE=fake");
    fs.writeFileSync(
      path.join(customBuildDir, ".npmrc"),
      "registry=https://registry.example.test\n",
    );
    fs.writeFileSync(path.join(customBuildDir, "model.pem"), "fake test certificate");
    fs.writeFileSync(path.join(customBuildDir, "credentials.json"), "{}");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const customDockerfilePath = JSON.stringify(path.join(customBuildDir, "Dockerfile"));

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
let hasExtraFileAtSpawn = false;
let stagedIgnoredFilesAtSpawn = null;
const largeFilePath = ${JSON.stringify(path.join(customBuildDir, "large.bin"))};
const originalStatSync = fs.statSync;
fs.statSync = (target, ...rest) => {
  const stats = originalStatSync(target, ...rest);
  if (target === largeFilePath) {
    return { ...stats, size: 101_000_000 };
  }
  return stats;
};
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const cmd = _n(args[1][1]);
  commands.push({ command: cmd, env: args[2]?.env || null });
  // Observe the staged build context state while the sandbox create is in
  // flight — onboard deletes it once streamSandboxCreate resolves.
  const fromMatch = cmd.match(/--from\s+(\S+)/);
  if (fromMatch) {
    const stagedDir = path.dirname(fromMatch[1]);
    hasExtraFileAtSpawn = fs.existsSync(path.join(stagedDir, "extra.txt"));
    stagedIgnoredFilesAtSpawn = {
      nodeModules: fs.existsSync(path.join(stagedDir, "node_modules")),
      ssh: fs.existsSync(path.join(stagedDir, ".ssh")),
      aws: fs.existsSync(path.join(stagedDir, ".aws")),
      secrets: fs.existsSync(path.join(stagedDir, "secrets")),
      env: fs.existsSync(path.join(stagedDir, ".env.local")),
      npmrc: fs.existsSync(path.join(stagedDir, ".npmrc")),
      pem: fs.existsSync(path.join(stagedDir, "model.pem")),
      credentialsJson: fs.existsSync(path.join(stagedDir, "credentials.json")),
    };
  }
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${customDockerfilePath});
  console.log(JSON.stringify({ sandboxName, hasExtraFile: hasExtraFileAtSpawn, stagedIgnoredFiles: stagedIgnoredFilesAtSpawn }));
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
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.sandboxName, "my-assistant");
    assert.match(result.stdout, /Using custom Dockerfile:/);
    assert.match(result.stdout, /Docker build context:/);
    assert.match(result.stdout, /Docker build context:.*custom-image/);
    assert.match(result.stderr, /WARN: build context contains about 101\.0 MB/);
    assert.equal(
      payload.hasExtraFile,
      true,
      "extra.txt from custom build context should be staged",
    );
    assert.deepEqual(payload.stagedIgnoredFiles, {
      nodeModules: false,
      ssh: false,
      aws: false,
      secrets: false,
      env: false,
      npmrc: false,
      pem: false,
      credentialsJson: false,
    });
  });

  it("exits with an error when the --from Dockerfile path does not exist", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-missing-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-missing.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const missingPath = JSON.stringify(path.join(tmpDir, "does-not-exist", "Dockerfile"));

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${missingPath});
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
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 1, "should exit 1 when fromDockerfile path is missing");
    assert.match(result.stderr, /Custom Dockerfile not found/);
  });

  it("exits with an error when the --from Dockerfile path is a directory", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-dir-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-dir.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const directoryPath = JSON.stringify(tmpDir);

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${directoryPath});
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
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 1, "should exit 1 when fromDockerfile path is a directory");
    assert.match(result.stderr, /Custom Dockerfile path is not a file/);
  });

  it("exits clearly when the --from Dockerfile is inside an ignored context path", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-ignored-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-ignored.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const ignoredDir = path.join(tmpDir, "node_modules", "pkg");

    fs.mkdirSync(ignoredDir, { recursive: true });
    fs.writeFileSync(path.join(ignoredDir, "Dockerfile"), "FROM ubuntu:22.04\n");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const customDockerfilePath = JSON.stringify(path.join(ignoredDir, "Dockerfile"));

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${customDockerfilePath});
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
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 1, "should exit 1 when fromDockerfile is ignored");
    assert.match(result.stderr, /inside an ignored build-context path/);
  });

  it("cleans up the custom build context when staging fails", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-cleanup-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-cleanup.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const customBuildDir = path.join(tmpDir, "custom-image");

    fs.mkdirSync(customBuildDir, { recursive: true });
    fs.writeFileSync(path.join(customBuildDir, "Dockerfile"), "FROM ubuntu:22.04\n");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const customDockerfilePath = JSON.stringify(path.join(customBuildDir, "Dockerfile"));
    const customBuildDirLiteral = JSON.stringify(customBuildDir);

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});

let createdBuildContext = null;
const originalMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...rest) => {
  const dir = originalMkdtempSync(prefix, ...rest);
  if (String(prefix).includes("nemoclaw-build-")) {
    createdBuildContext = dir;
  }
  return dir;
};
const originalCpSync = fs.cpSync;
fs.cpSync = (src, dest, options) => {
  if (src === ${customBuildDirLiteral}) {
    fs.writeFileSync(path.join(dest, "partial.txt"), "partial custom context");
    throw new Error("simulated custom context copy failure");
  }
  return originalCpSync(src, dest, options);
};

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  try {
    await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${customDockerfilePath});
  } catch (error) {
    console.log(JSON.stringify({
      removed: Boolean(createdBuildContext) && !fs.existsSync(createdBuildContext),
      message: error.message,
    }));
    return;
  }
  console.error("expected createSandbox to throw");
  process.exit(1);
})();
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop()!);
    assert.equal(payload.removed, true, result.stdout);
    assert.match(payload.message, /simulated custom context copy failure/);
  });

});
