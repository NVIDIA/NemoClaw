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
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapObservedSnapshot,
  ManagedBootstrapOwnerCleanupRequiredError,
} from "./adapter";
import { createDockerManagedBootstrapAdapter, type DockerManagedBootstrapDeps } from "./docker";
import type {
  DockerManagedBootstrapJournal,
  DockerManagedBootstrapJournalStore,
} from "./docker-journal";
import { DockerManagedBootstrapJournalAcknowledgementLostError } from "./docker-journal";
import { normalizeDockerManagedBootstrapLaunchSpec } from "./docker-spec";
import { parseManagedBootstrapEnvelope } from "./envelope";

const IDENTITY = "1".repeat(64);
const OLD_ID = "2".repeat(64);
const NEW_ID = "3".repeat(64);
const CONFIG_ID = `sha256:${"4".repeat(64)}`;
const MANIFEST = `sha256:${"5".repeat(64)}` as const;
const REPOSITORY = "registry.example/nemoclaw/hermes";
const IMAGE = `${REPOSITORY}@${MANIFEST}`;
const SUPERVISOR = ["/opt/openshell/bin/openshell-sandbox", "supervise"] as const;
const request = createManagedStartupRootApplyRequest({
  agent: "hermes",
  encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("hermes", false, false)),
});
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
] as const;
const metadata = { "nemoclaw.ai/managed-profile": request.profileFingerprint };
const sandbox = { sandboxName: "alpha", sandboxId: "sandbox-alpha", driverId: "docker" };

function shellArgv(argv: readonly string[]): string {
  return argv.join(" ");
}

function originalInspect(): DockerContainerInspect {
  return {
    Id: OLD_ID,
    Image: CONFIG_ID,
    Name: "/openshell-alpha",
    Config: {
      Image: IMAGE,
      Env: ["A=1", `OPENSHELL_SANDBOX_COMMAND=${shellArgv(heldArgv)}`],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-alpha",
        ...metadata,
      },
      Entrypoint: [SUPERVISOR[0]],
      Cmd: SUPERVISOR.slice(1),
      User: "root",
      WorkingDir: "/sandbox",
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

function authority() {
  const inspect = originalInspect();
  const normalized = normalizeDockerManagedBootstrapLaunchSpec(inspect);
  const plan = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: "alpha",
    driverId: "docker",
    image: { repository: REPOSITORY, manifestDigest: MANIFEST },
    profile: { agent: "hermes" as const, fingerprint: request.profileFingerprint },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    intendedWorkloadArgv: ["env", "A=1", "nemoclaw-start"],
    expectedSupervisorArgv: SUPERVISOR,
    metadata,
  };
  const handle: ManagedBootstrapHeldWorkloadHandle = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    bootstrapIdentity: IDENTITY,
    heldWorkloadArgv: heldArgv,
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
    heldWorkloadArgv: heldArgv,
    metadata,
  };
  return { handle, plan, snapshot };
}

type FixtureOptions = {
  failAfterCutoverFence?: boolean;
  failStart?: boolean;
  lostAcks?: boolean;
  ownerId?: string;
  sharedState?: "committed" | "none" | "pending";
};

function fixture(options: FixtureOptions = {}) {
  let original = originalInspect();
  let replacement: DockerContainerInspect | null = null;
  let journal: DockerManagedBootstrapJournal | null = null;
  let sharedState: "committed" | "none" | "pending" = options.sharedState ?? "none";
  const events: string[] = [];
  const lostTransitions = new Set(["cutover", "shared-state-committed"]);
  let loseCreateAck = options.lostAcks === true;
  let loseRemoveAck = options.lostAcks === true;
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const copyJournal = () => (journal ? structuredClone(journal) : null);
  const store: DockerManagedBootstrapJournalStore = {
    create(value) {
      journal = structuredClone(value);
      events.push("journal:staged");
      if (loseCreateAck) {
        loseCreateAck = false;
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal create acknowledgement",
        );
      }
    },
    load: () => copyJournal(),
    transition(_identity, expected, next) {
      if (!journal || journal.phase !== expected) throw new Error("stale journal transition");
      journal = { ...journal, phase: next };
      events.push(`journal:${next}`);
      if (next === "cutover" && options.failAfterCutoverFence) {
        throw new Error("injected crash after durable cutover fence");
      }
      if (options.lostAcks && lostTransitions.delete(next)) {
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal transition acknowledgement",
        );
      }
      return structuredClone(journal);
    },
    remove(_identity, expected) {
      if (!journal || !expected.includes(journal.phase)) throw new Error("stale journal remove");
      journal = null;
      events.push("journal:removed");
      if (loseRemoveAck) {
        loseRemoveAck = false;
        throw new DockerManagedBootstrapJournalAcknowledgementLostError(
          "lost journal remove acknowledgement",
        );
      }
    },
  };
  const inspect = (reference: string): DockerContainerInspect => {
    const candidates = [original, replacement].filter(
      (value): value is DockerContainerInspect => value !== null,
    );
    const found = candidates.find(
      (value) =>
        value.Id === reference || String(value.Name ?? "").replace(/^\/+/u, "") === reference,
    );
    if (!found) throw new Error(`No such container: ${reference}`);
    return structuredClone(found);
  };
  const dockerCapture: NonNullable<DockerManagedBootstrapDeps["dockerCapture"]> = vi.fn((args) => {
    if (args[0] === "image") {
      return JSON.stringify([{ Id: CONFIG_ID, RepoDigests: [IMAGE] }]);
    }
    return JSON.stringify([inspect(String(args[3] ?? ""))]);
  });
  const dockerRun: NonNullable<DockerManagedBootstrapDeps["dockerRun"]> = vi.fn(
    (args: readonly string[]) => {
      if (args[0] === "create") {
        events.push("create:replacement");
        const name = String(args[args.indexOf("--name") + 1] ?? "");
        const entrypoint = String(args[args.indexOf("--entrypoint") + 1] ?? "");
        const imageIndex = args.indexOf(IMAGE);
        const env: string[] = [];
        args.forEach((value, index) => {
          if (value === "--env") env.push(String(args[index + 1] ?? ""));
        });
        replacement = {
          ...structuredClone(original),
          Id: NEW_ID,
          Name: `/${name}`,
          Config: {
            ...structuredClone(original.Config),
            Image: IMAGE,
            Env: env,
            Entrypoint: [entrypoint],
            Cmd: args.slice(imageIndex + 1),
          },
          State: { Running: false, Paused: false, Restarting: false, Dead: false },
        };
        return options.lostAcks
          ? { status: 1, stdout: "", stderr: "lost create acknowledgement" }
          : ok(NEW_ID);
      }
      if (args[0] === "ps") return ok(original ? OLD_ID : "");
      if (args[0] === "inspect") {
        const id = String(args[3] ?? "");
        try {
          inspect(id);
          return ok(`[{"Id":"${id}"}]`);
        } catch {
          return { status: 1, stderr: `Error response from daemon: No such container: ${id}` };
        }
      }
      if (args[0] === "cp") {
        const sourceIndex = args[1] === "-a" ? 2 : 1;
        const source = String(args[sourceIndex] ?? "");
        const destination = String(args[sourceIndex + 1] ?? "");
        if (!source.includes(":")) {
          events.push("stage:envelope");
          expect(fs.statSync(source).mode & 0o777).toBe(0o400);
          expect(
            parseManagedBootstrapEnvelope(fs.readFileSync(source, "utf8")).bootstrapIdentity,
          ).toBe(IDENTITY);
          return ok();
        }
        const receipt = source.split(":")[1];
        const expected = receipt?.includes("shared-state-commit") ? "committed" : "pending";
        if (sharedState === expected) {
          fs.mkdirSync(destination, { recursive: true });
          return ok();
        }
        return {
          status: 1,
          stderr: `Error response from daemon: Could not find the file ${receipt} in container ${NEW_ID}`,
        };
      }
      if (args[0] === "run" && args.includes("--shared-state-transaction-status")) {
        return ok(`${sharedState}\n`);
      }
      if (args[0] === "run" && args.includes("--rollback-shared-state-transaction")) {
        sharedState = "none";
        events.push("shared:rollback");
        return ok();
      }
      if (args[0] === "exec" && args.includes("--commit-shared-state-transaction")) {
        sharedState = "committed";
        events.push("shared:commit");
        return ok();
      }
      if (args[0] === "exec" && args.includes("--clear-shared-state-commit-receipt")) {
        sharedState = "none";
        events.push("shared:clear");
        return ok();
      }
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    },
  );
  const deps: DockerManagedBootstrapDeps = {
    journalStore: store,
    dockerCapture,
    dockerRun,
    dockerStop: vi.fn((id) => {
      events.push(`stop:${id}`);
      const target = id === OLD_ID ? original : replacement;
      if (target?.State) target.State = { ...target.State, Running: false };
      return options.lostAcks ? { status: 1, stderr: "lost stop acknowledgement" } : ok();
    }),
    dockerRename: vi.fn((id, name) => {
      events.push(`rename:${id}:${name}`);
      const target = id === OLD_ID ? original : replacement;
      if (target) target.Name = `/${name}`;
      return options.lostAcks ? { status: 1, stderr: "lost rename acknowledgement" } : ok();
    }),
    dockerStart: vi.fn((id) => {
      events.push(`start:${id}`);
      const target = id === OLD_ID ? original : replacement;
      if (target?.State && !(id === NEW_ID && options.failStart)) {
        target.State = { ...target.State, Running: true };
      }
      return id === NEW_ID && options.failStart
        ? { status: 1, stderr: "injected start failure" }
        : options.lostAcks
          ? { status: 1, stderr: "lost start acknowledgement" }
          : ok();
    }),
    dockerRm: vi.fn((id) => {
      events.push(`rm:${id}`);
      if (id === OLD_ID) original = null as unknown as DockerContainerInspect;
      if (id === NEW_ID) replacement = null;
      return options.lostAcks ? { status: 1, stderr: "lost rm acknowledgement" } : ok();
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
    get original() {
      return original;
    },
    get replacement() {
      return replacement;
    },
    get sharedState() {
      return sharedState;
    },
  };
}

function completion(
  replacement: Awaited<
    ReturnType<ReturnType<typeof createDockerManagedBootstrapAdapter>["replaceForBootstrap"]>
  >,
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

describe("Docker managed bootstrap adapter", () => {
  it("journals both exact identities before cutover and reconciles lost acknowledgements", async () => {
    const fake = fixture({ lostAcks: true, sharedState: "pending" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, snapshot } = authority();
    const replacement = await adapter.replaceForBootstrap({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const order = fake.events;
    expect(order.indexOf("journal:staged")).toBeGreaterThan(order.indexOf("stage:envelope"));
    expect(order.indexOf("journal:cutover")).toBeLessThan(order.indexOf(`stop:${OLD_ID}`));
    expect(fake.journal).toMatchObject({
      phase: "cutover",
      originalRuntimeId: OLD_ID,
      replacementRuntimeId: NEW_ID,
    });

    await expect(
      adapter.finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        replacement,
        completion: completion(replacement),
      }),
    ).resolves.toMatchObject({ outcome: "committed" });
    expect(fake.events.indexOf("journal:shared-state-committed")).toBeLessThan(
      fake.events.indexOf(`rm:${OLD_ID}`),
    );
    expect(fake.journal).toBeNull();
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.Id).toBe(NEW_ID);
  });

  it("recovers a failed cutover after adapter restart from exact journal authority", async () => {
    const fake = fixture({ failStart: true });
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, snapshot } = authority();
    await expect(
      first.replaceForBootstrap({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow("could not prove its exact replacement running");
    expect(fake.journal?.phase).toBe("cutover");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(
      restarted.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.events.indexOf("journal:rollback-authorized")).toBeLessThan(
      fake.events.indexOf(`rm:${NEW_ID}`),
    );
    expect(fake.journal).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(fake.original.Name).toBe("/openshell-alpha");
    expect(fake.original.State?.Running).toBe(false);
  });

  it("recovers the pre-stop cutover crash state after adapter restart", async () => {
    const fake = fixture({ failAfterCutoverFence: true });
    const { handle, snapshot } = authority();
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).replaceForBootstrap({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow("crash after durable cutover fence");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.events.indexOf("journal:rollback-authorized")).toBeLessThan(
      fake.events.indexOf(`rm:${NEW_ID}`),
    );
    expect(fake.journal).toBeNull();
  });

  it("fences rollback when image-owned shared state is already committed", async () => {
    const fake = fixture({ sharedState: "committed" });
    const { handle, snapshot } = authority();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const replacement = await adapter.replaceForBootstrap({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const eventCount = fake.events.length;
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        replacement,
        completion: null,
      }),
    ).rejects.toMatchObject({ name: "ManagedBootstrapDurableCommitCleanupPendingError" });
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.events.slice(eventCount)).toEqual(["journal:shared-state-committed"]);
  });

  it("quiesces and retains an exact incomplete create when its mutable name is reused", async () => {
    const fake = fixture({ ownerId: "sandbox-alpha-recreated" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { plan } = authority();
    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
      }),
    ).rejects.toMatchObject({
      name: "ManagedBootstrapOwnerCleanupRequiredError",
      sandboxId: "sandbox-alpha",
      runtimeId: OLD_ID,
    });
    expect(fake.original.State?.Running).toBe(false);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(vi.mocked(fake.deps.runOpenshell!)).not.toHaveBeenCalled();
  });
});
