// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { DockerContainerInspect } from "../docker-gpu-patch-types";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { MANAGED_BOOTSTRAP_SCHEMA_VERSION, runManagedBootstrapSequence } from "./adapter";
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
    readonly completionTransactionPending?: boolean;
    readonly extraEnvironment?: readonly string[];
    readonly sharedStateStatus?: "none" | "pending";
  } = {},
) {
  const original = originalInspect(heldArgv);
  original.Config = {
    ...original.Config,
    Env: [...(original.Config?.Env ?? []), ...(options.extraEnvironment ?? [])],
  };
  let originalName = "openshell-alpha";
  let originalRunning = true;
  let replacement: DockerContainerInspect | null = null;
  let copiedEnvelope: ReturnType<typeof parseManagedBootstrapEnvelope> | null = null;
  let copiedMode: number | null = null;
  let copyDestination = "";
  const createArgs: string[][] = [];

  const dockerCapture: NonNullable<DockerManagedBootstrapDeps["dockerCapture"]> = vi.fn((args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([{ Id: CONFIG_ID, RepoDigests: [IMAGE_REFERENCE] }]);
    }
    if (args[0] !== "inspect") throw new Error(`unexpected capture ${args.join(" ")}`);
    const id = String(args[3] ?? "");
    if (id === OLD_ID) {
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
    if (args[0] === "ps") return ok(OLD_ID);
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
            bootstrapIdentity: IDENTITY,
            profileFingerprint: request.profileFingerprint,
            transactionPending: options.completionTransactionPending ?? false,
          }),
          { mode: 0o444 },
        );
        fs.chmodSync(destination, 0o444);
        return ok();
      }
      if (source === `${NEW_ID}:/var/lib/nemoclaw/managed-startup-shared-state-transaction-v1`) {
        if (options.sharedStateStatus === "pending") return ok();
        return {
          status: 1,
          stderr: `Error response from daemon: Could not find the file /var/lib/nemoclaw/managed-startup-shared-state-transaction-v1 in container ${NEW_ID}`,
        };
      }
      copyDestination = String(args[destinationIndex] ?? "");
      copiedMode = fs.statSync(source).mode & 0o777;
      copiedEnvelope = parseManagedBootstrapEnvelope(fs.readFileSync(source, "utf8"));
      return ok();
    }
    if (args[0] === "run" && args.includes("--shared-state-transaction-status")) {
      return ok(`${options.sharedStateStatus ?? "none"}\n`);
    }
    throw new Error(`unexpected docker run ${args.join(" ")}`);
  });

  const deps: DockerManagedBootstrapDeps = {
    createBootstrapIdentity: () => IDENTITY,
    dockerCapture,
    dockerRun,
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
        replacement.State = { ...replacement.State, Running: true };
      }
      return ok();
    }),
    dockerRm: vi.fn((id) => {
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
});
