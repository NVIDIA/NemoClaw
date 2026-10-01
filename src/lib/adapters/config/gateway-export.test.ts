// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openRegularFileNoFollow } from "../fs/regular-file";
import {
  loadGatewayManagementDeclaration,
  type GatewayManagementDeclaration,
} from "../../onboard/gateway-management";
import { bindGatewayAuthorityToCheckpoint } from "../../onboard/gateway-authority-checkpoint";
import { resolveGatewayOwner, type GatewayAttachmentProbe } from "../../onboard/gateway-ownership";
import { createProductionGatewayReadinessDependencies } from "../../readiness/gateway-production";
import { createSession } from "../../state/onboard-session";
import { managedGatewayStateRootOwnershipFailure } from "../../onboard/gateway/state-dir";
import { observeOpenShellGatewayRegistration } from "../openshell/gateway-reuse-cli";
import { isWsl } from "../../core/wsl";
import { observeExportGateway } from "./gateway-export";
import { entry } from "./live-export-source-test-fixture";

vi.mock("../fs/regular-file", () => ({ openRegularFileNoFollow: vi.fn() }));
vi.mock("../../onboard/gateway-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/gateway-management")>()),
  loadGatewayManagementDeclaration: vi.fn(),
}));
vi.mock("../../readiness/gateway-production", () => ({
  createProductionGatewayReadinessDependencies: vi.fn(),
}));
vi.mock("../openshell/gateway-reuse-cli", () => ({ observeOpenShellGatewayRegistration: vi.fn() }));
vi.mock("../../core/wsl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/wsl")>()),
  isWsl: vi.fn(() => false),
}));
vi.mock("../../onboard/gateway/state-dir", () => ({
  managedGatewayStateRootOwnershipFailure: vi.fn(() => null),
  resolveGatewayStateDirForPort: vi.fn(() => "/managed/gateway"),
}));

const declaration: GatewayManagementDeclaration = {
  version: 1,
  mode: "externally-supervised",
  endpoint: "http://127.0.0.1:8080",
  stateDir: "/private/source/gateway",
  supervisor: {
    kind: "systemd-user",
    serviceName: "gateway.service",
    execPath: "/opt/openshell-gateway",
  },
  requiredCapabilities: ["gateway.health"],
};
const attachment: GatewayAttachmentProbe = {
  gatewayPort: 8080,
  httpReady: true,
  portOccupied: true,
  listenerPids: [4242],
  listenerScanComplete: true,
  listenerStartTime: "710024",
  supervisorActive: true,
  listenerExecPath: "/opt/openshell-gateway",
  listenerSupervisorMatch: true,
};

function mockSource(selected: GatewayManagementDeclaration = declaration) {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const lstat = vi.spyOn(fs, "lstatSync").mockReturnValue({} as fs.Stats);
  vi.mocked(isWsl).mockReturnValue(false);
  vi.mocked(managedGatewayStateRootOwnershipFailure).mockReturnValue(null);
  const session = createSession({ sandboxName: "alpha" });
  bindGatewayAuthorityToCheckpoint(
    session,
    resolveGatewayOwner({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      declaration: selected,
      hasPackagedService: false,
    }),
  );
  const readBytes = vi.fn(() => Buffer.from(JSON.stringify(session)));
  const close = vi.fn();
  vi.mocked(openRegularFileNoFollow).mockReturnValue({ readBytes, close } as unknown as ReturnType<
    typeof openRegularFileNoFollow
  >);
  vi.mocked(loadGatewayManagementDeclaration).mockReturnValue({
    ok: true,
    declaration: selected,
    source: "file",
  });
  vi.mocked(observeOpenShellGatewayRegistration).mockResolvedValue({
    name: "nemoclaw",
    endpoint: "http://127.0.0.1:8080",
    active: false,
    auth: "plaintext",
  });
  const probeAttachment = vi.fn().mockResolvedValue(attachment);
  vi.mocked(createProductionGatewayReadinessDependencies).mockReturnValue({
    probeAttachment,
    resolveOwner: vi.fn(),
    observeManagedGateway: vi.fn(),
  });
  return { session, readBytes, close, probeAttachment, lstat };
}

describe("gateway export observation", () => {
  it("uses checkpointed external ownership even when the state root appears managed (#11861)", async () => {
    const { close, probeAttachment } = mockSource();
    const observed = await observeExportGateway(entry);
    expect(observed).toMatchObject({
      name: "nemoclaw",
      port: 8080,
      management: "external",
      stateRootOwned: false,
      external: { endpoint: declaration.endpoint, listenerPid: 4242, listenerStartTime: "710024" },
    });
    expect(observed.external?.authorityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(observed)).not.toContain(declaration.stateDir);
    expect(managedGatewayStateRootOwnershipFailure).not.toHaveBeenCalled();
    expect(probeAttachment).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses an external declaration without recorded onboarding authority (#11861)", async () => {
    const { probeAttachment } = mockSource();
    vi.mocked(fs.lstatSync).mockReturnValue(undefined as never);
    await expect(observeExportGateway(entry)).rejects.toThrow("missing or changed");
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
    expect(probeAttachment).not.toHaveBeenCalled();
  });

  it("does not reinterpret recorded external ownership after its declaration disappears (#11861)", async () => {
    mockSource();
    vi.mocked(loadGatewayManagementDeclaration).mockReturnValue({
      ok: true,
      declaration: null,
      source: null,
    });
    await expect(observeExportGateway(entry)).rejects.toThrow("no longer has its declaration");
    expect(managedGatewayStateRootOwnershipFailure).not.toHaveBeenCalled();
  });

  it("refuses a declaration that disagrees with the checkpoint (#11861)", async () => {
    mockSource();
    vi.mocked(loadGatewayManagementDeclaration).mockReturnValue({
      ok: true,
      declaration: { ...declaration, stateDir: "/replacement/state" },
      source: "file",
    });
    await expect(observeExportGateway(entry)).rejects.toThrow("missing or changed");
  });

  it.each([
    { endpoint: "http://127.0.0.1:9090", auth: "plaintext" },
    { endpoint: declaration.endpoint!, auth: "oidc" },
    { endpoint: declaration.endpoint!, auth: "mtls" },
    { endpoint: declaration.endpoint!, auth: undefined },
  ])("refuses incompatible registration before probing %# (#11861)", async (change) => {
    const { probeAttachment } = mockSource();
    vi.mocked(observeOpenShellGatewayRegistration).mockResolvedValue({
      name: "nemoclaw",
      active: false,
      ...change,
    });
    await expect(observeExportGateway(entry)).rejects.toThrow("registration or authentication");
    expect(probeAttachment).not.toHaveBeenCalled();
  });

  it.each([
    { httpReady: false },
    { supervisorActive: false },
    { listenerSupervisorMatch: null },
    { listenerStartTime: null },
    { listenerPids: [4242, 4243] },
    { listenerScanComplete: false },
    { listenerExecPath: "/other/gateway" },
  ])("refuses unverified listener or supervisor evidence %# (#11861)", async (change) => {
    const { probeAttachment } = mockSource();
    probeAttachment.mockResolvedValue({ ...attachment, ...change });
    await expect(observeExportGateway(entry)).rejects.toThrow("identity could not be verified");
  });

  it("rejects HTTPS before inspecting gateway registration (#11861)", async () => {
    mockSource({ ...declaration, endpoint: "https://127.0.0.1:8080" });
    await expect(observeExportGateway(entry)).rejects.toThrow("without TLS");
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
  });

  it("refuses WSL before inspecting external registration (#11861)", async () => {
    mockSource();
    vi.mocked(isWsl).mockReturnValue(true);
    await expect(observeExportGateway(entry)).rejects.toThrow("native Linux");
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)(
    "refuses external export on %s before inspecting registration (#11861)",
    async (platform) => {
      mockSource();
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      await expect(observeExportGateway(entry)).rejects.toThrow("native Linux");
      expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
    },
  );

  it("refuses malformed checkpoint data and closes the read handle (#11861)", async () => {
    const { readBytes, close } = mockSource();
    readBytes.mockReturnValue(Buffer.from("not JSON"));
    await expect(observeExportGateway(entry)).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "linux")(
    "rejects same-inode checkpoint changes during the read before probing (#11861)",
    async () => {
      const { session, lstat, probeAttachment } = mockSource();
      lstat.mockRestore();
      const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-export-checkpoint-"));
      try {
        vi.stubEnv("HOME", temporaryHome);
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
        vi.spyOn(os, "homedir").mockReturnValue(temporaryHome);
        vi.resetModules();
        const { saveSession, SESSION_FILE } = await import("../../state/onboard-session");
        expect(SESSION_FILE.startsWith(temporaryHome + path.sep)).toBe(true);
        saveSession(session);
        const { openRegularFileNoFollow: openActual } =
          await vi.importActual<typeof import("../fs/regular-file")>("../fs/regular-file");
        vi.mocked(openRegularFileNoFollow).mockImplementation(openActual);

        expect(await observeExportGateway(entry)).toMatchObject({ management: "external" });
        vi.mocked(observeOpenShellGatewayRegistration).mockClear();
        probeAttachment.mockClear();
        const descriptor = fs.openSync(SESSION_FILE, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        try {
          const before = fs.fstatSync(descriptor);
          const original = fs.readFileSync(descriptor, "utf8");
          const replacement = original.replace("gateway.service", "changed.service");
          expect(replacement).not.toBe(original);
          const originalRead = fs.readSync.bind(fs);
          const read = vi.spyOn(fs, "readSync").mockImplementationOnce(((...args: unknown[]) => {
            const count = Reflect.apply(originalRead, fs, args);
            expect(fs.writeSync(descriptor, replacement, 0, "utf8")).toBe(
              Buffer.byteLength(replacement),
            );
            fs.futimesSync(descriptor, before.atime, new Date(before.mtimeMs + 10_000));
            return count;
          }) as typeof fs.readSync);

          await expect(observeExportGateway(entry)).rejects.toThrow("changed while reading");

          expect(read).toHaveBeenCalledTimes(1);
          const after = fs.fstatSync(descriptor);
          expect([after.dev, after.ino, after.size]).toEqual([before.dev, before.ino, before.size]);
          expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
          expect(probeAttachment).not.toHaveBeenCalled();
        } finally {
          fs.closeSync(descriptor);
        }
      } finally {
        fs.rmSync(temporaryHome, { recursive: true, force: true });
      }
    },
  );

  it("preserves a legacy managed source without an onboarding checkpoint (#11861)", async () => {
    mockSource();
    vi.mocked(loadGatewayManagementDeclaration).mockReturnValue({
      ok: true,
      declaration: null,
      source: null,
    });
    vi.mocked(fs.lstatSync).mockReturnValue(undefined as never);
    expect(await observeExportGateway(entry)).toEqual({
      name: "nemoclaw",
      port: 8080,
      management: "nemoclaw",
      stateRootOwned: true,
    });
  });

  it("refuses a checkpoint that disappears after the path read (#11861)", async () => {
    mockSource();
    vi.mocked(openRegularFileNoFollow).mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(observeExportGateway(entry)).rejects.toThrow("missing");
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
  });

  it("refuses checkpoint path inspection errors (#11861)", async () => {
    const { lstat } = mockSource();
    lstat.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(observeExportGateway(entry)).rejects.toThrow("denied");
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
  });

  it("does not infer external ownership from a missing managed marker (#11861)", async () => {
    mockSource();
    vi.mocked(loadGatewayManagementDeclaration).mockReturnValue({
      ok: true,
      declaration: null,
      source: null,
    });
    vi.mocked(fs.lstatSync).mockReturnValue(undefined as never);
    vi.mocked(managedGatewayStateRootOwnershipFailure).mockReturnValue("missing ownership marker");
    expect(await observeExportGateway(entry)).toEqual({
      name: "nemoclaw",
      port: 8080,
      management: "unknown",
      stateRootOwned: false,
    });
    expect(observeOpenShellGatewayRegistration).not.toHaveBeenCalled();
  });
});
