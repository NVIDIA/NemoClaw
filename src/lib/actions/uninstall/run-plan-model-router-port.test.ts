// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import { resolveGatewayStateDirName } from "../../onboard/gateway-binding";
import { writeCompleteDockerDriverGatewayLocalTlsBundle } from "../../onboard/__test-helpers__/docker-driver-gateway-local-tls";
import { runUninstallPlan, type RunResult } from "./run-plan";
import { createRouterMigrationHarness } from "../../../../test/support/uninstall-model-router-migration";
import { readOnboardSessionModelRouter } from "./runtime-commands";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const missing = (): RunResult => ({ status: 1, stdout: "", stderr: "" });

it.each([
  { receipt: "recorded", sibling: false },
  { receipt: "legacy", sibling: false },
  { receipt: "recorded", sibling: true },
  { receipt: "legacy", sibling: true },
])(
  "uses the $receipt router identity despite filesystem warnings without stopping a sibling router (sibling=$sibling)",
  async ({ receipt, sibling }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-router-port-"));
    const blueprintDir = path.join(root, "nemoclaw-blueprint");
    const stateDir = path.join(root, ".nemoclaw");
    const routerPort = 14000;
    const routerPid = 55680;
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const routerRuntime = path.join(stateDir, "model-router-venv", "pyvenv.cfg");
    fs.mkdirSync(path.dirname(routerRuntime));
    fs.writeFileSync(routerRuntime, "shared router runtime\n");
    const gatewayState = path.join(root, ".local/state/nemoclaw", resolveGatewayStateDirName(8080));
    const jwtBundle = ensureDockerDriverGatewayJwtBundle(gatewayState);
    writeCompleteDockerDriverGatewayLocalTlsBundle(gatewayState);
    fs.writeFileSync(
      path.join(gatewayState, "openshell-gateway.toml"),
      buildDockerDriverGatewayConfigToml(
        {
          OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
          OPENSHELL_LOCAL_TLS_DIR: path.join(gatewayState, "tls"),
          OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
          OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
        },
        "/usr/bin/openshell-sandbox",
        jwtBundle,
        gatewayIdForStateDir(gatewayState),
      ),
      { mode: 0o600 },
    );
    writeManagedGatewayRuntimeProof(gatewayState, 8080);
    fs.writeFileSync(
      path.join(stateDir, "onboard-session.json"),
      JSON.stringify({
        provider: "nvidia-router",
        routerPid,
        ...(receipt === "recorded"
          ? { routerPort }
          : { endpointUrl: `http://host.openshell.internal:${routerPort}` }),
      }),
    );
    fs.writeFileSync(
      path.join(blueprintDir, "blueprint.yaml"),
      [
        "components:",
        "  inference:",
        "    profiles:",
        "      routed:",
        "        model: test/model",
        "  router:",
        "    enabled: true",
        "    port: 15000",
        "",
      ].join("\n"),
    );
    const killed: number[] = [];
    const errors: string[] = [];
    const exited = new Set<number>();
    let listenerOverride: RunResult | undefined;
    const run = vi.fn((command: string, args: string[]): RunResult => {
      switch (command) {
        case "lsof": {
          const result =
            args[1] === `:${String(routerPort)}`
              ? (listenerOverride ??
                (exited.has(routerPid) ? missing() : ok(`${String(routerPid)}\n`)))
              : ok();
          return {
            ...result,
            stderr:
              result.stderr ||
              (args.includes("-w")
                ? ""
                : "lsof: WARNING: can't stat() fuse.gvfsd-fuse file system"),
          };
        }
        case "ps":
          switch (args[3]) {
            case "user=":
              return ok("testuser\n");
            case "args=":
              return ok(
                `/home/test/.nemoclaw/model-router-venv/bin/python /home/test/.nemoclaw/model-router-venv/bin/model-router proxy --port ${String(routerPort)}\n`,
              );
            case "pid=":
            case "stat=":
              return exited.has(routerPid) ? missing() : ok(`${String(routerPid)}\n`);
            default:
              return missing();
          }
        case "openshell":
          return args[0] === "gateway" && args[1] === "list"
            ? ok(
                JSON.stringify(
                  sibling
                    ? [{ name: "nemoclaw" }, { name: "nemoclaw-8091" }]
                    : [{ name: "nemoclaw" }],
                ),
              )
            : ok();
        default:
          return args[0] === "-c" ? ok("/fake/bin/tool\n") : ok();
      }
    });

    try {
      const uninstall = () =>
        runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          withProvenManagedGatewayProcess({
            commandExists: () => true,
            env: { HOME: root, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
            error: (message) => errors.push(message),
            existsSync: (target) => target.startsWith(root) && fs.existsSync(target),
            isTty: false,
            kill: (pid) => {
              killed.push(pid);
              exited.add(pid);
              return true;
            },
            log: () => undefined,
            resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
              endpoint: null,
              gatewayName,
              gatewayPort,
              mode: "nemoclaw-managed",
              requiredCapabilities: [],
              source: "packaged-service",
              stateDir: null,
              supervisor: null,
            }),
            rmSync: fs.rmSync,
            run,
            runDocker: () => ok(),
          }),
        );

      const result = await uninstall();
      expect(result.exitCode, errors.join("\n")).toBe(sibling ? 1 : 0);
      expect(
        run.mock.calls.filter(
          ([command, args]) => command === "lsof" && args[1] === `:${String(routerPort)}`,
        ),
      ).toHaveLength(1);
      expect(run).not.toHaveBeenCalledWith("lsof", ["-ti", ":15000", "-w"], expect.anything());
      expect(killed).toEqual(sibling ? [] : [routerPid]);
      expect(exited.has(routerPid)).toBe(!sibling);
      expect(fs.existsSync(path.join(stateDir, "onboard-session.json"))).toBe(sibling);
      expect(fs.existsSync(routerRuntime)).toBe(sibling);
      // The dependent sandboxes have finished and the router was stopped
      // externally. Unrelated gateway registrations still exist during retry.
      exited.add(routerPid);
      listenerOverride = { status: 2, stdout: "", stderr: "listener inventory failed" };
      expect((await uninstall()).exitCode).toBe(sibling ? 1 : 0);
      expect(fs.existsSync(routerRuntime)).toBe(sibling);
      listenerOverride = missing();
      expect((await uninstall()).exitCode, errors.join("\n")).toBe(0);
      expect(killed).toEqual(sibling ? [] : [routerPid]);
      expect(fs.existsSync(path.join(stateDir, "onboard-session.json"))).toBe(false);
      expect(fs.existsSync(routerRuntime)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { oldPort: 4000, latestReceipt: "present", expectedPids: [55681, 55682] },
  { oldPort: 14000, latestReceipt: "present", expectedPids: [55681, 55682] },
  { oldPort: 4000, latestReceipt: "cleared", expectedPids: [55681] },
  { oldPort: 4000, latestReceipt: "absent", expectedPids: [55681] },
] as const)(
  "cleans retained port $oldPort with a $latestReceipt latest receipt",
  async (scenario) => {
    const harness = createRouterMigrationHarness(scenario);
    try {
      expect((await harness.uninstall()).exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.killed.sort()).toEqual(scenario.expectedPids);
      expect(harness.live.size).toBe(0);
      expect(fs.existsSync(harness.registryFile)).toBe(false);
      expect(fs.existsSync(harness.routerRuntime)).toBe(false);
    } finally {
      harness.dispose();
    }
  },
);

it.each(["missing-lsof", "inventory-error", "malformed-pid", "stop-failed"] as const)(
  "retains all router cleanup state after $0 and retries safely",
  async (failure) => {
    const harness = createRouterMigrationHarness({
      oldPort: 4000,
      latestReceipt: "present",
      failure,
    });
    try {
      expect((await harness.uninstall()).exitCode, harness.errors.join("\n")).toBe(1);
      expect(harness.live.has(55681)).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(fs.existsSync(harness.sessionFile)).toBe(true);
      expect(fs.existsSync(harness.routerRuntime)).toBe(true);
      harness.allowCleanup();
      expect((await harness.uninstall()).exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.killed.sort()).toEqual([55681, 55682]);
      expect(harness.live.size).toBe(0);
      expect(fs.existsSync(harness.registryFile)).toBe(false);
      expect(fs.existsSync(harness.routerRuntime)).toBe(false);
    } finally {
      harness.dispose();
    }
  },
);

it.each([
  { latestReceipt: "present", expectedPids: [55681, 55682] },
  { latestReceipt: "cleared", expectedPids: [55681] },
] as const)(
  "preserves every sibling router with a $latestReceipt latest receipt",
  async (scenario) => {
    const harness = createRouterMigrationHarness({
      oldPort: 4000,
      latestReceipt: scenario.latestReceipt,
      failure: "sibling",
    });
    try {
      expect((await harness.uninstall()).exitCode, harness.errors.join("\n")).toBe(1);
      expect(harness.killed).toEqual([]);
      expect([...harness.live.keys()].sort()).toEqual(scenario.expectedPids);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(fs.existsSync(harness.sessionFile)).toBe(true);
      expect(fs.existsSync(harness.routerRuntime)).toBe(true);
      harness.allowCleanup();
      expect((await harness.uninstall()).exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.killed.sort()).toEqual(scenario.expectedPids);
      expect(harness.live.size).toBe(0);
      expect(fs.existsSync(harness.registryFile)).toBe(false);
      expect(fs.existsSync(harness.routerRuntime)).toBe(false);
    } finally {
      harness.dispose();
    }
  },
);

it.each([
  { label: "malformed JSON", contents: "{broken" },
  { label: "null JSON", contents: "null" },
  { label: "array JSON", contents: "[]" },
  { label: "number JSON", contents: "42" },
])("retains $label router receipts until repaired", async ({ contents }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-router-unreadable-"));
  const stateDir = path.join(root, ".nemoclaw");
  const receipt = path.join(stateDir, "onboard-session.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(receipt, contents);
  const killed: number[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const run = vi.fn((command: string, args: string[]): RunResult =>
    command === "openshell" && args[0] === "gateway" && args[1] === "list"
      ? ok(JSON.stringify([{ name: "nemoclaw" }]))
      : args[0] === "-c"
        ? ok("/fake/bin/tool\n")
        : ok(),
  );
  const uninstall = () =>
    runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: root, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
        error: (message) => errors.push(message),
        existsSync: (target) => target.startsWith(root) && fs.existsSync(target),
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          return true;
        },
        log: (message) => logs.push(message),
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          endpoint: null,
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          requiredCapabilities: [],
          source: "packaged-service",
          stateDir: null,
          supervisor: null,
        }),
        rmSync: fs.rmSync,
        run,
        runDocker: () => ok(),
      },
    );
  try {
    expect((await uninstall()).exitCode).toBe(1);
    expect(errors.join("\n")).toContain("onboarding session");
    expect(logs.some((line) => line.endsWith("State and binaries"))).toBe(false);
    expect(killed).toEqual([]);
    expect(
      run.mock.calls.filter(([command]) => command === "lsof").map(([, args]) => args.join(" ")),
    ).not.toContain("-ti :4000");
    expect(fs.readFileSync(receipt, "utf8")).toBe(contents);
    fs.writeFileSync(
      receipt,
      JSON.stringify({ routerPort: null, routerPid: null, routerCredentialHash: null }),
    );
    expect((await uninstall()).exitCode, errors.join("\n")).toBe(0);
    expect(fs.existsSync(receipt)).toBe(false);
    expect(killed).toEqual([]);
    expect((await uninstall()).exitCode).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { code: "ENOENT", result: { pid: null, port: null, expected: false } },
  { code: "EACCES", result: { pid: null, port: null, expected: true, readFailed: true } },
  { code: "EIO", result: { pid: null, port: null, expected: true, readFailed: true } },
])("distinguishes $code from an absent router receipt", ({ code, result }) => {
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw Object.assign(new Error("receipt read failed"), { code });
  });
  try {
    expect(readOnboardSessionModelRouter("/unused-router-receipt")).toEqual(result);
  } finally {
    read.mockRestore();
  }
});

it.each([false, true])(
  "retains incomplete router state until receipt cleanup or verified PID absence (cleared=%s)",
  async (cleared) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-router-no-port-"));
    const stateDir = path.join(root, ".nemoclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "onboard-session.json"),
      JSON.stringify(
        cleared
          ? {
              provider: "nvidia-router",
              routerPid: null,
              routerPort: null,
              routerCredentialHash: null,
              endpointUrl: "http://host.openshell.internal:14000",
            }
          : { provider: "nvidia-router", routerPid: 55681 },
      ),
    );
    const errors: string[] = [];
    const killed: number[] = [];
    const logs: string[] = [];
    let processObservation = ok("55681\n");
    const run = vi.fn((command: string, args: string[]): RunResult => {
      return command === "ps"
        ? processObservation
        : command === "openshell" && args[0] === "gateway" && args[1] === "list"
          ? ok(JSON.stringify([{ name: "nemoclaw" }]))
          : args[0] === "-c"
            ? ok("/fake/bin/tool\n")
            : ok();
    });

    try {
      const uninstall = () =>
        runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: () => true,
            env: { HOME: root, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
            error: (message) => errors.push(message),
            existsSync: (target) =>
              (target === stateDir || target === path.join(stateDir, "onboard-session.json")) &&
              fs.existsSync(target),
            isTty: false,
            kill: (pid) => {
              killed.push(pid);
              return true;
            },
            log: (message) => logs.push(message),
            resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
              endpoint: null,
              gatewayName,
              gatewayPort,
              mode: "nemoclaw-managed",
              requiredCapabilities: [],
              source: "packaged-service",
              stateDir: null,
              supervisor: null,
            }),
            rmSync: fs.rmSync,
            run,
            runDocker: () => ok(),
          },
        );

      const result = await uninstall();
      expect(result.exitCode).toBe(cleared ? 0 : 1);
      expect(errors.filter((message) => message.includes("Model Router cleanup"))).toEqual(
        cleared
          ? []
          : [
              expect.stringMatching(
                /recorded port is missing.*PID 55681.*rerun nemoclaw uninstall/,
              ),
            ],
      );
      expect(run).not.toHaveBeenCalledWith("lsof", ["-ti", ":4000", "-w"], expect.anything());
      expect(killed).toEqual([]);
      expect(run).not.toHaveBeenCalledWith("lsof", ["-ti", ":14000", "-w"], expect.anything());
      expect(logs.some((line) => line.endsWith("State and binaries"))).toBe(cleared);
      expect(fs.existsSync(path.join(stateDir, "onboard-session.json"))).toBe(!cleared);
      processObservation = { status: 2, stdout: "", stderr: "process inventory unavailable" };
      expect((await uninstall()).exitCode).toBe(cleared ? 0 : 1);
      expect(fs.existsSync(path.join(stateDir, "onboard-session.json"))).toBe(!cleared);
      processObservation = missing();
      expect((await uninstall()).exitCode).toBe(0);
      expect(fs.existsSync(path.join(stateDir, "onboard-session.json"))).toBe(false);
      expect(killed).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
