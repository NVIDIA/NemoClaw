// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

async function runUninstallPlan(
  options: UninstallRunOptions,
  deps: UninstallRunDeps,
  runPlan = runUninstallPlanBase,
) {
  return await runPlan(options, {
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const FOREIGN_ROWS = [
  "foreign-prefix redis:7 nemoclaw-unrelated",
  "foreign-openshell redis:7 openshell-scratch",
  "foreign-image nemoclaw-hermes-sandbox-base-local:build-1 foreign-workload",
  "foreign-openclaw ghcr.io/openclaw/openclaw:latest my-openclaw-test",
  "foreign-cache redis:7 cache",
];
const IMAGES_OUTPUT = [
  "i-nemoclaw ghcr.io/nvidia/nemoclaw:test",
  "i-managed ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest",
  "i-openshell openshell/sandbox-from:1780294581",
  "i-openclaw ghcr.io/openclaw/openclaw:latest",
  "i-tag python:3.12-nemoclaw",
  "i-registry registry.example.com/nemoclaw/tool:1",
  "i-unrelated redis:7",
].join("\n");
const CONTAINER_FORMAT = "{{.ID}} {{.Image}} {{.Names}}";

async function runWithDockerInventory(
  options: {
    leftovers?: readonly string[];
    inventory?: RunResult;
    port?: number;
    runPlan?: typeof runUninstallPlanBase;
    registration?: Record<string, unknown>;
    deleteResult?: RunResult;
    dockerResponses?: Record<string, RunResult>;
    commandExists?: UninstallRunDeps["commandExists"];
    siblingId?: string;
    prepareHome?: (homeDir: string) => void;
  } = {},
) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-scope-"));
  const port = options.port ?? 8080;
  const gateway = port === 8080 ? "nemoclaw" : `nemoclaw-${String(port)}`;
  const stateDir =
    port === 8080
      ? path.join(homeDir, ".nemoclaw")
      : path.join(homeDir, ".nemoclaw", "gateways", String(port));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const registryFile = path.join(stateDir, "sandboxes.json");
  const registry = JSON.stringify({
    defaultSandbox: "my-assistant",
    sandboxes: {
      "my-assistant": {
        name: "my-assistant",
        gatewayPort: port,
        gatewayName: gateway,
        ...options.registration,
      },
    },
  });
  fs.writeFileSync(registryFile, registry, { mode: 0o600 });
  options.prepareHome?.(homeDir);
  const leftovers = options.leftovers ?? FOREIGN_ROWS;
  const owned = [
    `owned-gateway openshell/cluster:old openshell-cluster-${gateway}`,
    "owned-sandbox nemoclaw-sandbox-local:build-1 openshell-default--my-assistant-runtime-id",
  ].filter((row) => !leftovers.some((foreign) => foreign.split(" ")[2] === row.split(" ")[2]));
  const rows = new Map([...owned, ...leftovers].map((row) => [row.split(" ")[0]!, row]));
  const calls: string[][] = [];
  const commands: string[][] = [];
  const errors: string[] = [];
  const rmSync = vi.fn();
  try {
    const run: UninstallRunDeps["run"] = (command, args) => {
      commands.push([command, ...args]);
      const handlers: Record<string, () => RunResult> = {
        "openshell sandbox delete": () => {
          rows.delete("owned-sandbox");
          return options.deleteResult ?? ok();
        },
        "openshell sandbox get": () =>
          ok(JSON.stringify({ name: "my-assistant", id: options.siblingId })),
        "openshell gateway list": () => ok(JSON.stringify([{ name: gateway }])),
        "openshell gateway remove": () => ({
          status: 2,
          stdout: "",
          stderr: "error: unrecognized subcommand 'remove'",
        }),
        "openshell gateway destroy": () => {
          expect(args).toContain(gateway);
          rows.delete("owned-gateway");
          return ok();
        },
      };
      return (
        handlers[[command, args[0], args[1]].join(" ")]?.() ??
        (args[0] === "-c" ? ok("/fake/bin/tool\n") : ok())
      );
    };
    const runDocker: UninstallRunDeps["runDocker"] = (args) => {
      calls.push(args);
      const handlers: Record<string, () => RunResult> = {
        ps: () =>
          args.includes(CONTAINER_FORMAT)
            ? (options.inventory ?? ok([...rows.values()].join("\n")))
            : ok(),
        images: () => ok(IMAGES_OUTPUT),
        rm: () => {
          rows.delete(args[2]!);
          return ok();
        },
      };
      return options.dockerResponses?.[args.join(" ")] ?? handlers[args[0] ?? ""]?.() ?? ok();
    };
    const result = await runUninstallPlan(
      { assumeYes: true, destroyUserData: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: options.commandExists ?? (() => true),
        env: {
          HOME: homeDir,
          NEMOCLAW_GATEWAY_PORT: String(port),
          NEMOCLAW_AGENT: "",
          TMPDIR: homeDir,
        },
        existsSync: (target) => target.startsWith(homeDir) && fs.existsSync(target),
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        log: () => undefined,
        error: (message) => errors.push(message),
        rmSync,
        run,
        runDocker,
      },
      options.runPlan,
    );
    return {
      calls,
      commands,
      metadataWrites: commands.filter((args) =>
        [
          "openshell provider delete",
          "openshell gateway remove",
          "openshell gateway destroy",
        ].includes(args.slice(0, 3).join(" ")),
      ),
      result,
      errors,
      rmSync,
      stateDir,
      remaining: [...rows.keys()],
      retainedRegistry: fs.existsSync(registryFile) ? fs.readFileSync(registryFile, "utf8") : null,
      registry,
    };
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("uninstall Docker resource scope", () => {
  it("removes runtime-owned resources through their owner and preserves foreign names and images (#10382)", async () => {
    const { calls, commands, result, remaining } = await runWithDockerInventory();
    expect(result.exitCode).toBe(0);
    expect(commands).toContainEqual(["openshell", "sandbox", "delete", "--all"]);
    expect(commands.some((args) => args[1] === "gateway" && args[2] === "destroy")).toBe(true);
    expect(remaining).toEqual(FOREIGN_ROWS.map((row) => row.split(" ")[0]));
    expect(calls.filter((args) => args[0] === "rm")).toEqual([]);
    expect(commands).toContainEqual(["npm", "uninstall", "-g", "--loglevel=error", "nemoclaw"]);
    expect(calls.filter((args) => args[0] === "rmi").map((args) => args[2])).toEqual([
      "i-nemoclaw",
      "i-managed",
      "i-openshell",
    ]);
  });

  it.each([0, 1])(
    "retains the gateway and state when a published sandbox remains after cleanup status %s",
    async (status) => {
      const id = "a".repeat(64);
      const sandboxId = "selected-sandbox-id";
      const fingerprint = createHash("sha256").update(sandboxId).digest("hex");
      const result = await runWithDockerInventory({
        deleteResult: { status, stdout: "", stderr: "" },
        registration: { openshellDriver: "docker", lifecycleLiveIdentityFingerprint: fingerprint },
        leftovers: [
          `${id} nemoclaw-sandbox-local:build-1 openshell-default--my-assistant-runtime-id`,
        ],
        dockerResponses: {
          "ps -a --no-trunc --filter label=openshell.ai/sandbox-name=my-assistant --format {{.ID}}":
            ok(id),
          [`inspect --type container --format [{{json .Id}},{{json .Config.Labels}}] ${id}`]: ok(
            JSON.stringify([
              id,
              {
                "openshell.ai/managed-by": "openshell",
                "openshell.ai/sandbox-name": "my-assistant",
                "openshell.ai/sandbox-id": sandboxId,
                "openshell.ai/sandbox-namespace": "default",
              },
            ]),
          ),
        },
      });
      expect(result.result.exitCode).toBe(1);
      expect(result.calls.some((args) => args[0] === "inspect" && args.at(-1) === id)).toBe(true);
      expect(result.errors.join("\n")).toContain("my-assistant");
      expect(result.retainedRegistry).toBe(result.registry);
      expect(result.metadataWrites).toEqual([]);
      expect(result.calls.filter((args) => args[0] === "rm" || args[0] === "images")).toEqual([]);
    },
  );

  it("accepts published sandbox absence after its owning runtime removes it", async () => {
    const result = await runWithDockerInventory({
      registration: {
        openshellDriver: "docker",
        lifecycleLiveIdentityFingerprint: "b".repeat(64),
      },
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.calls).toContainEqual([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/sandbox-name=my-assistant",
      "--format",
      "{{.ID}}",
    ]);
    expect(result.remaining).toEqual(FOREIGN_ROWS.map((row) => row.split(" ")[0]));
  });

  it("preserves a published same-name sibling during nondefault uninstall", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();
    const { runUninstallPlan: runPlan } = await import("./run-plan");
    const id = "c".repeat(64);
    const siblingId = "sibling-native";
    const result = await runWithDockerInventory({
      port: 18080,
      runPlan,
      siblingId,
      prepareHome: (homeDir: string) => {
        fs.writeFileSync(
          path.join(homeDir, ".nemoclaw", "sandboxes.json"),
          JSON.stringify({
            defaultSandbox: "my-assistant",
            sandboxes: {
              "my-assistant": {
                name: "my-assistant",
                gatewayPort: 8080,
                gatewayName: "nemoclaw",
                openshellDriver: "docker",
                createdAt: "2026-09-23T00:00:00.000Z",
                lifecycleLiveIdentityFingerprint: createHash("sha256")
                  .update(siblingId)
                  .digest("hex"),
              },
            },
          }),
          { mode: 0o600 },
        );
      },
      registration: {
        openshellDriver: "docker",
        lifecycleLiveIdentityFingerprint: "b".repeat(64),
      },
      leftovers: [`${id} nemoclaw-sandbox-local:build-1 openshell-my-assistant-sibling`],
      dockerResponses: {
        "ps -a --no-trunc --filter label=openshell.ai/sandbox-name=my-assistant --format {{.ID}}":
          ok(id),
        [`inspect --type container --format [{{json .Id}},{{json .Config.Labels}}] ${id}`]: ok(
          JSON.stringify([
            id,
            {
              "openshell.ai/managed-by": "openshell",
              "openshell.ai/sandbox-name": "my-assistant",
              "openshell.ai/sandbox-id": siblingId,
              "openshell.ai/sandbox-namespace": "sibling-namespace",
            },
          ]),
        ),
      },
    });
    expect(result.result.exitCode, result.errors.join("\n")).toBe(0);
    expect(result.commands).toContainEqual([
      "openshell",
      "sandbox",
      "get",
      "-g",
      "nemoclaw",
      "my-assistant",
      "-o",
      "json",
    ]);
    expect(result.remaining).toEqual([id]);
    expect(result.calls.filter((args) => args[0] === "rm")).toEqual([]);
  });

  it.each<[string, string[], boolean]>([
    ["cluster", ["foreign-exact redis:7 openshell-cluster-nemoclaw"], false],
    ["gateway", ["foreign-exact redis:7 nemoclaw-openshell-gateway"], false],
    ["sandbox", ["foreign-exact redis:7 openshell-my-assistant"], true],
    [
      "ambiguous sandbox",
      [
        "first redis:7 openshell-my-assistant-runtime-a",
        "second redis:7 openshell-my-assistant-runtime-b",
      ],
      true,
    ],
  ])(
    "preserves %s name collisions, recovery state, and the CLI",
    async (_kind, leftovers, keepGateway) => {
      const result = await runWithDockerInventory({ leftovers });
      expect(result.calls).toContainEqual(["ps", "-a", "--format", CONTAINER_FORMAT]);
      expect(result.result.exitCode).toBe(1);
      expect(result.remaining).toEqual([
        ...(keepGateway ? ["owned-gateway"] : []),
        ...leftovers.map((row) => row.split(" ")[0]),
      ]);
      expect(result.metadataWrites.length === 0).toBe(keepGateway);
      expect(result.calls.filter((args) => args[0] === "rm" || args[0] === "images")).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        _kind.includes("sandbox") ? "my-assistant" : leftovers[0]!.split(" ")[2],
      );
      expect(result.retainedRegistry).toBe(result.registry);
      expect(result.rmSync.mock.calls.some(([target]) => target === result.stateDir)).toBe(false);
      expect(
        result.commands.some(
          ([command, action]) => command === "npm" && ["unlink", "uninstall"].includes(action!),
        ),
      ).toBe(false);
    },
  );

  it.each([
    { status: 42, stdout: "", stderr: "inventory unavailable" },
    { status: 0, stdout: "incomplete", stderr: "" },
  ])("preserves state and the CLI when Docker inventory is inconclusive: %j", async (inventory) => {
    const result = await runWithDockerInventory({ inventory });
    expect(result.result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("preserved for retry");
    expect(result.calls.filter((args) => args[0] === "rm" || args[0] === "images")).toEqual([]);
    expect(result.retainedRegistry).toBe(result.registry);
    expect(result.metadataWrites).toEqual([]);
    expect(
      result.commands.some(
        ([command, action]) => command === "npm" && ["unlink", "uninstall"].includes(action!),
      ),
    ).toBe(false);
  });

  it("retains state when Docker is unreachable after runtime cleanup", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();
    const { runUninstallPlan: runPlan } = await import("./run-plan");
    const unavailable = { status: 1, stdout: "", stderr: "Docker unreachable" };
    const result = await runWithDockerInventory({
      port: 18080,
      runPlan,
      inventory: unavailable,
      dockerResponses: { info: unavailable },
    });
    expect(result.result.exitCode).toBe(1);
    expect(result.retainedRegistry).toBe(result.registry);
    expect(result.calls.filter((args) => args[0] === "rm" || args[0] === "images")).toEqual([]);
    expect(
      result.commands.some(
        ([command, action]) => command === "npm" && ["unlink", "uninstall"].includes(action!),
      ),
    ).toBe(false);
  });

  it.each([
    { kind: "Docker", registration: { openshellDriver: "docker" } },
    { kind: "legacy Docker", registration: {} },
  ])("retains $kind resources when the Docker command is missing", async ({ registration }) => {
    const result = await runWithDockerInventory({
      commandExists: (command) => command !== "docker",
      registration,
    });
    expect(result.result.exitCode).toBe(1);
    expect(result.retainedRegistry).toBe(result.registry);
    expect(result.metadataWrites).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(
      result.commands.some(
        ([command, resource]) => command === "openshell" && resource === "sandbox",
      ),
    ).toBe(false);
    expect(result.commands.some(([command]) => command === "npm")).toBe(false);
    expect(result.rmSync).not.toHaveBeenCalled();
    expect(result.errors.join("\n")).toContain("Docker command");
  });

  it("retains recovery metadata if Docker disappears after admission", async () => {
    const dockerAvailable = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const result = await runWithDockerInventory({
      commandExists: (command) => command !== "docker" || dockerAvailable(),
      inventory: { status: 127, stdout: "", stderr: "Docker command missing" },
    });
    expect(result.result.exitCode).toBe(1);
    expect(result.calls).toContainEqual(["ps", "-a", "--format", CONTAINER_FORMAT]);
    expect(result.metadataWrites).toEqual([]);
    expect(result.retainedRegistry).toBe(result.registry);
    expect(result.commands.some(([command]) => command === "npm")).toBe(false);
  });

  it.each([
    {
      kind: "no sandbox",
      prepareHome: (homeDir: string) =>
        fs.writeFileSync(
          path.join(homeDir, ".nemoclaw", "sandboxes.json"),
          JSON.stringify({ defaultSandbox: null, sandboxes: {} }),
        ),
    },
    { kind: "Podman sandbox", registration: { openshellDriver: "podman" } },
  ])("permits missing Docker with $kind recorded", async (options) => {
    const result = await runWithDockerInventory({
      commandExists: (command) => command !== "docker",
      ...options,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.commands).toContainEqual([
      "npm",
      "uninstall",
      "-g",
      "--loglevel=error",
      "nemoclaw",
    ]);
  });

  it("uses the selected non-default gateway and preserves default gateway containers", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();
    const { runUninstallPlan: runPlan } = await import("./run-plan");
    const leftovers = [
      "default-cluster redis:7 openshell-cluster-nemoclaw",
      "default-gateway redis:7 nemoclaw-openshell-gateway",
    ];
    const result = await runWithDockerInventory({ port: 18080, runPlan, leftovers });
    expect(result.result.exitCode).toBe(0);
    expect(result.commands).toContainEqual([
      "openshell",
      "gateway",
      "destroy",
      "-g",
      "nemoclaw-18080",
    ]);
    expect(result.remaining).toEqual(["default-cluster", "default-gateway"]);
    expect(result.calls.filter((args) => args[0] === "rm")).toEqual([]);
  });

  it.each([
    {
      kind: "labelled",
      volume: `nemoclaw-managed-startup-receipt-volume-${"a".repeat(32)}`,
    },
    {
      kind: "unlabelled",
      volume: `nemoclaw-managed-startup-receipt-volume-${"b".repeat(32)}`,
    },
  ])("preserves an $kind receipt-volume match during force-fresh cleanup", async ({ volume }) => {
    const calls: string[][] = [];
    const routes: Record<string, () => RunResult> = {
      info: () => ok(),
      "ps -a --format {{.ID}} {{.Image}} {{.Names}}": () => ok(),
      "volume ls --format {{.Name}}": () => ok(volume),
      "volume inspect openshell-cluster-nemoclaw": () => ({
        status: 1,
        stdout: "",
        stderr: "Error response from daemon: get openshell-cluster-nemoclaw: no such volume",
      }),
    };
    const runDocker = vi.fn((args: string[]) => {
      calls.push(args);
      const command = args.join(" ");
      return (routes[command] ?? (() => ok()))();
    });

    const result = await runUninstallPlan(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        forceFreshReset: true,
        keepOpenShell: true,
      },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-force-fresh-receipts" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        log: () => undefined,
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? ok(JSON.stringify([{ name: "nemoclaw" }]))
            : ok(),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(calls).toContainEqual(["volume", "ls", "--format", "{{.Name}}"]);
    expect(calls).not.toContainEqual(["volume", "rm", "-f", volume]);
  });

  it.each([
    {
      failureCommand: ["volume", "rm", "-f", "openshell-cluster-nemoclaw"],
      plannedVolumeInspection: ok(),
      scenario: "planned-volume removal fails",
    },
    {
      failureCommand: ["volume", "inspect", "openshell-cluster-nemoclaw"],
      plannedVolumeInspection: { status: 1, stdout: "", stderr: "permission denied" },
      scenario: "planned-volume inspection is inconclusive",
    },
  ] as const)(
    "fails force-fresh cleanup when $scenario",
    async ({ failureCommand, plannedVolumeInspection }) => {
      const routes: Record<string, RunResult> = {
        info: ok(),
        "ps -a --format {{.ID}} {{.Image}} {{.Names}}": ok(),
        "volume inspect openshell-cluster-nemoclaw": plannedVolumeInspection,
        "volume rm -f openshell-cluster-nemoclaw": {
          status: 1,
          stdout: "",
          stderr: "busy",
        },
      };
      const runDocker = vi.fn((args: string[]): RunResult => {
        return routes[args.join(" ")] ?? ok();
      });

      const result = await runUninstallPlan(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          forceFreshReset: true,
          keepOpenShell: true,
        },
        {
          commandExists: () => true,
          env: { HOME: "/tmp/nemoclaw-force-fresh-docker-failure" } as NodeJS.ProcessEnv,
          existsSync: () => false,
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          kill: () => true,
          log: () => undefined,
          rmSync: vi.fn(),
          run: (command, args) =>
            command === "openshell" && args.join(" ") === "gateway list -o json"
              ? ok(JSON.stringify([{ name: "nemoclaw" }]))
              : ok(),
          runDocker,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(runDocker).toHaveBeenCalledWith(failureCommand, expect.any(Object));
      expect(runDocker).toHaveBeenCalledWith(
        ["volume", "inspect", "openshell-cluster-nemoclaw"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    },
  );

  it("preserves a convention-matching container and images during force-fresh cleanup", async () => {
    const calls: string[][] = [];
    const routes: Record<string, RunResult> = {
      info: ok(),
      "ps -a --format {{.ID}} {{.Image}} {{.Names}}": ok(
        "foreign-id registry.example.com/unrelated:latest openshell-foreign",
      ),
      "volume inspect openshell-cluster-nemoclaw": {
        status: 1,
        stdout: "",
        stderr: "Error response from daemon: get openshell-cluster-nemoclaw: no such volume",
      },
    };
    const runDocker = vi.fn((args: string[]): RunResult => {
      calls.push(args);
      return routes[args.join(" ")] ?? ok();
    });

    const result = await runUninstallPlan(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        forceFreshReset: true,
        keepOpenShell: true,
      },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-force-fresh-foreign-container" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        log: () => undefined,
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? ok(JSON.stringify([{ name: "nemoclaw" }]))
            : ok(),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(calls).toContainEqual(["ps", "-a", "--format", "{{.ID}} {{.Image}} {{.Names}}"]);
    expect(calls).not.toContainEqual(["rm", "-f", "foreign-id"]);
    expect(calls.some((args) => args[0] === "rmi")).toBe(false);
  });
});
