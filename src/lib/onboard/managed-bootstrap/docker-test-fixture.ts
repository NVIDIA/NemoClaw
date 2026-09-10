// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { expect, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { DockerContainerInspect } from "../docker-gpu-patch-types";
import { encodeManagedStartupProfile, type ManagedStartupAgent } from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  createManagedBootstrapPreparedAuthority,
  MANAGED_BOOTSTRAP_IDENTITY_ENV,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapDurablePreparationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapObservedSnapshot,
  type ManagedBootstrapPreparedReplacementHandle,
  type ManagedBootstrapReplacementHandle,
  sameManagedBootstrapCompletionReceipt,
} from "./adapter";
import type { DockerManagedBootstrapDeps } from "./docker";
import {
  type DockerManagedBootstrapFinalizationRecord,
  type DockerManagedBootstrapJournal,
  DockerManagedBootstrapJournalAcknowledgementLostError,
  type DockerManagedBootstrapJournalPhase,
  type DockerManagedBootstrapJournalStore,
  serializeDockerManagedBootstrapFinalizationRecord,
} from "./docker-journal";
import { normalizeDockerManagedBootstrapLaunchSpec } from "./docker-spec";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  serializeManagedBootstrapEnvelopeTar,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";

export const IDENTITY = "1".repeat(64);
export const OLD_ID = "2".repeat(64);
export const NEW_ID = "3".repeat(64);
const CONFIG_ID = `sha256:${"4".repeat(64)}`;
const MANIFEST = `sha256:${"5".repeat(64)}` as const;
const REPOSITORY = "registry.example/nemoclaw/hermes";
const IMAGE = `${REPOSITORY}@${MANIFEST}`;
const SUPERVISOR = ["/opt/openshell/bin/openshell-sandbox", "--workdir", "/sandbox"] as const;
export const SUPPORTED_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

type FixtureCommandResult = {
  readonly status: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

export type DockerFixtureAcknowledgement =
  | "container:create"
  | "container:remove"
  | "container:rename"
  | "container:start"
  | "container:stop"
  | "journal:create"
  | "journal:cutover"
  | "journal:completion"
  | "journal:owner-cleanup-required"
  | "journal:remove"
  | "journal:rollback-authorized"
  | "journal:staged"
  | "journal:shared-state-committed";

export type DockerFixtureOptions = {
  readonly agent?: ManagedStartupAgent;
  readonly dockerCliSerializationDefaults?: boolean;
  readonly dockerRemoveFailures?: readonly Error[];
  readonly dockerRemoveResults?: readonly FixtureCommandResult[];
  readonly dockerInspectUnknownIds?: readonly string[];
  readonly dockerStartResults?: Readonly<Record<string, FixtureCommandResult>>;
  readonly journalCreateFailures?: readonly Error[];
  readonly journalRemoveFailures?: readonly Error[];
  readonly journalTransitionFailures?: Partial<
    Readonly<Record<DockerManagedBootstrapJournalPhase, Error>>
  >;
  readonly lostAcknowledgements?: readonly DockerFixtureAcknowledgement[];
  readonly ownerId?: string;
  readonly replacementEnvironment?: (environment: readonly string[]) => readonly string[];
  readonly sharedState?: "committed" | "none" | "pending";
  readonly sharedStateCommitResult?: FixtureCommandResult;
  readonly sharedStateRollbackResult?: FixtureCommandResult;
  readonly sharedReceiptClearFailures?: readonly Error[];
};

function agentInputs(agent: ManagedStartupAgent = "hermes") {
  const request = createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, false)),
  });
  const heldArgv = [
    "env",
    "A=1",
    "/usr/local/bin/nemoclaw-managed-startup-hold",
    "--agent",
    agent,
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    IDENTITY,
    "--",
  ] as const;
  return {
    request,
    heldArgv,
    metadata: { "nemoclaw.ai/managed-profile": request.profileFingerprint },
  };
}

export const { heldArgv } = agentInputs();
export const sandbox = {
  sandboxName: "alpha",
  sandboxId: "sandbox-alpha",
  driverId: "docker",
};

function originalInspect(inputs = agentInputs()): DockerContainerInspect {
  return {
    Id: OLD_ID,
    Image: CONFIG_ID,
    Name: "/openshell-alpha",
    Config: {
      Image: IMAGE,
      Env: [
        "A=1",
        `${MANAGED_BOOTSTRAP_IDENTITY_ENV}=${IDENTITY}`,
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
        "OPENSHELL_OCI_IMAGE_USER=root",
        "OPENSHELL_SANDBOX_UID=",
        "OPENSHELL_SANDBOX_GID=",
      ],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-alpha",
        ...inputs.metadata,
      },
      Entrypoint: [SUPERVISOR[0]],
      Cmd: SUPERVISOR.slice(1),
      User: "0",
      WorkingDir: "/",
      Hostname: "alpha",
    },
    State: { Running: true, Paused: false, Restarting: false, Dead: false },
    HostConfig: {
      Binds: ["/host/workspace:/sandbox:rw"],
      NetworkMode: "openshell",
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["NET_RAW"],
      SecurityOpt: ["no-new-privileges"],
      Ulimits: [{ Name: "nofile", Soft: 65_536, Hard: 65_536 }],
    },
    NetworkSettings: { Networks: { openshell: { Aliases: ["openshell-alpha"] } } },
  };
}

export function authority(agent: ManagedStartupAgent = "hermes") {
  const inputs = agentInputs(agent);
  const inspect = originalInspect(inputs);
  const normalized = normalizeDockerManagedBootstrapLaunchSpec(inspect);
  const plan = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: "alpha",
    driverId: "docker",
    image: { repository: REPOSITORY, manifestDigest: MANIFEST },
    profile: { agent, fingerprint: inputs.request.profileFingerprint },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    managedStateRoots: [],
    intendedWorkloadArgv: ["env", "A=1", "/usr/local/bin/nemoclaw-start"],
    expectedSupervisorArgv: SUPERVISOR,
    metadata: inputs.metadata,
  };
  const handle: ManagedBootstrapHeldWorkloadHandle = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    bootstrapIdentity: IDENTITY,
    heldWorkloadArgv: inputs.heldArgv,
    intendedWorkloadArgv: plan.intendedWorkloadArgv,
    plan,
    createReceipt: { sandbox, ready: true, readyAt: "2026-07-31T12:00:00.000Z" },
  };
  const snapshot: ManagedBootstrapObservedSnapshot = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    runtimeId: OLD_ID,
    bootstrapIdentity: IDENTITY,
    image: plan.image,
    runtimeImageContentId: CONFIG_ID,
    specHash: normalized.hash,
    specCanonicalJson: normalized.canonicalJson,
    agentIdentity: plan.agentIdentity,
    supervisorArgv: SUPERVISOR,
    heldWorkloadArgv: inputs.heldArgv,
    metadata: inputs.metadata,
  };
  return { handle, plan, request: inputs.request, snapshot };
}

function failFixture(message: string): never {
  throw new Error(message);
}

export function parseFixtureDockerUlimits(
  args: readonly string[],
  imageIndex: number,
): NonNullable<DockerContainerInspect["HostConfig"]>["Ulimits"] {
  return args.slice(0, imageIndex).flatMap((value, index) => {
    const match =
      value === "--ulimit"
        ? /^([a-z][a-z0-9_]*)=(-?\d+):(-?\d+)$/u.exec(String(args[index + 1] ?? ""))
        : null;
    return match ? [{ Name: match[1], Soft: Number(match[2]), Hard: Number(match[3]) }] : [];
  });
}

export function fixture(options: DockerFixtureOptions = {}) {
  let original: DockerContainerInspect | null = originalInspect(agentInputs(options.agent));
  if (options.dockerCliSerializationDefaults) {
    Object.assign(original.Config!, {
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
    });
    Object.assign(original.HostConfig!, { PortBindings: null });
  }
  let replacement: DockerContainerInspect | null = null;
  let journal: DockerManagedBootstrapJournal | null = null;
  let finalization: DockerManagedBootstrapFinalizationRecord | null = null;
  let sharedState: "committed" | "none" | "pending" = options.sharedState ?? "none";
  const events: string[] = [];
  const dockerRemoveFailures = [...(options.dockerRemoveFailures ?? [])];
  const dockerRemoveResults = [...(options.dockerRemoveResults ?? [])];
  const journalCreateFailures = [...(options.journalCreateFailures ?? [])];
  const journalRemoveFailures = [...(options.journalRemoveFailures ?? [])];
  const sharedReceiptClearFailures = [...(options.sharedReceiptClearFailures ?? [])];
  const dockerInspectUnknownIds = new Set(options.dockerInspectUnknownIds ?? []);
  const lostAcknowledgements = new Set(options.lostAcknowledgements ?? []);
  const losesAcknowledgement = (operation: DockerFixtureAcknowledgement) =>
    lostAcknowledgements.has(operation);
  const ok = (stdout = ""): FixtureCommandResult => ({ status: 0, stdout, stderr: "" });
  const copyJournal = () => (journal ? structuredClone(journal) : null);
  const store: DockerManagedBootstrapJournalStore = {
    create(value) {
      void (journal === null ? journal : failFixture("managed bootstrap journal already exists"));
      journal = structuredClone(value);
      events.push("journal:staged");
      const injectedFailure = journalCreateFailures.shift();
      switch (injectedFailure) {
        case undefined:
          break;
        default:
          throw injectedFailure;
      }
      if (losesAcknowledgement("journal:create")) {
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal create acknowledgement",
        );
      }
    },
    load: () => copyJournal(),
    listUnfinishedIdentities: () => (journal ? [journal.bootstrapIdentity] : []),
    transition(_identity, expected, next) {
      const current =
        journal !== null && journal.phase === expected
          ? journal
          : failFixture("stale journal transition");
      journal = { ...current, phase: next };
      events.push(`journal:${next}`);
      const injectedFailure = options.journalTransitionFailures?.[next];
      if (injectedFailure) throw injectedFailure;
      if (losesAcknowledgement(`journal:${next}`)) {
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal transition acknowledgement",
        );
      }
      return structuredClone(journal);
    },
    recordCompletion(_identity, receipt) {
      if (!journal || journal.phase !== "cutover") {
        throw new Error("completion requires cutover journal");
      }
      if (
        journal.commitReceipt !== null &&
        !sameManagedBootstrapCompletionReceipt(journal.commitReceipt, receipt)
      ) {
        throw new Error("completion changed");
      }
      journal = { ...journal, commitReceipt: structuredClone(receipt) };
      events.push("journal:completion");
      if (losesAcknowledgement("journal:completion")) {
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal completion acknowledgement",
        );
      }
      return structuredClone(journal);
    },
    remove(_identity, expected) {
      const current = journal;
      void (current !== null && expected.includes(current.phase)
        ? current
        : failFixture("stale journal remove"));
      const injectedFailure = journalRemoveFailures.shift();
      switch (injectedFailure) {
        case undefined:
          break;
        default:
          throw injectedFailure;
      }
      journal = null;
      events.push("journal:removed");
      if (losesAcknowledgement("journal:remove")) {
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal remove acknowledgement",
        );
      }
    },
    recordFinalization(value) {
      if (
        finalization &&
        serializeDockerManagedBootstrapFinalizationRecord(finalization) !==
          serializeDockerManagedBootstrapFinalizationRecord(value)
      ) {
        throw new Error("finalization changed");
      }
      finalization = structuredClone(value);
      events.push(`finalization:${value.phase}`);
    },
    loadFinalization: () => (finalization ? structuredClone(finalization) : null),
  };
  const inspect = (reference: string): DockerContainerInspect => {
    const candidates = [original, replacement].filter(
      (value): value is DockerContainerInspect => value !== null,
    );
    const found = candidates.find(
      (value) =>
        value.Id === reference || String(value.Name ?? "").replace(/^\/+/u, "") === reference,
    );
    return found ? structuredClone(found) : failFixture(`No such container: ${reference}`);
  };
  const dockerCapture: NonNullable<DockerManagedBootstrapDeps["dockerCapture"]> = vi.fn((args) => {
    switch (args[0]) {
      case "image":
        return JSON.stringify([{ Id: CONFIG_ID, RepoDigests: [IMAGE] }]);
      default:
        return JSON.stringify([inspect(String(args[3] ?? ""))]);
    }
  });
  const dockerRun: NonNullable<DockerManagedBootstrapDeps["dockerRun"]> = vi.fn(
    (args: readonly string[], commandOptions?: Record<string, unknown>) => {
      switch (args[0]) {
        case "create": {
          const name = String(args[args.indexOf("--name") + 1] ?? "");
          if (name.startsWith("nemoclaw-managed-startup-receipt-seed-")) return ok();
          events.push("create:replacement");
          const source =
            original ?? failFixture("original disappeared before replacement creation");
          const entrypoint = String(args[args.indexOf("--entrypoint") + 1] ?? "");
          const imageIndex = args.indexOf(IMAGE);
          const dockerOptions = args.slice(0, imageIndex);
          const env = dockerOptions.flatMap((value, index) =>
            value === "--env" ? [String(args[index + 1] ?? "")] : [],
          );
          const ulimits = parseFixtureDockerUlimits(args, imageIndex);
          replacement = {
            ...structuredClone(source),
            Id: NEW_ID,
            Name: `/${name}`,
            Config: {
              ...structuredClone(source.Config),
              Image: IMAGE,
              Env: [...(options.replacementEnvironment?.(env) ?? env)],
              Entrypoint: [entrypoint],
              Cmd: args.slice(imageIndex + 1),
            },
            HostConfig: {
              ...structuredClone(source.HostConfig),
              Ulimits: ulimits,
            },
            State: { Running: false, Paused: false, Restarting: false, Dead: false },
          };
          if (options.dockerCliSerializationDefaults) {
            Object.assign(replacement.Config!, {
              AttachStdin: args.includes("stdin"),
              AttachStdout: true,
              AttachStderr: true,
            });
            Object.assign(replacement.HostConfig!, { PortBindings: {} });
          }
          return losesAcknowledgement("container:create")
            ? { status: 1, stdout: "", stderr: "lost create acknowledgement" }
            : ok(NEW_ID);
        }
        case "ps":
          return ok(original ? OLD_ID : "");
        case "volume":
          return ok();
        case "rm":
          return ok();
        case "inspect": {
          const id = String(args[3] ?? "");
          if (dockerInspectUnknownIds.has(id)) {
            return { status: 1, stderr: `injected unknown inspect state for ${id}` };
          }
          try {
            inspect(id);
            return ok(`[{"Id":"${id}"}]`);
          } catch {
            return { status: 1, stderr: `Error response from daemon: No such container: ${id}` };
          }
        }
        case "cp": {
          const sourceIndex = args[1] === "-a" ? 2 : 1;
          const source = String(args[sourceIndex] ?? "");
          const destination = String(args[sourceIndex + 1] ?? "");
          const copyIntoContainer = () => {
            if (args[1] === "-a" && destination.includes("nemoclaw-managed-startup-receipt-seed")) {
              return ok();
            }
            events.push("stage:envelope");
            expect(args).toEqual(["cp", "-", `${NEW_ID}:/`]);
            expect(commandOptions?.stdio).toEqual(["pipe", "pipe", "pipe"]);
            expect(commandOptions?.input).toEqual(
              serializeManagedBootstrapEnvelopeTar({
                bootstrapIdentity: IDENTITY,
                rootApplyRequest: agentInputs(options.agent).request,
              }),
            );
            return ok();
          };
          const copyFromContainer = () => {
            if (source === `${NEW_ID}:${MANAGED_BOOTSTRAP_COMPLETION_FILE}`) {
              fs.writeFileSync(
                destination,
                serializeManagedBootstrapImageCompletion({
                  bootstrapIdentity: IDENTITY,
                  agent: options.agent ?? "hermes",
                  profileFingerprint: agentInputs(options.agent).request.profileFingerprint,
                  transactionPending: sharedState === "pending",
                }),
                { mode: 0o444 },
              );
              fs.chmodSync(destination, 0o444);
              return ok();
            }
            const receipt = source.split(":")[1];
            const expected = receipt?.includes("shared-state-commit") ? "committed" : "pending";
            return sharedState === expected
              ? (() => {
                  fs.mkdirSync(destination, { recursive: true });
                  return ok();
                })()
              : {
                  status: 1,
                  stderr: `Error response from daemon: Could not find the file ${receipt} in container ${NEW_ID}`,
                };
          };
          return source.includes(":") ? copyFromContainer() : copyIntoContainer();
        }
        case "run":
          switch (true) {
            case args.includes("--shared-state-transaction-status"):
              return ok(`${sharedState}\n`);
            case args.includes("--rollback-shared-state-transaction"): {
              const result = options.sharedStateRollbackResult ?? ok();
              if (result.status === 0) sharedState = "none";
              events.push("shared:rollback");
              return result;
            }
          }
          break;
        case "exec":
          switch (true) {
            case args.includes("--commit-shared-state-transaction"): {
              const result = options.sharedStateCommitResult ?? ok();
              sharedState = result.status === 0 ? "committed" : sharedState;
              events.push("shared:commit");
              return result;
            }
            case args.includes("--clear-shared-state-commit-receipt"):
              {
                const injectedFailure = sharedReceiptClearFailures.shift();
                if (injectedFailure) throw injectedFailure;
              }
              sharedState = "none";
              events.push("shared:clear");
              return ok();
          }
          break;
      }
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    },
  );
  const deps: DockerManagedBootstrapDeps = {
    journalStore: store,
    dockerCapture,
    dockerRun,
    dockerLogs: vi.fn(() => ""),
    dockerStop: vi.fn((id) => {
      events.push(`stop:${id}`);
      const target = id === OLD_ID ? original : replacement;
      [target]
        .filter((value): value is DockerContainerInspect => value?.State !== undefined)
        .forEach((value) => {
          value.State = { ...value.State, Running: false, Restarting: false };
        });
      return losesAcknowledgement("container:stop")
        ? { status: 1, stderr: "lost stop acknowledgement" }
        : ok();
    }),
    dockerRename: vi.fn((id, name) => {
      events.push(`rename:${id}:${name}`);
      const target = id === OLD_ID ? original : replacement;
      [target]
        .filter((value): value is DockerContainerInspect => value !== null)
        .forEach((value) => {
          value.Name = `/${name}`;
        });
      return losesAcknowledgement("container:rename")
        ? { status: 1, stderr: "lost rename acknowledgement" }
        : ok();
    }),
    dockerStart: vi.fn((id) => {
      events.push(`start:${id}`);
      const result = options.dockerStartResults?.[id] ?? ok();
      const target = id === OLD_ID ? original : replacement;
      [target]
        .filter(
          (value): value is DockerContainerInspect =>
            value?.State !== undefined && result.status === 0,
        )
        .forEach((value) => {
          value.State = { ...value.State, Running: true };
        });
      return losesAcknowledgement("container:start")
        ? { status: 1, stderr: "lost start acknowledgement" }
        : result;
    }),
    dockerRm: vi.fn((id) => {
      events.push(`rm:${id}`);
      const injectedFailure = dockerRemoveFailures.shift();
      switch (injectedFailure) {
        case undefined:
          break;
        default:
          throw injectedFailure;
      }
      const result = dockerRemoveResults.shift() ?? ok();
      switch (result.status) {
        case 0:
          switch (id) {
            case OLD_ID:
              original = null;
              break;
            case NEW_ID:
              replacement = null;
              break;
          }
      }
      return losesAcknowledgement("container:remove")
        ? { status: 1, stderr: "lost rm acknowledgement" }
        : result;
    }),
    runCaptureOpenshell: vi.fn(() => `Name: alpha\nID: ${options.ownerId ?? "sandbox-alpha"}\n`),
    runOpenshell: vi.fn(() => ok()),
    now: () => new Date("2026-07-31T12:30:00.000Z"),
  };
  return {
    deps,
    events,
    get journal() {
      return journal;
    },
    get finalization() {
      return finalization;
    },
    get original() {
      return original;
    },
    get replacement() {
      return replacement;
    },
    get sharedState() {
      return sharedState;
    },
    removeOriginalExternally() {
      original = null as unknown as DockerContainerInspect;
      events.push(`external-rm:${OLD_ID}`);
    },
    setDockerInspectUnknown(runtimeId: string, indeterminate: boolean) {
      if (indeterminate) dockerInspectUnknownIds.add(runtimeId);
      else dockerInspectUnknownIds.delete(runtimeId);
    },
  };
}

export function completion(
  replacement: ManagedBootstrapReplacementHandle,
): ManagedBootstrapCompletionReceipt {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    runtimeId: replacement.replacementRuntimeId,
    image: replacement.image,
    runtimeImageContentId: replacement.runtimeImageContentId,
    originalSpecHash: replacement.originalSpecHash,
    replacementSpecHash: replacement.replacementSpecHash,
    profileFingerprint: replacement.profileFingerprint,
    bootstrapIdentity: replacement.bootstrapIdentity,
    transactionPending: true,
    completedAt: "2026-07-31T12:15:00.000Z",
  };
}

export function durablePreparation(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  prepared: ManagedBootstrapPreparedReplacementHandle,
): ManagedBootstrapDurablePreparationReceipt {
  const preparedAuthority = createManagedBootstrapPreparedAuthority({
    handle,
    snapshot,
    prepared,
  });
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    bootstrapIdentity: handle.bootstrapIdentity,
    authorityFingerprint: preparedAuthority.authorityFingerprint,
    recordId: `test-authority-${handle.plan.profile.agent}`,
    recordedAt: "2026-07-31T12:10:00.000Z",
  };
}
