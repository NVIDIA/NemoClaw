// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import {
  encodeManagedStartupProfile,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
} from "../../onboard/managed-startup/profile";
import {
  captureSandboxRebuildAuthority,
  type SandboxRebuildAuthority,
} from "../../state/registry/rebuild-authority";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type { SnapshotRestoreAuthority } from "../../state/sandbox";
import {
  cleanupManagedCloneProviderTransaction,
  type ManagedCloneProviderBinding,
  ManagedCloneProviderTransactionError,
  prepareManagedCloneProviderTransaction,
  provisionManagedCloneProviderTransaction,
  revalidateManagedCloneMutationAuthority,
} from "./snapshot/managed-clone-providers";

const CONTENT_AUTHORITY = {
  schemaVersion: 1,
  backupPath: "/tmp/nemoclaw-managed-clone-source",
  contentSha256: "c".repeat(64),
} as const satisfies SnapshotRestoreAuthority;

const TOKEN_BINDING = {
  providerName: "destination-runtime-token",
  providerType: "generic",
  providerEnvKey: "RUNTIME_TOKEN",
  source: "runtime-extension",
} as const satisfies ManagedCloneProviderBinding;

function receipt(profile: ManagedStartupProfile) {
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    schemaVersion: 1 as const,
    kind: "managed-image" as const,
    reference: `ghcr.io/nvidia/nemoclaw/${profile.agent}-sandbox@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64" as const,
    release: "v0.0.99",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123456-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  } satisfies Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;
}

function entry(
  name: string,
  profile: ManagedStartupProfile,
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  const workload = receipt(profile);
  return {
    name,
    agent: profile.agent,
    openshellDriver: "docker",
    imageTag: workload.reference,
    workload,
    lifecycleGeneration: `generation-${name}`,
    lifecycleLiveIdentityFingerprint: createHash("sha256").update(name).digest("hex"),
    provider: profile.inference.upstreamProvider,
    model: profile.inference.model,
    ...overrides,
  };
}

function messagingPlan(sandboxName: string): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        configured: true,
        active: true,
        disabled: false,
        inputs: [{ inputId: "botToken", credentialAvailable: true }],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "botToken",
        providerName: `${sandboxName}-telegram-bridge`,
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  } as unknown as SandboxMessagingPlan;
}

function handoff(
  profile: ManagedStartupProfile,
  source: SandboxEntry,
  messaging?: SandboxMessagingPlan,
) {
  return {
    providerId: "docker",
    sourceSandboxName: "source",
    destinationSandboxName: "destination",
    sourceRegistryAuthority: captureSandboxRebuildAuthority(source, "docker"),
    snapshotRestoreAuthority: CONTENT_AUTHORITY,
    rebound: {
      profile,
      encodedProfile:
        source.workload?.kind === "managed-image" ? source.workload.encodedProfile : "",
      startupProfileSha256:
        source.workload?.kind === "managed-image" ? source.workload.startupProfileSha256 : "",
    },
    ...(messaging === undefined
      ? {}
      : { messaging: { schemaVersion: 1 as const, plan: messaging } }),
  };
}

type LiveBinding = Pick<
  ManagedCloneProviderBinding,
  "providerName" | "providerType" | "providerEnvKey"
>;

function providerMetadata(binding: LiveBinding): string {
  return [
    `Name: ${binding.providerName}`,
    `Type: ${binding.providerType}`,
    `Credential keys: ${binding.providerEnvKey}`,
    "Config keys: <none>",
    "",
  ].join("\n");
}

const EXACT_MESSAGING_PROFILE = {
  status: 0,
  stdout: JSON.stringify({
    id: "nemoclaw-mcp-v1",
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: false,
  }),
  stderr: "",
};

function providerRunner(initial: readonly LiveBinding[] = []) {
  const live = new Map(initial.map((binding) => [binding.providerName, { ...binding }] as const));
  const commands: string[] = [];
  let createBehavior:
    | ((binding: LiveBinding) => { readonly materialize?: LiveBinding; readonly status: number })
    | undefined;
  let profileImportResult = { status: 0, stdout: "", stderr: "" };
  let profileExportResult = EXACT_MESSAGING_PROFILE;
  let failDelete = false;
  const run = vi.fn((args: string[]) => {
    commands.push(args.join(" "));
    switch (args.slice(0, 2).join(" ")) {
      case "provider profile": {
        const importing = args[2] === "import";
        profileExportResult =
          importing && profileImportResult.status === 0
            ? EXACT_MESSAGING_PROFILE
            : profileExportResult;
        return importing ? profileImportResult : profileExportResult;
      }
      case "provider get": {
        const name = args[2] ?? "";
        const binding = live.get(name);
        return binding
          ? { status: 0, stdout: providerMetadata(binding), stderr: "" }
          : { status: 1, stdout: "", stderr: `provider '${name}' not found` };
      }
      case "provider create": {
        const binding = {
          providerName: args[3] ?? "",
          providerType: args[5] ?? "",
          providerEnvKey: args[7] ?? "",
        };
        const outcome = createBehavior?.(binding) ?? { status: 0, materialize: binding };
        (outcome.materialize === undefined ? [] : [outcome.materialize]).forEach((materialized) =>
          live.set(binding.providerName, { ...materialized }),
        );
        return { status: outcome.status, stdout: "", stderr: "" };
      }
      case "provider delete": {
        (failDelete ? [] : [args[2] ?? ""]).forEach((name) => live.delete(name));
        return failDelete
          ? { status: 1, stdout: "", stderr: "gateway unavailable" }
          : { status: 0, stdout: "", stderr: "" };
      }
      default:
        return args.slice(0, 3).join(" ") === "sandbox provider detach"
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 1, stdout: "", stderr: "unsupported test command" };
    }
  });
  return {
    commands,
    live,
    run,
    setCreateBehavior(value: typeof createBehavior) {
      createBehavior = value;
    },
    setFailDelete(value: boolean) {
      failDelete = value;
    },
    setProfileImportResult(value: typeof profileImportResult) {
      profileImportResult = value;
    },
    setProfileExportResult(value: typeof profileExportResult) {
      profileExportResult = value;
    },
  };
}

function authorityDeps(
  source: SandboxEntry,
  destination: SandboxEntry | null = null,
  content: SnapshotRestoreAuthority | null = CONTENT_AUTHORITY,
) {
  return {
    readSandbox: (name: string) =>
      name === source.name ? source : name === destination?.name ? destination : null,
    captureSnapshotRestoreAuthority: vi.fn(() => content),
  };
}

function prepareWithBinding(input: {
  readonly agent?: ManagedStartupAgent;
  readonly binding?: ManagedCloneProviderBinding;
  readonly destination?: SandboxEntry | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: ReturnType<typeof providerRunner>;
}) {
  const profile = managedStartupE2eProfile(input.agent ?? "openclaw");
  const source = entry("source", profile);
  const runner = input.runner ?? providerRunner();
  const destination = input.destination ?? null;
  const prepared = prepareManagedCloneProviderTransaction({
    handoff: handoff(profile, source),
    destination,
    additionalBindings: [input.binding ?? TOKEN_BINDING],
    environment: input.environment ?? { RUNTIME_TOKEN: "test-only-runtime-token" },
    runOpenshell: runner.run,
    transactionId: "1".repeat(32),
  });
  return { destination, prepared, profile, runner, source };
}

describe("managed clone provider transaction", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "keeps the %s transaction provider-neutral, secret-free, and deeply frozen (#8931)",
    (agent) => {
      const { prepared } = prepareWithBinding({ agent });

      expect(prepared).toMatchObject({
        providerId: "docker",
        sourceSandboxName: "source",
        destinationSandboxName: "destination",
        snapshotRestoreAuthority: CONTENT_AUTHORITY,
        providers: [{ binding: TOKEN_BINDING, action: "create" }],
      });
      expect(JSON.stringify(prepared)).not.toContain("test-only-runtime-token");
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(Object.isFrozen(prepared.snapshotRestoreAuthority)).toBe(true);
      expect(Object.isFrozen(prepared.sourceRegistryAuthority.workload)).toBe(true);
      expect(Object.isFrozen(prepared.providers[0]?.binding)).toBe(true);
    },
  );

  it("resolves active messaging providers from the handoff", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const runner = providerRunner();
    const plan = messagingPlan("destination");

    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source, plan),
      destination: null,
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
      transactionId: "2".repeat(32),
    });

    expect(prepared.providers).toEqual([
      {
        binding: {
          providerName: "destination-telegram-bridge",
          providerType: "nemoclaw-mcp-v1",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          source: "messaging",
        },
        action: "create",
      },
    ]);
  });

  it("imports the endpointless profile before creating a cloned messaging provider (#9875)", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const runner = providerRunner();
    runner.setProfileExportResult({
      status: 1,
      stdout: "",
      stderr: "provider profile not found",
    });
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source, messagingPlan("destination")),
      destination: null,
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
      transactionId: "9".repeat(32),
    });

    provisionManagedCloneProviderTransaction(prepared, {
      ...authorityDeps(source),
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
    });

    const importIndex = runner.commands.findIndex((command) =>
      command.startsWith("provider profile import --file "),
    );
    const createIndex = runner.commands.findIndex((command) =>
      command.startsWith("provider create --name destination-telegram-bridge "),
    );
    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(runner.commands[importIndex]).toBe(
      `provider profile import --file ${path.join(
        REPOSITORY_ROOT,
        "nemoclaw-blueprint",
        "provider-profiles",
        "nemoclaw-mcp-v1.yaml",
      )}`,
    );
    expect(createIndex).toBeGreaterThan(importIndex);
  });

  it("rejects stale clone authority before importing the messaging profile (#9875)", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const runner = providerRunner();
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source, messagingPlan("destination")),
      destination: null,
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
      transactionId: "8".repeat(32),
    });

    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source, null, {
          ...CONTENT_AUTHORITY,
          contentSha256: "d".repeat(64),
        }),
        environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
        runOpenshell: runner.run,
      }),
    ).toThrow(/snapshot content changed before mutation/u);
    expect(
      runner.commands.some((command) => command.startsWith("provider profile import --file ")),
    ).toBe(false);
    expect(runner.commands.some((command) => command.startsWith("provider create --name "))).toBe(
      false,
    );
  });

  it("does not create a cloned messaging provider after profile import fails (#9875)", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const runner = providerRunner();
    runner.setProfileExportResult({
      status: 1,
      stdout: "",
      stderr: "provider profile not found",
    });
    runner.setProfileImportResult({ status: 1, stdout: "", stderr: "gateway unavailable" });
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source, messagingPlan("destination")),
      destination: null,
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
      transactionId: "7".repeat(32),
    });

    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source),
        environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
        runOpenshell: runner.run,
      }),
    ).toThrow(/Could not import the OpenShell messaging credential profile/);
    expect(runner.commands.some((command) => command.startsWith("provider create"))).toBe(false);
  });

  it("reuses an exact provider only with exact destination registry ownership", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const plan = messagingPlan("destination");
    const destination = entry("destination", profile, { messaging: { schemaVersion: 1, plan } });
    const liveBinding = {
      providerName: "destination-telegram-bridge",
      providerType: "nemoclaw-mcp-v1",
      providerEnvKey: "TELEGRAM_BOT_TOKEN",
    };
    const runner = providerRunner([liveBinding]);
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source, plan),
      destination,
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
      transactionId: "3".repeat(32),
    });

    expect(prepared.providers[0]?.action).toBe("reuse-destination-owned");
    const receipt = provisionManagedCloneProviderTransaction(prepared, {
      ...authorityDeps(source, destination),
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
    });
    expect(receipt.providers[0]?.disposition).toBe("reused-destination-owned");
    expect(
      runner.commands.some((command) => /provider (create|delete|update)/u.test(command)),
    ).toBe(false);
    expect(cleanupManagedCloneProviderTransaction(receipt, runner.run)).toMatchObject({
      status: "complete",
      providers: [{ outcome: "reused-preserved" }],
    });
  });

  it("rejects clone reuse backed by an incompatible global messaging profile (#9875)", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const plan = messagingPlan("destination");
    const destination = entry("destination", profile, { messaging: { schemaVersion: 1, plan } });
    const liveBinding = {
      providerName: "destination-telegram-bridge",
      providerType: "nemoclaw-mcp-v1",
      providerEnvKey: "TELEGRAM_BOT_TOKEN",
    };
    const runner = providerRunner([liveBinding]);
    runner.setProfileImportResult({ status: 1, stdout: "", stderr: "profile already exists" });
    runner.setProfileExportResult({
      status: 0,
      stdout: JSON.stringify({
        id: "nemoclaw-mcp-v1",
        credentials: [],
        endpoints: ["https://foreign.invalid"],
        binaries: [],
        inference_capable: false,
      }),
      stderr: "",
    });
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source, plan),
      destination,
      environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
      runOpenshell: runner.run,
      transactionId: "4".repeat(32),
    });

    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source, destination),
        environment: { TELEGRAM_BOT_TOKEN: "test-only-telegram-token" },
        runOpenshell: runner.run,
      }),
    ).toThrow(/does not match NemoClaw's endpointless messaging credential contract/u);
    expect(
      runner.commands.some((command) => /provider (create|delete|update)/u.test(command)),
    ).toBe(false);
  });

  it("rejects an exact same-name provider without destination ownership", () => {
    const runner = providerRunner([TOKEN_BINDING]);

    expect(() => prepareWithBinding({ runner })).toThrow(/without exact destination ownership/u);
    expect(
      runner.commands.some((command) => /provider (create|delete|update)/u.test(command)),
    ).toBe(false);
  });

  it("rejects a destination registered under another runtime provider", () => {
    const profile = managedStartupE2eProfile("langchain-deepagents-code");
    const source = entry("source", profile);
    const destination = entry("destination", profile, { openshellDriver: "mxc" });
    const runner = providerRunner();

    expect(() =>
      prepareManagedCloneProviderTransaction({
        handoff: handoff(profile, source),
        destination,
        environment: {},
        runOpenshell: runner.run,
        transactionId: "8".repeat(32),
      }),
    ).toThrow(/destination registry authority uses a different runtime provider/u);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("fails closed on indeterminate provider inspection with bounded diagnostics", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "gateway transport unavailable",
    }));

    expect(() =>
      prepareManagedCloneProviderTransaction({
        handoff: handoff(profile, source),
        destination: null,
        additionalBindings: [TOKEN_BINDING],
        environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
        runOpenshell,
        transactionId: "7".repeat(32),
      }),
    ).toThrow(/could not prove whether provider/u);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "get", TOKEN_BINDING.providerName],
      expect.objectContaining({
        maxBuffer: 64 * 1024,
        suppressOutput: true,
        timeout: 5_000,
      }),
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("rejects an incompatible provider collision during read-only preflight", () => {
    const runner = providerRunner([{ ...TOKEN_BINDING, providerType: "other" }]);

    expect(() => prepareWithBinding({ runner })).toThrow(/incompatible live binding/u);
    expect(
      runner.commands.some((command) => /provider (create|delete|update)/u.test(command)),
    ).toBe(false);
  });

  it("revalidates snapshot, source, and destination authority before provider mutation", () => {
    const { prepared, runner, source } = prepareWithBinding({});
    const changedContent = { ...CONTENT_AUTHORITY, contentSha256: "d".repeat(64) };

    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source, null, changedContent),
        environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
        runOpenshell: runner.run,
      }),
    ).toThrow(/snapshot content changed before mutation/u);
    expect(runner.commands.some((command) => command.startsWith("provider create"))).toBe(false);

    expect(() =>
      revalidateManagedCloneMutationAuthority(prepared, {
        ...authorityDeps({ ...source, model: "changed-model" }),
      }),
    ).toThrow(/source registry authority changed/u);
    expect(() =>
      revalidateManagedCloneMutationAuthority(prepared, {
        ...authorityDeps(source, entry("destination", managedStartupE2eProfile("openclaw"))),
      }),
    ).toThrow(/destination appeared after clone preflight/u);
  });

  it("revalidates content authority for an agent with no credential providers", () => {
    const profile = managedStartupE2eProfile("langchain-deepagents-code");
    const source = entry("source", profile);
    const runner = providerRunner();
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source),
      destination: null,
      environment: {},
      runOpenshell: runner.run,
      transactionId: "6".repeat(32),
    });

    expect(prepared.providers).toEqual([]);
    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source, null, {
          ...CONTENT_AUTHORITY,
          contentSha256: "d".repeat(64),
        }),
        environment: {},
        runOpenshell: runner.run,
      }),
    ).toThrow(/snapshot content changed before mutation/u);
    expect(runner.commands).toEqual([]);
  });

  it("creates with an exact receipt and makes cleanup idempotent against name reuse", () => {
    const { prepared, runner, source } = prepareWithBinding({});
    const receipt = provisionManagedCloneProviderTransaction(prepared, {
      ...authorityDeps(source),
      environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
      runOpenshell: runner.run,
    });

    expect(receipt.providers).toEqual([{ binding: TOKEN_BINDING, disposition: "created" }]);
    expect(Object.isFrozen(receipt.providers[0]?.binding)).toBe(true);
    expect(cleanupManagedCloneProviderTransaction(receipt, runner.run)).toMatchObject({
      status: "complete",
      providers: [{ outcome: "deleted" }],
    });
    runner.live.set(TOKEN_BINDING.providerName, { ...TOKEN_BINDING, providerType: "other" });
    const deletesBeforeRetry = runner.commands.filter((command) =>
      command.startsWith("provider delete"),
    ).length;
    expect(cleanupManagedCloneProviderTransaction(receipt, runner.run)).toMatchObject({
      status: "complete",
      providers: [{ outcome: "already-cleaned" }],
    });
    expect(runner.commands.filter((command) => command.startsWith("provider delete"))).toHaveLength(
      deletesBeforeRetry,
    );
    expect(runner.live.get(TOKEN_BINDING.providerName)?.providerType).toBe("other");
  });

  it("bounds provider creation before exact-result reconciliation", () => {
    const { prepared, runner, source } = prepareWithBinding({});

    provisionManagedCloneProviderTransaction(prepared, {
      ...authorityDeps(source),
      environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
      runOpenshell: runner.run,
    });

    expect(runner.run).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "--name",
        TOKEN_BINDING.providerName,
        "--type",
        TOKEN_BINDING.providerType,
        "--credential",
        TOKEN_BINDING.providerEnvKey,
      ],
      expect.objectContaining({
        maxBuffer: 64 * 1024,
        suppressOutput: true,
        timeout: 30_000,
      }),
    );
  });

  it("rolls back confirmed providers when a later credential disappears", () => {
    const first = { ...TOKEN_BINDING, providerName: "destination-first-token" };
    const second = {
      ...TOKEN_BINDING,
      providerName: "destination-second-token",
      providerEnvKey: "SECOND_TOKEN",
    };
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const runner = providerRunner();
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source),
      destination: null,
      additionalBindings: [first, second],
      environment: {
        RUNTIME_TOKEN: "test-only-runtime-token",
        SECOND_TOKEN: "test-only-second-token",
      },
      runOpenshell: runner.run,
      transactionId: "4".repeat(32),
    });

    let failure: ManagedCloneProviderTransactionError | null = null;
    try {
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source),
        environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
        runOpenshell: runner.run,
      });
    } catch (error) {
      failure = error as ManagedCloneProviderTransactionError;
    }
    expect(failure).toBeInstanceOf(ManagedCloneProviderTransactionError);
    expect(failure?.partialReceipt?.providers).toEqual([
      { binding: first, disposition: "created" },
    ]);
    expect(failure?.rollback?.status).toBe("complete");
    expect(runner.live.has(first.providerName)).toBe(false);
    expect(runner.commands).toContain(`provider delete ${first.providerName}`);
  });

  it.each([
    ["nonzero and missing", 1, undefined],
    ["nonzero and exact", 1, TOKEN_BINDING],
    [
      "zero and collision",
      0,
      { ...TOKEN_BINDING, providerType: "other" } satisfies ManagedCloneProviderBinding,
    ],
  ] as const)(
    "preserves an unowned provider after an ambiguous create: %s",
    (_name, status, materialize) => {
      const runner = providerRunner();
      runner.setCreateBehavior(() => ({ status, ...(materialize ? { materialize } : {}) }));
      const { prepared, source } = prepareWithBinding({ runner });

      expect(() =>
        provisionManagedCloneProviderTransaction(prepared, {
          ...authorityDeps(source),
          environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
          runOpenshell: runner.run,
        }),
      ).toThrow(/preserving the observed/u);
      expect(runner.commands).not.toContain(`provider delete ${TOKEN_BINDING.providerName}`);
      expect(runner.live.has(TOKEN_BINDING.providerName)).toBe(Boolean(materialize));
    },
  );

  it("reconciles and preserves an exact provider when the create adapter throws", () => {
    const runner = providerRunner();
    runner.setCreateBehavior((binding) => {
      runner.live.set(binding.providerName, binding);
      throw new Error("synthetic child-process transport loss");
    });
    const { prepared, source } = prepareWithBinding({ runner });

    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source),
        environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
        runOpenshell: runner.run,
      }),
    ).toThrow(/exact but unowned/u);
    expect(runner.commands).not.toContain(`provider delete ${TOKEN_BINDING.providerName}`);
    expect(runner.live.has(TOKEN_BINDING.providerName)).toBe(true);
  });

  it("reports cleanup failure without discarding its exact retry receipt", () => {
    const { prepared, runner, source } = prepareWithBinding({});
    const receipt = provisionManagedCloneProviderTransaction(prepared, {
      ...authorityDeps(source),
      environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
      runOpenshell: runner.run,
    });
    runner.setFailDelete(true);

    expect(cleanupManagedCloneProviderTransaction(receipt, runner.run)).toMatchObject({
      status: "partial",
      providers: [{ outcome: "delete-failed" }],
    });
    expect(runner.live.has(TOKEN_BINDING.providerName)).toBe(true);
  });

  it("rejects a cloned or fabricated cleanup receipt", () => {
    const { prepared, runner, source } = prepareWithBinding({});
    const receipt = provisionManagedCloneProviderTransaction(prepared, {
      ...authorityDeps(source),
      environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
      runOpenshell: runner.run,
    });

    expect(() =>
      cleanupManagedCloneProviderTransaction(structuredClone(receipt), runner.run),
    ).toThrow(/exact process-local ownership receipt/u);
    expect(runner.live.has(TOKEN_BINDING.providerName)).toBe(true);
  });

  it("fails a force-replace transaction when destination authority becomes stale", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const source = entry("source", profile);
    const destination = entry("destination", profile);
    const runner = providerRunner();
    const prepared = prepareManagedCloneProviderTransaction({
      handoff: handoff(profile, source),
      destination,
      additionalBindings: [TOKEN_BINDING],
      environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
      runOpenshell: runner.run,
      transactionId: "5".repeat(32),
    });
    const staleDestination = { ...destination, model: "changed-model" };

    expect(() =>
      provisionManagedCloneProviderTransaction(prepared, {
        ...authorityDeps(source, staleDestination),
        environment: { RUNTIME_TOKEN: "test-only-runtime-token" },
        runOpenshell: runner.run,
      }),
    ).toThrow(/destination registry authority changed/u);
    expect(runner.commands.some((command) => command.startsWith("provider create"))).toBe(false);
  });

  it("captures the complete destination row in the reuse authority receipt", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const destination = entry("destination", profile);
    const { prepared } = prepareWithBinding({ destination });

    expect(prepared.destinationRegistryAuthority).toEqual(
      captureSandboxRebuildAuthority(destination, "docker") as SandboxRebuildAuthority,
    );
  });
});
