// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";
// Verify sandbox names stay validated and out of raw shell command strings.
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { completeOrdinaryOnboardSandboxCreation } from "../../src/lib/onboard/created-sandbox-finalization";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

describe("sandboxName command hardening in onboard.js", () => {
  it("re-validates sandboxName at the createSandbox boundary", async () => {
    const onboardModule = await import("../../src/lib/onboard.js");
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
      createSandbox(null, "test-model", "nvidia-prod", null, "bad;touch"),
    ).rejects.toThrow(/Invalid sandbox name/);
  });

  it("passes DNS proxy gateway values as one literal argument", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dns-literal-"));
    const argsFile = path.join(tmpDir, "dns-args.txt");
    const sideEffectFile = path.join(tmpDir, "shell-expanded");
    const gatewayName = `nemoclaw; touch ${sideEffectFile}; #`;
    fs.writeFileSync(
      path.join(tmpDir, "setup-dns-proxy.sh"),
      '#!/usr/bin/env bash\nset -eu\nprintf \'%s\\n\' "$1" "$2" > "$NEMOCLAW_DNS_ARGS_FILE"\n',
    );

    try {
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "my-assistant",
          sandboxWasLiveDefault: false,
          gatewayPort: 8080,
          runtimeFields: { openshellDriver: "kubernetes" },
          messagingProviders: [],
          liveExists: true,
        } as never,
        {
          setDefault: () => undefined,
          runFile: (command: string, args: string[]) =>
            spawnSync(command, args, {
              encoding: "utf-8",
              env: { ...process.env, NEMOCLAW_DNS_ARGS_FILE: argsFile },
            }),
          scriptsDir: tmpDir,
          gatewayName,
          providerExistsInGateway: () => true,
          armCancelRollback: () => undefined,
          markCancellationRecovery: () => undefined,
          dockerInfoFormat: () => "",
          runCapture: () => "",
          revalidateSandboxIdentity: () => undefined,
          applyVmDnsMonkeypatch: () => undefined,
        } as never,
      );

      expect(fs.readFileSync(argsFile, "utf-8").trim().split("\n")).toEqual([
        gatewayName,
        "my-assistant",
      ]);
      expect(fs.existsSync(sideEffectFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scopes created sandbox probes to the owning gateway", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
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
    const onboardScriptMocksPath = JSON.stringify(
      path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
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
const createdSandbox = fixtureMocks.createCreatedSandboxFixture();
createdSandbox.installRuntimeObservation();
runner.run = (command, opts = {}) => {
  const text = asText(command);
  commands.push({ type: "run", command: text, env: opts.env || null });
  if (text.includes("provider profile") && text.includes("export nemoclaw-mcp-v1")) {
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        id: "nemoclaw-mcp-v1",
        credentials: [],
        endpoints: [],
        binaries: [],
        inference_capable: false,
      })),
      stderr: Buffer.alloc(0),
    };
  }
  return createdSandbox.run(command) ?? { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", file, args, command: asText([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const text = asText(command);
  const createdIdentity = createdSandbox.capture(command);
  if (createdIdentity !== null) return createdIdentity;
  if (text.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  if (text.includes("sandbox exec") && text.includes("http://localhost:") && text.includes("/health")) return "200";
  if (text === "uname -r") return "6.8.0";
  const mockedCapture = fixtureMocks.mockOnboardRunCapture(command);
  if (mockedCapture !== null) return mockedCapture;
  return "";
};
registry.getSandbox = () => null;
registry.getDisabledChannels = () => [];
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
registry.updateSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";
sandboxCreateStream.streamSandboxCreate = async (...args) => {
  createdSandbox.create(args.flat());
  return {
    status: 0,
    output: "Built image openshell/sandbox-from:123\nCreated sandbox: my-assistant",
    sawProgress: true,
  };
};
const { createSandbox } = require(${onboardPath});
(async () => {
try {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_HEALTH_POLL_COUNT = "1";
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "x64" });
  const sandboxName = await createSandbox(
    ...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
      [
        null,
        "gpt-5.4",
        "nvidia-prod",
        null,
        "my-assistant",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [],
      ],
      createFixture,
    ),
  );
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
          env: {
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            NEMOCLAW_TEST_MANAGED_IMAGE_FALLBACK: "1",
          },
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
      const sandboxGetCommands = payload.commands.filter(
        (entry: { command: string }) =>
          entry.command.includes("sandbox get") && entry.command.includes("my-assistant"),
      );
      const sandboxExecCommands = payload.commands.filter(
        (entry: { command: string }) =>
          entry.command.includes("sandbox exec") && entry.command.includes("my-assistant"),
      );
      expect(sandboxGetCommands).not.toHaveLength(0);
      expect(sandboxExecCommands).not.toHaveLength(0);
      expect(
        sandboxGetCommands.every(
          (entry: { command: string }) =>
            entry.command.includes("sandbox get -g nemoclaw") ||
            entry.command.includes("sandbox get --gateway nemoclaw"),
        ),
      ).toBe(true);
      expect(
        sandboxExecCommands.every(
          (entry: { command: string }) =>
            entry.command.includes("sandbox exec -g nemoclaw") ||
            entry.command.includes("--gateway nemoclaw"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds openshell argv with an explicit openshellBinary override", async () => {
    const onboardModule = await import("../../src/lib/onboard.js");
    const onboard = onboardModule as unknown as {
      openshellArgv: (args: string[], opts?: { openshellBinary?: string }) => string[];
    };

    expect(
      onboard.openshellArgv(["--version"], { openshellBinary: "/tmp/custom-openshell" }),
    ).toEqual(["/tmp/custom-openshell", "--version"]);
  });
});
