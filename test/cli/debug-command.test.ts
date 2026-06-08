// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDebugCommandTestEnv,
  run,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI debug command", () => {
  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", testTimeoutOptions(30_000), () => {
    const r = runWithEnv(
      "debug --quick",
      createDebugCommandTestEnv("nemoclaw-cli-debug-quick-"),
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it.skipIf(os.platform() !== "linux")(
    "debug --quick explains restricted dmesg instead of printing raw stderr on Linux",
    testTimeoutOptions(30_000),
    () => {
      const env = createDebugCommandTestEnv("nemoclaw-cli-debug-dmesg-");
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

      const r = runWithEnv("debug --quick", env, 30000);

      expect(r.code).toBe(0);
      expect(r.out).toContain("Kernel Messages");
      expect(r.out).toContain("kernel messages skipped");
      expect(r.out).toContain("dmesg access is restricted");
      expect(r.out).not.toContain("dmesg: read kernel buffer failed: Operation not permitted");
    },
  );

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Nonexistent flag: --quik");
  });

  it("debug --output without a path is rejected by oclif", () => {
    const r = run("debug --output");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Flag --output expects a value");
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("debug --sandbox NAME targets the specified sandbox", testTimeoutOptions(30_000), () => {
    const r = runWithEnv(
      "debug --quick --sandbox mybox",
      createDebugCommandTestEnv("nemoclaw-cli-debug-sandbox-", { extraSandboxNames: ["mybox"] }),
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });

  it("debug --sandbox NAME rejects an unregistered name and exits non-zero", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-debug-unknown-"));
    writeSandboxRegistry(home);
    const tarball = path.join(home, "out.tar.gz");
    const r = runWithEnv(
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
    () => {
      // Same fixture pattern as createDebugCommandTestEnv but with an openshell
      // stub whose live list intentionally omits the registry name, mirroring
      // the bug where the local registry kept a name the gateway no longer
      // serves.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-debug-stale-"));
      const localBin = path.join(home, "bin");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home, "stale-box");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          "  echo 'NAME'",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      const tarball = path.join(home, "out.tar.gz");
      const r = runWithEnv(
        `debug --sandbox stale-box --output ${tarball} 2>&1`,
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30000,
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("stale-box");
      expect(r.out).toContain("not registered");
      expect(fs.existsSync(tarball)).toBe(false);
    },
  );

  it("debug --sandbox without a name exits 1", () => {
    const r = run("debug --sandbox");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--sandbox");
  });

  it("debug warns when default sandbox is stale", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: "ghost" }),
      { mode: 0o600 },
    );
    const r = runWithEnv("debug --quick 2>&1", { HOME: home }, 30000);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Warning");
    expect(r.out).toContain("ghost");
    expect(r.out).toContain("--sandbox NAME");
  });

  it("debug --sandbox skips stale default warning", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
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
            policies: [],
          },
        },
        defaultSandbox: "ghost",
      }),
      { mode: 0o600 },
    );
    // Fake openshell so the live-list check sees `mybox`. Without this the
    // host's real openshell (or absence thereof) decides the assertion.
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME'",
        "  echo 'mybox      Ready'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = runWithEnv(
      "debug --quick --sandbox mybox 2>&1",
      { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("default sandbox 'ghost'");
    expect(r.out).not.toContain("--sandbox NAME");
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });
});
