// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_NAME } from "../cli/branding";

const originalHome = process.env.HOME;
const temporaryHomes: string[] = [];

async function loadRegistryDocument(document: unknown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-normalization-"));
  temporaryHomes.push(home);
  const configDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "sandboxes.json"), JSON.stringify(document), {
    mode: 0o600,
  });
  process.env.HOME = home;
  vi.resetModules();
  return { home, registry: await import("./registry") };
}

async function loadRegistryWith(
  sandboxes: Record<string, unknown>,
  defaultSandbox: unknown = null,
) {
  return (await loadRegistryDocument({ defaultSandbox, sandboxes })).registry;
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("sandbox registry normalization", () => {
  const servingProfileProvenance = {
    schemaVersion: 1,
    catalogDigest: `sha256:${"1".repeat(64)}`,
    preset: {
      id: "vllm.dgx-spark-gb10.single.example",
      digest: `sha256:${"2".repeat(64)}`,
      displayName: "Example Spark profile",
      supportState: "experimental",
    },
    recipe: {
      id: "vllm.dgx-spark-gb10.single.example",
      digest: `sha256:${"3".repeat(64)}`,
      backend: "vllm",
    },
    model: { id: "example/model", revision: "revision-1" },
    runtimeImage: null,
    estimatedImageDownloadBytes: null,
    estimatedModelDownloadBytes: null,
  } as const;

  it("drops a malformed sandboxes container at the file boundary", async () => {
    const { registry } = await loadRegistryDocument({
      defaultSandbox: 42,
      sandboxes: "not-an-object",
    });

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: null });
  });

  it("drops object-shaped entries that do not contain a usable sandbox name", async () => {
    const registry = await loadRegistryWith({
      missing: { createdAt: "2026-07-09T00:00:00.000Z" },
      empty: { name: "" },
      whitespace: { name: "   " },
      wrongType: { name: 42 },
      mismatched: { name: "different" },
      valid: { name: "valid", createdAt: "2026-07-09T00:00:00.000Z" },
    });

    expect(registry.listSandboxes().sandboxes).toEqual([
      { name: "valid", createdAt: "2026-07-09T00:00:00.000Z" },
    ]);
  });

  it("drops legacy CUA readiness while preserving ordinary sandbox data (#9649)", async () => {
    const registry = await loadRegistryWith({
      alpha: {
        name: "alpha",
        agent: "nemocua",
        provider: "nvidia",
        model: "model-a",
        cuaRuntimeReadiness: { schemaVersion: 1, digest: "legacy" },
      },
    });

    expect(registry.getSandbox("alpha")).toMatchObject({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "model-a",
    });
    expect(registry.getSandbox("alpha")).not.toHaveProperty("cuaRuntimeReadiness");

    registry.save(registry.load());
    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { sandboxes?: { alpha?: Record<string, unknown> } };
    expect(persisted.sandboxes?.alpha).toMatchObject({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "model-a",
    });
    expect(persisted.sandboxes?.alpha).not.toHaveProperty("cuaRuntimeReadiness");
  });

  it("lists managed MCP credential reservations in a stable order", async () => {
    const registry = await loadRegistryWith({
      zeta: {
        name: "zeta",
        mcp: {
          bridges: {
            search: {
              server: "search",
              agent: "openclaw",
              url: "https://8.8.8.8/mcp",
              env: ["SEARCH_TOKEN", "SEARCH_REGION"],
              policyName: "mcp-bridge-search",
              addedAt: "2026-08-18T00:00:00.000Z",
            },
          },
        },
      },
      alpha: {
        name: "alpha",
        mcp: {
          bridges: {
            files: {
              server: "files",
              agent: "hermes",
              url: "https://1.1.1.1/mcp",
              env: ["FILES_TOKEN"],
              policyName: "mcp-bridge-files",
              addedAt: "2026-08-18T00:00:00.000Z",
            },
          },
        },
      },
    });

    expect(registry.listManagedMcpCredentialReservations()).toEqual([
      { sandboxName: "alpha", server: "files", credentialKeys: ["FILES_TOKEN"] },
      {
        sandboxName: "zeta",
        server: "search",
        credentialKeys: ["SEARCH_TOKEN", "SEARCH_REGION"],
      },
    ]);
  });

  it("preserves a stale pointer for diagnostics but repairs it on registration", async () => {
    const registry = await loadRegistryWith({ mismatched: { name: "different" } }, "mismatched");

    expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: "mismatched" });

    registry.registerSandbox({ name: "replacement" });

    expect(registry.listSandboxes().defaultSandbox).toBe("replacement");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBe("replacement");
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("advances the ownership revision when persistence repairs a stale pointer", async () => {
    const registry = await loadRegistryWith({}, "ghost");

    registry.save(registry.load());

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBeNull();
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("does not retain a default inherited from Object.prototype", async () => {
    const registry = await loadRegistryWith({}, "constructor");

    registry.save(registry.load());

    const persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { defaultSandbox?: unknown; defaultSelectionRevision?: unknown };
    expect(persisted.defaultSandbox).toBeNull();
    expect(persisted.defaultSelectionRevision).toBe(1);
  });

  it("round-trips the lifecycle proof used to retire a replaced workload", async () => {
    const registry = await loadRegistryWith({});
    const lifecycleGeneration = "22222222-2222-4222-8222-222222222222";
    const lifecycleLiveIdentityFingerprint = "d".repeat(64);

    registry.registerSandbox({
      name: "replacement",
      lifecycleGeneration,
      lifecycleLiveIdentityFingerprint,
    });

    vi.resetModules();
    const reloadedRegistry = await import("./registry");
    expect(reloadedRegistry.getSandbox("replacement")).toMatchObject({
      lifecycleGeneration,
      lifecycleLiveIdentityFingerprint,
    });
  });

  it("backfills a lifecycle generation only for the unchanged legacy Docker row (#8584)", async () => {
    const registry = await loadRegistryWith({});
    const { compareAndSetLegacySandboxLifecycleGeneration } =
      await import("./registry/lifecycle-generation");
    registry.registerSandbox({ name: "portable", openshellDriver: "docker" });
    const expected = registry.getSandbox("portable")!;

    expect(compareAndSetLegacySandboxLifecycleGeneration(expected, "a".repeat(64))).toBe(true);
    expect(registry.getSandbox("portable")?.lifecycleGeneration).toBe("a".repeat(64));
    expect(compareAndSetLegacySandboxLifecycleGeneration(expected, "b".repeat(64))).toBe(false);

    registry.registerSandbox({ name: "changed", openshellDriver: "docker" });
    const stale = registry.getSandbox("changed")!;
    registry.updateSandbox("changed", { model: "replacement" });
    expect(compareAndSetLegacySandboxLifecycleGeneration(stale, "c".repeat(64))).toBe(false);
  });

  const generation = "22222222-2222-4222-8222-222222222222";
  const fingerprint = "b".repeat(64);

  async function prepareMessagingIdentityRecovery(
    entry: Partial<import("./registry").SandboxEntry> = {},
  ) {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
    const registry = await loadRegistryWith({
      legacy: {
        name: "legacy",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        ...entry,
      },
    });
    const expected = registry.getSandbox("legacy")!;
    const sessionStore = await import("./onboard-session");
    const { deriveCheckpointFromSession } = await import("./onboard-checkpoint-migrate");
    const { policyChannelDependencies } =
      await import("../actions/sandbox/policy-channel-dependencies");
    const { revalidateMessagingProviderAttachmentTarget } =
      await import("../actions/sandbox/policy-channel");
    const session = sessionStore.createSession({ sandboxName: "legacy", agent: "openclaw" });
    session.status = "complete";
    session.sandboxPromptProgress.sandboxName = true;
    session.machine = { ...session.machine, state: "complete" };
    session.checkpoint = {
      ...deriveCheckpointFromSession(session),
      gatewayAuthority: {
        kind: "selected",
        value: {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        },
      },
      sandboxRecreate: {
        version: 1,
        id: "11111111-1111-4111-8111-111111111111",
        revision: 6,
        sandboxName: "legacy",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        sourceRegistryFingerprint: "a".repeat(64),
        sourceLiveIdentityFingerprint: null,
        sourceWorkload: null,
        targetIntentFingerprint: "c".repeat(64),
        targetGeneration: generation,
        targetLiveIdentityFingerprint: fingerprint,
        phase: "completed",
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
      },
    };
    sessionStore.saveSession(session);
    const before = sessionStore.loadSession();
    expect(before?.checkpoint?.sandboxRecreate?.phase).toBe("completed");
    const inspect = vi
      .spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget")
      .mockReturnValue(fingerprint);
    return {
      registry,
      expected,
      sessionStore,
      before,
      inspect,
      validate: () => revalidateMessagingProviderAttachmentTarget("legacy", "nemoclaw"),
    };
  }

  it.each([
    { field: "both fields", entry: {} },
    { field: "fingerprint", entry: { lifecycleGeneration: generation } },
    { field: "generation", entry: { lifecycleLiveIdentityFingerprint: fingerprint } },
  ])("recovers missing $field from a completed lifecycle receipt", async ({ entry }) => {
    const f = await prepareMessagingIdentityRecovery(entry);

    expect(f.validate).not.toThrow();
    expect(f.registry.getSandbox("legacy")).toEqual({
      ...f.expected,
      lifecycleGeneration: generation,
      lifecycleLiveIdentityFingerprint: fingerprint,
    });
    expect(f.sessionStore.loadSession()).toEqual(f.before);
    expect(f.sessionStore.isOnboardLockHeldByCurrentProcess()).toBe(false);
  });

  it.each([
    {
      label: "missing proof",
      mutate: (session: import("./onboard-session").Session) => ({ ...session, checkpoint: null }),
    },
    {
      label: "unfinished session",
      mutate: (session: import("./onboard-session").Session) => ({
        ...session,
        status: "in_progress",
      }),
    },
    {
      label: "another sandbox",
      mutate: (session: import("./onboard-session").Session) => ({
        ...session,
        sandboxName: "other",
      }),
    },
    {
      label: "another gateway",
      mutate: (session: import("./onboard-session").Session) => ({
        ...session,
        metadata: { ...session.metadata, gatewayName: "nemoclaw-8081" },
      }),
    },
    {
      label: "another session",
      mutate: (session: import("./onboard-session").Session) => ({
        ...session,
        checkpoint: { ...session.checkpoint!, sessionId: "other-session" },
      }),
    },
    {
      label: "unfinished transaction",
      mutate: (session: import("./onboard-session").Session) => ({
        ...session,
        checkpoint: {
          ...session.checkpoint!,
          sandboxRecreate: { ...session.checkpoint!.sandboxRecreate!, phase: "created" as const },
        },
      }),
    },
  ])("preserves legacy state with $label", async ({ mutate }) => {
    const f = await prepareMessagingIdentityRecovery();
    f.sessionStore.saveSession(mutate(f.before!));

    expect(f.validate).toThrow("incomplete lifecycle identity");
    expect(f.validate).toThrow(
      `Run \`${CLI_NAME} legacy rebuild --yes\` to record its lifecycle identity, then rerun this command.`,
    );
    expect(f.registry.getSandbox("legacy")).toEqual(f.expected);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.sessionStore.isOnboardLockHeldByCurrentProcess()).toBe(false);
  });

  it("omits the rebuild remedy when the recorded gateway differs from the target", async () => {
    const f = await prepareMessagingIdentityRecovery({
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
    });

    expect(f.validate).toThrow(
      /^Sandbox 'legacy' has incomplete lifecycle identity for messaging provider attachment\.$/u,
    );
    expect(f.registry.getSandbox("legacy")).toEqual(f.expected);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { lifecycleGeneration: "33333333-3333-4333-8333-333333333333" },
    { lifecycleLiveIdentityFingerprint: "f".repeat(64) },
    { pendingRouteReservation: true as const },
  ])("does not overwrite conflicting registry identity %j", async (entry) => {
    const f = await prepareMessagingIdentityRecovery(entry);

    expect(f.validate).toThrow("incomplete lifecycle identity");
    expect(f.registry.getSandbox("legacy")).toEqual(f.expected);
  });

  it.each([0, 1])(
    "rejects a live identity change after %s successful observations",
    async (successful) => {
      const f = await prepareMessagingIdentityRecovery();
      const observations = [fingerprint, "f".repeat(64)];
      let index = 1 - successful;
      f.inspect.mockImplementation(() => observations[index++] ?? "f".repeat(64));

      expect(f.validate).toThrow("lifecycle identity changed");
      expect(f.registry.getSandbox("legacy")).toEqual(f.expected);
      expect(f.sessionStore.isOnboardLockHeldByCurrentProcess()).toBe(false);
    },
  );

  it("preserves a registry change made while live identity is inspected", async () => {
    const f = await prepareMessagingIdentityRecovery();
    f.inspect.mockImplementationOnce(() => {
      f.registry.updateSandbox("legacy", { model: "changed" });
      return fingerprint;
    });

    expect(f.validate).toThrow("incomplete lifecycle identity");
    expect(f.registry.getSandbox("legacy")).toEqual({ ...f.expected, model: "changed" });
  });

  it("rechecks the complete registry row after locked identity validation", async () => {
    const f = await prepareMessagingIdentityRecovery();
    f.inspect.mockReturnValueOnce(fingerprint).mockImplementationOnce(() => {
      const document = f.registry.load();
      document.sandboxes.legacy.model = "changed-without-lock";
      f.registry.save(document);
      return fingerprint;
    });

    expect(f.validate).toThrow("incomplete lifecycle identity");
    expect(f.registry.getSandbox("legacy")).toEqual({
      ...f.expected,
      model: "changed-without-lock",
    });
  });

  it("rejects receipt replacement during live identity validation", async () => {
    const f = await prepareMessagingIdentityRecovery();
    f.inspect.mockImplementationOnce(() => {
      f.sessionStore.saveSession({ ...f.before!, sessionId: "replacement" });
      return fingerprint;
    });

    expect(f.validate).toThrow("lifecycle identity changed");
    expect(f.registry.getSandbox("legacy")).toEqual(f.expected);
    expect(f.sessionStore.isOnboardLockHeldByCurrentProcess()).toBe(false);
  });

  it("refuses recovery while another onboarding writer owns the lock", async () => {
    const f = await prepareMessagingIdentityRecovery();
    vi.spyOn(f.sessionStore, "acquireOnboardLock").mockReturnValue({
      acquired: false,
      lockFile: "locked",
      stale: false,
    });

    expect(f.validate).toThrow("another onboarding writer is active");
    expect(f.registry.getSandbox("legacy")).toEqual(f.expected);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("preserves an onboarding lock already held by the caller", async () => {
    const f = await prepareMessagingIdentityRecovery();
    expect(f.sessionStore.acquireOnboardLock("test lifecycle recovery").acquired).toBe(true);
    try {
      expect(f.validate).not.toThrow();
      expect(f.sessionStore.isOnboardLockHeldByCurrentProcess()).toBe(true);
    } finally {
      f.sessionStore.releaseOnboardLock();
    }
  });

  it("round-trips immutable serving profile provenance while preserving legacy rows (#8246)", async () => {
    const registry = await loadRegistryWith({ legacy: { name: "legacy" } });
    expect(registry.getSandbox("legacy")?.servingProfileProvenance).toBeUndefined();

    registry.registerSandbox({ name: "profile", servingProfileProvenance });
    vi.resetModules();
    const reloadedRegistry = await import("./registry");
    expect(reloadedRegistry.getSandbox("profile")?.servingProfileProvenance).toEqual(
      servingProfileProvenance,
    );
  });

  it("round-trips only valid Deferred N1x preview acceptance (#10959)", async () => {
    const registry = await loadRegistryWith({ legacy: { name: "legacy" } });
    registry.registerSandbox({
      name: "preview",
      provider: "vllm-local",
      model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      endpointUrl: null,
      endpointSource: null,
      openshellDriver: "docker",
      deferredN1xManagedVllmAccepted: true,
    });
    vi.resetModules();
    const reloadedRegistry = await import("./registry");

    expect(reloadedRegistry.getSandbox("preview")?.deferredN1xManagedVllmAccepted).toBe(true);
    const malformed = await loadRegistryWith({
      malformed: {
        name: "malformed",
        deferredN1xManagedVllmAccepted: "true",
      },
    });
    expect(() => malformed.getSandbox("malformed")).toThrow("invalid N1x preview acceptance");
    const mismatchedRoute = await loadRegistryWith({
      mismatched: {
        name: "mismatched",
        provider: "vllm-local",
        model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
        endpointUrl: null,
        endpointSource: "inference-set",
        openshellDriver: "docker",
        deferredN1xManagedVllmAccepted: true,
      },
    });
    expect(() => mismatchedRoute.getSandbox("mismatched")).toThrow(
      "invalid N1x preview acceptance",
    );
  });

  it("clears Deferred N1x acceptance when route authority changes (#10959)", async () => {
    const registry = await loadRegistryWith({});
    registry.registerSandbox({
      name: "preview",
      provider: "vllm-local",
      model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      endpointUrl: null,
      endpointSource: null,
      openshellDriver: "docker",
      deferredN1xManagedVllmAccepted: true,
    });
    registry.updateSandbox("preview", { dashboardPort: 18_789 });
    const afterUnrelatedUpdate = registry.getSandbox("preview")?.deferredN1xManagedVllmAccepted;
    registry.updateSandbox("preview", { model: "other/model" });

    expect({
      afterUnrelatedUpdate,
      afterRouteUpdate: registry.getSandbox("preview")?.deferredN1xManagedVllmAccepted,
    }).toEqual({ afterUnrelatedUpdate: true, afterRouteUpdate: undefined });
  });

  it("fails closed when persisted serving profile provenance is malformed (#8246)", async () => {
    const registry = await loadRegistryWith({
      profile: {
        name: "profile",
        servingProfileProvenance: { schemaVersion: 1, catalogDigest: "latest" },
      },
    });
    expect(() => registry.getSandbox("profile")).toThrow("invalid serving profile provenance");
  });

  it.each([null, [], 42, "invalid"])(
    "treats a non-object registry document as empty: %j",
    async (document) => {
      const { registry } = await loadRegistryDocument(document);
      expect(registry.listSandboxes()).toEqual({ sandboxes: [], defaultSandbox: null });
    },
  );

  it("drops malformed sandbox rows", async () => {
    const { registry } = await loadRegistryDocument({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { name: "different" }, beta: { name: "beta" } },
    });
    expect(registry.listSandboxes()).toEqual({
      sandboxes: [expect.objectContaining({ name: "beta" })],
      defaultSandbox: "alpha",
    });
  });

  it("removes every legacy policy shadow field without replaying it", async () => {
    const legacy = {
      name: "alpha",
      gatewayName: "nemoclaw",
      customPolicies: [{ name: "corp", content: "network_policies: {}" }],
      baselineExclusions: [{ key: "npm", digest: "a".repeat(64) }],
      baselineExclusionTransition: { operation: "exclude" },
      policyCreationReceipt: { schemaVersion: 1 },
      pendingPolicyVerification: { expectedHash: "legacy" },
      policyHash: "sha256:legacy",
      policyVersion: 17,
      observedPolicyAuthority: { source: "sandbox", owner: "nemoclaw" },
    };
    const { home, registry } = await loadRegistryDocument({
      defaultSandbox: "alpha",
      sandboxes: { alpha: legacy },
    });

    const sandbox = registry.getSandbox("alpha") as unknown as Record<string, unknown>;
    expect(Object.keys(sandbox)).not.toEqual(
      expect.arrayContaining([
        "policies",
        "customPolicies",
        "baselineExclusions",
        "baselineExclusionTransition",
        "policyAuthority",
        "policyCreationReceipt",
        "pendingPolicyVerification",
        "policyHash",
        "policyPresetsFinalized",
        "policyTier",
        "policyVersion",
        "observedPolicyAuthority",
      ]),
    );

    registry.updateSandbox("alpha", { gatewayName: "nemoclaw" });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    );
    expect(persisted.sandboxes.alpha).toEqual(sandbox);
  });

  it("retains only the bounded generic create checkpoint", async () => {
    const checkpoint = {
      schemaVersion: 1 as const,
      state: "verified-create" as const,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration: "generation",
      sandboxIdentityFingerprint: "a".repeat(64),
      route: "compatibility" as const,
      exactFinalHandoffCommitStarted: true as const,
      exactFinalHandoffRuntimeId: "b".repeat(64),
      exactFinalHandoffAcknowledged: true as const,
      policyHash: "legacy",
    };
    const { registry } = await loadRegistryDocument({
      defaultSandbox: null,
      sandboxes: {
        alpha: {
          name: "alpha",
          pendingRouteReservation: true,
          pendingCreateIdentity: checkpoint,
        },
      },
    });
    expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual({
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration: "generation",
      sandboxIdentityFingerprint: "a".repeat(64),
      route: "compatibility",
      exactFinalHandoffCommitStarted: true,
      exactFinalHandoffRuntimeId: "b".repeat(64),
      exactFinalHandoffAcknowledged: true,
    });
  });

  it.each([
    ["an acknowledgement without a commit fence", { exactFinalHandoffAcknowledged: true }],
    ["a false commit fence", { exactFinalHandoffCommitStarted: false }],
    ["a false acknowledgement", { exactFinalHandoffAcknowledged: false }],
    [
      "a compatibility fence without exact runtime authority",
      { exactFinalHandoffCommitStarted: true },
    ],
    ["runtime authority without a commit fence", { exactFinalHandoffRuntimeId: "b".repeat(64) }],
    [
      "malformed runtime authority",
      { exactFinalHandoffCommitStarted: true, exactFinalHandoffRuntimeId: "short" },
    ],
  ])("rejects %s in a pending create checkpoint", async (_case, receipt) => {
    const registry = await loadRegistryWith({
      alpha: {
        name: "alpha",
        pendingRouteReservation: true,
        pendingCreateIdentity: {
          schemaVersion: 1,
          state: "verified-create",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          sandboxName: "alpha",
          lifecycleGeneration: "generation",
          sandboxIdentityFingerprint: "a".repeat(64),
          route: "compatibility",
          ...receipt,
        },
      },
    });

    expect(() => registry.getSandbox("alpha")).toThrow(
      /invalid pending sandbox create verification/u,
    );
  });

  it("sets a gateway port only while the complete qualified row remains current", async () => {
    const registry = await loadRegistryWith({
      alpha: {
        name: "alpha",
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "11111111-1111-4111-8111-111111111111",
        model: "qualified",
      },
    });
    const qualified = registry.getSandbox("alpha")!;

    expect(registry.updateSandbox("alpha", { model: "replacement" })).toBe(true);
    expect(registry.compareAndSetSandboxGatewayPort("alpha", qualified, 8080)).toBe(false);
    const replacement = registry.getSandbox("alpha")!;
    expect(replacement).toMatchObject({ model: "replacement", gatewayName: "nemoclaw" });
    expect(replacement).not.toHaveProperty("gatewayPort");

    expect(registry.compareAndSetSandboxGatewayPort("alpha", replacement, 8080)).toBe(true);
    expect(registry.getSandbox("alpha")).toEqual({ ...replacement, gatewayPort: 8080 });
  });
});
