// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

import { applyOpenShellVmDnsMonkeypatch } from "./vm-dns-monkeypatch";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vm-dns-monkeypatch-"));
  tempDirs.push(dir);
  return dir;
}

function sandboxRootfs(stateDir: string, sandboxId = "abc"): string {
  return path.join(stateDir, "vm-driver", "sandboxes", sandboxId, "rootfs");
}

describe("OpenShell VM DNS monkeypatch", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a warning result instead of throwing when rootfs files cannot be patched", () => {
    const stateDir = makeTempDir();
    const rootfs = sandboxRootfs(stateDir);
    fs.mkdirSync(path.join(rootfs, "etc", "resolv.conf"), { recursive: true });

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
      rootfs,
    });
    expect(result.reason).toContain("failed to patch VM DNS files");
  });
});
