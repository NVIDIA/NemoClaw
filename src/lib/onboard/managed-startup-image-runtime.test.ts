// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMock = vi.hoisted(() => ({
  coordinateManagedStartupApplication: vi.fn(),
}));
vi.mock("./managed-startup/coordinator", () => coordinatorMock);

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
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
  MANAGED_STARTUP_PROFILE_ENV,
  MANAGED_STARTUP_RUNTIME_ENV_FILE,
  type ManagedStartupImageActionPlanInput,
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
  }
}

function actionInput(
  agent: ManagedStartupAgent,
  mode: "apply" | "clear" = "apply",
): ManagedStartupImageActionPlanInput {
  const messagingActions =
    agent === "langchain-deepagents-code"
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
  beforeEach(() => {
    coordinatorMock.coordinateManagedStartupApplication.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockRootReplayFilesystem(
    runtimeWrites: string[],
    seededFiles: ReadonlyMap<
      string,
      { readonly contents: string | Buffer; readonly mode: number }
    > = new Map(),
  ): {
    readonly beforeRename: (callback: ((source: string, target: string) => void) | null) => void;
    readonly beforeUnlink: (callback: ((target: string) => void) | null) => void;
    readonly hasFile: (target: string) => boolean;
    readonly readFile: (target: string) => string | null;
    readonly writeFile: (target: string, contents: string | Buffer, mode: number) => void;
  } {
    const directories = new Set([
      "/",
      "/run",
      "/run/nemoclaw",
      "/var",
      "/var/lib",
      "/var/lib/nemoclaw",
    ]);
    const files: Map<string, Buffer> = new Map(
      [...seededFiles].map(([target, file]) => [
        target,
        Buffer.isBuffer(file.contents)
          ? Buffer.from(file.contents)
          : Buffer.from(file.contents, "utf8"),
      ]),
    );
    const directoryModes = new Map([...directories].map((target) => [target, 0o755]));
    const fileModes = new Map([...seededFiles].map(([target, file]) => [target, file.mode]));
    let nextFileInode = 2n;
    const fileInodes = new Map<string, bigint>();
    const fileCtimes = new Map<string, bigint>();
    for (const target of files.keys()) {
      fileInodes.set(target, nextFileInode);
      fileCtimes.set(target, 1n);
      nextFileInode += 1n;
    }
    const descriptorTargets = new Map<number, string>();
    const descriptorSnapshots = new Map<
      number,
      {
        readonly bytes: Buffer;
        readonly ctimeNs: bigint;
        readonly ino: bigint;
        readonly mode: number;
      }
    >();
    const pendingFiles = new Map<string, Buffer>();
    const pendingModes = new Map<string, number>();
    let renameObserver: ((source: string, target: string) => void) | null = null;
    let unlinkObserver: ((target: string) => void) | null = null;
    let nextDescriptor = 91;
    const stat = (kind: "directory" | "file", mode: number) =>
      ({
        gid: 0,
        isDirectory: () => kind === "directory",
        isFile: () => kind === "file",
        isSymbolicLink: () => false,
        mode,
        nlink: 1,
        uid: 0,
      }) as fs.Stats;
    const bigDirectoryStat = (target: string) =>
      ({
        ctimeNs: 1n,
        dev: 1n,
        gid: 0n,
        ino: 1n,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
        mode: BigInt(0o040000 | (directoryModes.get(target) ?? 0o755)),
        mtimeNs: 1n,
        nlink: 1n,
        size: 0n,
        uid: 0n,
      }) as fs.BigIntStats;
    const bigFileStat = (bytes: Buffer, mode: number, ino: bigint, ctimeNs: bigint) =>
      ({
        ctimeNs,
        dev: 1n,
        gid: 0n,
        ino,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: BigInt(0o100000 | mode),
        mtimeNs: 1n,
        nlink: 1n,
        size: BigInt(bytes.length),
        uid: 0n,
      }) as fs.BigIntStats;
    const missing = (): never => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const allocateDescriptor = (resolved: string, mode = 0o600): number => {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      descriptorTargets.set(descriptor, resolved);
      pendingModes.set(resolved, mode);
      return descriptor;
    };
    const deleteExistingFile = (resolved: string): void => {
      void (files.get(resolved) ?? missing());
      files.delete(resolved);
      fileInodes.delete(resolved);
      fileCtimes.delete(resolved);
      fileModes.delete(resolved);
    };

    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.spyOn(fs, "lstatSync").mockImplementation(((
      target: fs.PathLike,
      options?: { bigint?: boolean },
    ) => {
      const resolved = String(target);
      const bytes = files.get(resolved);
      const mode = fileModes.get(resolved) ?? 0o444;
      return directories.has(resolved)
        ? options?.bigint
          ? bigDirectoryStat(resolved)
          : stat("directory", directoryModes.get(resolved) ?? 0o755)
        : bytes === undefined
          ? missing()
          : options?.bigint
            ? bigFileStat(
                bytes,
                mode,
                fileInodes.get(resolved) ?? missing(),
                fileCtimes.get(resolved) ?? missing(),
              )
            : stat("file", mode);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((
      target: fs.PathLike,
      options?: { mode?: number },
    ) => {
      const resolved = String(target);
      if (directories.has(resolved) || files.has(resolved)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      directories.add(resolved);
      directoryModes.set(resolved, options?.mode ?? 0o777);
      return undefined;
    }) as typeof fs.mkdirSync);
    vi.spyOn(fs, "chownSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "chmodSync").mockImplementation(((target: fs.PathLike, mode: fs.Mode) => {
      const resolved = String(target);
      const numeric = typeof mode === "number" ? mode : Number.parseInt(mode, 8);
      if (directories.has(resolved)) directoryModes.set(resolved, numeric);
      else if (files.has(resolved)) fileModes.set(resolved, numeric);
      else missing();
    }) as typeof fs.chmodSync);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags, mode) => {
      const resolved = String(target);
      const creates =
        typeof flags === "number" ? (flags & fs.constants.O_CREAT) !== 0 : /[awx]/u.test(flags);
      if (!creates && !files.has(resolved) && !directories.has(resolved)) missing();
      const descriptor = allocateDescriptor(resolved, typeof mode === "number" ? mode : 0o600);
      const bytes = files.get(resolved);
      if (bytes !== undefined) {
        descriptorSnapshots.set(descriptor, {
          bytes: Buffer.from(bytes),
          ctimeNs: fileCtimes.get(resolved) ?? missing(),
          ino: fileInodes.get(resolved) ?? missing(),
          mode: fileModes.get(resolved) ?? 0o444,
        });
      }
      return descriptor;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number) => {
      const snapshot = descriptorSnapshots.get(descriptor);
      if (snapshot !== undefined) {
        return bigFileStat(snapshot.bytes, snapshot.mode, snapshot.ino, snapshot.ctimeNs);
      }
      const target = descriptorTargets.get(descriptor);
      const bytes = target === undefined ? undefined : files.get(target);
      return bytes === undefined
        ? missing()
        : bigFileStat(
            bytes,
            fileModes.get(target as string) ?? 0o444,
            fileInodes.get(target as string) ?? missing(),
            fileCtimes.get(target as string) ?? missing(),
          );
    }) as typeof fs.fstatSync);
    vi.spyOn(fs, "readSync").mockImplementation(((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const target = descriptorTargets.get(descriptor);
      const bytes =
        descriptorSnapshots.get(descriptor)?.bytes ??
        (target === undefined ? undefined : files.get(target)) ??
        missing();
      const start = position ?? 0;
      const count = Math.min(length, Math.max(0, bytes.length - start));
      bytes.copy(buffer as Buffer, offset, start, start + count);
      return count;
    }) as typeof fs.readSync);
    vi.spyOn(fs, "fchownSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, value) => {
      const resolved =
        (typeof target === "number" ? descriptorTargets.get(target) : undefined) ?? missing();
      pendingFiles.set(
        resolved,
        Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8"),
      );
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "fchmodSync").mockImplementation((descriptor, mode) => {
      const target = descriptorTargets.get(descriptor) ?? missing();
      pendingModes.set(target, typeof mode === "number" ? mode : Number.parseInt(mode, 8));
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      descriptorSnapshots.delete(descriptor);
      descriptorTargets.delete(descriptor);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      const resolvedSource = String(source);
      const resolvedTarget = String(target);
      renameObserver?.(resolvedSource, resolvedTarget);
      const pending = pendingFiles.get(resolvedSource);
      if (pending !== undefined) {
        if (files.has(resolvedTarget)) deleteExistingFile(resolvedTarget);
        files.set(resolvedTarget, pending);
        fileInodes.set(resolvedTarget, nextFileInode);
        fileCtimes.set(resolvedTarget, 1n);
        nextFileInode += 1n;
        fileModes.set(resolvedTarget, pendingModes.get(resolvedSource) ?? 0o444);
        pendingFiles.delete(resolvedSource);
        pendingModes.delete(resolvedSource);
      } else {
        const sourceBytes = files.get(resolvedSource) ?? missing();
        const sourceInode = fileInodes.get(resolvedSource) ?? missing();
        const sourceMode = fileModes.get(resolvedSource) ?? missing();
        const sourceCtime = fileCtimes.get(resolvedSource) ?? missing();
        if (files.has(resolvedTarget)) deleteExistingFile(resolvedTarget);
        files.set(resolvedTarget, sourceBytes);
        fileInodes.set(resolvedTarget, sourceInode);
        fileModes.set(resolvedTarget, sourceMode);
        fileCtimes.set(resolvedTarget, sourceCtime + 1n);
        for (const [descriptor, snapshot] of descriptorSnapshots) {
          if (snapshot.ino === sourceInode) {
            descriptorSnapshots.set(descriptor, { ...snapshot, ctimeNs: sourceCtime + 1n });
          }
        }
        files.delete(resolvedSource);
        fileInodes.delete(resolvedSource);
        fileModes.delete(resolvedSource);
        fileCtimes.delete(resolvedSource);
      }
      runtimeWrites.push(
        ...(resolvedTarget === MANAGED_STARTUP_RUNTIME_ENV_FILE
          ? [(files.get(resolvedTarget) ?? missing()).toString("utf8")]
          : []),
      );
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
      const resolved = String(target);
      unlinkObserver?.(resolved);
      const removedPendingFile = pendingFiles.delete(resolved);
      pendingModes.delete(resolved);
      if (removedPendingFile) return;
      deleteExistingFile(resolved);
    }) as typeof fs.unlinkSync);
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike) => {
      const resolved = String(target);
      if (!directories.has(resolved)) return missing();
      const prefix = `${resolved}/`;
      return [...files.keys(), ...directories]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .filter((entry) => entry.length > 0 && !entry.includes("/"));
    }) as typeof fs.readdirSync);
    vi.spyOn(fs, "rmdirSync").mockImplementation(((target: fs.PathLike) => {
      const resolved = String(target);
      if (!directories.has(resolved)) return missing();
      const prefix = `${resolved}/`;
      if (
        [...files.keys(), ...directories].some(
          (entry) => entry !== resolved && entry.startsWith(prefix),
        )
      ) {
        throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
      }
      directories.delete(resolved);
      directoryModes.delete(resolved);
    }) as typeof fs.rmdirSync);

    return {
      beforeRename: (callback) => {
        renameObserver = callback;
      },
      beforeUnlink: (callback) => {
        unlinkObserver = callback;
      },
      hasFile: (target) => files.has(target),
      readFile: (target) => files.get(target)?.toString("utf8") ?? null,
      writeFile: (target, contents, mode) => {
        files.set(
          target,
          Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8"),
        );
        fileInodes.set(target, nextFileInode);
        fileCtimes.set(target, 1n);
        nextFileInode += 1n;
        fileModes.set(target, mode);
      },
    };
  }

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
    filesystem.beforeRename((source, target) => {
      if (source === requestFile && target === claim.file) {
        filesystem.writeFile(requestFile, replacement, 0o400);
      }
    });

    await expect(
      applyManagedBootstrapEnvelope(expected, {}, requestFile, completionFile),
    ).rejects.toThrow(/changed before its atomic claim/u);
    expect(filesystem.hasFile(requestFile)).toBe(false);
    expect(filesystem.readFile(claim.file)).toBe(replacement);
    expect(filesystem.hasFile(completionFile)).toBe(false);
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
    expect(() => recoverManagedBootstrapEnvelopeClaim(expected, requestFile)).toThrow(
      "identity does not match",
    );
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
    filesystem.beforeRename((_source, target) => {
      if (target === completionFile) {
        filesystem.writeFile(requestFile, replacement, 0o400);
        throw new Error("completion publication interrupted");
      }
    });

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
    filesystem.beforeRename((source, target) => {
      if (interruptClaim && source === requestFile && target === claim.file) {
        throw new Error("claim interrupted");
      }
    });
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
    filesystem.beforeUnlink((target) => {
      if (interruptCleanup && target === claim.file) {
        throw new Error("claim cleanup interrupted");
      }
    });
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
