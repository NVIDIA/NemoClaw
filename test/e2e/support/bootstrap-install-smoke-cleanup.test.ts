// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  cleanupBootstrapClone,
  registerBootstrapRuntimeCleanup,
} from "../live/bootstrap-install-smoke-cleanup.ts";

class BootstrapHostFixture extends HostCliClient {
  readonly sandboxes = new Set<string>();
  readonly runtimeSandboxes = new Set<string>();
  readonly gateways = new Set<string>();
  readonly failures = new Set<string>();
  readonly leaveBehind = new Set<string>();
  readonly unsupportedGatewayVerbs = new Set<string>();
  readonly gatewayDeletionVerbs: string[] = [];

  constructor() {
    super({
      run: async () => {
        throw new Error("Bootstrap fixture commands must use the state-backed command handler");
      },
    });
  }

  override async command(command: string, args: string[]): Promise<ShellProbeResult> {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const operation =
      command === "sudo"
        ? "clone"
        : command === "rm"
          ? "clone"
          : command === "nemoclaw"
            ? args[0] === "list"
              ? "inventory"
              : "sandbox"
            : args[0] === "gateway"
              ? args[1] === "list"
                ? "gateways"
                : "gateway"
              : args[1] === "list"
                ? "runtime-inventory"
                : "runtime";
    if (operation === "gateway") this.gatewayDeletionVerbs.push(args[1]);
    if (operation === "gateway" && this.unsupportedGatewayVerbs.has(args[1])) {
      exitCode = 2;
      stderr = `unrecognized subcommand '${args[1]}'`;
    } else if (this.failures.has(operation)) {
      exitCode = 1;
      stderr = `injected ${operation} deletion failure`;
    } else if (operation === "inventory") {
      stdout = JSON.stringify({ sandboxes: [...this.sandboxes].map((name) => ({ name })) });
    } else if (operation === "gateways") {
      stdout = JSON.stringify([...this.gateways].map((name) => ({ name })));
    } else if (operation === "runtime-inventory") {
      if (!this.gateways.has("nemoclaw")) {
        exitCode = 1;
        stderr = "gateway nemoclaw not found";
      } else {
        stdout = JSON.stringify([...this.runtimeSandboxes].map((name) => ({ name })));
      }
    } else if (operation === "clone") {
      if (!this.leaveBehind.has(operation))
        fs.rmSync(args.at(-1)!, { recursive: true, force: true });
    } else {
      const resources =
        operation === "gateway"
          ? this.gateways
          : operation === "sandbox"
            ? this.sandboxes
            : this.runtimeSandboxes;
      const name = operation === "sandbox" ? args[0] : args.at(-1)!;
      if (!resources.has(name)) {
        exitCode = 1;
        stderr =
          operation === "gateway"
            ? `gateway ${name} not found`
            : operation === "runtime"
              ? "Error: code: 'Some requested entity was not found', message: \"sandbox not found\""
              : `sandbox ${name} not found`;
      } else if (!this.leaveBehind.has(operation)) {
        resources.delete(name);
      }
    }
    return {
      command: [command, ...args],
      exitCode,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
      artifacts: { stdout: "stdout.txt", stderr: "stderr.txt", result: "result.json" },
    };
  }
}

describe("bootstrap install smoke owned cleanup", () => {
  it.each(["remove", "destroy"])(
    "cleans up through the supported gateway %s verb",
    async (supportedVerb) => {
      const host = new BootstrapHostFixture();
      host.unsupportedGatewayVerbs.add(supportedVerb === "remove" ? "destroy" : "remove");
      const cleanup = new CleanupRegistry();
      await registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {});
      host.gateways.add("nemoclaw");
      expect((await cleanup.runAll()).failures).toEqual([]);
      expect(host.gateways.size).toBe(0);
      expect(host.gatewayDeletionVerbs).toEqual(
        supportedVerb === "remove" ? ["remove"] : ["remove", "destroy"],
      );
    },
  );

  it.each(["gateway", "sandbox"])(
    "preserves a pre-existing %s before claiming ownership",
    async (resource) => {
      const host = new BootstrapHostFixture();
      const cleanup = new CleanupRegistry();
      host.gateways.add(resource === "gateway" ? "nemoclaw" : "somebody-elses-gateway");
      host.sandboxes.add(resource === "sandbox" ? "e2e-owned" : "somebody-elses-sandbox");
      await expect(registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {})).rejects.toThrow(
        "requires an unused",
      );
      expect(await cleanup.runAll()).toEqual({ passed: [], failures: [] });
      expect(host.gateways.size).toBe(1);
      expect(host.sandboxes.size).toBe(1);
    },
  );

  it("reports each cleanup failure and still releases later owned resources", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-cleanup-"));
    context.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clone = path.join(directory, "owned-clone");
    const unrelated = path.join(directory, "unrelated");
    fs.mkdirSync(clone);
    fs.mkdirSync(unrelated);
    const host = new BootstrapHostFixture();
    const cleanup = new CleanupRegistry();
    cleanup.add("remove owned clone", () => cleanupBootstrapClone(host, clone, {}));
    await registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {});
    host.sandboxes.add("e2e-owned");
    host.runtimeSandboxes.add("e2e-owned");
    host.gateways.add("nemoclaw");
    host.failures.add("sandbox");
    host.failures.add("gateway");
    const result = await cleanup.runAll();
    expect(result.failures.map(({ message }) => message)).toEqual([
      expect.stringContaining("injected sandbox deletion failure"),
      expect.stringContaining("injected gateway deletion failure"),
    ]);
    expect(host.runtimeSandboxes.size).toBe(0);
    expect(host.sandboxes.has("e2e-owned")).toBe(true);
    expect(host.gateways.has("nemoclaw")).toBe(true);
    expect(fs.existsSync(clone)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("treats already absent resources as successful cleanup", async () => {
    const host = new BootstrapHostFixture();
    const cleanup = new CleanupRegistry();
    await registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {});
    expect((await cleanup.runAll()).failures).toEqual([]);
  });

  it.each(["sandbox", "runtime"])(
    "fails a successful %s command that leaves the owned sandbox behind",
    async (resource) => {
      const host = new BootstrapHostFixture();
      const cleanup = new CleanupRegistry();
      await registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {});
      host.sandboxes.add("e2e-owned");
      host.sandboxes.add("somebody-elses-sandbox");
      host.runtimeSandboxes.add("e2e-owned");
      host.runtimeSandboxes.add("somebody-elses-sandbox");
      host.gateways.add("nemoclaw");
      host.leaveBehind.add(resource);
      const result = await cleanup.runAll();
      expect(result.failures).toEqual([
        {
          name: expect.stringContaining(
            `owned bootstrap ${resource === "runtime" ? "runtime " : ""}sandbox e2e-owned`,
          ),
          message: expect.stringContaining("remains registered after cleanup"),
        },
      ]);
      expect(host.sandboxes.has("e2e-owned")).toBe(resource === "sandbox");
      expect(host.runtimeSandboxes.has("e2e-owned")).toBe(resource === "runtime");
      expect(host.sandboxes.has("somebody-elses-sandbox")).toBe(true);
      expect(host.runtimeSandboxes.has("somebody-elses-sandbox")).toBe(true);
      expect(host.gateways.size).toBe(0);
    },
  );

  it.each(["inventory", "runtime-inventory"])(
    "fails closed when %s cannot establish sandbox absence",
    async (inventory) => {
      const host = new BootstrapHostFixture();
      const cleanup = new CleanupRegistry();
      await registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {});
      host.gateways.add("nemoclaw");
      host.failures.add(inventory);
      const result = await cleanup.runAll();
      expect(result.failures).toEqual([
        {
          name: expect.stringContaining("sandbox e2e-owned"),
          message: expect.stringContaining(`injected ${inventory} deletion failure`),
        },
      ]);
      expect(host.gateways.size).toBe(0);
    },
  );

  it.for(["failure", "reported-success-with-leftover"])(
    "fails clone cleanup on %s",
    async (mode, context) => {
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-clone-failure-"));
      context.onTestFinished(() => fs.rmSync(clone, { recursive: true, force: true }));
      const host = new BootstrapHostFixture();
      if (mode === "failure") host.failures.add("clone");
      else host.leaveBehind.add("clone");
      const cleanup = new CleanupRegistry();
      cleanup.add("remove owned clone", () => cleanupBootstrapClone(host, clone, {}));
      const result = await cleanup.runAll();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].message).toMatch(/deletion failure|still exists/);
      expect(fs.existsSync(clone)).toBe(true);
    },
  );

  it("fails a successful gateway command that leaves the owned registration behind", async () => {
    const host = new BootstrapHostFixture();
    const cleanup = new CleanupRegistry();
    await registerBootstrapRuntimeCleanup(cleanup, host, "e2e-owned", {});
    host.gateways.add("nemoclaw");
    host.leaveBehind.add("gateway");
    const result = await cleanup.runAll();
    expect(result.failures).toEqual([
      {
        name: "remove owned bootstrap gateway",
        message: "Owned bootstrap gateway remains registered after cleanup",
      },
    ]);
  });
});
