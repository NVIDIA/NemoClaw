// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));
vi.mock("node:child_process", () => childProcessMock);

const coordinatorMock = vi.hoisted(() => ({
  coordinateManagedStartupApplication: vi.fn(),
}));
vi.mock("./managed-startup/coordinator", () => coordinatorMock);

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  mockRootReplayFilesystem,
  observeMatchingLink,
  observeMatchingRename,
  observeMatchingRenameTarget,
  observeMatchingUnlink,
} from "../../../test/helpers/managed-startup-root-replay-filesystem";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapEnvelope,
} from "./managed-bootstrap/envelope";
import {
  applyManagedBootstrapEnvelope,
  type ManagedBootstrapImageRuntimeExpected,
  main as mainManagedBootstrapImageRuntime,
  managedBootstrapEnvelopeClaimPaths,
  recoverManagedBootstrapEnvelopeClaim,
} from "./managed-bootstrap/image-runtime";
import {
  applyManagedStartupImageProfile,
  applyManagedStartupRootRequest,
  buildManagedStartupImageActionPlan,
  installHermesManagedPolicy,
  MANAGED_STARTUP_PROFILE_ENV,
  type ManagedStartupImageActionPlanInput,
  main as mainManagedStartupImageRuntime,
} from "./managed-startup/image-runtime";
import {
  encodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
  type ManagedStartupProfile,
} from "./managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import * as sharedStateTransaction from "./managed-startup/shared-state-transaction";

function dashboard(agent: ManagedStartupAgent): ManagedStartupDashboard {
  switch (agent) {
    case "openclaw":
      return {
        agent,
        mode: "loopback",
        url: "http://127.0.0.1:18789",
        port: 18_789,
        bindAddress: "127.0.0.1",
        wslExposure: false,
      };
    case "hermes":
      return {
        agent,
        mode: "disabled",
        url: "http://127.0.0.1:18789",
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      };
    case "langchain-deepagents-code":
      return { agent, mode: "disabled" };
    case "pi":
      return { agent, mode: "disabled" };
  }
}

function actionInput(
  agent: ManagedStartupAgent,
  mode: "apply" | "clear" = "apply",
): ManagedStartupImageActionPlanInput {
  const messagingActions =
    agent === "langchain-deepagents-code" || agent === "pi"
      ? []
      : [
          {
            kind: "apply-messaging-plan" as const,
            agent,
            mode,
            phase: "runtime-setup" as const,
            runAs: "root" as const,
          },
          {
            kind: "apply-messaging-plan" as const,
            agent,
            mode,
            phase: "post-agent-install" as const,
            runAs: "sandbox" as const,
          },
        ];
  return {
    agent,
    actions: [
      ...messagingActions.slice(0, 1),
      { kind: "generate-agent-config", agent, runAs: "sandbox" },
      ...messagingActions.slice(1),
      { kind: "configure-dashboard", dashboard: dashboard(agent) },
    ],
  };
}

describe("buildManagedStartupImageActionPlan", () => {
  it.each([
    "openclaw",
    "hermes",
  ] as const)("constructs the complete offline %s messaging and config plan", (agent) => {
    const plan = buildManagedStartupImageActionPlan(actionInput(agent));

    expect(plan.map(({ action, runAs }) => ({ action, runAs }))).toEqual([
      { action: "messaging-runtime-setup", runAs: "root" },
      { action: "generate-agent-config", runAs: "sandbox" },
      { action: "messaging-post-agent-install", runAs: "sandbox" },
    ]);
    expect(plan[0]?.argv).toContain("runtime-setup");
    expect(plan[0]?.argv).toContain("apply");
    expect(plan[0]?.argv).not.toContain("--managed-startup-runtime");
    expect(plan[2]?.argv).toContain("post-agent-install");
    expect(plan[2]?.argv).toContain("apply");
    expect(plan[2]?.argv).toContain("--managed-startup-runtime");
    expect(
      plan.some((command) =>
        command.argv.some((argument) => /^(?:npm|npx|pip|pip3|uv)$/u.test(argument)),
      ),
    ).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every((command) => Object.isFrozen(command) && Object.isFrozen(command.argv))).toBe(
      true,
    );
  });

  it("constructs DCode's complete offline config plan without messaging actions", () => {
    expect(buildManagedStartupImageActionPlan(actionInput("langchain-deepagents-code"))).toEqual([
      {
        action: "generate-agent-config",
        runAs: "sandbox",
        argv: [
          "/usr/local/bin/node",
          "--experimental-strip-types",
          "/opt/nemoclaw-deepagents-code/generate-config.ts",
        ],
      },
    ]);
  });

  it.each([
    ["openclaw", "/scripts/generate-openclaw-config.mts"],
    ["hermes", "/opt/nemoclaw-hermes-config/generate-config.ts"],
    ["langchain-deepagents-code", "/opt/nemoclaw-deepagents-code/generate-config.ts"],
    ["pi", "/opt/nemoclaw-pi/generate-config.ts"],
  ] as const)("selects the reviewed %s generator asset", (agent, generator) => {
    const command = buildManagedStartupImageActionPlan(actionInput(agent)).find(
      ({ action }) => action === "generate-agent-config",
    );
    expect(command?.argv.at(-1)).toBe(generator);
  });

  it.each([
    "apply",
    "clear",
  ] as const)("passes explicit %s intent to both messaging phases", (mode) => {
    const plan = buildManagedStartupImageActionPlan(actionInput("openclaw", mode));
    expect(plan[0]?.argv).toEqual(expect.arrayContaining(["--mode", mode]));
    expect(plan[2]?.argv).toEqual(expect.arrayContaining(["--mode", mode]));
  });

  it("keeps apply and clear as distinct reviewed commands", () => {
    expect(buildManagedStartupImageActionPlan(actionInput("openclaw", "clear"))).not.toEqual(
      buildManagedStartupImageActionPlan(actionInput("openclaw", "apply")),
    );
  });

  it.each([
    [
      "cross-agent action",
      {
        ...actionInput("openclaw"),
        actions: [
          ...actionInput("openclaw").actions.slice(0, 1),
          { kind: "generate-agent-config", agent: "hermes", runAs: "sandbox" },
          ...actionInput("openclaw").actions.slice(2),
        ],
      },
      /action for hermes cannot be used by openclaw/,
    ],
    [
      "partial messaging plan",
      {
        ...actionInput("hermes"),
        actions: actionInput("hermes").actions.filter(
          (action) =>
            action.kind !== "apply-messaging-plan" || action.phase !== "post-agent-install",
        ),
      },
      /requires 1 action for each messaging phase/,
    ],
    [
      "duplicate config action",
      {
        ...actionInput("langchain-deepagents-code"),
        actions: [
          ...actionInput("langchain-deepagents-code").actions,
          {
            kind: "generate-agent-config",
            agent: "langchain-deepagents-code",
            runAs: "sandbox",
          },
        ],
      },
      /exactly one agent config/,
    ],
    [
      "out-of-order messaging",
      {
        ...actionInput("openclaw"),
        actions: [
          ...actionInput("openclaw").actions.slice(1, 3),
          actionInput("openclaw").actions[0],
          actionInput("openclaw").actions[3],
        ],
      },
      /not in the required construction order/,
    ],
    [
      "root config generation",
      {
        ...actionInput("hermes"),
        actions: actionInput("hermes").actions.map((action) =>
          action.kind === "generate-agent-config" ? { ...action, runAs: "root" } : action,
        ),
      },
      /configuration generation must run as sandbox/,
    ],
    [
      "sandbox messaging runtime setup",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.map((action) =>
          action.kind === "apply-messaging-plan" && action.phase === "runtime-setup"
            ? { ...action, runAs: "sandbox" }
            : action,
        ),
      },
      /messaging runtime setup must run as root/,
    ],
    [
      "root messaging post-agent configuration",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.map((action) =>
          action.kind === "apply-messaging-plan" && action.phase === "post-agent-install"
            ? { ...action, runAs: "root" }
            : action,
        ),
      },
      /messaging post-agent configuration must run as sandbox/,
    ],
    [
      "arbitrary command action",
      {
        ...actionInput("langchain-deepagents-code"),
        actions: [
          ...actionInput("langchain-deepagents-code").actions,
          { kind: "run-command", argv: ["npm", "install"] },
        ],
      },
      /unsupported managed startup construction action/,
    ],
    [
      "missing dashboard",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.filter(
          (action) => action.kind !== "configure-dashboard",
        ),
      },
      /exactly one dashboard construction action/,
    ],
    [
      "duplicate dashboard",
      {
        ...actionInput("hermes"),
        actions: [...actionInput("hermes").actions, actionInput("hermes").actions.at(-1)!],
      },
      /exactly one dashboard construction action/,
    ],
    [
      "mismatched dashboard",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.map((action) =>
          action.kind === "configure-dashboard"
            ? { ...action, dashboard: dashboard("hermes") }
            : action,
        ),
      },
      /dashboard for hermes cannot be used by openclaw/,
    ],
    [
      "unknown image agent",
      { ...actionInput("openclaw"), agent: "unknown-agent" },
      /unsupported agent "unknown-agent"/,
    ],
    [
      "invalid messaging mode",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.map((action) =>
          action.kind === "apply-messaging-plan" ? { ...action, mode: "replace" } : action,
        ),
      },
      /messaging intent must be apply or clear/,
    ],
  ])("fails closed for an incomplete or mismatched construction contract: %s", (_name, input, message) => {
    expect(() =>
      buildManagedStartupImageActionPlan(input as ManagedStartupImageActionPlanInput),
    ).toThrow(message);
  });
});

describe("managed startup image runtime", () => {
  const policyTemporaryDirectories: string[] = [];

  function temporaryPolicyDirectory(): string {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "nemoclaw-managed-policy-"));
    policyTemporaryDirectories.push(directory);
    return directory;
  }

  beforeEach(() => {
    childProcessMock.spawnSync.mockReset().mockReturnValue({ error: undefined, status: 0 });
    coordinatorMock.coordinateManagedStartupApplication.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of policyTemporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("verifies copied transaction status only through a read-only receipt mount", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const profileFingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const status = vi
      .spyOn(sharedStateTransaction, "getManagedStartupSharedStateTransactionStatus")
      .mockReturnValue("pending");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    await mainManagedStartupImageRuntime([
      "--shared-state-transaction-status",
      "--agent",
      profile.agent,
      "--profile-fingerprint",
      profileFingerprint,
      "--bootstrap-identity",
      bootstrapIdentity,
      "--read-only-receipt",
    ]);

    expect(status).toHaveBeenCalledWith(
      {
        agent: profile.agent,
        profileFingerprint,
        bootstrapIdentity,
      },
      { readOnlyReceipt: true },
    );
    expect(write).toHaveBeenCalledWith("pending\n");
  });

  function mockRootOwnedPolicyInstallPaths(
    source: string,
    shareDirectory: string,
    target: string,
    beforeSourceCleanup?: () => void,
  ): void {
    const realLstatSync = fs.lstatSync.bind(fs);
    const rootOwned = (stat: fs.Stats): fs.Stats =>
      new Proxy(stat, {
        get(inner, property) {
          const value = property === "uid" || property === "gid" ? 0 : Reflect.get(inner, property);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    vi.spyOn(fs, "lstatSync").mockImplementation(((
      file: fs.PathLike,
      options?: { bigint?: boolean },
    ) => {
      const sourceCleanupHook =
        file.toString() === source && options?.bigint === true ? beforeSourceCleanup : undefined;
      sourceCleanupHook?.();
      const stat = options?.bigint ? realLstatSync(file, { bigint: true }) : realLstatSync(file);
      const rootPath = file.toString() === shareDirectory || file.toString() === target;
      return rootPath && options?.bigint !== true ? rootOwned(stat as fs.Stats) : stat;
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "fchownSync").mockImplementation(() => undefined);
  }

  it("promotes generated Hermes policy to one root-owned, read-only runtime artifact", () => {
    const directory = temporaryPolicyDirectory();
    const shareDirectory = path.join(directory, "share");
    const source = path.join(directory, "managed-policy.json");
    const target = path.join(shareDirectory, "hermes-managed-policy.json");
    const policy = '{"schema_version":1}\n';
    fs.mkdirSync(shareDirectory);
    fs.writeFileSync(source, policy, { mode: 0o600 });
    mockRootOwnedPolicyInstallPaths(source, shareDirectory, target);

    installHermesManagedPolicy(source, target);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(policy);
    expect(fs.statSync(target).mode & 0o777).toBe(0o444);
  });

  it("preserves generated Hermes policy when it changes before source cleanup", () => {
    const directory = temporaryPolicyDirectory();
    const shareDirectory = path.join(directory, "share");
    const source = path.join(directory, "managed-policy.json");
    const target = path.join(shareDirectory, "hermes-managed-policy.json");
    const policy = '{"schema_version":1}\n';
    fs.mkdirSync(shareDirectory);
    fs.writeFileSync(source, policy, { mode: 0o600 });
    mockRootOwnedPolicyInstallPaths(source, shareDirectory, target, () => {
      fs.appendFileSync(source, "changed\n");
    });

    expect(() => installHermesManagedPolicy(source, target)).toThrow(
      /changed before source cleanup/u,
    );
    expect(fs.readFileSync(source, "utf8")).toBe(`${policy}changed\n`);
    expect(fs.readFileSync(target, "utf8")).toBe(policy);
  });

  it("verifies a host-copied transaction only through the explicit read-only receipt mode", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const profileFingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const status = vi
      .spyOn(sharedStateTransaction, "getManagedStartupSharedStateTransactionStatus")
      .mockReturnValue("pending");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await mainManagedStartupImageRuntime([
      "--shared-state-transaction-status",
      "--agent",
      profile.agent,
      "--profile-fingerprint",
      profileFingerprint,
      "--bootstrap-identity",
      bootstrapIdentity,
      "--read-only-receipt",
    ]);

    expect(status).toHaveBeenCalledWith(
      { agent: profile.agent, profileFingerprint, bootstrapIdentity },
      { readOnlyReceipt: true },
    );
    expect(write).toHaveBeenCalledWith("pending\n");
  });

  it("rejects invalid OpenClaw launch controls before filesystem or coordinator mutation", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const request = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile: encodeManagedStartupProfile(profile),
    });
    const lstat = vi.spyOn(fs, "lstatSync");
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    await expect(
      applyManagedStartupRootRequest(request, {
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "NaN",
      }),
    ).rejects.toThrow(/finite positive seconds/u);
    expect(lstat).not.toHaveBeenCalled();
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown live agent", "unknown-agent", "openclaw", /unsupported agent "unknown-agent"/u],
    [
      "configured and live agent mismatch",
      "hermes",
      "openclaw",
      /managed startup profile targets openclaw, expected hermes/u,
    ],
  ] as const)("rejects %s before filesystem or coordinator mutation", async (_label, expectedAgent, profileAgent, message) => {
    const profile = managedStartupE2eProfile(profileAgent);
    const lstat = vi.spyOn(fs, "lstatSync");
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    await expect(
      applyManagedStartupImageProfile(expectedAgent, {
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
        [MANAGED_STARTUP_PROFILE_ENV]: encodeManagedStartupProfile(profile),
      }),
    ).rejects.toThrow(message);
    expect(lstat).not.toHaveBeenCalled();
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
  });

  it("refreshes admitted launch controls on committed replay without changing the profile", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const runtimeWrites: string[] = [];
    mockRootReplayFilesystem(runtimeWrites);
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });

    const first = await applyManagedStartupImageProfile("openclaw", {
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
      [MANAGED_STARTUP_PROFILE_ENV]: encodedProfile,
    });
    const second = await applyManagedStartupRootRequest(
      createManagedStartupRootApplyRequest({
        agent: profile.agent,
        encodedProfile,
      }),
      {
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "5",
      },
    );

    expect(first).toMatchObject({ adapterApplied: false, fingerprint });
    expect(second).toMatchObject({
      adapterApplied: false,
      fingerprint,
      transactionPending: false,
    });
    expect(runtimeWrites).toHaveLength(2);
    expect(runtimeWrites[0]).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS='3'");
    expect(runtimeWrites[1]).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS='5'");
    expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledTimes(2);
  });

  it("publishes bootstrap completion only after application and preserves attempt identity", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const requestFile = MANAGED_BOOTSTRAP_REQUEST_FILE;
    const completionFile = MANAGED_BOOTSTRAP_COMPLETION_FILE;
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          requestFile,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    const beginTransaction = vi
      .spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction")
      .mockReturnValue(true);
    coordinatorMock.coordinateManagedStartupApplication.mockImplementation(async () => {
      expect(filesystem.hasFile(completionFile)).toBe(false);
      return {
        adapterApplied: false,
        application: {
          status: "committed",
          stateDirectory: "/var/lib/nemoclaw/managed-startup",
          generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
          profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
          corporateCaPath: null,
          fingerprint,
          expectedAgent: "openclaw",
          profile,
        },
      };
    });

    await expect(
      applyManagedBootstrapEnvelope(
        { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity },
        {},
        requestFile,
        completionFile,
      ),
    ).resolves.toMatchObject({ fingerprint, transactionPending: true });

    expect(filesystem.hasFile(requestFile)).toBe(false);
    expect(beginTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ agent: profile.agent }),
      { bootstrapIdentity },
    );
    expect(
      fingerprintManagedStartupProfile(
        beginTransaction.mock.calls[0]?.[0] as ManagedStartupProfile,
      ),
    ).toBe(fingerprint);
    expect(parseManagedBootstrapImageCompletion(filesystem.readFile(completionFile) ?? "")).toEqual(
      {
        schemaVersion: MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION,
        agent: profile.agent,
        bootstrapIdentity,
        profileFingerprint: fingerprint,
        transactionPending: true,
      },
    );
  });

  it("applies and verifies bootstrap completion through the CLI modes", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    mockRootReplayFilesystem(
      [],
      new Map([
        [
          MANAGED_BOOTSTRAP_REQUEST_FILE,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
      true,
    );
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("pending");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cliArguments = [
      "--agent",
      profile.agent,
      "--profile-fingerprint",
      fingerprint,
      "--bootstrap-identity",
      bootstrapIdentity,
    ];

    await mainManagedBootstrapImageRuntime(["--apply-bootstrap-file", ...cliArguments]);
    expect(log).toHaveBeenLastCalledWith(
      `[managed-startup] applied ${profile.agent} profile ${fingerprint}; transaction pending`,
    );
    await mainManagedBootstrapImageRuntime(["--verify-bootstrap-completion", ...cliArguments]);
    expect(log).toHaveBeenLastCalledWith(
      `[managed-startup] verified ${profile.agent} profile ${fingerprint} bootstrap ${bootstrapIdentity}; transaction pending`,
    );
  });

  it.each([
    ["unsafe metadata", 0o444, "b".repeat(64), /mode 0400/u],
    ["mismatched identity", 0o400, "c".repeat(64), /identity does not match/u],
  ])("rejects bootstrap envelope %s without consuming the canonical request", async (_label, mode, envelopeIdentity, error) => {
    const profile = managedStartupE2eProfile("openclaw");
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const request = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: envelopeIdentity,
      rootApplyRequest: createManagedStartupRootApplyRequest({
        agent: profile.agent,
        encodedProfile: encodeManagedStartupProfile(profile),
      }),
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([[MANAGED_BOOTSTRAP_REQUEST_FILE, { contents: request, mode }]]),
    );

    await expect(applyManagedBootstrapEnvelope(expected, {})).rejects.toThrow(error);
    expect(filesystem.readFile(MANAGED_BOOTSTRAP_REQUEST_FILE)).toBe(request);
    expect(filesystem.hasFile(managedBootstrapEnvelopeClaimPaths().file)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
  });

  it("retains the exact bootstrap request after failure and consumes it after a successful retry", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const requestFile = MANAGED_BOOTSTRAP_REQUEST_FILE;
    const completionFile = MANAGED_BOOTSTRAP_COMPLETION_FILE;
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          requestFile,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest: createManagedStartupRootApplyRequest({
                agent: profile.agent,
                encodedProfile,
              }),
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
      true,
    );
    coordinatorMock.coordinateManagedStartupApplication
      .mockRejectedValueOnce(new Error("application failed"))
      .mockResolvedValue({
        adapterApplied: false,
        application: {
          status: "committed",
          stateDirectory: "/var/lib/nemoclaw/managed-startup",
          generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
          profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
          corporateCaPath: null,
          fingerprint,
          expectedAgent: "openclaw",
          profile,
        },
      });

    await expect(
      applyManagedBootstrapEnvelope(
        { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity },
        {},
        requestFile,
        completionFile,
      ),
    ).rejects.toThrow("application failed");
    const claim = managedBootstrapEnvelopeClaimPaths(requestFile);
    expect(filesystem.hasFile(requestFile)).toBe(false);
    expect(filesystem.hasFile(claim.file)).toBe(true);
    fs.chmodSync(path.dirname(claim.directory), 0o777);
    expect(() => recoverManagedBootstrapEnvelopeClaim(expected, requestFile)).toThrow(
      "claim parent must be a protected root-owned directory",
    );
    fs.chmodSync(path.dirname(claim.directory), 0o755);
    expect(
      recoverManagedBootstrapEnvelopeClaim(
        { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity },
        requestFile,
      ),
    ).toBe(true);
    expect(filesystem.hasFile(completionFile)).toBe(false);

    await expect(
      applyManagedBootstrapEnvelope(
        { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity },
        {},
        requestFile,
        completionFile,
      ),
    ).resolves.toMatchObject({ fingerprint, transactionPending: true });
    expect(filesystem.hasFile(requestFile)).toBe(false);
    expect(filesystem.hasFile(claim.file)).toBe(false);
    expect(
      parseManagedBootstrapImageCompletion(filesystem.readFile(completionFile) ?? ""),
    ).toMatchObject({
      agent: profile.agent,
      bootstrapIdentity,
      profileFingerprint: fingerprint,
      transactionPending: true,
    });
    expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "default",
      requestFile: MANAGED_BOOTSTRAP_REQUEST_FILE,
      completionFile: MANAGED_BOOTSTRAP_COMPLETION_FILE,
      apply: (expected: ManagedBootstrapImageRuntimeExpected) =>
        applyManagedBootstrapEnvelope(expected, {}),
    },
    {
      label: "injected",
      requestFile: "/run/nemoclaw/injected-managed-bootstrap-request.json",
      completionFile: "/run/nemoclaw/injected-managed-bootstrap-completion.json",
      apply: (expected: ManagedBootstrapImageRuntimeExpected) =>
        applyManagedBootstrapEnvelope(
          expected,
          {},
          "/run/nemoclaw/injected-managed-bootstrap-request.json",
          "/run/nemoclaw/injected-managed-bootstrap-completion.json",
        ),
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly requestFile: string;
    readonly completionFile: string;
    readonly apply: (expected: ManagedBootstrapImageRuntimeExpected) => Promise<unknown>;
  }>)("preserves a newly staged $label request after claiming the exact attempt", async ({
    requestFile,
    completionFile,
    apply,
  }) => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const replacement = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: "c".repeat(64),
      rootApplyRequest,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          requestFile,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
      true,
    );
    coordinatorMock.coordinateManagedStartupApplication.mockImplementation(async () => {
      filesystem.writeFile(requestFile, replacement, 0o400);
      return {
        adapterApplied: false,
        application: {
          status: "committed",
          stateDirectory: "/var/lib/nemoclaw/managed-startup",
          generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
          profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
          corporateCaPath: null,
          fingerprint,
          expectedAgent: "openclaw",
          profile,
        },
      };
    });

    await expect(apply(expected)).resolves.toMatchObject({
      fingerprint,
      transactionPending: true,
    });
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(
      parseManagedBootstrapImageCompletion(filesystem.readFile(completionFile) ?? ""),
    ).toMatchObject({ bootstrapIdentity, profileFingerprint: fingerprint });
    expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "default",
      requestFile: MANAGED_BOOTSTRAP_REQUEST_FILE,
      completionFile: MANAGED_BOOTSTRAP_COMPLETION_FILE,
    },
    {
      label: "injected",
      requestFile: "/run/nemoclaw/preclaim-managed-bootstrap-request.json",
      completionFile: "/run/nemoclaw/preclaim-managed-bootstrap-completion.json",
    },
  ])("preserves a pre-claim $label replacement without publishing completion", async ({
    requestFile,
    completionFile,
  }) => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const replacement = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: "c".repeat(64),
      rootApplyRequest,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          requestFile,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    const claim = managedBootstrapEnvelopeClaimPaths(requestFile);
    filesystem.beforeRename(
      observeMatchingRename(requestFile, claim.file, () => {
        filesystem.writeFile(requestFile, replacement, 0o400);
      }),
    );

    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow(/changed before its atomic claim/u);
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(filesystem.hasFile(claim.file)).toBe(false);
    expect(filesystem.hasFile(completionFile)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
    expect(recoverManagedBootstrapEnvelopeClaim(expected, requestFile)).toBe(false);
  });

  it.each([
    {
      label: "default",
      requestFile: MANAGED_BOOTSTRAP_REQUEST_FILE,
      completionFile: MANAGED_BOOTSTRAP_COMPLETION_FILE,
    },
    {
      label: "injected",
      requestFile: "/run/nemoclaw/post-rename-managed-bootstrap-request.json",
      completionFile: "/run/nemoclaw/post-rename-managed-bootstrap-completion.json",
    },
  ])("restores a $label replacement after interruption immediately after claim rename", async ({
    requestFile,
    completionFile,
  }) => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const replacement = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: "c".repeat(64),
      rootApplyRequest,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          requestFile,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    const claim = managedBootstrapEnvelopeClaimPaths(requestFile);
    filesystem.beforeRename(
      observeMatchingRename(requestFile, claim.file, () => {
        filesystem.writeFile(requestFile, replacement, 0o400);
      }),
    );
    filesystem.afterRename(
      observeMatchingRename(requestFile, claim.file, () => {
        throw new Error("claim process interrupted");
      }),
    );

    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow(/could not atomically claim managed bootstrap envelope/u);
    expect(filesystem.hasFile(requestFile)).toBe(false);
    expect(filesystem.readFile(claim.file)).toBe(replacement);
    expect(filesystem.hasFile(completionFile)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();

    filesystem.afterRename(null);
    expect(recoverManagedBootstrapEnvelopeClaim(expected, requestFile)).toBe(true);
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(filesystem.linkCount(requestFile)).toBe(1n);
    expect(filesystem.hasFile(claim.file)).toBe(false);
    expect(filesystem.hasFile(completionFile)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "default",
      requestFile: MANAGED_BOOTSTRAP_REQUEST_FILE,
      completionFile: MANAGED_BOOTSTRAP_COMPLETION_FILE,
    },
    {
      label: "injected",
      requestFile: "/run/nemoclaw/interrupted-restore-managed-bootstrap-request.json",
      completionFile: "/run/nemoclaw/interrupted-restore-managed-bootstrap-completion.json",
    },
  ])("reconciles an interrupted $label pre-claim replacement restoration", async ({
    requestFile,
    completionFile,
  }) => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const replacementIdentity = "c".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const replacementExpected = {
      agent: profile.agent,
      profileFingerprint: fingerprint,
      bootstrapIdentity: replacementIdentity,
    };
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const replacement = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: replacementIdentity,
      rootApplyRequest,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          requestFile,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    const claim = managedBootstrapEnvelopeClaimPaths(requestFile);
    let interruptRestoration = true;
    filesystem.beforeRename(
      observeMatchingRename(requestFile, claim.file, () => {
        filesystem.writeFile(requestFile, replacement, 0o400);
      }),
    );
    filesystem.beforeUnlink(
      observeMatchingUnlink(
        claim.file,
        () => {
          throw new Error("restoration cleanup interrupted");
        },
        () => interruptRestoration,
      ),
    );

    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow(/could not remove restored managed bootstrap envelope/u);
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(filesystem.readFile(claim.file)).toBe(replacement);
    expect(filesystem.linkCount(requestFile)).toBe(2n);
    expect(filesystem.hasFile(completionFile)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();

    interruptRestoration = false;
    expect(recoverManagedBootstrapEnvelopeClaim(replacementExpected, requestFile)).toBe(true);
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(filesystem.linkCount(requestFile)).toBe(1n);
    expect(filesystem.hasFile(claim.file)).toBe(false);
    expect(filesystem.hasFile(completionFile)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
  });

  it("fails closed without clobbering a second replacement during claim restoration", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const displacedIdentity = "c".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const displacedExpected = {
      agent: profile.agent,
      profileFingerprint: fingerprint,
      bootstrapIdentity: displacedIdentity,
    };
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const displaced = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: displacedIdentity,
      rootApplyRequest,
    });
    const latest = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: "d".repeat(64),
      rootApplyRequest,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [
          MANAGED_BOOTSTRAP_REQUEST_FILE,
          {
            contents: serializeManagedBootstrapEnvelope({
              bootstrapIdentity,
              rootApplyRequest,
            }),
            mode: 0o400,
          },
        ],
      ]),
    );
    const claim = managedBootstrapEnvelopeClaimPaths();
    filesystem.beforeRename(
      observeMatchingRename(MANAGED_BOOTSTRAP_REQUEST_FILE, claim.file, () => {
        filesystem.writeFile(MANAGED_BOOTSTRAP_REQUEST_FILE, displaced, 0o400);
      }),
    );
    filesystem.beforeLink(
      observeMatchingLink(claim.file, MANAGED_BOOTSTRAP_REQUEST_FILE, () => {
        filesystem.writeFile(MANAGED_BOOTSTRAP_REQUEST_FILE, latest, 0o400);
      }),
    );

    await expect(applyManagedBootstrapEnvelope(expected, {})).rejects.toThrow(
      /canonical managed bootstrap request was replaced again/u,
    );
    expect(filesystem.readFile(MANAGED_BOOTSTRAP_REQUEST_FILE)).toBe(latest);
    expect(filesystem.readFile(claim.file)).toBe(displaced);
    expect(filesystem.linkCount(MANAGED_BOOTSTRAP_REQUEST_FILE)).toBe(1n);
    expect(filesystem.linkCount(claim.file)).toBe(1n);
    expect(filesystem.hasFile(MANAGED_BOOTSTRAP_COMPLETION_FILE)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
    expect(recoverManagedBootstrapEnvelopeClaim(displacedExpected)).toBe(true);
    expect(filesystem.readFile(MANAGED_BOOTSTRAP_REQUEST_FILE)).toBe(latest);
    expect(filesystem.readFile(claim.file)).toBe(displaced);
  });

  it.each([
    {
      label: "default",
      requestFile: MANAGED_BOOTSTRAP_REQUEST_FILE,
      completionFile: MANAGED_BOOTSTRAP_COMPLETION_FILE,
    },
    {
      label: "injected",
      requestFile: "/run/nemoclaw/failure-managed-bootstrap-request.json",
      completionFile: "/run/nemoclaw/failure-managed-bootstrap-completion.json",
    },
  ])("keeps the $label private claim across completion failure and a new canonical request", async ({
    requestFile,
    completionFile,
  }) => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.agent,
      encodedProfile,
    });
    const original = serializeManagedBootstrapEnvelope({ bootstrapIdentity, rootApplyRequest });
    const replacement = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: "c".repeat(64),
      rootApplyRequest,
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([[requestFile, { contents: original, mode: 0o400 }]]),
    );
    const claim = managedBootstrapEnvelopeClaimPaths(requestFile);
    vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
      true,
    );
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });
    filesystem.beforeRename(
      observeMatchingRenameTarget(completionFile, () => {
        filesystem.writeFile(requestFile, replacement, 0o400);
        throw new Error("completion publication interrupted");
      }),
    );

    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow("could not atomically write");
    expect(filesystem.readFile(claim.file)).toBe(original);
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(filesystem.hasFile(completionFile)).toBe(false);

    filesystem.beforeRename(null);
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("pending");
    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).resolves.toMatchObject({ fingerprint, transactionPending: true });
    expect(filesystem.hasFile(claim.file)).toBe(false);
    expect(filesystem.readFile(requestFile)).toBe(replacement);
    expect(
      parseManagedBootstrapImageCompletion(filesystem.readFile(completionFile) ?? ""),
    ).toMatchObject({ bootstrapIdentity, profileFingerprint: fingerprint });
  });

  it("recovers an empty claim directory and a completion-published claim cleanup interruption", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const expected = { agent: profile.agent, profileFingerprint: fingerprint, bootstrapIdentity };
    const requestFile = "/run/nemoclaw/crash-managed-bootstrap-request.json";
    const completionFile = "/run/nemoclaw/crash-managed-bootstrap-completion.json";
    const original = serializeManagedBootstrapEnvelope({
      bootstrapIdentity,
      rootApplyRequest: createManagedStartupRootApplyRequest({
        agent: profile.agent,
        encodedProfile,
      }),
    });
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([[requestFile, { contents: original, mode: 0o400 }]]),
    );
    const claim = managedBootstrapEnvelopeClaimPaths(requestFile);
    let interruptClaim = true;
    filesystem.beforeRename(
      observeMatchingRename(
        requestFile,
        claim.file,
        () => {
          throw new Error("claim interrupted");
        },
        () => interruptClaim,
      ),
    );
    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow("could not atomically claim");
    expect(recoverManagedBootstrapEnvelopeClaim(expected, requestFile)).toBe(true);

    interruptClaim = false;
    vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
      true,
    );
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });
    let interruptCleanup = true;
    filesystem.beforeUnlink(
      observeMatchingUnlink(
        claim.file,
        () => {
          throw new Error("claim cleanup interrupted");
        },
        () => interruptCleanup,
      ),
    );
    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow("could not consume managed bootstrap envelope claim");
    expect(filesystem.hasFile(completionFile)).toBe(true);
    expect(filesystem.hasFile(claim.file)).toBe(true);

    interruptCleanup = false;
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("pending");
    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).resolves.toMatchObject({ fingerprint, transactionPending: true });
    expect(filesystem.hasFile(claim.file)).toBe(false);
    expect(filesystem.hasFile(completionFile)).toBe(true);
  });

  it.each([
    ["pending", true],
    ["committed", false],
  ] as const)("binds a completed profile replay to its %s bootstrap transaction", async (status, transactionPending) => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    mockRootReplayFilesystem([]);
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });
    await applyManagedStartupImageProfile("openclaw", {
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      [MANAGED_STARTUP_PROFILE_ENV]: encodedProfile,
    });
    const statusProbe = vi
      .spyOn(sharedStateTransaction, "getManagedStartupSharedStateTransactionStatus")
      .mockReturnValue(status);

    const result = await applyManagedStartupRootRequest(
      createManagedStartupRootApplyRequest({ agent: profile.agent, encodedProfile }),
      {},
      { bootstrapIdentity },
    );

    expect(result).toMatchObject({ fingerprint, transactionPending });
    expect(statusProbe).toHaveBeenCalledWith({
      agent: "openclaw",
      profileFingerprint: fingerprint,
      bootstrapIdentity,
    });
  });

  it("rejects a completed profile that has no authority for the bootstrap attempt", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    mockRootReplayFilesystem([]);
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });
    await applyManagedStartupImageProfile("openclaw", {
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      [MANAGED_STARTUP_PROFILE_ENV]: encodedProfile,
    });
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("none");

    await expect(
      applyManagedStartupRootRequest(
        createManagedStartupRootApplyRequest({ agent: profile.agent, encodedProfile }),
        {},
        { bootstrapIdentity: "b".repeat(64) },
      ),
    ).rejects.toThrow(/no shared-state authority/u);
    expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledTimes(1);
  });
});
