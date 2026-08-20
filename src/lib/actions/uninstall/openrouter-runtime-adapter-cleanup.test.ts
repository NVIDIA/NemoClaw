// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  type UninstallRunDeps,
  type UninstallRunOptions,
  runUninstallPlan as runUninstallPlanBase,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: gatewayPort === 8080 ? "packaged-service" : "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
  });
}

const BEDROCK_RUNTIME_ADAPTER_CMDLINE =
  "/usr/bin/node /home/test/NemoClaw/dist/lib/inference/bedrock-runtime-adapter.js\n";
const OPENROUTER_RUNTIME_ADAPTER_CMDLINE =
  "/usr/bin/node /home/test/NemoClaw/dist/lib/inference/openrouter-runtime-adapter-entry.js\n";
const HTTPS_PIN_RUNTIME_ADAPTER_CMDLINE =
  "/usr/bin/node /home/test/NemoClaw/dist/lib/inference/https-pin-runtime-adapter.js\n";

const RUNTIME_ADAPTERS = [
  {
    cmdline: OPENROUTER_RUNTIME_ADAPTER_CMDLINE,
    customPort: 12037,
    defaultPort: 11437,
    envPort: "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
    foreignPid: 99998,
    issueSuffix: " (#5826)",
    label: "OpenRouter Runtime adapter",
    orphanPid: 33334,
    persistedPid: 44323,
    pidFile: "openrouter-runtime-adapter.pid",
  },
  {
    cmdline: BEDROCK_RUNTIME_ADAPTER_CMDLINE,
    customPort: 12036,
    defaultPort: 11436,
    envPort: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
    foreignPid: 99996,
    issueSuffix: " (#9552)",
    label: "Bedrock Runtime adapter",
    orphanPid: 33336,
    persistedPid: 44325,
    pidFile: "bedrock-runtime-adapter.pid",
  },
  {
    cmdline: HTTPS_PIN_RUNTIME_ADAPTER_CMDLINE,
    customPort: 12038,
    defaultPort: 11438,
    envPort: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
    foreignPid: 99997,
    issueSuffix: "",
    label: "HTTPS Pin Runtime adapter",
    orphanPid: 33338,
    persistedPid: 44324,
    pidFile: "https-pin-runtime-adapter.pid",
  },
] as const;

type RunStub = (args: readonly string[]) => RunResult | null;

function psStub(pidStr: string, opts: { exited: Set<number>; cmdline?: string; owner?: string }) {
  const pid = Number(pidStr);
  const responses = new Map<string, () => RunResult>([
    [
      ["-p", pidStr, "-o", "pid="].join("\0"),
      () => (opts.exited.has(pid) ? notFound() : ok(`${pidStr}\n`)),
    ],
    [["-p", pidStr, "-o", "user="].join("\0"), () => ok(`${opts.owner ?? "testuser"}\n`)],
    [
      ["-p", pidStr, "-o", "args="].join("\0"),
      () => ok(opts.cmdline ?? OPENROUTER_RUNTIME_ADAPTER_CMDLINE),
    ],
  ]);

  return (args: readonly string[]): RunResult | null => {
    return responses.get(args.join("\0"))?.() ?? null;
  };
}

function defaultRun(command: string, args: readonly string[]): RunResult {
  switch (command) {
    case "openshell":
      return args[0] === "gateway" && args[1] === "list"
        ? ok(JSON.stringify([{ name: "nemoclaw" }]))
        : ok("");
    case "lsof":
      return ok("");
    default:
      switch (args[0]) {
        case "-c":
          return ok("/fake/bin/tool\n");
        case "-f":
          return ok("");
        default:
          return ok();
      }
  }
}

function runStub(routes: Record<string, RunStub> = {}) {
  return (command: string, args: readonly string[]): RunResult => {
    return routes[command]?.(args) ?? defaultRun(command, args);
  };
}

function lsofPortStub(ports: string[], portPids: Map<string, RunResult>) {
  return (args: readonly string[]): RunResult => {
    const port = args[1] ?? "";
    ports.push(port);
    return portPids.get(port) ?? ok("");
  };
}

describe("runtime adapter uninstall cleanup", () => {
  it.each(RUNTIME_ADAPTERS)(
    "stops $label from its persisted PID before state removal$issueSuffix",
    ({ cmdline, label, persistedPid, pidFile: pidFilename }) => {
      const logs: string[] = [];
      const killed: number[] = [];
      const exited = new Set<number>();
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-adapter-pid-"));
      const pidFile = path.join(tmpHome, ".nemoclaw", pidFilename);
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, `${String(persistedPid)}\n`);

      try {
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: () => true,
            env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
            existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
            isTty: false,
            kill: (pid) => {
              killed.push(pid);
              exited.add(pid);
              return true;
            },
            log: (line) => logs.push(line),
            rmSync: fs.rmSync,
            run: runStub({
              ps: psStub(String(persistedPid), { cmdline, exited }),
            }),
            runDocker: () => ok(""),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(killed).toContain(persistedPid);
        expect(logs).toContain(`Stopped ${label} ${String(persistedPid)}`);
        expect(fs.existsSync(pidFile)).toBe(false);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it.each(RUNTIME_ADAPTERS)(
    "stops an owned $label orphan on its configured port$issueSuffix",
    ({ cmdline, customPort, defaultPort, envPort, label, orphanPid }) => {
      const logs: string[] = [];
      const killed: number[] = [];
      const exited = new Set<number>();
      const lsofPorts: string[] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: {
            HOME: "/tmp/nemoclaw-uninstall-test-adapter-custom-port",
            LOGNAME: "testuser",
            [envPort]: String(customPort),
          } as NodeJS.ProcessEnv,
          existsSync: () => false,
          isTty: false,
          kill: (pid) => {
            killed.push(pid);
            exited.add(pid);
            return true;
          },
          log: (line) => logs.push(line),
          rmSync: vi.fn(),
          run: runStub({
            lsof: lsofPortStub(
              lsofPorts,
              new Map([[`:${String(customPort)}`, ok(`${String(orphanPid)}\n`)]]),
            ),
            ps: psStub(String(orphanPid), { cmdline, exited }),
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(lsofPorts).toContain(`:${String(customPort)}`);
      expect(lsofPorts).not.toContain(`:${String(defaultPort)}`);
      expect(killed).toContain(orphanPid);
      expect(logs).toContain(`Stopped ${label} ${String(orphanPid)}`);
    },
  );

  it.each(RUNTIME_ADAPTERS)(
    "does not signal an unrelated process on the $label port$issueSuffix",
    ({ defaultPort, foreignPid, label }) => {
      const logs: string[] = [];
      const killed: number[] = [];
      const lsofPorts: string[] = [];
      const stub = psStub(String(foreignPid), {
        exited: new Set(),
        cmdline: "/usr/sbin/nginx -g daemon off;\n",
      });
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: {
            HOME: "/tmp/nemoclaw-uninstall-test-adapter-foreign",
            LOGNAME: "testuser",
          } as NodeJS.ProcessEnv,
          existsSync: () => false,
          isTty: false,
          kill: (pid) => {
            killed.push(pid);
            return true;
          },
          log: (line) => logs.push(line),
          rmSync: vi.fn(),
          run: runStub({
            lsof: lsofPortStub(
              lsofPorts,
              new Map([[`:${String(defaultPort)}`, ok(`${String(foreignPid)}\n`)]]),
            ),
            ps: stub,
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(lsofPorts).toContain(`:${String(defaultPort)}`);
      expect(killed).not.toContain(foreignPid);
      expect(logs).toContain(`No ${label} processes found`);
    },
  );

  it("does not signal a Bedrock marker lookalike from persisted state or port discovery (#9552)", () => {
    const foreignPid = 99995;
    const killed: number[] = [];
    const lsofPorts: string[] = [];
    let commandLineProbeCount = 0;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bedrock-marker-"));
    const pidFile = path.join(tmpHome, ".nemoclaw", "bedrock-runtime-adapter.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${String(foreignPid)}\n`);
    const stub = psStub(String(foreignPid), {
      exited: new Set(),
      cmdline: "/usr/bin/node /tmp/not-bedrock-runtime-adapter.js\n",
    });

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill: (pid) => {
            killed.push(pid);
            return true;
          },
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: runStub({
            lsof: lsofPortStub(lsofPorts, new Map([[":11436", ok(`${String(foreignPid)}\n`)]])),
            ps: (args) => {
              commandLineProbeCount += Number(
                args.join("\0") === ["-p", String(foreignPid), "-o", "args="].join("\0"),
              );
              return stub(args);
            },
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(commandLineProbeCount).toBe(2);
      expect(lsofPorts).toContain(":11436");
      expect(killed).not.toContain(foreignPid);
      expect(fs.existsSync(pidFile)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
