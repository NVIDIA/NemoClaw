// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
  ensureManagedGatewayStateRoot,
  managedGatewayStateRootOwnershipFailure,
} from "./gateway-binding";

function target(stateDir: string, gatewayPort = 9123) {
  return { gatewayName: `nemoclaw-${String(gatewayPort)}`, gatewayPort, stateDir };
}

describe("managed gateway state root ownership", () => {
  it("rejects an existing nonempty directory that NemoClaw does not own", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-unowned-gateway-root-"));
    const stateDir = path.join(root, "gateway");
    try {
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.writeFileSync(path.join(stateDir, "operator-data"), "keep\n", { mode: 0o600 });

      expect(() => ensureManagedGatewayStateRoot(target(stateDir))).toThrow(
        /refusing to adopt an existing nonempty directory/,
      );
      expect(fs.readFileSync(path.join(stateDir, "operator-data"), "utf8")).toBe("keep\n");
      expect(fs.existsSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER))).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a pre-created directory that is not owner-private", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-public-gateway-root-"));
    const stateDir = path.join(root, "gateway");
    try {
      fs.mkdirSync(stateDir, { mode: 0o755 });
      fs.chmodSync(stateDir, 0o755);

      expect(() => ensureManagedGatewayStateRoot(target(stateDir))).toThrow(/mode 0700/);
      expect(fs.existsSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER))).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a custom root beneath a group- or world-writable parent", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-writable-gateway-parent-"));
    const stateDir = path.join(root, "gateway");
    try {
      fs.chmodSync(root, 0o777);

      expect(() => ensureManagedGatewayStateRoot(target(stateDir))).toThrow(
        /ancestor .* is not a trusted real directory/,
      );
      expect(fs.existsSync(stateDir)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER))).toBe(false);
    } finally {
      fs.chmodSync(root, 0o700);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not suggest chmod for a shared root-owned directory like /tmp", () => {
    const real = fs.lstatSync;
    const lstat = vi
      .spyOn(fs, "lstatSync")
      .mockImplementation(((p: fs.PathLike) =>
        String(p) === "/shared"
          ? Object.assign(real("/"), { uid: 0, mode: 0o41777 })
          : real(p)) as typeof fs.lstatSync);
    try {
      expect(() => ensureManagedGatewayStateRoot(target("/shared/gateway"))).toThrow(
        /ancestor '\/shared' is not a trusted real directory/,
      );
      expect(() => ensureManagedGatewayStateRoot(target("/shared/gateway"))).not.toThrow(/chmod/);
    } finally {
      lstat.mockRestore();
    }
  });

  it("does not suggest chmod for /tmp when running as root", () => {
    const real = fs.lstatSync;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    const lstat = vi
      .spyOn(fs, "lstatSync")
      .mockImplementation(((p: fs.PathLike) =>
        String(p) === "/shared"
          ? Object.assign(real("/"), { uid: 0, mode: 0o41777 })
          : Object.assign(real(p), { uid: 0 })) as typeof fs.lstatSync);
    try {
      expect(() => ensureManagedGatewayStateRoot(target("/shared/gateway"))).toThrow(
        /ancestor '\/shared' is not a trusted real directory/,
      );
      expect(() => ensureManagedGatewayStateRoot(target("/shared/gateway"))).not.toThrow(/chmod/);
    } finally {
      lstat.mockRestore();
      getuid.mockRestore();
    }
  });

  it("names the mode and the chmod remedy when an owned ancestor is group-writable", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-group-writable-parent-"));
    const stateDir = path.join(root, "gateway");
    try {
      fs.chmodSync(root, 0o775);

      expect(() => ensureManagedGatewayStateRoot(target(stateDir))).toThrow(
        `ancestor '${root}' is not a trusted real directory owned by the current user or root without group or world write access. It has mode 0775; remove group and other write permission (chmod go-w '${root}'), then retry.`,
      );
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.chmodSync(root, 0o700);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a private immediate parent beneath a replaceable ancestor", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-replaceable-gateway-parent-"));
    const replaceableAncestor = path.join(root, "replaceable");
    const immediateParent = path.join(replaceableAncestor, "private");
    const stateDir = path.join(immediateParent, "gateway");
    try {
      fs.mkdirSync(immediateParent, { mode: 0o700, recursive: true });
      fs.chmodSync(immediateParent, 0o700);
      fs.chmodSync(replaceableAncestor, 0o777);

      expect(() => ensureManagedGatewayStateRoot(target(stateDir))).toThrow(
        new RegExp(`ancestor '${replaceableAncestor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`),
      );
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.chmodSync(replaceableAncestor, 0o700);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("marks an empty dedicated directory and binds it to one gateway", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-owned-gateway-root-"));
    const stateDir = path.join(root, "gateway");
    try {
      ensureManagedGatewayStateRoot(target(stateDir));

      expect(managedGatewayStateRootOwnershipFailure(target(stateDir))).toBeNull();
      expect(managedGatewayStateRootOwnershipFailure(target(stateDir, 9124))).toMatch(
        /does not identify the selected gateway/,
      );
      expect(fs.statSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER)).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a marker path replaced while its descriptor is being read", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-replaced-gateway-marker-"));
    const stateDir = path.join(root, "gateway");
    const markerPath = path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER);
    const displacedPath = path.join(stateDir, "opened-marker.json");
    try {
      ensureManagedGatewayStateRoot(target(stateDir));
      const markerContents = fs.readFileSync(markerPath);
      const originalReadSync = fs.readSync.bind(fs);
      const readSpy = vi.spyOn(fs, "readSync").mockImplementationOnce(((...args: unknown[]) => {
        fs.renameSync(markerPath, displacedPath);
        fs.writeFileSync(markerPath, markerContents, { mode: 0o600 });
        return Reflect.apply(originalReadSync, fs, args);
      }) as typeof fs.readSync);
      try {
        expect(managedGatewayStateRootOwnershipFailure(target(stateDir))).toMatch(/read safely/);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
