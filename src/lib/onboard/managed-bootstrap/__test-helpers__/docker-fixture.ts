// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { vi } from "vitest";

import type { DockerContainerInspect } from "../../docker-gpu-patch-types";
import type { DockerManagedBootstrapDeps } from "../docker";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  parseManagedBootstrapEnvelope,
  serializeManagedBootstrapImageCompletion,
} from "../envelope";

export type DockerManagedBootstrapFixtureConfig = {
  readonly identity: string;
  readonly oldId: string;
  readonly newId: string;
  readonly configId: string;
  readonly imageReference: string;
  readonly profileFingerprint: string;
  readonly supervisorArgv: readonly string[];
};

export type FakeDockerOptions = {
  readonly completionBootstrapIdentity?: string;
  readonly completionTransactionPending?: boolean;
  readonly extraEnvironment?: readonly string[];
  readonly failBackupRemovalAttempts?: number;
  readonly failCommitReceiptClearAttempts?: number;
  readonly failCommittedProbeAttempts?: number;
  readonly failOwnerRetentionList?: "nonzero" | "throw";
  readonly failOwnerRetentionStop?: boolean;
  readonly failOriginalAbsenceProbeAttempts?: number;
  readonly failReplacementStart?: boolean;
  readonly omitRetainedState?: boolean;
  readonly ownerRetentionRuntimeIds?: readonly string[];
  readonly sharedCommitWithoutDurableState?: boolean;
  readonly missingContainerMessage?: "daemon-container" | "error-container" | "error-object";
  readonly sharedStateStatus?: "committed" | "none" | "pending";
};

function commandEnv(argv: readonly string[]): string {
  return argv
    .map((value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value}'`))
    .join(" ");
}

function originalInspect(
  config: DockerManagedBootstrapFixtureConfig,
  heldArgv: readonly string[],
): DockerContainerInspect {
  return {
    Id: config.oldId,
    Image: config.configId,
    Name: "/openshell-alpha",
    Config: {
      Image: config.imageReference,
      Env: ["A=1", `OPENSHELL_SANDBOX_COMMAND=${commandEnv(heldArgv)}`],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-alpha",
        "nemoclaw.ai/managed-profile": config.profileFingerprint,
      },
      Entrypoint: [config.supervisorArgv[0]],
      Cmd: config.supervisorArgv.slice(1),
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

export function createFakeDockerFixture(
  config: DockerManagedBootstrapFixtureConfig,
  heldArgv: readonly string[],
  options: FakeDockerOptions = {},
) {
  const original = originalInspect(config, heldArgv);
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
  let originalAbsenceProbeFailuresRemaining = options.failOriginalAbsenceProbeAttempts ?? 0;
  let copiedEnvelope: ReturnType<typeof parseManagedBootstrapEnvelope> | null = null;
  let copiedMode: number | null = null;
  let copyDestination = "";
  let psCalls = 0;
  const createArgs: string[][] = [];
  const events: string[] = [];

  const dockerCapture: NonNullable<DockerManagedBootstrapDeps["dockerCapture"]> = vi.fn((args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([{ Id: config.configId, RepoDigests: [config.imageReference] }]);
    }
    if (args[0] !== "inspect") throw new Error(`unexpected capture ${args.join(" ")}`);
    const id = String(args[3] ?? "");
    if (id === config.oldId && originalPresent) {
      const state =
        !originalRunning && options.omitRetainedState
          ? undefined
          : { ...original.State, Running: originalRunning };
      return JSON.stringify([
        {
          ...original,
          Name: `/${originalName}`,
          State: state,
        },
      ]);
    }
    if (id === config.newId && replacement) return JSON.stringify([replacement]);
    throw new Error("No such container");
  });

  const dockerRun: NonNullable<DockerManagedBootstrapDeps["dockerRun"]> = vi.fn((args) => {
    if (args[0] === "ps") {
      psCalls += 1;
      if (psCalls > 1 && options.failOwnerRetentionList === "throw") {
        throw new Error("injected exact owner enumeration exception");
      }
      if (psCalls > 1 && options.failOwnerRetentionList === "nonzero") {
        return { status: 1, stderr: "injected exact owner enumeration failure" };
      }
      if (psCalls > 1 && options.ownerRetentionRuntimeIds) {
        return ok(options.ownerRetentionRuntimeIds.join("\n"));
      }
      return ok(
        [originalPresent ? config.oldId : null, replacement ? config.newId : null]
          .filter((id): id is string => id !== null)
          .join("\n"),
      );
    }
    if (args[0] === "create") {
      createArgs.push([...args]);
      const nameIndex = args.indexOf("--name");
      const entrypointIndex = args.indexOf("--entrypoint");
      const imageIndex = args.indexOf(config.imageReference);
      const envValues: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--env") envValues.push(String(args[index + 1] ?? ""));
      }
      replacement = {
        ...structuredClone(original),
        Id: config.newId,
        Name: `/${String(args[nameIndex + 1] ?? "")}`,
        Config: {
          ...structuredClone(original.Config),
          Image: config.imageReference,
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
      return ok(config.newId);
    }
    if (args[0] === "cp") {
      const sourceIndex = args[1] === "-a" ? 2 : 1;
      const destinationIndex = sourceIndex + 1;
      const source = String(args[sourceIndex] ?? "");
      if (source === `${config.newId}:${MANAGED_BOOTSTRAP_COMPLETION_FILE}`) {
        const destination = String(args[destinationIndex] ?? "");
        fs.writeFileSync(
          destination,
          serializeManagedBootstrapImageCompletion({
            agent: "hermes",
            bootstrapIdentity: options.completionBootstrapIdentity ?? config.identity,
            profileFingerprint: config.profileFingerprint,
            transactionPending: options.completionTransactionPending ?? false,
          }),
          { mode: 0o444 },
        );
        fs.chmodSync(destination, 0o444);
        return ok();
      }
      if (
        source === `${config.newId}:/var/lib/nemoclaw/managed-startup-shared-state-transaction-v1`
      ) {
        if (sharedStateStatus === "pending") {
          fs.mkdirSync(String(args[destinationIndex] ?? ""), { recursive: true });
          return ok();
        }
        return {
          status: 1,
          stderr: `Error response from daemon: Could not find the file /var/lib/nemoclaw/managed-startup-shared-state-transaction-v1 in container ${config.newId}`,
        };
      }
      if (source === `${config.newId}:/var/lib/nemoclaw/managed-startup-shared-state-commit-v1`) {
        if (sharedStateStatus === "committed") {
          fs.mkdirSync(String(args[destinationIndex] ?? ""), { recursive: true });
          return ok();
        }
        return {
          status: 1,
          stderr: `Error response from daemon: Could not find the file /var/lib/nemoclaw/managed-startup-shared-state-commit-v1 in container ${config.newId}`,
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
      if (options.sharedCommitWithoutDurableState) {
        return { status: 1, stderr: "injected non-durable shared-state commit failure" };
      }
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
    if (args[0] === "inspect" && args[1] === "--type" && args[3] === config.oldId) {
      if (originalAbsenceProbeFailuresRemaining > 0) {
        originalAbsenceProbeFailuresRemaining -= 1;
        return { status: 1, stderr: "injected exact original inspection failure" };
      }
      if (originalPresent) return ok(`[{"Id":"${config.oldId}"}]`);
      const missing =
        options.missingContainerMessage === "error-container"
          ? `Error: No such container: ${config.oldId}`
          : options.missingContainerMessage === "daemon-container"
            ? `Error response from daemon: No such container: ${config.oldId}`
            : `Error: No such object: ${config.oldId}`;
      return { status: 1, stderr: missing };
    }
    if (args[0] === "inspect" && args[1] === "--type" && args[3] === config.newId) {
      if (replacement) return ok(`[{"Id":"${config.newId}"}]`);
      return {
        status: 1,
        stderr: `Error response from daemon: No such container: ${config.newId}`,
      };
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
    createBootstrapIdentity: () => config.identity,
    dockerCapture,
    dockerRun,
    runCaptureOpenshell,
    runOpenshell,
    dockerStop: vi.fn((id) => {
      if (id === config.oldId && options.failOwnerRetentionStop) {
        return { status: 1, stderr: "injected exact owner stop failure" };
      }
      if (id === config.oldId) originalRunning = false;
      if (id === config.newId && replacement) {
        replacement.State = { ...replacement.State, Running: false };
      }
      return ok();
    }),
    dockerRename: vi.fn((id, name) => {
      if (id === config.oldId) originalName = name;
      return ok();
    }),
    dockerStart: vi.fn((id) => {
      if (id === config.oldId) originalRunning = true;
      if (id === config.newId && replacement) {
        if (options.failReplacementStart) {
          return { status: 1, stderr: "injected replacement start failure" };
        }
        replacement.State = { ...replacement.State, Running: true };
      }
      return ok();
    }),
    dockerRm: vi.fn((id) => {
      if (id === config.oldId) {
        events.push("rollback-backup-remove");
        if (backupRemovalFailuresRemaining > 0) {
          backupRemovalFailuresRemaining -= 1;
          return { status: 1, stderr: "injected exact backup removal failure" };
        }
        if (!originalPresent) {
          return {
            status: 1,
            stderr: `Error response from daemon: No such container: ${config.oldId}`,
          };
        }
        originalPresent = false;
      }
      if (id === config.newId) replacement = null;
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
      mutateOriginalEnvironment(entry: string) {
        original.Config = {
          ...original.Config,
          Env: [...(original.Config?.Env ?? []), entry],
        };
      },
      get replacementEnvironment() {
        return replacement?.Config?.Env ?? null;
      },
      get sandboxId() {
        return sandboxId;
      },
      get containerIds() {
        return [originalPresent ? config.oldId : null, replacement ? config.newId : null].filter(
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

export function createOpenShellSandboxLookup(
  getResult: string,
  listResult: string,
  onGet: () => void = () => undefined,
) {
  return vi.fn((args: string[]) => {
    if (args[0] === "sandbox" && args[1] === "get") {
      onGet();
      return getResult;
    }
    return listResult;
  });
}
