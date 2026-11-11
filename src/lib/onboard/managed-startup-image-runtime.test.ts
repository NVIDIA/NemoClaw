// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  switchyardBindingFixture,
  switchyardRoutingFixture,
} from "../../../test/helpers/hermes-switchyard";
import {
  encodeSwitchyardProviderBindings,
  HERMES_SWITCHYARD_BINDINGS_ENV,
} from "../hermes-switchyard-routing";

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
  delegatedRequest,
  preparedApplication,
  mockRootOwnedPolicyInstallPaths,
  mockRootReplayFilesystem,
} from "../../../test/helpers/managed-startup-root-replay-filesystem";
import {
  applyManagedStartupImageProfile,
  applyManagedStartupRootRequest,
  applyManagedStartupOwnerRequest,
  prepareManagedStartupDelegatedRequest,
  finishManagedStartupDelegatedRequest,
  installHermesManagedPolicy,
  installHermesSwitchyardRoutingFiles,
  MANAGED_STARTUP_COMPLETION_FILE,
  MANAGED_STARTUP_PROFILE_ENV,
  MANAGED_STARTUP_RUNTIME_ENV_FILE,
  normalizeManagedStartupWorkspaceRoot,
  publishManagedStartupCompletionAfterCommit,
  main as mainManagedStartupImageRuntime,
  verifyHermesSwitchyardRoutingFiles,
} from "./managed-startup/image-runtime";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_ROUTING_ENV,
  HERMES_RELAY_PLUGINS_FILE,
  HERMES_RELAY_PLUGIN_STATE_FILE,
  HERMES_SWITCHYARD_DEPLOYMENT_FILE,
  serializeHermesSwitchyardRouting,
} from "../hermes-switchyard-routing";
import {
  encodeManagedStartupProfile,
  decodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
} from "./managed-startup/profile";
import {
  createManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "./managed-startup/root-apply";
import * as sharedStateTransaction from "./managed-startup/shared-state-transaction";
import * as application from "./managed-startup/application";
import { managedImageRuntimeIdentity } from "./managed-image/agents";

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

  function stdin(text: string) {
    const input = Buffer.from(text);
    let offset = 0;
    vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      destination: Buffer,
      start: number,
      length: number,
    ) => {
      expect(fd).toBe(0);
      const count = Math.min(length, input.length - offset);
      input.copy(destination, start, offset, offset + count);
      offset += count;
      return count;
    }) as typeof fs.readSync);
  }

  it.each(["openclaw", "langchain-deepagents-code", "pi"] as const)(
    "generates %s only through native-owner commands",
    (agent) => {
      const request = delegatedRequest(agent);
      const identity = managedImageRuntimeIdentity(agent);
      vi.spyOn(process, "geteuid").mockReturnValue(identity.uid);
      vi.spyOn(process, "getegid").mockReturnValue(identity.gid);
      vi.spyOn(fs, "lstatSync").mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
        uid: 0,
        gid: 0,
        mode: 0o755,
      } as fs.Stats);
      childProcessMock.spawnSync.mockImplementation((command, args) => ({
        status: 0,
        stdout:
          command === "/usr/bin/id"
            ? String(args[0] === "-u" ? identity.uid : identity.gid)
            : command === "/usr/local/bin/openclaw"
              ? '{"valid":true}'
              : "private generation output",
        stderr: "",
      }));
      const result = applyManagedStartupOwnerRequest(request, "a".repeat(64));
      expect(result).toEqual({
        agent,
        profileFingerprint: request.profileFingerprint,
        bootstrapIdentity: "a".repeat(64),
        applied: true,
        hermesPolicyB64: null,
        hermesConfigHash: null,
      });
      const commands = childProcessMock.spawnSync.mock.calls.filter(
        ([command]) => command !== "/usr/bin/id",
      );
      expect(
        commands.some(([, args]) => args.some((arg: string) => /generate-.*config/u.test(arg))),
      ).toBe(true);
      expect(
        commands.every(
          ([command, args, options]) =>
            command !== "/usr/bin/setpriv" &&
            options.stdio === (args.includes("--wait-gateway-executable") ? "inherit" : "pipe"),
        ),
      ).toBe(true);
      expect(commands.flatMap(([, args]) => args)).not.toContain("runtime-setup");
    },
  );

  it("does not regenerate mutable config during an owner replay", () => {
    vi.spyOn(process, "geteuid").mockReturnValue(998);
    vi.spyOn(process, "getegid").mockReturnValue(998);
    expect(applyManagedStartupOwnerRequest(delegatedRequest(), "a".repeat(64), true).applied).toBe(
      false,
    );
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it("prepares only root messaging setup and keeps generation pending", () => {
    mockRootReplayFilesystem([]);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const request = delegatedRequest();
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("pending");
    vi.spyOn(application, "prepareManagedStartupApplication").mockReturnValue(
      preparedApplication(request),
    );
    const commit = vi.spyOn(application, "commitManagedStartupApplication");
    expect(prepareManagedStartupDelegatedRequest(request, "a".repeat(64))).toBe("prepared");
    expect(childProcessMock.spawnSync).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawnSync.mock.calls[0]?.[1]).toContain("runtime-setup");
    expect(childProcessMock.spawnSync.mock.calls[0]?.[2].stdio).toBe("pipe");
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects preparation without protected shared-state authority", () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("none");
    expect(() => prepareManagedStartupDelegatedRequest(delegatedRequest(), "a".repeat(64))).toThrow(
      /protected shared-state transaction/u,
    );
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it("commits a matching owner result without rerunning generation or publishing completion", async () => {
    const writes: string[] = [];
    const filesystem = mockRootReplayFilesystem(writes);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const request = delegatedRequest();
    const prepared = preparedApplication(request);
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("pending");
    vi.spyOn(application, "prepareManagedStartupApplication").mockReturnValue(prepared);
    coordinatorMock.coordinateManagedStartupApplication.mockImplementation(
      async (_input, adapters) => {
        await adapters
          .find((adapter: { agent: string }) => adapter.agent === request.agent)
          .apply({
            agent: request.agent,
            profile: prepared.profile,
            fingerprint: prepared.fingerprint,
            generationDirectory: prepared.generationDirectory,
            profilePath: prepared.profilePath,
            corporateCaPath: null,
          });
        return { adapterApplied: true, application: { ...prepared, status: "committed" } };
      },
    );
    const result = {
      agent: request.agent,
      profileFingerprint: request.profileFingerprint,
      bootstrapIdentity: "a".repeat(64),
      applied: true,
      hermesPolicyB64: null,
      hermesConfigHash: null,
    };
    await expect(
      finishManagedStartupDelegatedRequest(request, "a".repeat(64), JSON.stringify(result)),
    ).resolves.toEqual(
      expect.objectContaining({
        agent: "openclaw",
        adapterApplied: true,
        fingerprint: request.profileFingerprint,
      }),
    );
    expect(childProcessMock.spawnSync.mock.calls.map(([command]) => command)).toEqual([
      "/usr/sbin/update-ca-certificates",
    ]);
    expect(filesystem.hasFile(MANAGED_STARTUP_RUNTIME_ENV_FILE)).toBe(true);
    expect(filesystem.hasFile(MANAGED_STARTUP_COMPLETION_FILE)).toBe(false);
  });

  it("does not rerun root setup for a committed application", () => {
    mockRootReplayFilesystem([]);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const request = delegatedRequest();
    vi.spyOn(
      sharedStateTransaction,
      "getManagedStartupSharedStateTransactionStatus",
    ).mockReturnValue("committed");
    vi.spyOn(application, "prepareManagedStartupApplication").mockReturnValue(
      preparedApplication(request, "already-committed"),
    );
    expect(prepareManagedStartupDelegatedRequest(request, "a".repeat(64))).toBe(
      "already-committed",
    );
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it.each(["policy", "hash"])(
    "rejects malformed Hermes owner %s before root installation",
    async (field) => {
      mockRootReplayFilesystem([]);
      vi.spyOn(process, "geteuid").mockReturnValue(0);
      const request = delegatedRequest("hermes");
      vi.spyOn(
        sharedStateTransaction,
        "getManagedStartupSharedStateTransactionStatus",
      ).mockReturnValue("pending");
      vi.spyOn(application, "prepareManagedStartupApplication").mockReturnValue(
        preparedApplication(request),
      );
      const result = {
        agent: request.agent,
        profileFingerprint: request.profileFingerprint,
        bootstrapIdentity: "a".repeat(64),
        applied: true,
        hermesPolicyB64: field === "policy" ? "invalid!" : Buffer.from("{}").toString("base64"),
        hermesConfigHash:
          field === "hash"
            ? "wrong-path"
            : `${"b".repeat(64)}  /sandbox/.hermes/config.yaml\n${"c".repeat(64)}  /sandbox/.hermes/.env\n`,
      };
      await expect(
        finishManagedStartupDelegatedRequest(request, "a".repeat(64), JSON.stringify(result)),
      ).rejects.toThrow(/invalid Hermes owner materials/u);
      expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
    },
  );

  it.each(["bootstrapIdentity", "profileFingerprint", "applied", "hermesPolicyB64"] as const)(
    "does not commit after a mismatched owner %s",
    async (field) => {
      mockRootReplayFilesystem([]);
      vi.spyOn(process, "geteuid").mockReturnValue(0);
      const request = delegatedRequest();
      vi.spyOn(
        sharedStateTransaction,
        "getManagedStartupSharedStateTransactionStatus",
      ).mockReturnValue("pending");
      vi.spyOn(application, "prepareManagedStartupApplication").mockReturnValue(
        preparedApplication(request),
      );
      const result = {
        agent: request.agent,
        profileFingerprint: request.profileFingerprint,
        bootstrapIdentity: "a".repeat(64),
        applied: true,
        hermesPolicyB64: null,
        hermesConfigHash: null,
        [field]: field === "applied" ? false : "mismatch",
      };
      await expect(
        finishManagedStartupDelegatedRequest(request, "a".repeat(64), JSON.stringify(result)),
      ).rejects.toThrow(/owner/u);
      expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
    },
  );

  it("captures only as the exact agent owner and sends the snapshot on its private output pipe", async () => {
    const profile = managedStartupE2eProfile("openclaw", false);
    const encodedProfile = encodeManagedStartupProfile(profile);
    stdin(
      serializeManagedStartupRootApplyRequest(
        createManagedStartupRootApplyRequest({ agent: "openclaw", encodedProfile }),
      ),
    );
    vi.spyOn(process, "geteuid").mockReturnValue(998);
    vi.spyOn(process, "getegid").mockReturnValue(998);
    const capture = vi
      .spyOn(sharedStateTransaction, "captureManagedStartupSharedState")
      .mockReturnValue("synthetic capture only\n");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const begin = vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction");
    await mainManagedStartupImageRuntime([
      "--capture-shared-state-stdin",
      "--agent",
      "openclaw",
      "--bootstrap-identity",
      "a".repeat(64),
    ]);
    expect(capture).toHaveBeenCalledExactlyOnceWith(decodeManagedStartupProfile(encodedProfile), {
      bootstrapIdentity: "a".repeat(64),
    });
    expect(output).toHaveBeenCalledExactlyOnceWith("synthetic capture only\n");
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([
    [0, 0],
    [999, 998],
    [998, 999],
  ])("rejects capture identity %i:%i before reading private state", async (uid, gid) => {
    vi.spyOn(process, "geteuid").mockReturnValue(uid);
    vi.spyOn(process, "getegid").mockReturnValue(gid);
    const capture = vi.spyOn(sharedStateTransaction, "captureManagedStartupSharedState");
    await expect(
      mainManagedStartupImageRuntime([
        "--capture-shared-state-stdin",
        "--agent",
        "openclaw",
        "--bootstrap-identity",
        "a".repeat(64),
      ]),
    ).rejects.toThrow(/exact native state owner/u);
    expect(capture).not.toHaveBeenCalled();
  });

  it("admits captured state only into the root-owned transaction for the requested bootstrap", async () => {
    const profile = managedStartupE2eProfile("openclaw", false);
    mockRootReplayFilesystem([]);
    stdin(
      JSON.stringify({
        encodedProfile: encodeManagedStartupProfile(profile),
        capturedState: "synthetic transport",
      }),
    );
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const begin = vi
      .spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction")
      .mockReturnValue(true);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await mainManagedStartupImageRuntime([
      "--begin-shared-state-from-capture-stdin",
      "--agent",
      "openclaw",
      "--bootstrap-identity",
      "a".repeat(64),
    ]);
    expect(begin).toHaveBeenCalledExactlyOnceWith(
      decodeManagedStartupProfile(encodeManagedStartupProfile(profile)),
      {
        bootstrapIdentity: "a".repeat(64),
        capturedState: "synthetic transport",
      },
    );
    expect(output).toHaveBeenCalledExactlyOnceWith("created\n");
  });

  it("does not let the state owner admit its own trusted receipt", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(998);
    const begin = vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction");
    await expect(
      mainManagedStartupImageRuntime([
        "--begin-shared-state-from-capture-stdin",
        "--agent",
        "openclaw",
        "--bootstrap-identity",
        "a".repeat(64),
      ]),
    ).rejects.toThrow(/requires container effective uid 0/u);
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([
    [
      "--restore-shared-state-stdin",
      "restoreManagedStartupCapturedSharedState",
      998,
      "observed private state",
    ],
    ["--finish-shared-restoration-stdin", "finishManagedStartupSharedStateRestoration", 0, true],
  ] as const)(
    "routes %s through the required process identity",
    async (action, operation, uid, result) => {
      const encodedProfile = encodeManagedStartupProfile(
        managedStartupE2eProfile("openclaw", false),
      );
      vi.spyOn(process, "geteuid").mockReturnValue(uid);
      vi.spyOn(process, "getegid").mockReturnValue(uid);
      stdin(JSON.stringify({ encodedProfile, capturedState: "private transport" }));
      const handler = vi.spyOn(sharedStateTransaction, operation).mockReturnValue(result);
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await mainManagedStartupImageRuntime([
        action,
        "--agent",
        "openclaw",
        "--bootstrap-identity",
        "a".repeat(64),
      ]);
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        decodeManagedStartupProfile(encodedProfile),
        "private transport",
        { bootstrapIdentity: "a".repeat(64) },
      );
      expect(output).toHaveBeenCalledExactlyOnceWith(uid === 0 ? "restored\n" : result);
    },
  );

  it("exports the protected original only through a root process", async () => {
    const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw", false));
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    stdin(
      serializeManagedStartupRootApplyRequest(
        createManagedStartupRootApplyRequest({ agent: "openclaw", encodedProfile }),
      ),
    );
    const handler = vi
      .spyOn(sharedStateTransaction, "exportManagedStartupSharedStateRestoration")
      .mockReturnValue("private original");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await mainManagedStartupImageRuntime([
      "--export-shared-restoration-stdin",
      "--agent",
      "openclaw",
      "--bootstrap-identity",
      "a".repeat(64),
    ]);
    expect(handler).toHaveBeenCalledExactlyOnceWith(decodeManagedStartupProfile(encodedProfile), {
      bootstrapIdentity: "a".repeat(64),
    });
    expect(output).toHaveBeenCalledExactlyOnceWith("private original");
  });

  it("reports delegated startup without consuming input or preparing state", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const read = vi.spyOn(fs, "readSync");
    const begin = vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await mainManagedStartupImageRuntime(["--startup-protocol"]);
    expect(output).toHaveBeenCalledExactlyOnceWith("delegated-owner-v1\n");
    expect(read).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it("prepares the protected parent before querying a new delegated transaction", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    mockRootReplayFilesystem([]);
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("openclaw", false)),
    });
    stdin(serializeManagedStartupRootApplyRequest(request));
    const status = vi
      .spyOn(sharedStateTransaction, "getManagedStartupSharedStateTransactionStatus")
      .mockImplementation(() => {
        expect(fs.lstatSync("/var/lib/nemoclaw").isDirectory()).toBe(true);
        return "none";
      });
    const begin = vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await mainManagedStartupImageRuntime([
      "--prepare-delegated-transaction-stdin",
      "--agent",
      "openclaw",
      "--bootstrap-identity",
      "a".repeat(64),
    ]);
    expect(status).toHaveBeenCalledExactlyOnceWith({
      agent: "openclaw",
      profileFingerprint: request.profileFingerprint,
      bootstrapIdentity: "a".repeat(64),
    });
    expect(output).toHaveBeenCalledExactlyOnceWith("none\n");
    expect(begin).not.toHaveBeenCalled();
  });

  it.each(["none", "pending", "committed"] as const)(
    "reports transaction status %s without renaming it",
    async (phase) => {
      vi.spyOn(process, "geteuid").mockReturnValue(0);
      vi.spyOn(
        sharedStateTransaction,
        "getManagedStartupSharedStateTransactionStatus",
      ).mockReturnValue(phase);
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await mainManagedStartupImageRuntime([
        "--shared-state-transaction-status",
        "--agent",
        "openclaw",
        "--profile-fingerprint",
        "a".repeat(64),
        "--bootstrap-identity",
        "b".repeat(64),
      ]);
      expect(output).toHaveBeenCalledExactlyOnceWith(`${phase}\n`);
    },
  );

  it("exports recovery from a profile without transporting the CA bundle again", async () => {
    const encodedProfile = encodeManagedStartupProfile(
      managedStartupE2eProfile("openclaw", false, true, true),
    );
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    stdin(encodedProfile);
    const handler = vi
      .spyOn(sharedStateTransaction, "exportManagedStartupSharedStateRestoration")
      .mockReturnValue("private original");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await mainManagedStartupImageRuntime([
      "--export-shared-restoration-profile-stdin",
      "--agent",
      "openclaw",
      "--bootstrap-identity",
      "a".repeat(64),
    ]);
    expect(handler).toHaveBeenCalledExactlyOnceWith(decodeManagedStartupProfile(encodedProfile), {
      bootstrapIdentity: "a".repeat(64),
    });
  });

  it.each([
    ["--export-shared-restoration-stdin", 998, 998],
    ["--export-shared-restoration-profile-stdin", 998, 998],
    ["--prepare-delegated-transaction-stdin", 998, 998],
    ["--finish-shared-restoration-stdin", 998, 998],
    ["--restore-shared-state-stdin", 0, 0],
    ["--restore-shared-state-stdin", 998, 999],
  ] as const)("rejects %s as %i:%i before consuming transport", async (action, uid, gid) => {
    vi.spyOn(process, "geteuid").mockReturnValue(uid);
    vi.spyOn(process, "getegid").mockReturnValue(gid);
    const read = vi.spyOn(fs, "readSync");
    await expect(
      mainManagedStartupImageRuntime([
        action,
        "--agent",
        "openclaw",
        "--bootstrap-identity",
        "a".repeat(64),
      ]),
    ).rejects.toThrow(/requires/u);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["openclaw", 998, 998, 0o755],
    ["hermes", 998, 999, 0o755],
    ["langchain-deepagents-code", 0, 999, 0o1775],
    ["pi", 999, 999, 0o755],
  ] as const)("restores the declared %s workspace-root posture", (agent, uid, gid, mode) => {
    const lstat = vi
      .fn()
      .mockReturnValueOnce({
        gid: 0,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o040000 | 0o700,
        uid: 0,
      })
      .mockReturnValueOnce({
        gid,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o040000 | mode,
        uid,
      });
    const chown = vi.fn();
    const chmod = vi.fn();

    normalizeManagedStartupWorkspaceRoot(agent, { lstat, chown, chmod });

    expect(chown).toHaveBeenCalledExactlyOnceWith("/sandbox", uid, gid);
    expect(chmod).toHaveBeenCalledExactlyOnceWith("/sandbox", mode);
    expect(lstat).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["openclaw", 998, 998, 0o755],
    ["hermes", 998, 999, 0o755],
    ["langchain-deepagents-code", 0, 999, 0o1775],
    ["pi", 999, 999, 0o755],
  ] as const)(
    "preserves the declared %s workspace without metadata writes",
    (agent, uid, gid, mode) => {
      const lstat = vi.fn().mockReturnValue({
        gid,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o040000 | mode,
        uid,
      });
      const denied = () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      };
      const chown = vi.fn(denied);
      const chmod = vi.fn(denied);

      normalizeManagedStartupWorkspaceRoot(agent, { lstat, chown, chmod });

      expect(chown).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
      expect(lstat).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects workspace metadata drift after an initially matching observation", () => {
    const initial = {
      gid: 998,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o040755,
      uid: 998,
    };
    const lstat = vi
      .fn()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce({ ...initial, mode: 0o040777 });
    const chown = vi.fn();
    const chmod = vi.fn();

    expect(() => normalizeManagedStartupWorkspaceRoot("openclaw", { lstat, chown, chmod })).toThrow(
      /workspace root does not match its declared posture/u,
    );
    expect(chown).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
  });

  it("fails closed when a required workspace ownership repair is denied", () => {
    const lstat = vi.fn().mockReturnValue({
      gid: 0,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o040755,
      uid: 0,
    });
    const chmod = vi.fn();

    expect(() =>
      normalizeManagedStartupWorkspaceRoot("openclaw", {
        lstat,
        chown: () => {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        },
        chmod,
      }),
    ).toThrow(/workspace-root normalization failed/u);
    expect(chmod).not.toHaveBeenCalled();
    expect(lstat).toHaveBeenCalledTimes(1);
  });

  it("rejects a symlinked workspace root before mutation", () => {
    const chown = vi.fn();
    const chmod = vi.fn();

    expect(() =>
      normalizeManagedStartupWorkspaceRoot("langchain-deepagents-code", {
        lstat: () => ({
          gid: 999,
          isDirectory: () => false,
          isSymbolicLink: () => true,
          mode: 0o120777,
          uid: 999,
        }),
        chown,
        chmod,
      }),
    ).toThrow(/workspace root must be one real directory/u);
    expect(chown).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
  });

  it("fails closed when workspace-root normalization does not settle", () => {
    expect(() =>
      normalizeManagedStartupWorkspaceRoot("langchain-deepagents-code", {
        lstat: () => ({
          gid: 999,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          mode: 0o040000 | 0o1775,
          uid: 999,
        }),
        chown: () => undefined,
        chmod: () => undefined,
      }),
    ).toThrow(/workspace root does not match its declared posture/u);
  });

  it("recognizes the identity-bound completion wait used by the non-root startup hold", async () => {
    await expect(
      mainManagedStartupImageRuntime([
        "--wait-for-completion",
        "--agent",
        "openclaw",
        "--profile-fingerprint",
        "a".repeat(64),
        "--bootstrap-identity",
        "not-an-identity",
      ]),
    ).rejects.toThrow(/bootstrap identity argument is missing or invalid/u);
  });

  it("publishes the authorized completion marker only after shared state commits", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    const runtimeWrites: string[] = [];
    const filesystem = mockRootReplayFilesystem(
      runtimeWrites,
      new Map([
        [
          "/usr/local/share/nemoclaw/openclaw-proxy-url",
          {
            contents: `http://${profile.proxy.managedHost}:${profile.proxy.managedPort}\n`,
            mode: 0o444,
          },
        ],
      ]),
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
    const transactionStatus = vi
      .spyOn(sharedStateTransaction, "getManagedStartupSharedStateTransactionStatus")
      .mockReturnValue("pending");
    const beginTransaction = vi
      .spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction")
      .mockReturnValue(true);

    const applied = await applyManagedStartupRootRequest(
      createManagedStartupRootApplyRequest({ agent: "openclaw", encodedProfile }),
      {},
      { bootstrapIdentity },
    );

    expect(applied.transactionPending).toBe(true);
    expect(beginTransaction).toHaveBeenCalledWith(expect.objectContaining({ agent: "openclaw" }), {
      bootstrapIdentity,
    });
    expect(filesystem.hasFile(MANAGED_STARTUP_RUNTIME_ENV_FILE)).toBe(true);
    expect(filesystem.hasFile(MANAGED_STARTUP_COMPLETION_FILE)).toBe(false);
    expect(() =>
      publishManagedStartupCompletionAfterCommit("openclaw", fingerprint, bootstrapIdentity),
    ).toThrow(/requires a committed shared-state transaction/u);
    expect(filesystem.hasFile(MANAGED_STARTUP_COMPLETION_FILE)).toBe(false);

    transactionStatus.mockReturnValue("committed");
    publishManagedStartupCompletionAfterCommit("openclaw", fingerprint, bootstrapIdentity);

    expect(filesystem.hasFile(MANAGED_STARTUP_COMPLETION_FILE)).toBe(true);
    expect(filesystem.readFile(MANAGED_STARTUP_COMPLETION_FILE)).toContain(fingerprint);
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

  it("reports committed in-sandbox transaction state for resume recovery", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const profileFingerprint = fingerprintManagedStartupProfile(profile);
    const bootstrapIdentity = "b".repeat(64);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const status = vi
      .spyOn(sharedStateTransaction, "getManagedStartupSharedStateTransactionStatus")
      .mockReturnValue("committed");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await mainManagedStartupImageRuntime([
      "--shared-state-transaction-status",
      "--agent",
      profile.agent,
      "--profile-fingerprint",
      profileFingerprint,
      "--bootstrap-identity",
      bootstrapIdentity,
    ]);

    expect(status).toHaveBeenCalledWith({
      agent: profile.agent,
      profileFingerprint,
      bootstrapIdentity,
    });
    expect(write).toHaveBeenCalledWith("committed\n");
  });

  it("rolls back a pending transaction inside its exact managed sandbox", async () => {
    const bootstrapIdentity = "b".repeat(64);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const rollback = vi
      .spyOn(sharedStateTransaction, "rollbackManagedStartupSharedStateTransaction")
      .mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await mainManagedStartupImageRuntime([
      "--rollback-shared-state-transaction",
      "--agent",
      "openclaw",
      "--bootstrap-identity",
      bootstrapIdentity,
    ]);

    expect(rollback).toHaveBeenCalledWith("openclaw", { bootstrapIdentity });
  });

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

  it("atomically promotes exact Switchyard bytes before activating Relay (#13862)", () => {
    const { environment, paths, serialized } = switchyardRoutingFixture();
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [paths.relayPluginsSource, { contents: serialized.relayPluginsToml, mode: 0o600 }],
        [paths.relayPluginStateSource, { contents: serialized.relayPluginStateJson, mode: 0o600 }],
        [
          paths.switchyardDeploymentSource,
          { contents: serialized.switchyardDeploymentToml, mode: 0o600 },
        ],
        [paths.relayPluginsTarget, { contents: "previous relay activation", mode: 0o444 }],
        [paths.relayPluginStateTarget, { contents: "previous relay state", mode: 0o444 }],
        [paths.switchyardDeploymentTarget, { contents: "previous deployment", mode: 0o444 }],
      ]),
    );
    const promotionOrder: string[] = [];
    const previousByTarget = new Map([
      [paths.switchyardDeploymentTarget, "previous deployment"],
      [paths.relayPluginStateTarget, "previous relay state"],
      [paths.relayPluginsTarget, "previous relay activation"],
    ]);
    filesystem.beforeRename((_source, target) => {
      expect(filesystem.readFile(target)).toBe(previousByTarget.get(target));
      promotionOrder.push(target);
    });

    installHermesSwitchyardRoutingFiles(environment, paths, { uid: 0, gid: 0 });

    expect(promotionOrder).toEqual([
      paths.switchyardDeploymentTarget,
      paths.relayPluginStateTarget,
      paths.relayPluginsTarget,
    ]);
    expect(filesystem.readFile(paths.switchyardDeploymentTarget)).toBe(
      serialized.switchyardDeploymentToml,
    );
    expect(filesystem.readFile(paths.relayPluginsTarget)).toBe(serialized.relayPluginsToml);
    expect(filesystem.readFile(paths.relayPluginStateTarget)).toBe(serialized.relayPluginStateJson);
    expect(filesystem.hasFile(paths.switchyardDeploymentSource)).toBe(false);
    expect(filesystem.hasFile(paths.relayPluginStateSource)).toBe(false);
    expect(filesystem.hasFile(paths.relayPluginsSource)).toBe(false);
    expect(() => verifyHermesSwitchyardRoutingFiles(environment, paths)).not.toThrow();
  });

  it.each(["owner", "mode", "bytes"] as const)(
    "rejects a staged Switchyard artifact with invalid %s before target mutation (#13862)",
    (invalid) => {
      const { environment, paths, serialized } = switchyardRoutingFixture();
      const filesystem = mockRootReplayFilesystem(
        [],
        new Map([
          [
            paths.relayPluginsSource,
            {
              contents: invalid === "bytes" ? "changed relay config" : serialized.relayPluginsToml,
              mode: invalid === "mode" ? 0o644 : 0o600,
            },
          ],
          [
            paths.relayPluginStateSource,
            { contents: serialized.relayPluginStateJson, mode: 0o600 },
          ],
          [
            paths.switchyardDeploymentSource,
            { contents: serialized.switchyardDeploymentToml, mode: 0o600 },
          ],
          [paths.relayPluginsTarget, { contents: "previous relay activation", mode: 0o444 }],
          [paths.relayPluginStateTarget, { contents: "previous relay state", mode: 0o444 }],
          [paths.switchyardDeploymentTarget, { contents: "previous deployment", mode: 0o444 }],
        ]),
      );

      expect(() =>
        installHermesSwitchyardRoutingFiles(
          environment,
          paths,
          invalid === "owner" ? { uid: 999, gid: 999 } : { uid: 0, gid: 0 },
        ),
      ).toThrow(/generated Hermes routing artifact is invalid/u);
      expect(filesystem.readFile(paths.relayPluginsTarget)).toBe("previous relay activation");
      expect(filesystem.readFile(paths.relayPluginStateTarget)).toBe("previous relay state");
      expect(filesystem.readFile(paths.switchyardDeploymentTarget)).toBe("previous deployment");
    },
  );

  it("removes Relay activation before stale Switchyard deployment when disabled (#13862)", () => {
    const { paths } = switchyardRoutingFixture();
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [paths.relayPluginsTarget, { contents: "stale relay activation", mode: 0o444 }],
        [paths.relayPluginStateTarget, { contents: "stale relay state", mode: 0o444 }],
        [paths.switchyardDeploymentTarget, { contents: "stale deployment", mode: 0o444 }],
      ]),
    );
    const removalOrder: string[] = [];
    filesystem.beforeUnlink((target) => removalOrder.push(target));

    installHermesSwitchyardRoutingFiles({}, paths, { uid: 0, gid: 0 });

    expect(removalOrder).toEqual([
      paths.relayPluginsTarget,
      paths.relayPluginStateTarget,
      paths.switchyardDeploymentTarget,
    ]);
    expect(filesystem.hasFile(paths.relayPluginsTarget)).toBe(false);
    expect(filesystem.hasFile(paths.relayPluginStateTarget)).toBe(false);
    expect(filesystem.hasFile(paths.switchyardDeploymentTarget)).toBe(false);
    expect(() => verifyHermesSwitchyardRoutingFiles({}, paths)).not.toThrow();
  });

  it("rejects committed Switchyard routing drift on replay (#13862)", () => {
    const { environment, paths, serialized } = switchyardRoutingFixture();
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [paths.relayPluginsSource, { contents: serialized.relayPluginsToml, mode: 0o600 }],
        [paths.relayPluginStateSource, { contents: serialized.relayPluginStateJson, mode: 0o600 }],
        [
          paths.switchyardDeploymentSource,
          { contents: serialized.switchyardDeploymentToml, mode: 0o600 },
        ],
      ]),
    );
    installHermesSwitchyardRoutingFiles(environment, paths, { uid: 0, gid: 0 });
    filesystem.writeFile(paths.relayPluginsTarget, "drifted activation", 0o444);

    expect(() => verifyHermesSwitchyardRoutingFiles(environment, paths)).toThrow(
      /committed Hermes routing artifact drifted/u,
    );
  });

  it("installs Switchyard before committing initial direct Hermes startup", async () => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/efficient-model" },
      capable: { provider: "openai-api", model: "openai/capable-model" },
    });
    const original = managedStartupE2eProfile("hermes", false);
    assert(original.agentConfig.agent === "hermes");
    const profile = {
      ...original,
      agentConfig: {
        ...original.agentConfig,
        agent: "hermes" as const,
        switchyardRouting: routing,
        switchyardBindings: switchyardBindingFixture(routing),
      },
    };
    const serialized = serializeHermesSwitchyardRouting(routing, switchyardBindingFixture(routing));
    const sourceFiles = [
      ["/sandbox/.hermes/hermes-relay-plugins.toml", serialized.relayPluginsToml],
      ["/sandbox/.hermes/hermes-relay-plugin-state.json", serialized.relayPluginStateJson],
      ["/sandbox/.hermes/hermes-switchyard-v1.toml", serialized.switchyardDeploymentToml],
      ["/sandbox/.hermes/managed-policy.json", "{}"],
      ["/sandbox/.hermes/config.yaml", "model: test\n"],
      ["/sandbox/.hermes/.env", "HERMES_TEST=1\n"],
    ];
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        ...sourceFiles.map(
          ([target, contents]) =>
            [
              target!,
              {
                contents: contents!,
                mode: target!.endsWith("config.yaml") || target!.endsWith("/.env") ? 0o640 : 0o600,
                uid: 999,
                gid: 999,
              },
            ] as const,
        ),
        ["/usr/bin/setpriv", { contents: "test executable", mode: 0o555, uid: 0, gid: 0 }],
      ]),
    );
    fs.mkdirSync("/usr/local/share/nemoclaw", { mode: 0o755 });
    fs.mkdirSync("/etc/nemoclaw", { mode: 0o755 });
    childProcessMock.spawnSync.mockImplementation((command) => ({
      status: 0,
      stdout: command === "/usr/bin/id" ? "999" : "",
      stderr: "",
    }));
    const prepared = preparedApplication(
      createManagedStartupRootApplyRequest({
        agent: "hermes",
        encodedProfile: encodeManagedStartupProfile(profile),
      }),
    );
    let committed = false;
    coordinatorMock.coordinateManagedStartupApplication.mockImplementation(
      async (_input, adapters) => {
        await adapters
          .find((adapter: { agent: string }) => adapter.agent === "hermes")
          .apply({
            agent: "hermes",
            profile,
            fingerprint: prepared.fingerprint,
            generationDirectory: prepared.generationDirectory,
            profilePath: prepared.profilePath,
            corporateCaPath: null,
          });
        expect(() =>
          verifyHermesSwitchyardRoutingFiles({
            [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing),
            [HERMES_SWITCHYARD_BINDINGS_ENV]: encodeSwitchyardProviderBindings(
              switchyardBindingFixture(routing),
              routing,
            ),
          }),
        ).not.toThrow();
        expect(filesystem.hasFile("/sandbox/.hermes/hermes-relay-plugins.toml")).toBe(false);
        expect(filesystem.hasFile("/sandbox/.hermes/hermes-relay-plugin-state.json")).toBe(false);
        expect(filesystem.hasFile("/sandbox/.hermes/hermes-switchyard-v1.toml")).toBe(false);
        expect(filesystem.hasFile(MANAGED_STARTUP_COMPLETION_FILE)).toBe(false);
        committed = true;
        return { adapterApplied: true, application: { ...prepared, status: "committed" } };
      },
    );
    await expect(
      applyManagedStartupImageProfile("hermes", {
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
        [MANAGED_STARTUP_PROFILE_ENV]: encodeManagedStartupProfile(profile),
      }),
    ).resolves.toMatchObject({ adapterApplied: true, fingerprint: prepared.fingerprint });
    expect(committed).toBe(true);
    expect(filesystem.hasFile(MANAGED_STARTUP_COMPLETION_FILE)).toBe(true);
  });

  it.each([
    {
      state: "disabled-stale",
      succeeds: false,
      error: /disabled Hermes routing left a stale artifact/u,
    },
    {
      state: "enabled-drift",
      succeeds: false,
      error: /committed Hermes routing artifact drifted/u,
    },
    { state: "enabled-valid", succeeds: true, error: null },
  ] as const)(
    "validates Switchyard artifacts on delegated committed replay: $state",
    async ({ state, succeeds, error }) => {
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/efficient-model" },
        capable: { provider: "openai-api", model: "openai/capable-model" },
      });
      const original = managedStartupE2eProfile("hermes", false);
      assert(original.agentConfig.agent === "hermes");
      const profile = {
        ...original,
        agentConfig: {
          ...original.agentConfig,
          agent: "hermes" as const,
          switchyardRouting: state === "disabled-stale" ? null : routing,
          switchyardBindings: state === "disabled-stale" ? null : switchyardBindingFixture(routing),
        },
      };
      const fingerprint = fingerprintManagedStartupProfile(profile);
      const serialized = serializeHermesSwitchyardRouting(
        routing,
        switchyardBindingFixture(routing),
      );
      const filesystem = mockRootReplayFilesystem(
        [],
        new Map([
          [
            HERMES_RELAY_PLUGINS_FILE,
            {
              contents:
                state === "enabled-valid" ? serialized.relayPluginsToml : "stale activation",
              mode: 0o444,
            },
          ],
          [
            HERMES_RELAY_PLUGIN_STATE_FILE,
            { contents: serialized.relayPluginStateJson, mode: 0o444 },
          ],
          [
            HERMES_SWITCHYARD_DEPLOYMENT_FILE,
            { contents: serialized.switchyardDeploymentToml, mode: 0o444 },
          ],
        ]),
      );
      coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
        adapterApplied: false,
        application: {
          ...preparedApplication(
            createManagedStartupRootApplyRequest({
              agent: "hermes",
              encodedProfile: encodeManagedStartupProfile(profile),
            }),
          ),
          status: "committed",
        },
      });
      const replay = applyManagedStartupImageProfile(
        "hermes",
        {
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
          [MANAGED_STARTUP_PROFILE_ENV]: encodeManagedStartupProfile(profile),
        },
        {
          publishCompletion: false,
          ownerResult: {
            agent: "hermes",
            profileFingerprint: fingerprint,
            bootstrapIdentity: "a".repeat(64),
            applied: false,
            hermesPolicyB64: null,
            hermesConfigHash: null,
          },
        },
      );
      const outcome = await replay.then(
        (result) => ({
          success: true,
          adapterApplied: result.adapterApplied,
          fingerprint: result.fingerprint,
          error: null,
        }),
        (failure: Error) => ({
          success: false,
          adapterApplied: null,
          fingerprint: null,
          error: failure.message,
        }),
      );
      expect(outcome).toEqual({
        success: succeeds,
        adapterApplied: succeeds ? false : null,
        fingerprint: succeeds ? fingerprint : null,
        error: error === null ? null : expect.stringMatching(error),
      });
      expect(filesystem.hasFile(MANAGED_STARTUP_RUNTIME_ENV_FILE)).toBe(succeeds);
      const verification = Promise.resolve().then(() =>
        verifyHermesSwitchyardRoutingFiles({
          [HERMES_SWITCHYARD_ROUTING_ENV]:
            state === "disabled-stale" ? undefined : encodeHermesSwitchyardRoutingIntent(routing),
          [HERMES_SWITCHYARD_BINDINGS_ENV]:
            state === "disabled-stale"
              ? undefined
              : encodeSwitchyardProviderBindings(switchyardBindingFixture(routing), routing),
        }),
      );
      await expect(
        verification.then(
          () => null,
          (failure: Error) => failure.message,
        ),
      ).resolves.toEqual(error === null ? null : expect.stringMatching(error));
      const routingTargets: readonly string[] = [
        HERMES_RELAY_PLUGINS_FILE,
        HERMES_RELAY_PLUGIN_STATE_FILE,
        HERMES_SWITCHYARD_DEPLOYMENT_FILE,
      ];
      expect(
        vi
          .mocked(fs.renameSync)
          .mock.calls.filter(
            ([source, target]) =>
              routingTargets.includes(String(source)) || routingTargets.includes(String(target)),
          ),
      ).toEqual([]);
      expect(
        vi
          .mocked(fs.unlinkSync)
          .mock.calls.filter(([target]) => routingTargets.includes(String(target))),
      ).toEqual([]);
      const routingDescriptors = vi
        .mocked(fs.openSync)
        .mock.calls.flatMap(([target], index) =>
          routingTargets.includes(String(target))
            ? [vi.mocked(fs.openSync).mock.results[index]!.value]
            : [],
        );
      expect(
        vi
          .mocked(fs.writeFileSync)
          .mock.calls.filter(
            ([target]) =>
              routingTargets.includes(String(target)) || routingDescriptors.includes(target),
          ),
      ).toEqual([]);
    },
  );

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
  ] as const)(
    "rejects %s before filesystem or coordinator mutation",
    async (_label, expectedAgent, profileAgent, message) => {
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
    },
  );

  it("refreshes admitted launch controls on committed replay without changing the profile", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const runtimeWrites: string[] = [];
    mockRootReplayFilesystem(
      runtimeWrites,
      new Map([
        [
          "/usr/local/share/nemoclaw/openclaw-proxy-url",
          {
            contents: `http://${profile.proxy.managedHost}:${profile.proxy.managedPort}\n`,
            mode: 0o444,
          },
        ],
      ]),
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

  it("applies a routed root request without transporting workload credential references (#13863)", async () => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const base = managedStartupE2eProfile("hermes");
    const profile = {
      ...base,
      agentConfig: {
        agent: "hermes" as const,
        webSearch: { enabled: false, provider: "tavily" as const },
        switchyardRouting: routing,
        switchyardBindings: switchyardBindingFixture(routing),
      },
    };
    const request = createManagedStartupRootApplyRequest({
      agent: "hermes",
      encodedProfile: encodeManagedStartupProfile(profile),
    });
    mockRootReplayFilesystem([]);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.spyOn(sharedStateTransaction, "beginManagedStartupSharedStateTransaction").mockReturnValue(
      true,
    );
    const coordinatorFailure = new Error("coordinator boundary reached");
    coordinatorMock.coordinateManagedStartupApplication.mockRejectedValue(coordinatorFailure);

    await expect(
      applyManagedStartupRootRequest(request, {
        NVIDIA_INFERENCE_API_KEY: "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
        OPENAI_API_KEY: `openshell:resolve:env:s${"a".repeat(64)}_OPENAI_API_KEY`,
      }),
    ).rejects.toBe(coordinatorFailure);
    expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledTimes(1);
    const applicationInput = coordinatorMock.coordinateManagedStartupApplication.mock.calls[0][0];
    expect(applicationInput).toMatchObject({
      encodedProfile: request.encodedProfile,
      expectedAgent: "hermes",
    });
    expect(JSON.stringify(applicationInput)).not.toContain("openshell:resolve:env:");
  });
});
