// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { writeExternalGatewayAuthoritySession } from "../helpers/gateway-authority-session";
import { describe, expect, test as it } from "../helpers/owned-test-resources";

import {
  createDebugCommandTestEnv,
  runAsync,
  runWithEnvAsync,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

vi.setConfig({ maxConcurrency: 4 });

function createSandboxListStubEnv(
  home: string,
  liveSandboxNames: readonly string[],
): Record<string, string> {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/bin/sh",
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      "  echo 'NAME'",
      ...liveSandboxNames.map((name) => `  echo '${name}      Ready'`),
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    HOME: home,
    NEMOCLAW_OPENSHELL_BIN: "",
    PATH: `${localBin}:${process.env.PATH || ""}`,
  };
}

describe.concurrent("CLI debug command", () => {
  it("debug --help exits 0 and shows usage", async () => {
    const r = await runAsync("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it(
    "exits with status 0 and produces diagnostic output for debug --quick",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const r = await runWithEnvAsync(
        "debug --quick",
        createDebugCommandTestEnv(resources, "nemoclaw-cli-debug-quick-"),
        30000,
      );
      expect(r.code).toBe(0);
      expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
      expect(r.out.includes("System")).toBeTruthy();
      expect(r.out.includes("Onboard Session")).toBeTruthy();
      expect(r.out.includes("Done")).toBeTruthy();
    },
  );

  it(
    "debug --quick reports the selected gateway authority without its private state path (#6576)",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const env = createDebugCommandTestEnv(resources, "nemoclaw-cli-debug-authority-");
      expect(env.HOME).toBeTypeOf("string");
      writeExternalGatewayAuthoritySession(env.HOME!);

      const result = await runWithEnvAsync("debug --quick", env, 30000);

      expect(result.code).toBe(0);
      expect(result.out).toContain('"gatewayAuthority"');
      expect(result.out).toContain('"mode": "externally-supervised"');
      expect(result.out).toContain('"serviceName": "openshell-gateway.service"');
      expect(result.out).not.toContain("private-gateway-state");
    },
  );

  it.skipIf(os.platform() !== "linux")(
    "debug --quick explains restricted dmesg instead of printing raw stderr on Linux",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const env = createDebugCommandTestEnv(resources, "nemoclaw-cli-debug-dmesg-");
      const localBin = env.PATH?.split(path.delimiter)[0];
      if (!localBin) throw new Error("Expected debug test PATH to include a fake bin dir");
      fs.writeFileSync(
        path.join(localBin, "dmesg"),
        [
          "#!/bin/sh",
          "echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = await runWithEnvAsync("debug --quick", env, 30000);

      expect(r.code).toBe(0);
      expect(r.out).toContain("Kernel Messages");
      expect(r.out).toContain("kernel messages skipped");
      expect(r.out).toContain("dmesg access is restricted");
      expect(r.out).not.toContain("dmesg: read kernel buffer failed: Operation not permitted");
    },
  );

  it("debug exits 1 on unknown option", async () => {
    const r = await runAsync("debug --quik");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Nonexistent flag: --quik");
  });

  it("debug --output without a path is rejected by oclif", async () => {
    const r = await runAsync("debug --output");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Flag --output expects a value");
  });

  it("help mentions debug command", async () => {
    const r = await runAsync("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it(
    "debug --sandbox NAME targets the specified sandbox",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const r = await runWithEnvAsync(
        "debug --quick --sandbox mybox",
        createDebugCommandTestEnv(resources, "nemoclaw-cli-debug-sandbox-", {
          extraSandboxNames: ["mybox"],
        }),
        30000,
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
    },
  );

  it(
    "debug scopes OpenShell commands to the registered non-default gateway",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const argsLog = path.join(
        resources.home("nemoclaw-cli-debug-gateway-log-").home,
        "openshell-args.log",
      );
      const env = createDebugCommandTestEnv(resources, "nemoclaw-cli-debug-gateway-", {
        gatewayPort: 18080,
        openshellArgsLog: argsLog,
      });

      const r = await runWithEnvAsync("debug --quick", env, 30000);

      expect(r.code).toBe(0);
      const invocations = fs.readFileSync(argsLog, "utf-8");
      expect(invocations).toContain("sandbox list -g nemoclaw-18080");
      expect(invocations).toContain(
        `sandbox exec --name ${env.NEMOCLAW_SANDBOX} -g nemoclaw-18080`,
      );
      expect(invocations).not.toContain("sandbox ssh-config");
    },
  );

  it("debug --sandbox NAME rejects an unregistered name and exits non-zero", async ({
    resources,
  }) => {
    const home = resources.temporaryDirectory("nemoclaw-cli-debug-unknown-");
    writeSandboxRegistry(home);
    const tarball = path.join(home, "out.tar.gz");
    const r = await runWithEnvAsync(
      `debug --sandbox does-not-exist --output ${tarball} 2>&1`,
      { HOME: home },
      30000,
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does-not-exist");
    expect(r.out).toContain("not registered");
    expect(fs.existsSync(tarball)).toBe(false);
  });

  it(
    "debug --sandbox NAME rejects a stale registry entry missing from the live gateway",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      // Same fixture pattern as createDebugCommandTestEnv but with an openshell
      // stub whose live list intentionally omits the registry name, mirroring
      // the bug where the local registry kept a name the gateway no longer
      // serves.
      const home = resources.temporaryDirectory("nemoclaw-cli-debug-stale-");
      writeSandboxRegistry(home, "stale-box");
      const tarball = path.join(home, "out.tar.gz");
      const r = await runWithEnvAsync(
        `debug --sandbox stale-box --output ${tarball} 2>&1`,
        createSandboxListStubEnv(home, []),
        30000,
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("stale-box");
      expect(r.out).toContain("local registry but not in OpenShell");
      expect(fs.existsSync(tarball)).toBe(false);
    },
  );

  it("debug --sandbox without a name exits 1", async () => {
    const r = await runAsync("debug --sandbox");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--sandbox");
  });

  it(
    "debug warns when default sandbox is stale",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const home = resources.temporaryDirectory("nemoclaw-cli-stale-");
      writeSandboxRegistry(home, "ghost");
      const r = await runWithEnvAsync(
        "debug --quick 2>&1",
        createSandboxListStubEnv(home, []),
        30000,
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("Warning");
      expect(r.out).toContain("ghost");
      expect(r.out).toContain("local registry but not in OpenShell");
      expect(r.out).toContain("--sandbox NAME");
    },
  );

  it(
    "debug --sandbox skips stale default warning",
    testTimeoutOptions(30_000),
    async ({ resources }) => {
      const home = resources.temporaryDirectory("nemoclaw-cli-stale-");
      fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".nemoclaw", "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            mybox: {
              name: "mybox",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
            },
          },
          defaultSandbox: "ghost",
        }),
        { mode: 0o600 },
      );
      // Fake openshell so the live-list check sees `mybox`. Without this the
      // host's real openshell (or absence thereof) decides the assertion.
      const r = await runWithEnvAsync(
        "debug --quick --sandbox mybox 2>&1",
        createSandboxListStubEnv(home, ["mybox"]),
        30000,
      );
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("default sandbox 'ghost'");
      expect(r.out).not.toContain("--sandbox NAME");
      expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
    },
  );
});
