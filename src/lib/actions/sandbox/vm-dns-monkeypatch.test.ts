// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

import {
  applyOpenShellVmDnsMonkeypatch,
  shouldApplyVmDnsMonkeypatch,
} from "./vm-dns-monkeypatch";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vm-dns-monkeypatch-"));
  tempDirs.push(dir);
  return dir;
}

function sandboxRootfs(stateDir: string, sandboxId = "abc"): string {
  return path.join(stateDir, "vm-driver", "sandboxes", sandboxId, "rootfs");
}

function sandboxDir(stateDir: string, sandboxId = "abc"): string {
  return path.join(stateDir, "vm-driver", "sandboxes", sandboxId);
}

function writeRecognizedInit(rootfs: string): void {
  fs.mkdirSync(path.join(rootfs, "srv"), { recursive: true });
  fs.writeFileSync(
    path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"),
    [
      "elif ip link show eth0 >/dev/null 2>&1; then",
      "    if [ ! -s /etc/resolv.conf ]; then",
      '        echo "nameserver 8.8.8.8" > /etc/resolv.conf',
      '        echo "nameserver 8.8.4.4" >> /etc/resolv.conf',
      "    fi",
      "fi",
      "",
    ].join("\n"),
  );
}

function writeRootfsFiles(rootfs: string, resolver: string): void {
  fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
  fs.writeFileSync(path.join(rootfs, "etc", "resolv.conf"), resolver);
  writeRecognizedInit(rootfs);
}

describe("OpenShell VM DNS monkeypatch", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not attempt non-VM sandboxes", () => {
    const capture = vi.fn();

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "kubernetes" },
      {
        capture,
        env: {},
        platform: "darwin",
        stateDir: makeTempDir(),
      },
    );

    expect(result).toMatchObject({
      attempted: false,
      changed: false,
      ok: false,
      status: "skipped",
    });
    expect(result.reason).toContain("not an OpenShell VM sandbox");
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not attempt non-Darwin VM sandboxes unless force-enabled", () => {
    const capture = vi.fn();

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture,
        env: {},
        platform: "linux",
        stateDir: makeTempDir(),
      },
    );

    expect(result).toMatchObject({
      attempted: false,
      changed: false,
      ok: false,
      status: "skipped",
    });
    expect(result.reason).toContain("not running on macOS");
    expect(capture).not.toHaveBeenCalled();
    expect(shouldApplyVmDnsMonkeypatch({ openshellDriver: "vm" }, "linux", {})).toBe(false);
    expect(
      shouldApplyVmDnsMonkeypatch({ openshellDriver: "vm" }, "linux", {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      }),
    ).toBe(true);
  });

  it("honors the VM DNS monkeypatch kill switch", () => {
    const capture = vi.fn();

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture,
        env: { NEMOCLAW_DISABLE_VM_DNS_MONKEYPATCH: "1" },
        platform: "darwin",
        stateDir: makeTempDir(),
      },
    );

    expect(result).toMatchObject({
      attempted: false,
      changed: false,
      ok: false,
      status: "skipped",
    });
    expect(result.reason).toContain("disabled");
    expect(capture).not.toHaveBeenCalled();
  });

  it("puts gvproxy DNS first while preserving resolver options and private resolvers", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    writeRootfsFiles(
      rootfs,
      [
        "search corp.example",
        "options ndots:5",
        "nameserver 8.8.8.8",
        "nameserver 10.0.0.2",
        "nameserver 192.168.127.1",
        "nameserver 10.0.0.2",
        "nameserver 8.8.4.4",
        "",
      ].join("\n"),
    );

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: true,
      ok: true,
      status: "applied",
    });
    expect(fs.readFileSync(path.join(rootfs, "etc", "resolv.conf"), "utf-8")).toBe(
      [
        "nameserver 192.168.127.1",
        "search corp.example",
        "options ndots:5",
        "nameserver 10.0.0.2",
        "",
      ].join("\n"),
    );
    expect(
      fs.readFileSync(path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"), "utf-8"),
    ).toContain('echo "nameserver ${GVPROXY_GATEWAY_IP}" > /etc/resolv.conf');
  });

  it("is idempotent when resolver and init script are already patched", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.mkdirSync(path.join(rootfs, "srv"), { recursive: true });
    fs.writeFileSync(
      path.join(rootfs, "etc", "resolv.conf"),
      "nameserver 192.168.127.1\nsearch corp.example\noptions ndots:5\n",
    );
    fs.writeFileSync(
      path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"),
      'echo "nameserver ${GVPROXY_GATEWAY_IP}" > /etc/resolv.conf\n',
    );

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: true,
      status: "already-present",
    });
  });

  it("returns a soft failure when the VM rootfs is missing", () => {
    const stateDir = makeTempDir();
    fs.mkdirSync(sandboxDir(stateDir), { recursive: true });

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: false,
      status: "failed",
    });
    expect(result.reason).toContain("VM rootfs not found");
  });

  it("returns a specific unsupported-layout reason for ext4-style VM root disks", () => {
    const stateDir = makeTempDir();
    const dir = sandboxDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: false,
      status: "failed",
    });
    expect(result.reason).toContain("ext4 root disk layout");
    expect(result.reason).toContain("rootfs DNS monkeypatch no longer applies");
  });

  it("refuses unknown init-script shapes without rewriting resolver files", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.mkdirSync(path.join(rootfs, "srv"), { recursive: true });
    const resolverPath = path.join(rootfs, "etc", "resolv.conf");
    const originalResolver = "nameserver 8.8.8.8\n";
    fs.writeFileSync(resolverPath, originalResolver);
    fs.writeFileSync(path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"), "echo unknown\n");

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: false,
      status: "failed",
    });
    expect(result.reason).toContain("init script shape not recognized");
    expect(fs.readFileSync(resolverPath, "utf-8")).toBe(originalResolver);
  });

  it("refuses resolver symlinks that escape the VM rootfs", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    const outside = path.join(stateDir, "outside-resolv.conf");
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.writeFileSync(outside, "nameserver 8.8.8.8\n");
    fs.symlinkSync(outside, path.join(rootfs, "etc", "resolv.conf"));
    writeRecognizedInit(rootfs);

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: false,
      status: "failed",
    });
    expect(result.reason).toContain("resolves outside VM rootfs");
    expect(fs.readFileSync(outside, "utf-8")).toBe("nameserver 8.8.8.8\n");
  });

  it("refuses dangling resolver symlinks before writing", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    const outside = path.join(stateDir, "missing-resolv.conf");
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.symlinkSync(outside, path.join(rootfs, "etc", "resolv.conf"));
    writeRecognizedInit(rootfs);

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: false,
      status: "failed",
    });
    expect(result.reason).toContain("dangling symlink");
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("returns a warning result instead of throwing when rootfs files cannot be patched", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    fs.mkdirSync(path.join(rootfs, "etc", "resolv.conf"), { recursive: true });
    writeRecognizedInit(rootfs);

    const result = applyOpenShellVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        capture: () => ({ status: 0, output: "Id: abc\n" }),
        platform: "darwin",
        stateDir,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      changed: false,
      ok: false,
      rootfs: fs.realpathSync.native(rootfs),
      status: "failed",
    });
    expect(result.reason).toContain("failed to patch VM DNS files");
  });
});
