// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  BAD_PEM,
  LEAF_PEM,
  PEM,
  PRIVATE_KEY,
  tmpDir,
} from "../__test-helpers__/corporate-ca-fixtures";
import { MAX_CORPORATE_CA_BYTES, MAX_CORPORATE_CA_CERTS } from "../corporate-ca-policy";
import { readGatewayNetworkTrust, stageGatewayNetworkTrust } from "./network-trust";

describe("Gateway destination CA snapshots", () => {
  it("stores normalized public certificates once and retains previous generations", () => {
    const root = tmpDir();
    const first = stageGatewayNetworkTrust(root, PEM);
    const readSnapshot = (file: string) => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        return { metadata: fs.fstatSync(fd), content: fs.readFileSync(fd, "utf8") };
      } finally {
        fs.closeSync(fd);
      }
    };
    const initial = readSnapshot(first.path);
    const inode = initial.metadata.ino;
    expect(first.sha256).toBe(createHash("sha256").update(PEM).digest("hex"));
    expect(initial.metadata.mode & 0o777).toBe(0o444);
    expect(fs.statSync(path.dirname(first.path)).mode & 0o777).toBe(0o700);
    expect(stageGatewayNetworkTrust(root, PEM)).toEqual(first);
    expect(readSnapshot(first.path).metadata.ino).toBe(inode);
    const rotated = stageGatewayNetworkTrust(root, PEM + PEM);
    expect(rotated.sha256).not.toBe(first.sha256);
    expect(readSnapshot(first.path).content).toBe(PEM);
    expect(readSnapshot(rotated.path).content).toBe(PEM + PEM);
    expect(fs.readdirSync(path.dirname(first.path))).toHaveLength(2);
  });

  it.each([
    ["empty", ""],
    ["malformed", BAD_PEM],
    ["leaf", LEAF_PEM],
    ["key only", PRIVATE_KEY],
    ["adjacent key", PEM + PRIVATE_KEY],
    ["adjacent text", PEM + "unexpected"],
    ["oversized", "x".repeat(MAX_CORPORATE_CA_BYTES + 1)],
    ["too many certificates", PEM.repeat(MAX_CORPORATE_CA_CERTS + 1)],
  ])("rejects %s material before creating gateway state", (_name, pem) => {
    const root = path.join(tmpDir(), "gateway");
    expect(() => stageGatewayNetworkTrust(root, pem)).toThrow(/corporate CA/);
    expect(fs.existsSync(root)).toBe(false);
  });

  it.each([0o644, 0o666, 0o400])(
    "rejects an existing snapshot with mode %s without replacing it",
    (mode) => {
      const root = tmpDir();
      const saved = stageGatewayNetworkTrust(root, PEM);
      fs.chmodSync(saved.path, mode);
      const before = fs.statSync(saved.path);
      expect(() => stageGatewayNetworkTrust(root, PEM)).toThrow(/read-only certificate snapshot/);
      expect(fs.statSync(saved.path).ino).toBe(before.ino);
      expect(fs.statSync(saved.path).mode).toBe(before.mode);
    },
  );

  it("rejects a changed or missing snapshot", () => {
    const root = tmpDir();
    const saved = stageGatewayNetworkTrust(root, PEM);
    fs.chmodSync(saved.path, 0o600);
    fs.writeFileSync(saved.path, PEM + PEM);
    fs.chmodSync(saved.path, 0o444);
    expect(() => readGatewayNetworkTrust(root, saved.path)).toThrow(/snapshot changed/);
    fs.unlinkSync(saved.path);
    expect(() => readGatewayNetworkTrust(root, saved.path)).toThrow(/ENOENT/);
  });

  it.each([
    ["symbolic", fs.symlinkSync],
    ["hard", fs.linkSync],
  ] as const)("rejects a %s link to certificate material", (_kind, createLink) => {
    const root = tmpDir();
    const saved = stageGatewayNetworkTrust(root, PEM);
    const other = path.join(tmpDir(), "ca.pem");
    fs.renameSync(saved.path, other);
    createLink(other, saved.path);
    expect(() => readGatewayNetworkTrust(root, saved.path)).toThrow();
    expect(() => stageGatewayNetworkTrust(root, PEM)).toThrow();
    expect(fs.readFileSync(other, "utf8")).toBe(PEM);
  });

  it("rejects a certificate selected from another gateway", () => {
    const saved = stageGatewayNetworkTrust(tmpDir(), PEM);
    expect(() => readGatewayNetworkTrust(tmpDir(), saved.path)).toThrow(
      /owned certificate snapshot/,
    );
  });

  it.each(["state", "trust"])("rejects a writable %s directory", (location) => {
    const root = tmpDir();
    const saved = stageGatewayNetworkTrust(root, PEM);
    const directory = location === "state" ? root : path.dirname(saved.path);
    fs.chmodSync(directory, 0o770);
    expect(() => readGatewayNetworkTrust(root, saved.path)).toThrow(/mode 0700/);
    expect(() => stageGatewayNetworkTrust(root, PEM)).toThrow(/mode 0700/);
  });

  it("rejects a symlinked trust directory without touching its target", () => {
    const root = tmpDir();
    const other = tmpDir();
    fs.symlinkSync(other, path.join(root, "network-trust"));
    expect(() => stageGatewayNetworkTrust(root, PEM)).toThrow(/owned directory/);
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("removes only its own temporary file when publication fails", () => {
    const root = tmpDir();
    const saved = stageGatewayNetworkTrust(root, PEM);
    const retained = path.join(path.dirname(saved.path), ".ca-other.tmp");
    fs.writeFileSync(retained, "another operation", { mode: 0o600 });
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("publication interrupted");
    });
    expect(() => stageGatewayNetworkTrust(root, PEM + PEM)).toThrow("publication interrupted");
    expect(fs.readdirSync(path.dirname(saved.path)).sort()).toEqual(
      [path.basename(saved.path), path.basename(retained)].sort(),
    );
    expect(fs.readFileSync(saved.path, "utf8")).toBe(PEM);
  });
});
