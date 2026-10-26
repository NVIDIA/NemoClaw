// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

// This suite exercises the controller after reviewed 0.1.3 projection.
vi.mock("../../../src/lib/onboard/openshell-version.ts", async (original) => ({
  ...(await original<typeof import("../../../src/lib/onboard/openshell-version.ts")>()),
  SUPPORTED_OPENSHELL_FALLBACK_VERSION: "0.1.3",
}));

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  configureLocalInferenceRoute,
  assertLocalInferenceAgentResponse,
  localInferenceAgentCommand,
  localInferenceProbe,
  managedImageLocalInferenceBaseUrl,
  createManagedImageSandboxWithDiagnostics,
  MANAGED_IMAGE_LOCAL_INFERENCE_KINDS,
  MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX,
  managedImageProtectedSandboxName,
  managedImageFailureDetail,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  assertExactSandboxImage,
  assertOpenClawHeartbeatStart,
  createBootstrapCompletionFailureInjection,
  managedOpenClawHeartbeatLogProbe,
  assertFailedSandboxOwnerCleanupRetention,
  type ManagedImageCommandRunner,
  managedImageOpenShellBasePolicyPath,
  managedImageOpenShellCommittedProbe,
  managedImageOpenShellProbe,
  managedOpenClawHeartbeatProbe,
  parseManagedImageOpenShellE2eInputs,
  printExactContainerFailureState,
  protectedManagedStateRootDriverConfig,
  removeManagedImageGatewayStateIfSafe,
  resolveManagedImageOnboardModule,
} from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";
import {
  encodeManagedStartupProfile,
  validateManagedStartupProfile,
} from "../../../src/lib/onboard/managed-startup/profile.ts";
import { createManagedStartupRootApplyRequest } from "../../../src/lib/onboard/managed-startup/root-apply.ts";
import type { RuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/contract.ts";
import { gatewayIdForStateDir } from "../../../src/lib/onboard/gateway/process-environment.ts";
import { prepareNativeLocalProfile } from "../../../src/lib/inference/native-local/profile.ts";
import type { OpenShellProviderAdapter } from "../../../src/lib/adapters/openshell/provider-adapter.ts";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;
const VALID_SANDBOX = "managed-openclaw";

function nativeQualificationFixture(
  agent: "openclaw" | "hermes" | "langchain-deepagents-code",
  kind: "ollama" | "nim" | "vllm" | "llama-cpp",
) {
  const route = resolveManagedImageLocalInferenceRoute(kind);
  const binding = {
    provider: route.providerName,
    ...(agent === "langchain-deepagents-code" ? {} : { agent }),
    endpointUrl: route.defaultBaseUrl,
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode:
      kind === "nim" || kind === "vllm" ? ("sentinel" as const) : ("authenticated" as const),
    gatewayName: "nemoclaw",
    sandboxName: VALID_SANDBOX,
  };
  const prepared = prepareNativeLocalProfile(binding);
  const metadata = {
    name: prepared.providerName,
    type: prepared.profileId,
    credentialKeys: [binding.credentialEnv],
    configKeys: [],
    revision: { id: "fixture-owned-id", resourceVersion: 1 },
  };
  const imported: unknown[] = [];
  const adapter = {
    importProviderProfile: vi.fn(async ({ profilePath }) => {
      imported.push(JSON.parse(fs.readFileSync(profilePath, "utf8")));
      return { ok: true as const };
    }),
    getProvider: vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "absent" },
      })
      .mockResolvedValue({ ok: true, value: metadata }),
    createProvider: vi.fn(async () => ({ ok: true as const })),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    inspectProviderProfile: vi.fn(),
    listProviderAttachments: vi.fn(),
    attachProvider: vi.fn(),
    detachProvider: vi.fn(),
    listProviders: vi.fn(),
    ensureProviderPolicyComposition: vi.fn(),
    configureProviderRefresh: vi.fn(),
    getProviderRefreshStatus: vi.fn(),
  } satisfies OpenShellProviderAdapter;
  const runOpenshell = vi.fn((_args: string[]) => ({
    status: 0,
    stdout: JSON.stringify({ revisions: [], next_page_token: "" }),
    stderr: "",
  }));
  const input = {
    agent,
    image: IMAGE,
    sandbox: VALID_SANDBOX,
    localProvider: kind,
    model: "fixture-model",
  };
  return { adapter, binding, imported, input, metadata, prepared, route, runOpenshell };
}

it.each([
  ["openclaw", "ollama"],
  ["hermes", "ollama"],
  ["langchain-deepagents-code", "ollama"],
  ["openclaw", "nim"],
  ["hermes", "nim"],
  ["langchain-deepagents-code", "nim"],
  ["openclaw", "vllm"],
  ["hermes", "vllm"],
  ["langchain-deepagents-code", "vllm"],
  ["openclaw", "llama-cpp"],
] as const)(
  "registers the exact %s %s native boundary without a global inference route",
  async (agent, kind) => {
    const f = nativeQualificationFixture(agent, kind);
    expect(f.prepared.document.binaries).toContain(
      agent === "langchain-deepagents-code" ? "/opt/venv/bin/python3" : "/usr/bin/python3.13",
    );
    const receipt = await configureLocalInferenceRoute(
      f,
      f.input,
      { [f.route.credentialEnv]: "fixture-local-token" },
      f.adapter,
    );
    expect(receipt).toEqual({
      ...f.binding,
      profileId: f.prepared.profileId,
      providerName: f.prepared.providerName,
      schemaVersion: 1,
      providerId: "fixture-owned-id",
    });
    expect(f.imported).toEqual([f.prepared.document]);
    expect(f.adapter.createProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      name: f.prepared.providerName,
      type: f.prepared.profileId,
      credentials: [{ name: f.binding.credentialEnv, value: "fixture-local-token" }],
      config: [],
      fromExisting: false,
    });
    expect(f.runOpenshell.mock.calls[0][0]).toEqual([
      "policy",
      "list",
      "-g",
      "nemoclaw",
      "--global",
      "--page-size",
      "1",
      "--output",
      "json",
    ]);
    expect(f.runOpenshell).toHaveBeenCalledTimes(1);
  },
);

it("refuses an existing qualification provider without adopting or rotating it", async () => {
  const f = nativeQualificationFixture("openclaw", "ollama");
  f.adapter.getProvider.mockReset().mockResolvedValue({ ok: true, value: f.metadata });
  await expect(
    configureLocalInferenceRoute(
      f,
      f.input,
      { [f.route.credentialEnv]: "fixture-token" },
      f.adapter,
    ),
  ).rejects.toThrow("without a matching NemoClaw ownership receipt");
  expect(f.adapter.createProvider).not.toHaveBeenCalled();
  expect(f.adapter.updateProvider).not.toHaveBeenCalled();
});

it.each(["", "raw\ncredential"])(
  "rejects invalid qualification credential %j before importing a profile",
  async (credential) => {
    const f = nativeQualificationFixture("hermes", "ollama");
    await expect(
      configureLocalInferenceRoute(f, f.input, { [f.route.credentialEnv]: credential }, f.adapter),
    ).rejects.toThrow("required for protected local inference");
    expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
  },
);

function runNativeQualificationProbe(handle: string, model = "fixture-model") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-qualification-"));
  try {
    fs.writeFileSync(
      path.join(directory, "curl"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$PROBE_ARGS"\nprintf \'{"choices":[{"message":{"content":"PONG"}}]}\'\n',
      { mode: 0o700 },
    );
    const argsPath = path.join(directory, "args");
    const [command, ...commandArgs] = localInferenceProbe({
      agent: "openclaw",
      image: IMAGE,
      sandbox: VALID_SANDBOX,
      localProvider: "ollama",
      model,
    });
    const result = spawnSync(command, commandArgs, {
      encoding: "utf8",
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        TMPDIR: directory,
        PROBE_ARGS: argsPath,
        NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle,
      },
    });
    return {
      result,
      args: fs.existsSync(argsPath) ? fs.readFileSync(argsPath, "utf8") : null,
      remaining: fs
        .readdirSync(directory)
        .filter((name) => name.startsWith("nemoclaw-managed-image-inference.")),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("protected local inference agent response", () => {
  it.each([
    { response: "", expected: 'response=""' },
    { response: "unexpected answer", expected: 'response="unexpected answer"' },
    { response: "fixture-private-value", expected: 'response="<REDACTED>"' },
    { response: "x".repeat(600), expected: `response="${"x".repeat(512)}"` },
  ])("reports bounded, redacted rejected output [%#]", ({ response, expected }) => {
    expect(() =>
      assertLocalInferenceAgentResponse(
        {
          agent: "hermes",
          image: IMAGE,
          sandbox: VALID_SANDBOX,
          localProvider: "ollama",
          model: "fixture-model",
        },
        response,
        { NVIDIA_API_KEY: "fixture-private-value" },
      ),
    ).toThrow(expected);
  });
  const openclaw = {
    status: "ok",
    result: {
      meta: { aborted: false, agentMeta: { provider: "inference", model: "fixture-model" } },
      payloads: [{ text: "PONG" }],
    },
  };
  const dcode = { data: { status: "success", exit_code: 0, response: "PONG" } };
  const input = (agent: "openclaw" | "hermes" | "langchain-deepagents-code") => ({
    agent,
    image: IMAGE,
    sandbox: VALID_SANDBOX,
    localProvider: "ollama" as const,
    model: "fixture-model",
  });

  it.each([
    ["openclaw", JSON.stringify(openclaw), "openclaw"],
    ["hermes", "PONG\n", "hermes"],
    ["langchain-deepagents-code", JSON.stringify(dcode), "dcode"],
  ] as const)(
    "uses %s's configured route and accepts its assistant response",
    (agent, stdout, binary) => {
      const command = localInferenceAgentCommand(input(agent));
      expect(command[0]).toBe(binary);
      expect(command).not.toContain("--model");
      expect(command).not.toContain("--provider");
      expect(() => assertLocalInferenceAgentResponse(input(agent), stdout)).not.toThrow();
    },
  );

  it.each([
    [
      "openclaw",
      JSON.stringify({ ...openclaw, result: { ...openclaw.result, payloads: [], prompt: "PONG" } }),
    ],
    ["hermes", "request failed; prompt was PONG"],
    [
      "langchain-deepagents-code",
      JSON.stringify({ data: { ...dcode.data, response: "", prompt: "PONG" } }),
    ],
    [
      "langchain-deepagents-code",
      JSON.stringify({ data: { ...dcode.data, status: "turn_limit" } }),
    ],
    ["langchain-deepagents-code", JSON.stringify({ data: { ...dcode.data, exit_code: 1 } })],
    ["openclaw", "not JSON"],
    ["langchain-deepagents-code", "null"],
  ] as const)("rejects %s diagnostics or an incomplete turn", (agent, stdout) => {
    expect(() => assertLocalInferenceAgentResponse(input(agent), stdout)).toThrow();
  });

  it.each([
    ["aborted", { ...openclaw.result.meta, aborted: true }],
    [
      "wrong provider",
      { ...openclaw.result.meta, agentMeta: { provider: "nvidia", model: "fixture-model" } },
    ],
    [
      "wrong model",
      { ...openclaw.result.meta, agentMeta: { provider: "inference", model: "other-model" } },
    ],
  ])("rejects an OpenClaw %s result even when its text is PONG", (_reason, meta) => {
    expect(() =>
      assertLocalInferenceAgentResponse(
        input("openclaw"),
        JSON.stringify({
          ...openclaw,
          result: { ...openclaw.result, meta },
        }),
      ),
    ).toThrow("configured local model");
  });
});

it.each([
  "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  `openshell:resolve:env:s${"a".repeat(64)}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`,
])("uses the runtime-scoped local handle %s for the actual endpoint", (handle) => {
  const { result, args, remaining } = runNativeQualificationProbe(handle);
  expect(result.status, result.stderr).toBe(0);
  expect(args).toContain("http://host.openshell.internal:11435/v1/chat/completions\n");
  expect(args).toContain(`Authorization: Bearer ${handle}\n`);
  expect(remaining).toEqual([]);
});

it("passes shell syntax in the local model unchanged to curl", () => {
  const model = "model'$(printf substituted)`printf expanded`$HOME";
  const { result, args, remaining } = runNativeQualificationProbe(
    "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    model,
  );
  expect(result.status, result.stderr).toBe(0);
  const argv = args!.split("\n");
  expect(JSON.parse(argv[argv.indexOf("--data") + 1]).model).toBe(model);
  expect(remaining).toEqual([]);
});

it.each([
  "raw-token",
  "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  "openshell:resolve:env:v7_NEMOCLAW_OTHER_TOKEN",
  "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN\nraw",
])("rejects unscoped or invalid native probe credential %j before curl", (handle) => {
  const { result, args, remaining } = runNativeQualificationProbe(handle);
  expect(result.status).toBe(2);
  expect(args).toBeNull();
  expect(remaining).toEqual([]);
});

it("captures bounded owner startup logs and redacts secrets before cleanup", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const runner = vi.fn<ManagedImageCommandRunner>(() => ({
    status: 0,
    stdout: "fixture-api-secret",
    stderr: "",
  }));
  try {
    printExactContainerFailureState("c".repeat(64), { API_KEY: "fixture-api-secret" }, runner);
    const [argv, env, timeout] = runner.mock.calls[2];
    expect(argv.slice(0, 7)).toEqual([
      "docker",
      "exec",
      "--user",
      "sandbox",
      "c".repeat(64),
      "/usr/local/bin/node",
      "-e",
    ]);
    expect(env.API_KEY).toBe("fixture-api-secret");
    expect(timeout).toBe(5000);
    expect(String(error.mock.calls.at(-1))).not.toContain("fixture-api-secret");
    const writes: unknown[] = [];
    const close = vi.fn();
    const read = vi.fn((_fd, bytes) => {
      bytes.write("safe");
      return 4;
    });
    const open = vi
      .fn()
      .mockReturnValueOnce(1)
      .mockImplementationOnce(() => {
        throw new Error("symlink");
      })
      .mockReturnValueOnce(3);
    runInNewContext(argv[7], {
      Buffer,
      process: { stdout: { write: (value: unknown) => writes.push(value) } },
      require: () => ({
        constants: { O_RDONLY: 0, O_NOFOLLOW: 2, O_NONBLOCK: 4 },
        openSync: open,
        fstatSync: (fd: number) => ({ isFile: () => true, size: fd === 1 ? 4 : 262145 }),
        readSync: read,
        closeSync: close,
      }),
    });
    expect(open.mock.calls).toEqual(
      ["/tmp/nemoclaw-start.log", "/tmp/gateway.log", "/tmp/dashboard.log"].map((file) => [
        file,
        6,
      ]),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(close.mock.calls).toEqual([[1], [3]]);
    expect(writes.map(String).join("")).toContain("safe");
    expect(writes.filter((value) => value === "diagnostic log unavailable\n")).toHaveLength(2);
    runner.mockClear();
    printExactContainerFailureState("short-id", {}, runner);
    expect(runner).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

function observeWorkload(scenario: string): string {
  const stateDir = path.join(os.tmpdir(), "managed-workload-owner");
  const containerId = "c".repeat(64);
  const contentId = `sha256:${"d".repeat(64)}`;
  const runCommand: ManagedImageCommandRunner = (argv) => {
    const stdout =
      argv[1] === "--version"
        ? "openshell 0.1.3\n"
        : argv[1] === "image"
          ? contentId
          : argv[1] === "ps"
            ? argv.includes("label=openshell.ai/isolation-role=sandbox") && scenario !== "duplicate"
              ? containerId
              : `${containerId}\n${"e".repeat(64)}`
            : JSON.stringify([
                {
                  Image: scenario === "image" ? "sha256:wrong" : contentId,
                  Config: {
                    Labels: {
                      "openshell.ai/managed-by": "openshell",
                      "openshell.ai/sandbox-name": VALID_SANDBOX,
                      "openshell.ai/sandbox-namespace":
                        scenario === "namespace" ? "other" : gatewayIdForStateDir(stateDir),
                      "openshell.ai/isolation-role": scenario === "role" ? "supervisor" : "sandbox",
                    },
                  },
                  HostConfig: { NetworkMode: scenario === "network" ? "bridge" : "none" },
                },
              ]);
    return { status: 0, stdout, stderr: "" };
  };
  return assertExactSandboxImage(
    { agent: "openclaw", image: IMAGE, sandbox: VALID_SANDBOX },
    stateDir,
    {},
    runCommand,
  );
}

it("accepts one exact isolated workload", () => {
  expect(observeWorkload("valid")).toBe("c".repeat(64));
});

it.each(["namespace", "role", "image", "network", "duplicate"])(
  "rejects a workload with mismatched %s evidence",
  (scenario) => {
    expect(() => observeWorkload(scenario)).toThrow(
      "exactly one running harness-owned PR image container",
    );
  },
);

const MANAGED_IMAGE_ONBOARD = resolveManagedImageOnboardModule(
  await import("../../../src/lib/onboard.ts"),
);

function runManagedOpenClawHeartbeatProbe(heartbeat: { every: string; isolatedSession: boolean }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-'$HOME`pwd`-"));
  const configPath = path.join(directory, "openclaw.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { heartbeat } } }));
    return spawnSync(
      "/bin/sh",
      ["-c", managedOpenClawHeartbeatProbe(configPath, process.execPath)],
      { encoding: "utf8" },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function managedProfileApplyFixture(failure: Error | null = null) {
  const input = {
    runtimeProvider: {} as RuntimeProviderBundle,
    sandboxName: VALID_SANDBOX,
    sandboxId: "fixture-sandbox-id",
    bootstrapIdentity: "b".repeat(64),
    expectedContainerId: "c".repeat(64),
    request: createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile: encodeManagedStartupProfile(
        withManagedImageLocalInferenceProfile(
          managedStartupE2eProfile("openclaw"),
          resolveManagedImageLocalInferenceRoute("ollama"),
          "qwen3.5:9b",
        ),
      ),
    }),
  };
  const transaction = {
    agent: "openclaw" as const,
    bootstrapIdentity: input.bootstrapIdentity,
    containerId: input.expectedContainerId,
    image: `sha256:${"a".repeat(64)}`,
    protocol: "identity-bound" as const,
    providerId: "docker" as const,
  };
  const events: string[] = [];
  const operations = {
    applyProviderManagedStartupRootRequest: vi.fn(() => {
      events.push("apply");
      return transaction;
    }),
    finalizeProviderManagedStartupSharedState: vi.fn(() => {
      events.push("commit");
      return { supervisorReady: !failure, failure };
    }),
    releaseProviderManagedStartupHold: vi.fn(() => {
      events.push("release");
    }),
  };
  const owner = {
    runtimeProvider: input.runtimeProvider,
    sandboxName: input.sandboxName,
    sandboxId: input.sandboxId,
    transaction,
  };
  return { input, operations, owner, events };
}

describe("protected managed-image runtime contract", () => {
  it("applies the selected profile and commits before releasing the exact workload", () => {
    const { input, operations, owner, events } = managedProfileApplyFixture();
    const onPhase = vi.fn();
    const transaction = MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.completeProviderManagedStartup(
      input,
      { onPhase },
      operations,
    );
    expect(transaction).toBe(owner.transaction);
    expect(onPhase.mock.calls).toEqual([["apply"], ["commit"], ["release"]]);
    expect(operations.applyProviderManagedStartupRootRequest).toHaveBeenCalledWith(input);
    expect(operations.finalizeProviderManagedStartupSharedState).toHaveBeenCalledWith({
      ...owner,
      supervisorReady: true,
    });
    expect(operations.releaseProviderManagedStartupHold).toHaveBeenCalledWith({
      ...owner,
      profileFingerprint: input.request.profileFingerprint,
    });
    expect(events).toEqual(["apply", "commit", "release"]);
  });

  it("keeps the workload held when profile commit fails", () => {
    const failure = new Error("shared-state commit failed");
    const { input, operations, owner, events } = managedProfileApplyFixture(failure);
    const onApplied = vi.fn();
    expect(() =>
      MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.completeProviderManagedStartup(
        input,
        { onApplied },
        operations,
      ),
    ).toThrow(failure);
    expect(onApplied).toHaveBeenCalledWith(owner.transaction);
    expect(operations.releaseProviderManagedStartupHold).not.toHaveBeenCalled();
    expect(events).toEqual(["apply", "commit"]);
  });

  it("reuses production release retry without repeating profile application or commit", () => {
    const { input, operations, owner, events } = managedProfileApplyFixture();
    operations.releaseProviderManagedStartupHold.mockImplementationOnce(() => {
      events.push("release");
      throw new Error("release unavailable");
    });
    MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.completeProviderManagedStartup(
      input,
      {},
      operations,
    );
    const release = { ...owner, profileFingerprint: input.request.profileFingerprint };
    expect(operations.releaseProviderManagedStartupHold.mock.calls).toEqual([[release], [release]]);
    expect(events).toEqual(["apply", "commit", "release", "release"]);
  });

  it("retains redacted create-client failure evidence without authorizing a retry", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "managed-create-diagnostic-"));
    const executable = path.join(directory, "openshell-fixture");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(
      executable,
      "#!/bin/sh\necho 'create failed: https://user:password@example.test' >&2\nexit 2\n",
      { mode: 0o700 },
    );
    try {
      const createSandbox = createManagedImageSandboxWithDiagnostics(
        () => {
          throw new Error("unexpected buffered command");
        },
        () => executable,
      );
      const result = await createSandbox({
        sandboxName: VALID_SANDBOX,
        target: { kind: "named", gatewayName: "nemoclaw" },
        source: { reference: IMAGE },
        startupCommand: ["true"],
        environment: {},
      });
      expect(result).toMatchObject({ status: 2, ambiguous: true, sawProgress: false });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("create failed:"));
      expect(error.mock.calls.flat().join(" ")).not.toContain("user:password");
    } finally {
      error.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects declared managed state roots through the selected provider driver", () => {
    const mount = {
      type: "volume" as const,
      source: "nemoclaw-hermes-state-v1-alpha",
      target: "/sandbox/.hermes",
      read_only: false,
    };
    const provider = {
      workload: { managedStateMountDriverId: "docker" },
    } as Pick<RuntimeProviderBundle, "workload">;

    expect(JSON.parse(protectedManagedStateRootDriverConfig(provider, [mount])!)).toEqual({
      docker: { mounts: [mount] },
    });
    expect(protectedManagedStateRootDriverConfig(provider, [])).toBeNull();
    expect(() =>
      protectedManagedStateRootDriverConfig({ workload: {} } as typeof provider, [mount]),
    ).toThrow("provider-owned mount projection");
  });

  it("reads the structured heartbeat interval without exporting log credentials", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-log-"));
    try {
      fs.mkdirSync(path.join(root, "unreadable"), { mode: 0 });
      const log = path.join(root, "openclaw-2026-09-13.log");
      fs.writeFileSync(
        log,
        JSON.stringify({
          "0": JSON.stringify({ subsystem: "gateway/heartbeat" }),
          "1": { intervalMs: 120000, apiKey: "fixture-secret" },
          "2": "heartbeat: started",
        }) + "\n",
      );
      const probe = managedOpenClawHeartbeatLogProbe()
        .replace('"/tmp/openclaw"', JSON.stringify(path.join(root, "unreadable")))
        .replace('"/tmp/openclaw-" + process.getuid()', JSON.stringify(root));
      const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("heartbeat-interval-ms=120000");
      expect(result.stderr).toBe("");
      fs.writeFileSync(log, "malformed fixture-secret");
      const failed = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toBe("heartbeat-evidence-unavailable:parse:SyntaxError");
    } finally {
      fs.chmodSync(path.join(root, "unreadable"), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { reason: "unrelated subsystem", subsystem: "gateway/other", create: fs.copyFileSync },
    { reason: "symlink log", subsystem: "gateway/heartbeat", create: fs.symlinkSync },
  ])("rejects heartbeat evidence from a $reason", ({ subsystem, create }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-denial-"));
    try {
      const source = path.join(root, "source.log");
      fs.writeFileSync(
        source,
        JSON.stringify({
          "0": JSON.stringify({ subsystem }),
          "1": { intervalMs: 120000, apiKey: "fixture-secret" },
          "2": "heartbeat: started",
        }) + "\n",
      );
      create(source, path.join(root, "openclaw-2026-09-13.log"));
      const probe = managedOpenClawHeartbeatLogProbe()
        .replace('"/tmp/openclaw"', JSON.stringify(root))
        .replace('"/tmp/openclaw-" + process.getuid()', JSON.stringify(root));
      const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      expect(result.status).toBe(subsystem === "gateway/other" ? 2 : 1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        subsystem === "gateway/other"
          ? "heartbeat-not-started"
          : "heartbeat-evidence-unavailable:open:ELOOP",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds OpenClaw local inference output to the guarded server limit", () => {
    const route = resolveManagedImageLocalInferenceRoute("llama-cpp");
    const openclaw = managedStartupE2eProfile("openclaw", false, true, true);
    const bounded = withManagedImageLocalInferenceProfile(openclaw, route, "nano", 4096);
    expect(validateManagedStartupProfile(bounded).tuning.maxTokens).toBe(4096);
    expect(openclaw.tuning.maxTokens).toBe(8192);
    expect(() => withManagedImageLocalInferenceProfile(openclaw, route, "nano", 0)).toThrow(
      /output token limit/u,
    );
  });

  it.each([
    { separateLogs: false, intervals: [120000, 1800000] },
    { separateLogs: false, intervals: [1800000, 120000] },
    { separateLogs: true, intervals: [120000, 1800000] },
    { separateLogs: true, intervals: [1800000, 120000] },
  ])(
    "rejects conflicting heartbeat intervals $intervals with separateLogs=$separateLogs",
    ({ separateLogs, intervals }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-conflict-"));
      try {
        intervals.forEach((intervalMs, index) => {
          const name = separateLogs ? `openclaw-2026-09-${13 + index}.log` : "openclaw.log";
          fs.appendFileSync(
            path.join(root, name),
            JSON.stringify({
              "0": JSON.stringify({ subsystem: "gateway/heartbeat" }),
              "1": { intervalMs, apiKey: "fixture-secret" },
              "2": "heartbeat: started",
            }) + "\n",
          );
        });
        const probe = managedOpenClawHeartbeatLogProbe()
          .replace('"/tmp/openclaw"', JSON.stringify(root))
          .replace('"/tmp/openclaw-" + process.getuid()', JSON.stringify(root));
        const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("heartbeat-evidence-unavailable:parse:invalid");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("requires the exact managed OpenClaw heartbeat interval in startup logs (#10262)", async () => {
    const containerId = "a".repeat(64);
    const runCommand = vi.fn<ManagedImageCommandRunner>(() => ({
      status: 0,
      stderr: "",
      stdout: "heartbeat-interval-ms=120000",
    }));

    await expect(
      assertOpenClawHeartbeatStart(containerId, {}, runCommand, Date.now() + 30_000),
    ).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledWith(
      [
        "docker",
        "exec",
        "--user",
        "sandbox",
        containerId,
        "node",
        "-e",
        managedOpenClawHeartbeatLogProbe(),
      ],
      {},
      15_000,
    );

    runCommand.mockReturnValue({
      status: 0,
      stdout: "heartbeat-interval-ms=1800000",
      stderr: "",
    });
    await expect(assertOpenClawHeartbeatStart(containerId, {}, runCommand)).rejects.toThrow(
      "managed OpenClaw did not start with the requested 120000 ms heartbeat",
    );
  });

  it("waits for heartbeat after HTTP health within the original startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi
        .fn<ManagedImageCommandRunner>()
        .mockReturnValueOnce({ status: 2, stdout: "", stderr: "heartbeat-not-started" })
        .mockReturnValue({ status: 0, stdout: "heartbeat-interval-ms=120000", stderr: "" });
      const started = assertOpenClawHeartbeatStart(
        "a".repeat(64),
        {},
        runCommand,
        Date.now() + 3_000,
      );
      const checked = expect(started).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      await checked;
      expect(runCommand.mock.calls.map((call) => call[2])).toEqual([3_000, 1_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails missing heartbeat when the shared startup deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi.fn<ManagedImageCommandRunner>(() => ({
        status: 2,
        stdout: "",
        stderr: "heartbeat-not-started",
      }));
      const checked = expect(
        assertOpenClawHeartbeatStart("a".repeat(64), {}, runCommand, Date.now() + 500),
      ).rejects.toThrow("heartbeat did not start within the managed-startup deadline");
      await vi.advanceTimersByTimeAsync(500);
      await checked;
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(runCommand.mock.calls[0][2]).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { status: 1, stdout: "", stderr: "heartbeat-evidence-unavailable:parse:invalid" },
    { status: 2, stdout: "untrusted output", stderr: "heartbeat-not-started" },
    { status: 2, stdout: "", stderr: "untrusted error" },
  ])("rejects invalid heartbeat evidence without polling: $stderr", async (result) => {
    const runCommand = vi.fn<ManagedImageCommandRunner>(() => result);
    await expect(assertOpenClawHeartbeatStart("a".repeat(64), {}, runCommand)).rejects.toThrow(
      "structured heartbeat evidence unavailable",
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("does not expose JSON credentials when managed OpenClaw startup logs cannot be read", async () => {
    const containerId = "a".repeat(64);
    const secret = "json-api-key-secret";
    const runCommand = vi.fn<ManagedImageCommandRunner>(() => ({
      status: 1,
      stdout: JSON.stringify({ apiKey: secret }),
      stderr: JSON.stringify({ nested: { apiKey: secret } }),
    }));

    await expect(assertOpenClawHeartbeatStart(containerId, {}, runCommand)).rejects.toThrow(
      "managed OpenClaw structured heartbeat evidence unavailable",
    );
    await expect(assertOpenClawHeartbeatStart(containerId, {}, runCommand)).rejects.not.toThrow(
      secret,
    );
    runCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "heartbeat-evidence-unavailable:list:EACCES",
    });
    await expect(assertOpenClawHeartbeatStart(containerId, {}, runCommand)).rejects.toThrow(
      "(list: EACCES)",
    );
    const diagnostic = managedImageFailureDetail(
      new Error(
        `startup failed: ${secret} https://user:password@example.test ${"x".repeat(8_000)}`,
      ),
      { NVIDIA_API_KEY: secret },
    );
    expect(diagnostic).toContain("Error: startup failed:");
    expect(diagnostic).not.toMatch(/json-api-key-secret|user:password/);
    expect(diagnostic).toHaveLength(8_000);
  });

  it("loads managed workload operations through the existing onboard boundary", () => {
    expect(MANAGED_IMAGE_ONBOARD.createForwardPortObserver).toBeTypeOf("function");
    expect(MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.prepareManagedStateVolumes).toBeTypeOf(
      "function",
    );
    expect(MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.removeManagedStateVolumes).toBeTypeOf(
      "function",
    );
    expect(MANAGED_IMAGE_ONBOARD.managedWorkloadOnboard.completeProviderManagedStartup).toBeTypeOf(
      "function",
    );
  });

  it("rejects a missing protected OpenShell operation with a precise contract error (#8759)", () => {
    expect(() =>
      resolveManagedImageOnboardModule({
        default: {
          openshellArgv: () => [],
          runCaptureOpenshell: () => "",
          sleepSeconds: () => undefined,
          startGatewayForRecovery: async () => undefined,
          createForwardPortObserver: () => async () => [],
        },
      }),
    ).toThrow("managed-image onboard module is missing required operation(s): runOpenshell");
  });

  it.each([
    ["unknown ownership", { failed: [], ownershipFailures: ["status cannot be proven"] }, 0],
    ["denied signal", { failed: [9_999_601], ownershipFailures: [] }, 0],
    ["failed gateway removal", { failed: [], ownershipFailures: [] }, 1],
  ])("retains gateway evidence after %s (#7744)", (_case, gatewayStop, removalStatus) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-retain-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999601\n");

    try {
      expect(removeManagedImageGatewayStateIfSafe(stateDir, gatewayStop, removalStatus)).toBe(
        false,
      );
      expect(fs.readFileSync(pidFile, "utf8")).toBe("9999601\n");
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("removes gateway state only after scoped stop and gateway removal succeed (#7744)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-remove-"));
    fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), "9999601\n");

    expect(
      removeManagedImageGatewayStateIfSafe(stateDir, { failed: [], ownershipFailures: [] }, 0),
    ).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("retains scoped recovery state when another resource cleanup failed", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-retain-"));
    const marker = path.join(stateDir, "qualification-owner.json");
    fs.writeFileSync(marker, "owned");
    try {
      expect(
        removeManagedImageGatewayStateIfSafe(stateDir, { failed: [], ownershipFailures: [] }, 0, [
          "volume removal failed",
        ]),
      ).toBe(false);
      expect(fs.readFileSync(marker, "utf8")).toBe("owned");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts an exact retained OpenShell sandbox name", () => {
    const expectedSandboxId = "sandbox-id-123";
    const input = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
    ]);
    const responses = new Map([
      ["get", { status: 0, stdout: `Id: ${expectedSandboxId}\n`, stderr: "" }],
      ["list", { status: 0, stdout: `NAME STATUS\n${VALID_SANDBOX} Ready\n`, stderr: "" }],
    ]);
    const runOpenshell = vi.fn(
      (argv: readonly string[]) =>
        responses.get(argv[1] ?? "") ?? { status: 1, stdout: "", stderr: "unexpected command" },
    );

    expect(() =>
      assertFailedSandboxOwnerCleanupRetention(
        { runOpenshell } as never,
        input,
        expectedSandboxId,
        {},
      ),
    ).not.toThrow();
  });

  it("rejects a containing sandbox name and an exact name mentioned only in stderr", () => {
    const expectedSandboxId = "sandbox-id-123";
    const input = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
    ]);
    const responses = new Map([
      ["get", { status: 0, stdout: `Id: ${expectedSandboxId}\n`, stderr: "" }],
      [
        "list",
        {
          status: 0,
          stdout: `NAME STATUS\n${VALID_SANDBOX}-other Ready\n`,
          stderr: `diagnostic mentions ${VALID_SANDBOX}`,
        },
      ],
    ]);
    const runOpenshell = vi.fn(
      (argv: readonly string[]) =>
        responses.get(argv[1] ?? "") ?? { status: 1, stdout: "", stderr: "unexpected command" },
    );
    const assertion = () =>
      assertFailedSandboxOwnerCleanupRetention(
        { runOpenshell } as never,
        input,
        expectedSandboxId,
        {},
      );

    expect(assertion).toThrow("exact OpenShell owner-cleanup state");
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "list"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("assigns every protected agent and route a unique OpenShell-compatible sandbox name (#8497)", () => {
    const routeKinds = [...MANAGED_IMAGE_LOCAL_INFERENCE_KINDS, "rollback"] as const;
    const qualifications = PROTECTED_MANAGED_IMAGE_AGENTS.flatMap((agent) =>
      routeKinds.map((routeKind) => ({
        agent,
        sandbox: managedImageProtectedSandboxName(agent, routeKind),
      })),
    );
    const names = qualifications.map(({ sandbox }) => sandbox);

    expect(names).toEqual([
      "nmc-mi-oc-lc",
      "nmc-mi-oc-ol",
      "nmc-mi-oc-ni",
      "nmc-mi-oc-vl",
      "nmc-mi-oc-rb",
      "nmc-mi-he-lc",
      "nmc-mi-he-ol",
      "nmc-mi-he-ni",
      "nmc-mi-he-vl",
      "nmc-mi-he-rb",
      "nmc-mi-dc-lc",
      "nmc-mi-dc-ol",
      "nmc-mi-dc-ni",
      "nmc-mi-dc-vl",
      "nmc-mi-dc-rb",
    ]);
    expect(new Set(names).size).toBe(names.length);
    qualifications.forEach(({ agent, sandbox: name }) => {
      expect(name.startsWith(MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(19);
      expect(name).not.toContain("--");
      expect(
        parseManagedImageOpenShellE2eInputs(["--agent", agent, "--image", IMAGE, "--sandbox", name])
          .sandbox,
      ).toBe(name);
    });
  });

  it("enforces the canonical OpenShell sandbox-name length and delimiter contract (#8497)", () => {
    const parseSandbox = (sandbox: string) =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        sandbox,
      ]);

    expect(parseSandbox(`a${"b".repeat(18)}`).sandbox).toHaveLength(19);
    expect(() => parseSandbox(`a${"b".repeat(19)}`)).toThrow(/1-19 characters/u);
    expect(() => parseSandbox("managed--openclaw")).toThrow(/single internal hyphens/u);
  });

  it.each([
    ["llama-cpp", "llama-cpp-local", "NEMOCLAW_LLAMACPP_LOCAL_TOKEN", 8081],
    ["ollama", "ollama-local", "NEMOCLAW_OLLAMA_PROXY_TOKEN", 11435],
    ["nim", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
    ["vllm", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
  ] as const)("maps %s to its exact host-local route", (kind, provider, credential, port) => {
    const route = resolveManagedImageLocalInferenceRoute(kind);

    expect(MANAGED_IMAGE_LOCAL_INFERENCE_KINDS).toContain(kind);
    expect(route).toMatchObject({
      kind,
      providerName: provider,
      credentialEnv: credential,
    });
    expect(new URL(route.defaultBaseUrl)).toMatchObject({
      hostname: "host.openshell.internal",
      port: String(port),
      pathname: "/v1",
      protocol: "http:",
    });
  });

  it("accepts an exact protected local-inference URL override", () => {
    expect(
      managedImageLocalInferenceBaseUrl("ollama", "http://host.openshell.internal:11435/v1/"),
    ).toBe("http://host.openshell.internal:11435/v1");
  });

  it.each([
    ["HTTPS", "https://host.openshell.internal:11435/v1"],
    ["another host", "http://example.invalid:11435/v1"],
    ["a missing port", "http://host.openshell.internal/v1"],
    ["port zero", "http://host.openshell.internal:0/v1"],
    ["an out-of-range port", "http://host.openshell.internal:65536/v1"],
    ["another path", "http://host.openshell.internal:11435/v2"],
    ["credentials", "http://user:secret@host.openshell.internal:11435/v1"],
    ["a query", "http://host.openshell.internal:11435/v1?model=other"],
    ["a fragment", "http://host.openshell.internal:11435/v1#other"],
  ])("rejects a protected local-inference override with %s", (_case, value) => {
    expect(() => managedImageLocalInferenceBaseUrl("ollama", value)).toThrow(
      /protected local inference/u,
    );
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "binds %s to an exact GPU/local-inference launch",
    (agent) => {
      const parsed = parseManagedImageOpenShellE2eInputs([
        "--agent",
        agent,
        "--image",
        IMAGE,
        "--sandbox",
        managedImageProtectedSandboxName(agent, "nim"),
        "--gpu",
        "--local-provider",
        "nim",
        "--model",
        "nvidia/nemotron-3-nano",
      ]);

      expect(parsed).toEqual({
        agent,
        gpu: true,
        image: IMAGE,
        localProvider: "nim",
        model: "nvidia/nemotron-3-nano",
        sandbox: managedImageProtectedSandboxName(agent, "nim"),
      });
      expect(path.isAbsolute(managedImageOpenShellBasePolicyPath(agent))).toBe(true);
      const probe = managedImageOpenShellProbe(agent);
      const syntax = spawnSync("/bin/sh", ["-n", "-c", probe], { encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(probe).toContain("managed-startup-complete.json");
      expect(probe).toContain(
        `managed-image startup probe failed: ${
          agent === "openclaw"
            ? "OpenClaw health endpoint"
            : agent === "hermes"
              ? "Hermes health endpoint"
              : "LangChain Deep Agents Code version command"
        }`,
      );
      expect(probe).toContain(
        "managed-image startup probe failed: managed startup completion owner, group, and mode must equal 0:0:444",
      );
    },
  );

  it("accepts an isolated OpenClaw heartbeat (#10262)", () => {
    const result = runManagedOpenClawHeartbeatProbe({ every: "2m", isolatedSession: true });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["a main-session heartbeat", { every: "2m", isolatedSession: false }],
    ["another heartbeat interval", { every: "30m", isolatedSession: true }],
  ])("rejects %s in the managed OpenClaw probe (#10262)", (_case, heartbeat) => {
    const result = runManagedOpenClawHeartbeatProbe(heartbeat);

    expect(result.status).toBe(1);
  });

  it.each([
    ["openclaw", false],
    ["openclaw", true],
    ["hermes", false],
    ["hermes", true],
    ["langchain-deepagents-code", false],
  ] as const)("supplies a valid local route for %s with providerless=%s", (agent, providerless) => {
    const original = managedStartupE2eProfile(agent, false, true, true);
    const profile = providerless
      ? validateManagedStartupProfile({ ...original, inference: null })
      : original;
    const route = resolveManagedImageLocalInferenceRoute("nim");
    const rewritten = withManagedImageLocalInferenceProfile(
      profile,
      route,
      "nvidia/nemotron-3-nano",
    );

    expect(validateManagedStartupProfile(rewritten)).toEqual(rewritten);
    expect(rewritten).toEqual({
      ...profile,
      inference: {
        api: "openai-completions",
        model: "nvidia/nemotron-3-nano",
        routedBaseUrl: "http://host.openshell.internal:8000/v1",
        routeProvider: "inference",
        upstreamEndpointUrl: agent === "langchain-deepagents-code" ? route.defaultBaseUrl : null,
        upstreamProvider: "vllm-local",
        primaryModelRef: agent === "openclaw" ? "inference/nvidia/nemotron-3-nano" : null,
        compatibility: profile.inference?.compatibility ?? (agent === "openclaw" ? {} : null),
        inputModalities:
          profile.inference?.inputModalities ?? (agent === "openclaw" ? ["text"] : null),
      },
    });
    expect(profile.inference).toEqual(providerless ? null : original.inference);
    expect(() =>
      validateManagedStartupProfile(withManagedImageLocalInferenceProfile(profile, route, "")),
    ).toThrow();
  });

  it("rejects mutable images and incomplete GPU provider tuples", () => {
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        "localhost:5000/openclaw:latest",
        "--sandbox",
        VALID_SANDBOX,
      ]),
    ).toThrow(/immutable repository@sha256/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        VALID_SANDBOX,
        "--gpu",
      ]),
    ).toThrow(/--gpu requires/u);
  });

  it("allows only llama.cpp local inference without direct sandbox GPU access", () => {
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
      ]),
    ).toMatchObject({
      agent: "openclaw",
      localProvider: "llama-cpp",
      model: "nvidia-nemotron-3-nano-30b-a3b",
    });
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-vllm",
        "--local-provider",
        "vllm",
        "--model",
        "nvidia/nemotron-3-nano",
      ]),
    ).toThrow(/require --gpu/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
        "--gpu",
      ]),
    ).toThrow(/must not grant direct sandbox GPU access/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
      ]),
    ).toThrow(/requires --model/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toThrow(/cannot be combined/u);
  });

  it("keeps rollback cleanup distinct from initial readiness", () => {
    expect(managedImageOpenShellCommittedProbe()).toContain(
      "managed-startup-shared-state-transaction-v1",
    );
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-rollback",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toMatchObject({ failureInjection: "bootstrap-completion" });
  });

  it("injects bootstrap completion failure only after exact owner retention is proven", () => {
    const expectedSandboxId = "sandbox-id-rollback";
    const managedImage = parseManagedImageOpenShellE2eInputs([
      "--agent",
      "openclaw",
      "--image",
      IMAGE,
      "--sandbox",
      VALID_SANDBOX,
      "--inject-bootstrap-completion-failure",
    ]);
    const runOpenshell = vi.fn((argv: readonly string[]) =>
      argv[1] === "get"
        ? { status: 0, stdout: `Id: ${expectedSandboxId}\n`, stderr: "" }
        : { status: 0, stdout: `NAME STATUS\n${VALID_SANDBOX} Ready\n`, stderr: "" },
    );
    const onQualified = vi.fn();
    const write = vi.fn();
    const injection = createBootstrapCompletionFailureInjection({
      env: {},
      managedImage,
      onboard: { runOpenshell } as never,
      onQualified,
      write,
    });

    expect(() =>
      injection.flowInput.verifyCreatedSandboxBeforeEffects!({
        sandboxId: expectedSandboxId,
        liveIdentityFingerprint: "fingerprint",
        createAttemptNonce: "nonce",
        route: "none",
      }),
    ).toThrow(injection.expectedError);
    expect(onQualified).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("retained one exact quiescent openclaw sandbox for owner cleanup"),
    );
    expect(injection.flowInput.persistRetainedSandboxRecovery!("retained")).toBe(true);
  });
});
