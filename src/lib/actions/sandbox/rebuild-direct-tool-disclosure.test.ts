// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  type RebuildFlowOverrides,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  agentDefs,
  captureResolvedRebuildFixture,
  hermesManagedRoute,
  hermesPostRestore,
  hermesProjection,
  openClawLifecycle,
  rebuildPostRestore,
  registry,
  sanitizedCapture,
  sourceSandboxGateway,
} from "../../../../test/helpers/rebuild-flow-harness";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import {
  advanceSandboxRecreateTransaction,
  recordSandboxRecreateTargetCreated,
} from "../../onboard/sandbox-recreate-transaction";
import {
  createRestartFixture,
  RUNTIME_CONFIG_GUARD,
  hashInputs,
  runWriteConfig,
  strictHashIsValid,
  type RestartFixture,
} from "../../../../test/helpers/hermes-restart-config-seal-fixture";

type NativeConfig = {
  tools: Record<string, unknown>;
  [key: string]: unknown;
};

const nativeHandle = "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN";
const originalConfig = (agent: string): NativeConfig =>
  agent === "openclaw"
    ? {
        models: {
          providers: {
            inference: {
              baseUrl: "https://inference.local/v1",
              apiKey: nativeHandle,
              api: "openai-completions",
              models: [{ id: "retained-model", name: "Retained model" }],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "inference/retained-model" },
            workspace: "/sandbox/workspace",
          },
        },
        tools: {
          toolSearch: { mode: "tools", searchDefaultLimit: 8, maxSearchLimit: 20 },
          alsoAllow: ["bundle-mcp"],
        },
      }
    : {
        model: { default: "retained-model", api_key: nativeHandle },
        tools: { tool_search: { enabled: "on", search_default_limit: 5, max_search_limit: 20 } },
        mcp_servers: { retained: { command: "python3", args: ["retained-server.py"] } },
        terminal: { backend: "local", timeout: 321 },
      };

const roots: string[] = [];
const realSpawnSync = childProcess.spawnSync;

function nativeConfigFixture(
  agent: "openclaw" | "hermes",
  prepare: (initial: NativeConfig) => void = () => {},
) {
  const hermes = agent === "hermes" ? createRestartFixture() : null;
  const root = hermes?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-direct-tools-"));
  roots.push(root);
  const configPath = hermes?.configPath ?? path.join(root, "openclaw.json");
  const initial = originalConfig(agent);
  prepare(initial);
  const content =
    agent === "openclaw"
      ? JSON.stringify(initial)
      : YAML.stringify(initial, { compat: "yaml-1.1" });
  fs.writeFileSync(configPath, content);
  const hash = hermes
    ? `${hashInputs(hermes.configPath, hermes.envPath).split("\n").slice(0, 2).join("\n")}\n`
    : null;
  [hermes?.hashPath, hermes?.compatHashPath]
    .filter((file): file is string => typeof file === "string")
    .forEach((file) => fs.writeFileSync(file, hash!));
  return {
    root,
    hermes,
    configPath,
    initial,
    originalBytes: fs.readFileSync(configPath),
    read: (): NativeConfig => YAML.parse(fs.readFileSync(configPath, "utf8")),
  };
}

function captureNativeConfigTransport(
  fixture: ReturnType<typeof nativeConfigFixture>,
  refuseWrite: boolean | (() => boolean) = false,
  recordRead: (argv: readonly string[], options: SpawnSyncOptions) => void = () => {},
) {
  const observations: { argv: readonly string[]; input?: string; env?: NodeJS.ProcessEnv }[] = [];
  const result = (stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> => ({
    pid: 1,
    status,
    signal: null,
    stdout,
    stderr,
    output: [null, stdout, stderr],
  });
  const runGuardedWrite = (argv: readonly string[], options: SpawnSyncOptions) => {
    const digest = argv[argv.indexOf("--expected-config-sha256") + 1];
    const refused = typeof refuseWrite === "function" ? refuseWrite() : refuseWrite;
    const written = refused
      ? result("", 1, "private-config-fixture-value")
      : runWriteConfig(fixture.hermes as RestartFixture, digest, String(options.input), {
          restoreNativeLocalCredential: argv.includes("--restore-native-local-credential"),
        });
    observations.push({ argv, input: String(options.input), env: options.env });
    return result(written.stdout, written.status ?? 1, written.stderr);
  };
  const runNativeBatch = (argv: readonly string[], options: SpawnSyncOptions) => {
    expect(argv).toEqual(expect.arrayContaining(["-g", "nemoclaw"]));
    expect(options.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw",
      OPENSHELL_WORKSPACE: "default",
    });
    const updates = JSON.parse(String(options.input)) as { path: string; value: unknown }[];
    expect(updates).toEqual([{ path: "tools.toolSearch", value: false }]);
    const current = fixture.read();
    current.tools ??= {};
    current.tools.toolSearch = updates[0].value;
    observations.push({ argv, input: String(options.input), env: options.env });
    return (typeof refuseWrite === "function" ? refuseWrite() : refuseWrite)
      ? result("", 1, "private-config-fixture-value")
      : (fs.writeFileSync(fixture.configPath, JSON.stringify(current)), result());
  };
  const unexpectedCommand = (file: string, argv: readonly string[]): never => {
    throw new Error(`Unexpected native config transport: ${file} ${argv.join(" ")}`);
  };
  vi.spyOn(childProcess, "spawnSync").mockImplementation(((
    file: string,
    argv: readonly string[],
    options: SpawnSyncOptions,
  ) => {
    const routes = [
      {
        matches: () =>
          ["python3", "sha256sum", "tar"].includes(path.basename(file)) ||
          file === process.execPath,
        run: () => realSpawnSync(file, [...argv], options),
      },
      {
        matches: () => argv.includes("write-config"),
        run: () => runGuardedWrite(argv, options),
      },
      {
        matches: () => argv.includes("nemoclaw-openclaw-config-set-batch"),
        run: () => runNativeBatch(argv, options),
      },
      {
        matches: () =>
          argv.includes("cat") &&
          argv.some((arg) => /\/(?:openclaw\.json|config\.yaml)$/u.test(arg)),
        run: () => (recordRead(argv, options), result(fs.readFileSync(fixture.configPath, "utf8"))),
      },
      {
        matches: () => file === "docker" && argv.includes("ps"),
        run: () => result(`${"c".repeat(64)}\topenshell-alpha\tsandbox\n`),
      },
    ];
    return routes.find(({ matches }) => matches())?.run() ?? unexpectedCommand(file, argv);
  }) as typeof childProcess.spawnSync);
  return observations;
}

function configureRebuildHarness(
  agent: "openclaw" | "hermes",
  recordedMode = "progressive",
  overrides: RebuildFlowOverrides = {},
) {
  const harness = createRebuildFlowHarness({
    ...overrides,
    agentName: agent,
    sandboxEntry: {
      agent: agent === "openclaw" ? null : agent,
      toolDisclosure: recordedMode,
      ...overrides.sandboxEntry,
    },
  });
  const definition = agentDefs.loadAgent(agent);
  vi.mocked(agentDefs.loadAgent).mockReturnValue({
    ...definition,
    configPaths: {
      dir: `/sandbox/.${agent}`,
      configFile: agent === "openclaw" ? "openclaw.json" : "config.yaml",
      format: agent === "openclaw" ? "json5" : "yaml",
    },
  });
  return harness;
}

function currentHermesHash(fixture: RestartFixture): string {
  const result = realSpawnSync(
    "python3",
    [
      "-I",
      "-c",
      String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("fixture_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
print(guard._hash_text(sys.argv[2], sys.argv[3])[0], end="")
`,
      RUNTIME_CONFIG_GUARD,
      fixture.configPath,
      fixture.envPath,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

// The real Hermes guard fixture requires POSIX file ownership and modes.
describe.skipIf(process.platform === "win32")("rebuild direct tool disclosure", () => {
  installRebuildFlowTestHooks();

  afterEach(() => {
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it.each(["openclaw", "hermes"] as const)(
    "applies direct disclosure to restored %s configuration (#13902)",
    async (agent) => {
      const fixture = nativeConfigFixture(agent);
      const harness = configureRebuildHarness(agent);
      const writes = captureNativeConfigTransport(fixture);
      const activationModes: unknown[] = [];
      const start =
        agent === "openclaw"
          ? harness.finishOpenClawMaintenanceWindowSpy
          : harness.restartSandboxGatewaySpy;
      start.mockImplementation(() => {
        const current = fixture.read();
        activationModes.push(
          agent === "openclaw"
            ? current.tools.toolSearch
            : (current.tools.tool_search as { enabled: string }).enabled,
        );
        return { ok: true, restarted: true, healthPassed: true, forwardRecovered: false };
      });

      await expect(
        harness.rebuildSandbox(
          "alpha",
          { yes: true, toolDisclosure: "direct" },
          { throwOnError: true },
        ),
      ).resolves.toBeUndefined();

      const current = fixture.read();
      expect(current.model).toEqual(fixture.initial.model);
      expect(current.models).toEqual(fixture.initial.models);
      expect(current.agents).toEqual(fixture.initial.agents);
      expect(current.mcp_servers).toEqual(fixture.initial.mcp_servers);
      expect(current.terminal).toEqual(fixture.initial.terminal);
      expect(current.tools.alsoAllow).toEqual(fixture.initial.tools.alsoAllow);
      expect(
        agent === "openclaw"
          ? current.tools.toolSearch
          : (current.tools.tool_search as { enabled: string }).enabled,
      ).toBe(agent === "openclaw" ? false : "off");
      expect(activationModes).toEqual([agent === "openclaw" ? false : "off"]);
      expect(writes).toHaveLength(1);
      expect(writes[0].argv).not.toContain("--restore-native-local-credential");
      expect(fixture.hermes ? strictHashIsValid(fixture.hermes) : true).toBe(true);
    },
  );

  it.each(
    (["openclaw", "hermes"] as const).flatMap((agent) =>
      ["direct", "progressive"].map((recordedMode) => ({ agent, recordedMode })),
    ),
  )(
    "preserves restored $agent settings without a flag when the recorded mode is $recordedMode",
    async ({ agent, recordedMode }) => {
      const fixture = nativeConfigFixture(agent);
      const harness = configureRebuildHarness(agent, recordedMode);
      const writes = captureNativeConfigTransport(fixture);

      await harness.rebuildSandbox("alpha", { yes: true }, { throwOnError: true });

      expect(fs.readFileSync(fixture.configPath)).toEqual(fixture.originalBytes);
      expect(writes).toEqual([]);
    },
  );

  it.each(
    [
      { kind: "null", value: null },
      { kind: "scalar", value: "private-config-fixture-value" },
      { kind: "array", value: [] },
    ].flatMap(({ kind, value }) => [
      { agent: "openclaw" as const, parent: "tools", kind, value },
      { agent: "hermes" as const, parent: "tools", kind, value },
      { agent: "hermes" as const, parent: "tool_search", kind, value },
    ]),
  )(
    "refuses $kind at $parent in restored $agent configuration",
    async ({ agent, parent, value }) => {
      const fixture = nativeConfigFixture(agent);
      const current = fixture.read();
      const malformed =
        parent === "tools"
          ? { ...current, tools: value }
          : { ...current, tools: { tool_search: value } };
      fs.writeFileSync(
        fixture.configPath,
        agent === "openclaw"
          ? JSON.stringify(malformed)
          : YAML.stringify(malformed, { compat: "yaml-1.1" }),
      );
      const before = fs.readFileSync(fixture.configPath);
      const harness = configureRebuildHarness(agent);
      const writes = captureNativeConfigTransport(fixture);

      await expect(
        harness.rebuildSandbox(
          "alpha",
          { yes: true, toolDisclosure: "direct" },
          { throwOnError: true },
        ),
      ).rejects.toThrow("Direct tool disclosure could not be applied");

      expect(fs.readFileSync(fixture.configPath)).toEqual(before);
      expect(writes).toEqual([]);
      expect(harness.finishOpenClawMaintenanceWindowSpy).not.toHaveBeenCalled();
      expect(harness.restartSandboxGatewaySpy).not.toHaveBeenCalled();
      expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain(
        "private-config-fixture-value",
      );
    },
  );

  it("unwinds OpenClaw maintenance before an ordinary CLI failure can exit", async () => {
    const fixture = nativeConfigFixture("openclaw");
    const harness = configureRebuildHarness("openclaw");
    captureNativeConfigTransport(fixture, true);
    const order: string[] = [];
    vi.mocked(openClawLifecycle.abortUnregisteredOpenClawPostRestoreDoctor).mockImplementation(
      async () => {
        await Promise.resolve();
        order.push("abort");
        return { ok: true };
      },
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      order.push("exit");
      throw new Error("exit boundary");
    });

    await expect(
      harness
        .rebuildSandbox("alpha", { yes: true, toolDisclosure: "direct" })
        .catch((error: unknown) => {
          order.push("caller");
          throw error;
        }),
    ).rejects.toEqual(
      new Error("Direct tool disclosure could not be applied to the rebuilt sandbox."),
    );

    expect(order).toEqual(["abort", "caller"]);
    expect(exit).not.toHaveBeenCalled();
    expect(harness.finishOpenClawMaintenanceWindowSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(fixture.configPath)).toEqual(fixture.originalBytes);
    const { manifest } = harness.backupSandboxStateSpy.mock.results[0]!.value as {
      manifest: { backupPath: string };
    };
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(manifest.backupPath);
    expect(output).toContain("alpha rebuild --yes --tool-disclosure direct");
    expect(fs.existsSync(path.join(manifest.backupPath, "rebuild-manifest.json"))).toBe(true);
  });

  it.each([false, true])(
    "applies frozen direct disclosure through real accepted Hermes recovery before activation: explicit retry=%s",
    async (explicitRetry) => {
      const fixture = nativeConfigFixture("hermes");
      let deleted = false;
      let targetReady = false;
      let refuseWrite = true;
      const targetId = "sbx-alpha-replacement";
      const targetFingerprint = fingerprintOpenShellSandboxId(targetId);
      const observe = (argv: string[]) =>
        targetReady && sourceSandboxGateway(argv, "get")
          ? {
              status: 0,
              output: `Name: alpha\nId: ${targetId}\nPhase: Ready\n`,
              stdout: `Name: alpha\nId: ${targetId}\nPhase: Ready\n`,
              stderr: "",
            }
          : captureResolvedRebuildFixture(argv, new Set(deleted ? ["nemoclaw"] : []));
      let harness: ReturnType<typeof createRebuildFlowHarness>;
      harness = configureRebuildHarness("hermes", "progressive", {
        runOpenshell: (argv) => {
          deleted ||= sourceSandboxGateway(argv, "delete") !== null;
          return undefined;
        },
        captureOpenshell: observe,
        captureResolvedOpenshell: observe,
        onboard: (session, options) => {
          const current = session as unknown as Parameters<
            typeof advanceSandboxRecreateTransaction
          >[0];
          const transaction = current.checkpoint!.sandboxRecreate!;
          targetReady = true;
          advanceSandboxRecreateTransaction(current, transaction.id, "creating");
          recordSandboxRecreateTargetCreated(current, transaction.id, {
            state: "ready",
            liveIdentityFingerprint: targetFingerprint,
          });
          harness.registerSandboxEntry("alpha");
          registry.updateSandbox("alpha", {
            toolDisclosure: options.toolDisclosure,
            lifecycleGeneration: transaction.targetGeneration,
            lifecycleLiveIdentityFingerprint: targetFingerprint,
          });
          advanceSandboxRecreateTransaction(current, transaction.id, "registry_committing");
        },
      });
      captureNativeConfigTransport(fixture, () => refuseWrite);
      vi.spyOn(hermesPostRestore, "recoverHermesCronRestore").mockReturnValue("not-required");
      const activatedModes: unknown[] = [];
      harness.restartSandboxGatewaySpy.mockImplementation(() => {
        activatedModes.push((fixture.read().tools.tool_search as { enabled: string }).enabled);
        return { ok: true, restarted: true, healthPassed: true, forwardRecovered: false };
      });

      await expect(
        harness.rebuildSandbox(
          "alpha",
          { yes: true, toolDisclosure: "direct" },
          { throwOnError: true },
        ),
      ).rejects.toEqual(
        new Error("Direct tool disclosure could not be applied to the rebuilt sandbox."),
      );
      expect(activatedModes).toEqual([]);
      const { manifest } = harness.backupSandboxStateSpy.mock.results[0]!.value as {
        manifest: { backupPath: string };
      };
      const recoveryRecord = path.join(manifest.backupPath, ".nemoclaw-rebuild-recovery.json");
      expect(fs.existsSync(recoveryRecord)).toBe(true);
      const checkpoint = structuredClone(harness.session.checkpoint);
      const registered = harness.getSandboxEntry();
      vi.mocked(childProcess.spawnSync).mockRestore();
      const restarted = configureRebuildHarness("hermes", "direct", {
        sandboxEntry: { ...registered },
        captureOpenshell: observe,
        captureResolvedOpenshell: observe,
      });
      restarted.session.checkpoint = checkpoint;
      restarted.runOpenshellSpy.mockClear();
      restarted.onboardSpy.mockClear();
      restarted.backupSandboxStateSpy.mockClear();
      captureNativeConfigTransport(fixture, () => refuseWrite);
      restarted.restartSandboxGatewaySpy.mockImplementation(() => {
        activatedModes.push((fixture.read().tools.tool_search as { enabled: string }).enabled);
        return { ok: true, restarted: true, healthPassed: true, forwardRecovered: false };
      });
      refuseWrite = false;

      await restarted.rebuildSandbox(
        "alpha",
        explicitRetry ? ["--yes", "--tool-disclosure", "direct"] : ["--yes"],
        { throwOnError: true },
      );

      expect(activatedModes).toEqual(["off"]);
      expect((fixture.read().tools.tool_search as { enabled: string }).enabled).toBe("off");
      expect(strictHashIsValid(fixture.hermes!)).toBe(true);
      expect(restarted.onboardSpy).not.toHaveBeenCalled();
      expect(restarted.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(
        restarted.runOpenshellSpy.mock.calls.some(([argv]) => (argv as string[])[1] === "delete"),
      ).toBe(false);
      expect(fs.existsSync(recoveryRecord)).toBe(false);
    },
  );

  it.each([
    { agent: "hermes" as const, cron: true, retained: false, backup: true },
    { agent: "hermes" as const, cron: false, retained: true, backup: true },
    { agent: "hermes" as const, cron: false, retained: false, backup: true },
    { agent: "openclaw" as const, cron: false, retained: false, backup: false },
  ])(
    "reports direct configuration failure for $agent with cron=$cron retained=$retained backup=$backup",
    async ({ agent, cron, retained, backup }) => {
      const fixture = nativeConfigFixture(agent);
      const harness = configureRebuildHarness(agent);
      captureNativeConfigTransport(fixture, true);
      const bail = vi.fn((): never => {
        throw new Error("exit-backed failure boundary");
      });

      await expect(
        rebuildPostRestore.runRebuildPostRestorePhase({
          sandboxName: "alpha",
          targetAgentName: agent,
          messagingPlan: null,
          backupManifest: backup ? ({ backupPath: "/retained/alpha" } as never) : null,
          mcpEntries: [],
          restoreSucceeded: true,
          forceDirectToolDisclosure: true,
          hermesCronRestoreIdentity: cron
            ? { pid: 41, start_time: 902, drain_token: "restore-token" }
            : undefined,
          preparedBackupRecovery: retained,
          versionCheck: { expectedVersion: null } as never,
          log: vi.fn(),
          bail,
        }),
      ).rejects.toEqual(
        new Error("Direct tool disclosure could not be applied to the rebuilt sandbox."),
      );

      const output = harness.errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Direct tool disclosure configuration remains incomplete");
      expect(output).toContain("nemoclaw alpha rebuild --yes --tool-disclosure direct");
      expect(output.includes("/retained/alpha")).toBe(backup);
      expect(output.includes("Hermes cron dispatch remains drained")).toBe(cron);
      expect(output.includes("nemoclaw alpha recover")).toBe(cron || retained);
      expect(output.includes("Recovery alone does not complete direct tool disclosure")).toBe(
        cron || retained,
      );
      expect(output).not.toContain("private-config-fixture-value");
      expect(bail).not.toHaveBeenCalled();
      expect(harness.finishOpenClawMaintenanceWindowSpy).not.toHaveBeenCalled();
      expect(harness.restartSandboxGatewaySpy).not.toHaveBeenCalled();
      expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    { agent: "openclaw" as const, parent: "tools" },
    { agent: "hermes" as const, parent: "tools" },
    { agent: "hermes" as const, parent: "tool_search" },
  ])("creates an absent $parent parent for direct $agent disclosure", async ({ agent, parent }) => {
    const fixture = nativeConfigFixture(agent, (initial) =>
      parent === "tools"
        ? Reflect.deleteProperty(initial, "tools")
        : Reflect.deleteProperty(initial.tools, "tool_search"),
    );
    const harness = configureRebuildHarness(agent);
    const writes = captureNativeConfigTransport(fixture);

    await harness.rebuildSandbox(
      "alpha",
      { yes: true, toolDisclosure: "direct" },
      { throwOnError: true },
    );

    const current = fixture.read();
    expect(
      agent === "openclaw"
        ? current.tools.toolSearch
        : (current.tools.tool_search as { enabled: string }).enabled,
    ).toBe(agent === "openclaw" ? false : "off");
    expect(current.model).toEqual(fixture.initial.model);
    expect(current.models).toEqual(fixture.initial.models);
    expect(current.mcp_servers).toEqual(fixture.initial.mcp_servers);
    expect(writes).toHaveLength(1);
    expect(fixture.hermes ? strictHashIsValid(fixture.hermes) : true).toBe(true);
  });

  it("preserves restored Hermes state when an ordinary tool write fails its strict anchor", async () => {
    const fixture = nativeConfigFixture("hermes");
    const hermes = fixture.hermes!;
    const image = fixture.read();
    (image.tools.tool_search as { enabled: string }).enabled = "off";
    fs.writeFileSync(hermes.configPath, YAML.stringify(image, { compat: "yaml-1.1" }));
    const imageHash = currentHermesHash(hermes);
    fs.writeFileSync(hermes.hashPath, imageHash);
    fs.writeFileSync(hermes.configPath, fixture.originalBytes);
    expect(strictHashIsValid(hermes)).toBe(false);
    const harness = configureRebuildHarness("hermes");
    const writes = captureNativeConfigTransport(fixture);

    await expect(
      harness.rebuildSandbox(
        "alpha",
        { yes: true, toolDisclosure: "direct" },
        { throwOnError: true },
      ),
    ).rejects.toThrow("Direct tool disclosure could not be applied");

    expect(fs.readFileSync(hermes.configPath)).toEqual(fixture.originalBytes);
    expect(fs.readFileSync(hermes.hashPath, "utf8")).toBe(imageHash);
    expect(fs.existsSync(hermes.statePath)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0].argv).not.toContain("--restore-native-local-credential");
    expect(harness.restartSandboxGatewaySpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
  });

  it.each([
    { registered: "openclaw" as const, requested: "hermes" as const },
    { registered: "hermes" as const, requested: "openclaw" as const },
  ])(
    "refuses $requested writes to a registered $registered sandbox",
    async ({ registered, requested }) => {
      const fixture = nativeConfigFixture(registered);
      configureRebuildHarness(registered);
      const reads: unknown[] = [];
      const writes = captureNativeConfigTransport(fixture, false, (...args) => reads.push(args));
      const { applyRestoredDirectToolDisclosure } = await import("./rebuild-mcp-phase");

      expect(() =>
        applyRestoredDirectToolDisclosure(registry.getSandbox("alpha")!, requested),
      ).toThrow("Direct tool disclosure could not be applied");

      expect(reads).toEqual([]);
      expect(writes).toEqual([]);
      expect(fs.readFileSync(fixture.configPath)).toEqual(fixture.originalBytes);
    },
  );

  it.each([6, 7])(
    "applies direct mode after native NVIDIA restore with an archived v%s handle",
    async (archivedVersion) => {
      const fixture = nativeConfigFixture("hermes");
      const hermes = fixture.hermes!;
      const issued = "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY";
      const runtime = {
        gatewayName: "nemoclaw",
        workspace: "selected-workspace",
        localTlsDir: "/selected/tls",
      };
      const entry = {
        agent: "hermes",
        provider: "nvidia-prod",
        model: "retained-model",
        gatewayName: runtime.gatewayName,
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        lifecycleGeneration: "replacement-generation",
        lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("replacement-id"),
        nativeNvidiaProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "nvidia-provider-id",
        },
      };
      const archived = fixture.read() as import("../../security/credential-filter").ConfigObject;
      const route = {
        upstreamProvider: entry.provider,
        baseUrl: entry.endpointUrl,
        model: entry.model,
        inferenceApi: "openai-completions",
      };
      hermesManagedRoute.applyHermesManagedRoute(archived, {
        ...route,
        nativeCredentialHandle: `openshell:resolve:env:v${archivedVersion}_NVIDIA_INFERENCE_API_KEY`,
      });
      const archiveBytes = YAML.stringify(archived, { compat: "yaml-1.1" });
      const archiveEnv = "API_SERVER_PORT=18642\nSAFE_SETTING=archived\n";
      fs.writeFileSync(hermes.configPath, archiveBytes);
      fs.writeFileSync(hermes.envPath, archiveEnv);
      const archiveCompat = currentHermesHash(hermes);
      const image = structuredClone(archived);
      (
        (image.tools as import("../../security/credential-filter").ConfigObject)
          .tool_search as import("../../security/credential-filter").ConfigObject
      ).enabled = "off";
      hermesManagedRoute.applyHermesManagedRoute(image, {
        ...route,
        nativeCredentialHandle: issued,
      });
      fs.writeFileSync(hermes.configPath, YAML.stringify(image, { compat: "yaml-1.1" }));
      fs.writeFileSync(hermes.envPath, "API_SERVER_PORT=18642\nSAFE_SETTING=fresh-image\n");
      const imageHash = currentHermesHash(hermes);
      fs.writeFileSync(hermes.hashPath, imageHash);
      fs.writeFileSync(hermes.compatHashPath, imageHash);
      expect(strictHashIsValid(hermes)).toBe(true);

      // Native restore transfers config, env, and .config-hash; /etc keeps the image anchor.
      fs.writeFileSync(hermes.configPath, archiveBytes);
      fs.writeFileSync(hermes.envPath, archiveEnv);
      fs.writeFileSync(hermes.compatHashPath, archiveCompat);
      expect(strictHashIsValid(hermes)).toBe(false);
      const harness = createRebuildFlowHarness({ agentName: "hermes", sandboxEntry: entry });
      const definition = agentDefs.loadAgent("hermes");
      vi.mocked(agentDefs.loadAgent).mockReturnValue({
        ...definition,
        configPaths: { dir: "/sandbox/.hermes", configFile: "config.yaml", format: "yaml" },
      });
      vi.spyOn(sanitizedCapture, "captureSanitizedResolvedOpenshell").mockReturnValue({
        status: 0,
        output: "Id: replacement-id",
        stdout: "Id: replacement-id",
        stderr: "",
      });
      const realFactory = hermesProjection.createInitialHermesInferenceRoute;
      vi.spyOn(hermesProjection, "createInitialHermesInferenceRoute").mockImplementation(
        (overrides, options) =>
          realFactory({ ...overrides, readNvidiaCredentialHandle: async () => issued }, options),
      );
      const reads: { argv: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
      const writes = captureNativeConfigTransport(fixture, false, (argv, options) =>
        reads.push({ argv, env: options.env }),
      );
      vi.stubEnv("OPENSHELL_GATEWAY", "foreign-gateway");
      vi.stubEnv("OPENSHELL_WORKSPACE", "foreign-workspace");
      vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/foreign/tls");

      await hermesPostRestore.refreshRestoredHermesInferenceRoute(
        "alpha",
        runtime,
        registry.getSandbox,
        {
          OPENSHELL_GATEWAY: runtime.gatewayName,
          OPENSHELL_WORKSPACE: runtime.workspace,
          OPENSHELL_LOCAL_TLS_DIR: runtime.localTlsDir,
        },
      );

      const projected = fixture.read();
      expect((projected.tools.tool_search as { enabled: string }).enabled).toBe("on");
      expect((projected.model as { api_key: string }).api_key).toBe(issued);
      expect(strictHashIsValid(hermes)).toBe(true);
      const { applyRestoredDirectToolDisclosure } = await import("./rebuild-mcp-phase");
      applyRestoredDirectToolDisclosure(registry.getSandbox("alpha")!, "hermes", runtime);

      const expected = structuredClone(projected);
      (expected.tools.tool_search as { enabled: string }).enabled = "off";
      expect(fixture.read()).toEqual(expected);
      expect(fs.readFileSync(hermes.envPath, "utf8")).toBe(archiveEnv);
      expect(strictHashIsValid(hermes)).toBe(true);
      expect(writes.map(({ argv }) => argv.includes("--restore-native-local-credential"))).toEqual([
        true,
        false,
      ]);
      expect(reads.at(-1)?.env).toMatchObject({
        OPENSHELL_GATEWAY: runtime.gatewayName,
        OPENSHELL_WORKSPACE: runtime.workspace,
        OPENSHELL_LOCAL_TLS_DIR: runtime.localTlsDir,
      });
      expect(harness.restartSandboxGatewaySpy).not.toHaveBeenCalled();
    },
  );
});
