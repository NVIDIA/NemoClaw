// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";
// Verify sandbox names stay validated and out of raw shell command strings.
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { writeOkOpenshell } from "./helpers/onboard-openshell-fixture";

describe("sandboxName command hardening in onboard.js", () => {
  it("re-validates sandboxName at the createSandbox boundary", async () => {
    const onboardModule = await import("../src/lib/onboard.js");
    const { createSandbox } = onboardModule as unknown as {
      createSandbox: (
        gpu: null,
        model: string,
        provider: string,
        preferredInferenceApi: null,
        sandboxNameOverride: string,
      ) => Promise<string>;
    };

    await expect(
      createSandbox(null, "test-model", "nvidia-prod", null, "bad; touch /tmp/pwned"),
    ).rejects.toThrow(/Invalid sandbox name/);
  });

  it("runs setup-dns-proxy.sh through the argv helper instead of bash -c interpolation", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dns-argv-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-dns-argv.cjs");
    const sourceModule = (...segments: string[]) =>
      JSON.stringify(path.join(repoRoot, "src", "lib", ...segments));
    const onboardPath = sourceModule("onboard.ts");
    const runnerPath = sourceModule("runner.ts");
    const registryPath = sourceModule("state", "registry.ts");
    const preflightPath = sourceModule("onboard", "preflight.ts");
    const credentialsPath = sourceModule("credentials", "store.ts");
    const streamPath = sourceModule("sandbox", "create-stream.ts");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const sandboxCreateStream = require(${streamPath});
for (const key of Object.keys(process.env)) {
  if (/^(NEMOCLAW|OPENSHELL)_/.test(key) || key === "CHAT_UI_URL") {
    delete process.env[key];
  }
}
process.env.NEMOCLAW_OPENSHELL_BIN = ${JSON.stringify(path.join(fakeBin, "openshell"))};
const commands = [];
const asText = (command) => Array.isArray(command) ? command.join(" ") : String(command);
runner.run = (command, opts = {}) => {
  commands.push({ type: "run", command: asText(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", file, args, command: asText([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const text = asText(command);
  if (text.includes("sandbox get my-assistant")) return "";
  if (text.includes("sandbox list")) return "my-assistant Ready";
  if (text.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  if (text.includes("sandbox exec") && text.includes("http://localhost:") && text.includes("/health")) return "200";
  if (text === "uname -r") return "6.8.0";
  return "";
};
registry.getSandbox = () => null;
registry.getDisabledChannels = () => [];
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
registry.updateSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";
sandboxCreateStream.streamSandboxCreate = async () => ({
  status: 0,
  output: "Built image openshell/sandbox-from:123\nCreated sandbox: my-assistant",
  sawProgress: true,
});
const { createSandbox } = require(${onboardPath});
(async () => {
try {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_HEALTH_POLL_COUNT = "1";
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "x64" });
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
})();
`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
          scriptPath,
        ],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          env: { HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
          timeout: 30_000,
        },
      );
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      expect(payloadLine).toBeTruthy();
      const payload = JSON.parse(payloadLine!);
      const dnsCommand = payload.commands.find(
        (entry: { type: string; args: string[] }) =>
          entry.type === "runFile" && entry.args[0]?.endsWith("setup-dns-proxy.sh"),
      );
      expect(dnsCommand).toBeTruthy();
      expect(dnsCommand.file).toBe("bash");
      expect(dnsCommand.args).toEqual([
        expect.stringMatching(/setup-dns-proxy\.sh$/),
        "nemoclaw",
        "my-assistant",
      ]);
      expect(dnsCommand.command).not.toContain("bash -c");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds openshell argv with an explicit openshellBinary override", async () => {
    const onboardModule = await import("../src/lib/onboard.js");
    const onboard = onboardModule as unknown as {
      openshellArgv: (args: string[], opts?: { openshellBinary?: string }) => string[];
    };

    expect(
      onboard.openshellArgv(["--version"], { openshellBinary: "/tmp/custom-openshell" }),
    ).toEqual(["/tmp/custom-openshell", "--version"]);
  });
});
