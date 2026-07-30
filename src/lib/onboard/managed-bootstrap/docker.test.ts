// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { DockerContainerInspect } from "../docker-gpu-patch-types";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  ManagedBootstrapCommitStateIndeterminateError,
  ManagedBootstrapDurableCommitCleanupPendingError,
  type ManagedBootstrapFinalizationReceipt,
  runManagedBootstrapSequence,
} from "./adapter";
import {
  createDockerManagedBootstrapAdapter,
  type DockerManagedBootstrapDeps,
  MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE,
} from "./docker";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  parseManagedBootstrapEnvelope,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";

const IDENTITY = "1".repeat(64);
const OLD_ID = "2".repeat(64);
const NEW_ID = "3".repeat(64);
const CONFIG_ID = `sha256:${"4".repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${"5".repeat(64)}` as const;
const IMAGE_REPOSITORY = "registry.example/nemoclaw/hermes";
const IMAGE_REFERENCE = `${IMAGE_REPOSITORY}@${MANIFEST_DIGEST}`;
const SUPERVISOR_ARGV = [
  "/opt/openshell/bin/openshell-sandbox",
  "supervise",
  "--foreground",
] as const;

const request = createManagedStartupRootApplyRequest({
  agent: "hermes",
  encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("hermes", false, false)),
});

function plan() {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: "alpha",
    driverId: "docker",
    image: {
      repository: IMAGE_REPOSITORY,
      manifestDigest: MANIFEST_DIGEST,
    },
    profile: { agent: "hermes" as const, fingerprint: request.profileFingerprint },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    intendedWorkloadArgv: ["env", "A=1", "nemoclaw-start"],
    expectedSupervisorArgv: SUPERVISOR_ARGV,
    metadata: {
      "nemoclaw.ai/managed-profile": request.profileFingerprint,
    },
  };
}

function heldArgv(): string[] {
  return [
    "env",
    "A=1",
    "/usr/local/bin/nemoclaw-managed-startup-hold",
    "--agent",
    "hermes",
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    IDENTITY,
  ];
}

function runDefaultSequence(adapter: ReturnType<typeof createDockerManagedBootstrapAdapter>) {
  return runManagedBootstrapSequence(adapter, {
    create: {
      plan: plan(),
      request,
      bootstrapIdentity: IDENTITY,
      launch: async () => ({
        sandbox: {
          sandboxName: "alpha",
          sandboxId: "sandbox-alpha",
          driverId: "docker",
        },
        ready: true,
        readyAt: "2026-07-29T11:59:00.000Z",
      }),
    },
    request,
    replacementOptions: { values: {} },
    timeoutSecs: 30,
  });
}

async function captureSequenceFailure(
  promise: ReturnType<typeof runDefaultSequence>,
): Promise<Error & { managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt };
  }
  throw new Error("Expected managed bootstrap sequence to fail.");
}

function commandEnv(argv: readonly string[]): string {
  return argv
    .map((value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value}'`))
    .join(" ");
}

function originalInspect(heldArgv: readonly string[]): DockerContainerInspect {
  return {
    Id: OLD_ID,
    Image: CONFIG_ID,
    Name: "/openshell-alpha",
    Config: {
      Image: IMAGE_REFERENCE,
      Env: ["A=1", `OPENSHELL_SANDBOX_COMMAND=${commandEnv(heldArgv)}`],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-alpha",
        "nemoclaw.ai/managed-profile": request.profileFingerprint,
      },
      Entrypoint: [SUPERVISOR_ARGV[0]],
      Cmd: SUPERVISOR_ARGV.slice(1),
      User: "root",
      WorkingDir: "/sandbox",
      Hostname: "alpha",
      Tty: false,
      OpenStdin: false,
    },
    State: {
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    HostConfig: {
      Binds: ["/host/workspace:/sandbox:rw"],
      NetworkMode: "openshell",
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["NET_RAW"],
      SecurityOpt: ["no-new-privileges"],
      Dns: ["10.0.0.2"],
      Ulimits: [{ Name: "nofile", Soft: 65_536, Hard: 65_536 }],
    },
    NetworkSettings: {
      Networks: {
        openshell: { Aliases: ["openshell-alpha"] },
      },
    },
  };
}

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function fakeDocker(
  heldArgv: readonly string[],
  options: {
    readonly completionBootstrapIdentity?: string;
    readonly completionTransactionPending?: boolean;
    readonly extraEnvironment?: readonly string[];
    readonly failBackupRemovalAttempts?: number;
    readonly failCommitReceiptClearAttempts?: number;
    readonly failCommittedProbeAttempts?: number;
    readonly failReplacementStart?: boolean;
    readonly missingContainerMessage?: "daemon-container" | "error-container" | "error-object";
    readonly sharedStateStatus?: "committed" | "none" | "pending";
  } = {},
) {
  const original = originalInspect(heldArgv);
  original.Config = {
    ...original.Config,
    Env: [...(original.Config?.Env ?? []), ...(options.extraEnvironment ?? [])],
  };
  let originalPresent = true;
  let originalName = "openshell-alpha";
  let originalRunning = true;
  let replacement: DockerContainerInspect | null = null;
  let sandboxId: string | null = "sandbox-alpha";
  let sharedStateStatus = options.sharedStateStatus ?? "none";
  let backupRemovalFailuresRemaining = options.failBackupRemovalAttempts ?? 0;
  let commitReceiptClearFailuresRemaining = options.failCommitReceiptClearAttempts ?? 0;
  let committedProbeFailuresRemaining = options.failCommittedProbeAttempts ?? 0;
  let copiedEnvelope: ReturnType<typeof parseManagedBootstrapEnvelope> | null = null;
  let copiedMode: number | null = null;
  let copyDestination = "";
  const createArgs: string[][] = [];
  const events: string[] = [];

  const dockerCapture: NonNullable<DockerManagedBootstrapDeps["dockerCapture"]> = vi.fn((args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([{ Id: CONFIG_ID, RepoDigests: [IMAGE_REFERENCE] }]);
    }
    if (args[0] !== "inspect") throw new Error(`unexpected capture ${args.join(" ")}`);
    const id = String(args[3] ?? "");
    if (id === OLD_ID && originalPresent) {
      return JSON.stringify([
        {
          ...original,
          Name: `/${originalName}`,
          State: { ...original.State, Running: originalRunning },
        },
      ]);
    }
    if (id === NEW_ID && replacement) return JSON.stringify([replacement]);
    throw new Error("No such container");
  });

  const dockerRun: NonNullable<DockerManagedBootstrapDeps["dockerRun"]> = vi.fn((args) => {
    if (args[0] === "ps") {
      return ok(
        [originalPresent ? OLD_ID : null, replacement ? NEW_ID : null]
          .filter((id): id is string => id !== null)
          .join("\n"),
      );
    }
    if (args[0] === "create") {
      createArgs.push([...args]);
      const nameIndex = args.indexOf("--name");
      const entrypointIndex = args.indexOf("--entrypoint");
      const imageIndex = args.indexOf(IMAGE_REFERENCE);
      const envValues: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--env") envValues.push(String(args[index + 1] ?? ""));
      }
      replacement = {
        ...structuredClone(original),
        Id: NEW_ID,
        Name: `/${String(args[nameIndex + 1] ?? "")}`,
        Config: {
          ...structuredClone(original.Config),
          Image: IMAGE_REFERENCE,
          Env: envValues,
          Entrypoint: [String(args[entrypointIndex + 1] ?? "")],
          Cmd: args.slice(imageIndex + 1),
        },
        State: {
          Running: false,
          Paused: false,
          Restarting: false,
          Dead: false,
        },
      };
      return ok(NEW_ID);
    }
    if (args[0] === "cp") {
      const sourceIndex = args[1] === "-a" ? 2 : 1;
      const destinationIndex = sourceIndex + 1;
      const source = String(args[sourceIndex] ?? "");
      if (source === `${NEW_ID}:${MANAGED_BOOTSTRAP_COMPLETION_FILE}`) {
        const destination = String(args[destinationIndex] ?? "");
        fs.writeFileSync(
          destination,
          serializeManagedBootstrapImageCompletion({
            agent: "hermes",
            bootstrapIdentity: options.completionBootstrapIdentity ?? IDENTITY,
            profileFingerprint: request.profileFingerprint,
            transactionPending: options.completionTransactionPending ?? false,
          }),
          { mode: 0o444 },
        );
        fs.chmodSync(destination, 0o444);
        return ok();
      }
      if (source === `${NEW_ID}:/var/lib/nemoclaw/managed-startup-shared-state-transaction-v1`) {
        if (sharedStateStatus === "pending") {
          fs.mkdirSync(String(args[destinationIndex] ?? ""), { recursive: true });
          return ok();
        }
        return {
          status: 1,
          stderr: `Error response from daemon: Could not find the file /var/lib/nemoclaw/managed-startup-shared-state-transaction-v1 in container ${NEW_ID}`,
        };
      }
      if (source === `${NEW_ID}:/var/lib/nemoclaw/managed-startup-shared-state-commit-v1`) {
        if (sharedStateStatus === "committed") {
          fs.mkdirSync(String(args[destinationIndex] ?? ""), { recursive: true });
          return ok();
        }
        return {
          status: 1,
          stderr: `Error response from daemon: Could not find the file /var/lib/nemoclaw/managed-startup-shared-state-commit-v1 in container ${NEW_ID}`,
        };
      }
      copyDestination = String(args[destinationIndex] ?? "");
      copiedMode = fs.statSync(source).mode & 0o777;
      copiedEnvelope = parseManagedBootstrapEnvelope(fs.readFileSync(source, "utf8"));
      return ok();
    }
    if (args[0] === "run" && args.includes("--rollback-shared-state-transaction")) {
      events.push("shared-state-rollback");
      sharedStateStatus = "none";
      return ok();
    }
    if (args[0] === "run" && args.includes("--shared-state-transaction-status")) {
      if (sharedStateStatus === "committed" && committedProbeFailuresRemaining > 0) {
        committedProbeFailuresRemaining -= 1;
        return { status: 1, stderr: "injected immutable committed-status probe failure" };
      }
      return ok(`${sharedStateStatus}\n`);
    }
    if (args[0] === "exec" && args.includes("--commit-shared-state-transaction")) {
      events.push("shared-state-commit");
      sharedStateStatus = "committed";
      return ok();
    }
    if (args[0] === "exec" && args.includes("--clear-shared-state-commit-receipt")) {
      events.push("shared-state-commit-clear");
      if (commitReceiptClearFailuresRemaining > 0) {
        commitReceiptClearFailuresRemaining -= 1;
        return { status: 1, stderr: "injected durable receipt cleanup failure" };
      }
      sharedStateStatus = "none";
      return ok();
    }
    if (args[0] === "inspect" && args[1] === "--type" && args[3] === OLD_ID) {
      if (originalPresent) return ok(`[{"Id":"${OLD_ID}"}]`);
      const missing =
        options.missingContainerMessage === "error-container"
          ? `Error: No such container: ${OLD_ID}`
          : options.missingContainerMessage === "daemon-container"
            ? `Error response from daemon: No such container: ${OLD_ID}`
            : `Error: No such object: ${OLD_ID}`;
      return { status: 1, stderr: missing };
    }
    throw new Error(`unexpected docker run ${args.join(" ")}`);
  });

  const runOpenshell: NonNullable<DockerManagedBootstrapDeps["runOpenshell"]> = vi.fn((args) => {
    if (args[0] === "sandbox" && args[1] === "delete") {
      events.push("sandbox-delete");
      sandboxId = null;
      originalPresent = false;
      replacement = null;
    }
    return { status: 0 };
  });
  const runCaptureOpenshell: NonNullable<DockerManagedBootstrapDeps["runCaptureOpenshell"]> = vi.fn(
    (args) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return sandboxId ? `Name: alpha\nID: ${sandboxId}\n` : "";
      }
      if (args[0] === "sandbox" && args[1] === "list") {
        return sandboxId ? "alpha Ready\n" : "";
      }
      return "";
    },
  );
  const deps: DockerManagedBootstrapDeps = {
    createBootstrapIdentity: () => IDENTITY,
    dockerCapture,
    dockerRun,
    runCaptureOpenshell,
    runOpenshell,
    dockerStop: vi.fn((id) => {
      if (id === OLD_ID) originalRunning = false;
      if (id === NEW_ID && replacement) {
        replacement.State = { ...replacement.State, Running: false };
      }
      return ok();
    }),
    dockerRename: vi.fn((id, name) => {
      if (id === OLD_ID) originalName = name;
      return ok();
    }),
    dockerStart: vi.fn((id) => {
      if (id === OLD_ID) originalRunning = true;
      if (id === NEW_ID && replacement) {
        if (options.failReplacementStart) {
          return { status: 1, stderr: "injected replacement start failure" };
        }
        replacement.State = { ...replacement.State, Running: true };
      }
      return ok();
    }),
    dockerRm: vi.fn((id) => {
      if (id === OLD_ID) {
        events.push("rollback-backup-remove");
        if (backupRemovalFailuresRemaining > 0) {
          backupRemovalFailuresRemaining -= 1;
          return { status: 1, stderr: "injected exact backup removal failure" };
        }
        if (!originalPresent) {
          return {
            status: 1,
            stderr: `Error response from daemon: No such container: ${OLD_ID}`,
          };
        }
        originalPresent = false;
      }
      if (id === NEW_ID) replacement = null;
      return ok();
    }),
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  };
  return {
    deps,
    state: {
      createArgs,
      get copiedEnvelope() {
        return copiedEnvelope;
      },
      get copiedMode() {
        return copiedMode;
      },
      get copyDestination() {
        return copyDestination;
      },
      dropReplacement() {
        replacement = null;
      },
      get originalName() {
        return originalName;
      },
      get originalRunning() {
        return originalRunning;
      },
      get replacementEnvironment() {
        return replacement?.Config?.Env ?? null;
      },
      get sandboxId() {
        return sandboxId;
      },
      get containerIds() {
        return [originalPresent ? OLD_ID : null, replacement ? NEW_ID : null].filter(
          (id): id is string => id !== null,
        );
      },
      get events() {
        return [...events];
      },
      dropOriginal() {
        originalPresent = false;
      },
      get sharedStateStatus() {
        return sharedStateStatus;
      },
      replaceSandboxIdentity(id: string) {
        sandboxId = id;
      },
    },
  };
}

describe("Docker managed bootstrap adapter", () => {
  it("keeps manifest and local config identities distinct and stages one 0400 envelope", async () => {
    const heldArgv = [
      "env",
      "A=1",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ];
    const fake = fakeDocker(heldArgv);
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const launch = vi.fn(
      async (input: {
        readonly heldWorkloadArgv: readonly string[];
        readonly bootstrapIdentity: string;
      }) => {
        expect(input).toEqual({
          heldWorkloadArgv: heldArgv,
          bootstrapIdentity: IDENTITY,
        });
        return {
          sandbox: {
            sandboxName: "alpha",
            sandboxId: "sandbox-alpha",
            driverId: "docker",
          },
          ready: true as const,
          readyAt: "2026-07-29T11:59:00.000Z",
        };
      },
    );

    const result = await runManagedBootstrapSequence(adapter, {
      create: {
        plan: plan(),
        request,
        bootstrapIdentity: IDENTITY,
        launch,
      },
      request,
      replacementOptions: { values: {} },
      timeoutSecs: 30,
    });
    await adapter.finalizeBootstrap({
      outcome: "commit",
      ...result,
    });

    expect(result.snapshot).toMatchObject({
      image: {
        repository: IMAGE_REPOSITORY,
        manifestDigest: MANIFEST_DIGEST,
      },
      runtimeImageContentId: CONFIG_ID,
    });
    expect(result.completion).toMatchObject({
      bootstrapIdentity: IDENTITY,
      runtimeImageContentId: CONFIG_ID,
      transactionPending: false,
    });
    expect(fake.state.copiedMode).toBe(0o400);
    expect(fake.state.copyDestination).toBe(`${NEW_ID}:${MANAGED_BOOTSTRAP_REQUEST_FILE}`);
    expect(fake.state.copiedEnvelope).toEqual({
      schemaVersion: 1,
      bootstrapIdentity: IDENTITY,
      rootApplyRequest: request,
    });
    const create = fake.state.createArgs[0] ?? [];
    expect(create).toEqual(
      expect.arrayContaining([
        "create",
        "--entrypoint",
        MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE,
        IMAGE_REFERENCE,
        "--bootstrap-identity",
        IDENTITY,
        "--request-file",
        MANAGED_BOOTSTRAP_REQUEST_FILE,
        "--",
        ...SUPERVISOR_ARGV,
      ]),
    );
    expect(create.join(" ")).not.toContain(request.encodedProfile);
  });

  it("preserves ordinary supervisor environment exactly across replacement", async () => {
    const heldArgv = [
      "env",
      "A=1",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ];
    const ordinary = "SAFE_SUPERVISOR_VALUE=kept exactly";
    const fake = fakeDocker(heldArgv, { extraEnvironment: [ordinary] });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);

    await runManagedBootstrapSequence(adapter, {
      create: {
        plan: plan(),
        request,
        bootstrapIdentity: IDENTITY,
        launch: async () => ({
          sandbox: {
            sandboxName: "alpha",
            sandboxId: "sandbox-alpha",
            driverId: "docker",
          },
          ready: true,
          readyAt: "2026-07-29T11:59:00.000Z",
        }),
      },
      request,
      replacementOptions: { values: {} },
      timeoutSecs: 30,
    });

    expect(fake.state.replacementEnvironment).toContain(ordinary);
  });

  it.each([
    "BASH_ENV=/sandbox/attacker",
    "ENV=/sandbox/attacker",
    "LD_PRELOAD=/sandbox/attacker.so",
    "LD_AUDIT=/sandbox/attacker.so",
    "LD_LIBRARY_PATH=/sandbox/lib",
    "SHELLOPTS=xtrace",
    "PS4=$(touch /sandbox/root-owned)",
    "BASH_FUNC_attacker%%=() { touch /sandbox/root-owned; }",
  ])("refuses root-process injection environment before replacement: %s", async (entry) => {
    const heldArgv = [
      "env",
      "A=1",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ];
    const fake = fakeDocker(heldArgv, { extraEnvironment: [entry] });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);

    await expect(
      runManagedBootstrapSequence(adapter, {
        create: {
          plan: plan(),
          request,
          bootstrapIdentity: IDENTITY,
          launch: async () => ({
            sandbox: {
              sandboxName: "alpha",
              sandboxId: "sandbox-alpha",
              driverId: "docker",
            },
            ready: true,
            readyAt: "2026-07-29T11:59:00.000Z",
          }),
        },
        request,
        replacementOptions: { values: {} },
        timeoutSecs: 30,
      }),
    ).rejects.toThrow("root-process injection environment");
    expect(fake.deps.dockerStop).not.toHaveBeenCalled();
    expect(fake.deps.dockerStart).not.toHaveBeenCalled();
    expect(fake.state.sandboxId).toBeNull();
    expect(fake.state.containerIds).toEqual([]);
  });

  it.each([
    { count: 0, output: "" },
    { count: 2, output: `${OLD_ID}\n${"9".repeat(64)}\n` },
  ])("fails closed when post-Ready discovery finds $count workloads", async ({ count, output }) => {
    const heldArgv = [
      "env",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ];
    const fake = fakeDocker(heldArgv);
    vi.mocked(fake.deps.dockerRun!).mockImplementationOnce(() => ok(output));
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const created = await adapter.createHeldWorkload({
      plan: { ...plan(), intendedWorkloadArgv: ["env", "nemoclaw-start"] },
      request,
      bootstrapIdentity: IDENTITY,
      launch: async () => ({
        sandbox: {
          sandboxName: "alpha",
          sandboxId: "sandbox-alpha",
          driverId: "docker",
        },
        ready: true,
        readyAt: "2026-07-29T11:59:00.000Z",
      }),
    });

    await expect(
      adapter.discoverHeldWorkload({
        sandbox: created.sandbox,
        bootstrapIdentity: IDENTITY,
        expectedImage: created.plan.image,
        metadata: created.plan.metadata,
      }),
    ).rejects.toThrow(`found ${String(count)}`);
  });

  it("removes an identity-bound incomplete create and proves its owner and runtime absent", async () => {
    const fake = fakeDocker(heldArgv());
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);

    const receipt = await adapter.cleanupIncompleteCreate({
      plan: plan(),
      bootstrapIdentity: IDENTITY,
      heldWorkloadArgv: heldArgv(),
    });

    expect(receipt).toMatchObject({
      sandbox: {
        sandboxName: "alpha",
        sandboxId: "sandbox-alpha",
        driverId: "docker",
      },
      bootstrapIdentity: IDENTITY,
      outcome: "rolled-back",
      heldWorkloadRemoved: true,
    });
    expect(fake.state.events).toEqual(["sandbox-delete"]);
    expect(fake.state.sandboxId).toBeNull();
    expect(fake.state.containerIds).toEqual([]);
  });

  it("refuses owner cleanup when the same name now resolves to another durable sandbox ID", async () => {
    const intendedArgv = ["env", "nemoclaw-start"] as const;
    const heldArgv = [
      "env",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ];
    const fake = fakeDocker(heldArgv);
    const runOpenshell = vi.fn();
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return "Name: alpha\nID: sandbox-alpha-replacement\n";
      }
      return "alpha Ready\n";
    });
    const adapter = createDockerManagedBootstrapAdapter({
      ...fake.deps,
      runCaptureOpenshell,
      runOpenshell,
    });
    const handle = await adapter.createHeldWorkload({
      plan: { ...plan(), intendedWorkloadArgv: intendedArgv },
      request,
      bootstrapIdentity: IDENTITY,
      launch: async () => ({
        sandbox: {
          sandboxName: "alpha",
          sandboxId: "sandbox-alpha",
          driverId: "docker",
        },
        ready: true,
        readyAt: "2026-07-29T11:59:00.000Z",
      }),
    });

    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot: null,
        replacement: null,
        completion: null,
      }),
    ).rejects.toThrow("same-name sandbox with a different durable ID");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("removes the held workload after a partial replacement catch restores the original", async () => {
    const fake = fakeDocker(heldArgv(), { failReplacementStart: true });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const failure = await captureSequenceFailure(runDefaultSequence(adapter));

    expect(failure.message).toContain("could not start the Docker replacement");
    expect(failure.managedBootstrapRollback).toMatchObject({
      heldWorkloadRemoved: true,
      restoredRuntimeId: null,
      restoredSpecHash: null,
      alreadyRolledBack: true,
    });
    expect(fake.state.events).toEqual(["sandbox-delete"]);
    expect(fake.state.sandboxId).toBeNull();
    expect(fake.state.containerIds).toEqual([]);
  });

  it("rolls back shared state before deleting a post-snapshot failed workload", async () => {
    const fake = fakeDocker(heldArgv(), {
      completionBootstrapIdentity: "9".repeat(64),
      completionTransactionPending: true,
      sharedStateStatus: "pending",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const failure = await captureSequenceFailure(runDefaultSequence(adapter));

    expect(failure.message).toContain("completion identities do not match");
    expect(failure.managedBootstrapRollback).toMatchObject({
      outcome: "rolled-back",
      heldWorkloadRemoved: true,
      restoredRuntimeId: null,
      restoredSpecHash: null,
    });
    expect(fake.state.events).toEqual(["shared-state-rollback", "sandbox-delete"]);
    expect(fake.state.sandboxId).toBeNull();
    expect(fake.state.containerIds).toEqual([]);
  });

  it("tombstones a completed rollback without deleting a future same-name durable sandbox", async () => {
    const fake = fakeDocker(heldArgv(), {
      completionTransactionPending: true,
      sharedStateStatus: "pending",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runDefaultSequence(adapter);

    const first = await adapter.finalizeBootstrap({
      outcome: "rollback",
      ...result,
    });
    fake.state.replaceSandboxIdentity("sandbox-future");
    const repeated = await adapter.finalizeBootstrap({
      outcome: "rollback",
      ...result,
    });

    expect(first).toMatchObject({
      outcome: "rolled-back",
      heldWorkloadRemoved: true,
      restoredRuntimeId: null,
      restoredSpecHash: null,
      alreadyRolledBack: false,
    });
    expect(repeated).toMatchObject({
      outcome: "rolled-back",
      heldWorkloadRemoved: true,
      restoredRuntimeId: null,
      restoredSpecHash: null,
      alreadyRolledBack: true,
    });
    expect(fake.state.events).toEqual(["shared-state-rollback", "sandbox-delete"]);
    expect(fake.state.sandboxId).toBe("sandbox-future");
    expect(
      vi
        .mocked(fake.deps.runOpenshell!)
        .mock.calls.filter(
          ([args]) => args[0] === "sandbox" && args[1] === "delete" && args[2] === "alpha",
        ),
    ).toHaveLength(1);
  });

  it("fails closed with the original stopped when a pending replacement disappears", async () => {
    const heldArgv = [
      "env",
      "A=1",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ];
    const fake = fakeDocker(heldArgv, {
      completionTransactionPending: true,
      sharedStateStatus: "pending",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runManagedBootstrapSequence(adapter, {
      create: {
        plan: plan(),
        request,
        bootstrapIdentity: IDENTITY,
        launch: async () => ({
          sandbox: {
            sandboxName: "alpha",
            sandboxId: "sandbox-alpha",
            driverId: "docker",
          },
          ready: true,
          readyAt: "2026-07-29T11:59:00.000Z",
        }),
      },
      request,
      replacementOptions: { values: {} },
      timeoutSecs: 30,
    });
    fake.state.dropReplacement();

    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        ...result,
      }),
    ).rejects.toThrow("replacement disappeared before shared-state rollback could be proven");
    expect(fake.state.originalRunning).toBe(false);
    expect(fake.state.originalName).not.toBe("openshell-alpha");
  });

  it("survives an adapter restart after durable commit, forbids rollback, and retries exact backup cleanup", async () => {
    const fake = fakeDocker(heldArgv(), {
      completionTransactionPending: true,
      failBackupRemovalAttempts: 1,
      sharedStateStatus: "pending",
    });
    const firstAdapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runDefaultSequence(firstAdapter);

    let firstFailure: unknown;
    try {
      await firstAdapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      });
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);
    expect(fake.state.sharedStateStatus).toBe("committed");
    expect(fake.state.containerIds).toEqual([OLD_ID, NEW_ID]);
    await expect(
      firstAdapter.finalizeBootstrap({
        outcome: "rollback",
        ...result,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);

    // A new adapter has no process-local transaction map or durable-commit set.
    const freshAdapter = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(
      freshAdapter.finalizeBootstrap({
        outcome: "rollback",
        ...result,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);
    await expect(
      freshAdapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).resolves.toMatchObject({
      outcome: "committed",
      bootstrapIdentity: IDENTITY,
    });

    expect(fake.state.sharedStateStatus).toBe("none");
    expect(fake.state.containerIds).toEqual([NEW_ID]);
    expect(
      vi.mocked(fake.deps.dockerRm!).mock.calls.filter(([runtimeId]) => runtimeId === OLD_ID),
    ).toHaveLength(2);
    expect(fake.state.events).toEqual(
      expect.arrayContaining([
        "shared-state-commit",
        "rollback-backup-remove",
        "shared-state-commit-clear",
      ]),
    );
    expect(fake.state.events).not.toContain("shared-state-rollback");
    expect(fake.state.events).not.toContain("sandbox-delete");

    // A second restart after both irreversible cleanup steps accepts `none`
    // only together with exact proof that the old runtime ID is absent.
    const afterCleanupRestart = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(
      afterCleanupRestart.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).resolves.toMatchObject({ outcome: "committed" });
    expect(
      vi.mocked(fake.deps.dockerRm!).mock.calls.filter(([runtimeId]) => runtimeId === OLD_ID),
    ).toHaveLength(2);
  });

  it("forbids rollback when image commit succeeds but its immutable status probe is unavailable", async () => {
    const fake = fakeDocker(heldArgv(), {
      completionTransactionPending: true,
      failCommittedProbeAttempts: 1,
      sharedStateStatus: "pending",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runDefaultSequence(adapter);

    await expect(
      adapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapCommitStateIndeterminateError);
    expect(fake.state.sharedStateStatus).toBe("committed");
    expect(fake.state.containerIds).toEqual([OLD_ID, NEW_ID]);
    expect(fake.state.events).toContain("shared-state-commit");
    expect(fake.state.events).not.toContain("shared-state-rollback");
    expect(fake.state.events).not.toContain("sandbox-delete");
    expect(
      vi.mocked(fake.deps.dockerRm!).mock.calls.some(([runtimeId]) => runtimeId === OLD_ID),
    ).toBe(false);

    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        ...result,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);
    expect(fake.state.events).not.toContain("shared-state-rollback");
    expect(fake.state.events).not.toContain("sandbox-delete");
  });

  it("retries image-owned receipt retirement after exact backup removal without resurrecting rollback", async () => {
    const fake = fakeDocker(heldArgv(), {
      completionTransactionPending: true,
      failCommitReceiptClearAttempts: 1,
      sharedStateStatus: "pending",
    });
    const firstAdapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runDefaultSequence(firstAdapter);

    await expect(
      firstAdapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);
    expect(fake.state.containerIds).toEqual([NEW_ID]);
    expect(fake.state.sharedStateStatus).toBe("committed");
    await expect(
      firstAdapter.finalizeBootstrap({
        outcome: "rollback",
        ...result,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);

    const freshAdapter = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(
      freshAdapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).resolves.toMatchObject({ outcome: "committed" });
    expect(fake.state.containerIds).toEqual([NEW_ID]);
    expect(fake.state.sharedStateStatus).toBe("none");
    expect(
      vi.mocked(fake.deps.dockerRm!).mock.calls.filter(([runtimeId]) => runtimeId === OLD_ID),
    ).toHaveLength(2);
    expect(fake.state.events.filter((event) => event === "shared-state-commit-clear")).toHaveLength(
      2,
    );
    expect(fake.state.events).not.toContain("shared-state-rollback");
    expect(fake.state.events).not.toContain("sandbox-delete");
  });

  it("does not equate a missing durable receipt with commit while the exact backup still exists", async () => {
    const fake = fakeDocker(heldArgv(), {
      completionTransactionPending: true,
      sharedStateStatus: "none",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runDefaultSequence(adapter);

    await expect(
      adapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).rejects.toThrow(
      "lost its shared-state commit receipt before exact rollback-backup removal was proven",
    );
    expect(
      vi.mocked(fake.deps.dockerRm!).mock.calls.some(([runtimeId]) => runtimeId === OLD_ID),
    ).toBe(false);
    expect(fake.state.containerIds).toEqual([OLD_ID, NEW_ID]);
  });

  it.each([
    "daemon-container",
    "error-container",
    "error-object",
  ] as const)("accepts Docker's exact %s missing-container evidence after a lost rm acknowledgement", async (missingContainerMessage) => {
    const fake = fakeDocker(heldArgv(), {
      missingContainerMessage,
      sharedStateStatus: "none",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const result = await runDefaultSequence(adapter);
    fake.state.dropOriginal();

    await expect(
      adapter.finalizeBootstrap({
        outcome: "commit",
        ...result,
      }),
    ).resolves.toMatchObject({ outcome: "committed" });
    expect(fake.state.containerIds).toEqual([NEW_ID]);
  });
});
