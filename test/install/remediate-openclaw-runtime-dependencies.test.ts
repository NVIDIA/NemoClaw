// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_MANAGED_PLUGIN_WORKSPACE } from "../fixtures/openclaw-managed-plugin-workspace";
import {
  remediateOpenClawRuntimeDependencies,
  patchOpenClawManagedPluginOverrides,
} from "../../scripts/lib/remediate-openclaw-runtime-dependencies.mts";

const directories: string[] = [];
function fixture(installedVersion = "8.12.3") {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-runtime-security-"));
  directories.push(root);
  const legacy = join(root, "node_modules/openclaw/node_modules/undici");
  const replacement = join(root, "node_modules/undici");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(replacement, { recursive: true });
  writeFileSync(
    join(root, "node_modules/openclaw/package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.7" }),
  );
  writeFileSync(
    join(legacy, "package.json"),
    JSON.stringify({ name: "undici", version: "8.10.2" }),
  );
  writeFileSync(join(legacy, "original.js"), "original");
  writeFileSync(
    join(replacement, "package.json"),
    JSON.stringify({ name: "undici", version: installedVersion }),
  );
  const lockfile = join(root, "package-lock.json");
  writeFileSync(
    lockfile,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { openclaw: "2026.9.7", undici: "8.12.3" } },
        "node_modules/openclaw": { version: "2026.9.7" },
        "node_modules/undici": { version: "8.12.3" },
      },
    }),
  );
  return { root, legacy, replacement, lockfile };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("OpenClaw migration HTTP dependency remediation", () => {
  it("removes the bundled copy only when the consumer resolves the reviewed replacement", () => {
    const target = fixture();
    const originalLock = readFileSync(target.lockfile, "utf8");
    remediateOpenClawRuntimeDependencies(target.root);
    expect(existsSync(target.legacy)).toBe(false);
    expect(readFileSync(target.lockfile, "utf8")).toBe(originalLock);
    remediateOpenClawRuntimeDependencies(target.root);
    expect(readFileSync(target.lockfile, "utf8")).toBe(originalLock);
  });

  it("rechecks the resolved package on an already remediated installation", () => {
    const target = fixture();
    remediateOpenClawRuntimeDependencies(target.root);
    writeFileSync(
      join(target.replacement, "package.json"),
      JSON.stringify({ name: "undici", version: "8.10.2" }),
    );
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "HTTP client identity mismatch",
    );
    expect(existsSync(target.legacy)).toBe(false);
  });

  it("restores the original copy when replacement verification fails", () => {
    const target = fixture("8.10.2");
    const originalLock = readFileSync(target.lockfile, "utf8");
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "HTTP client identity mismatch",
    );
    expect(readFileSync(join(target.legacy, "original.js"), "utf8")).toBe("original");
    expect(readFileSync(target.lockfile, "utf8")).toBe(originalLock);
  });

  it("rejects a linked dependency without changing its target", () => {
    const target = fixture();
    const outside = join(target.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "preserved");
    rmSync(target.legacy, { recursive: true });
    symlinkSync(outside, target.legacy);
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "must be a real directory",
    );
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("preserved");
  });

  it("updates the opened lock without overwriting a replacement pathname", () => {
    const target = fixture();
    const opened = join(target.root, "opened-lock.json");
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((descriptor) => {
      const contents = originalRead(descriptor, "utf8");
      fs.renameSync(target.lockfile, opened);
      writeFileSync(target.lockfile, "replacement must remain unchanged");
      return contents;
    });
    remediateOpenClawRuntimeDependencies(target.root, { updateLock: true });
    expect(readFileSync(target.lockfile, "utf8")).toBe("replacement must remain unchanged");
    expect(JSON.parse(readFileSync(opened, "utf8")).packages["node_modules/undici"].version).toBe(
      "8.12.3",
    );
  });

  it("rejects lock contents changed since the initial review", () => {
    const target = fixture();
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((descriptor) => {
      writeFileSync(target.lockfile, '{"changed":true}\n');
      return originalRead(descriptor, "utf8");
    });
    expect(() => remediateOpenClawRuntimeDependencies(target.root, { updateLock: true })).toThrow(
      "metadata changed before writing",
    );
    expect(readFileSync(target.lockfile, "utf8")).toBe('{"changed":true}\n');
  });

  it("refuses a stale lock instead of quietly changing its reviewed identity", () => {
    const target = fixture();
    const lock = JSON.parse(readFileSync(target.lockfile, "utf8"));
    lock.packages["node_modules/openclaw/node_modules/undici"] = {
      version: "8.10.2",
      inBundle: true,
    };
    writeFileSync(target.lockfile, JSON.stringify(lock));
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "retains an unremediated bundled HTTP client",
    );
    expect(readFileSync(join(target.legacy, "original.js"), "utf8")).toBe("original");
  });
});

function workspaceFixture() {
  const { root } = fixture();
  const owner = join(root, "node_modules/openclaw");
  writeFileSync(
    join(owner, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
  );
  const workspace = join(owner, "pnpm-workspace.yaml");
  writeFileSync(workspace, OPENCLAW_MANAGED_PLUGIN_WORKSPACE, { mode: 0o600 });
  return { root, owner, workspace };
}

describe("OpenClaw managed plugin security overrides", () => {
  it("patches the reviewed workspace and remains idempotent", () => {
    const { owner, workspace } = workspaceFixture();
    patchOpenClawManagedPluginOverrides(owner);
    const patched = readFileSync(workspace);
    expect(createHash("sha256").update(patched).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
    expect(fs.statSync(workspace).mode & 0o777).toBe(0o600);
    patchOpenClawManagedPluginOverrides(owner);
    expect(readFileSync(workspace)).toEqual(patched);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink without changing its target", () => {
    const { root, owner, workspace } = workspaceFixture();
    const target = join(root, "target.yaml");
    fs.renameSync(workspace, target);
    symlinkSync(target, workspace);
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow();
    expect(readFileSync(target, "utf8")).toBe(OPENCLAW_MANAGED_PLUGIN_WORKSPACE);
  });

  it("does not follow a pathname replaced after reading the workspace", () => {
    const { root, owner, workspace } = workspaceFixture();
    const opened = join(root, "opened.yaml");
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((descriptor) => {
      const contents = originalRead(descriptor, "utf8");
      fs.renameSync(workspace, opened);
      writeFileSync(workspace, "replacement must remain unchanged");
      return contents;
    });
    patchOpenClawManagedPluginOverrides(owner);
    expect(readFileSync(workspace, "utf8")).toBe("replacement must remain unchanged");
    expect(createHash("sha256").update(readFileSync(opened)).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
  });

  it("completes a short write at the correct offset", () => {
    const { owner, workspace } = workspaceFixture();
    const originalWrite = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementationOnce((descriptor, bytes) =>
      originalWrite(descriptor, Buffer.from(bytes), 0, 7, 0),
    );
    patchOpenClawManagedPluginOverrides(owner);
    expect(createHash("sha256").update(readFileSync(workspace)).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
  });

  it("fails a stalled write and closes the opened file", () => {
    const { owner, workspace } = workspaceFixture();
    vi.spyOn(fs, "writeSync").mockReturnValueOnce(0);
    const close = vi.spyOn(fs, "closeSync");
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("write made no progress");
    expect(close).toHaveBeenCalledOnce();
    expect(readFileSync(workspace, "utf8")).toBe(OPENCLAW_MANAGED_PLUGIN_WORKSPACE);
  });

  it("rejects a missing workspace without creating it", () => {
    const { owner, workspace } = workspaceFixture();
    rmSync(workspace);
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow();
    expect(existsSync(workspace)).toBe(false);
  });

  it("repairs the runtime manifest through the opened file", () => {
    const { root, owner, workspace } = workspaceFixture();
    const ownerFile = join(owner, "package.json");
    writeFileSync(
      ownerFile,
      JSON.stringify({
        name: "openclaw",
        version: "2026.10.5",
        dependencies: { undici: "8.11.2", npm: "12.2.0" },
      }),
    );
    const lockfile = join(root, "package-lock.json");
    writeFileSync(
      lockfile,
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/openclaw": { version: "2026.10.5" } },
      }),
    );
    const opened = join(root, "opened-manifest.json");
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync")
      .mockImplementationOnce((descriptor) => originalRead(descriptor, "utf8"))
      .mockImplementationOnce((descriptor) => {
        const contents = originalRead(descriptor, "utf8");
        fs.renameSync(ownerFile, opened);
        writeFileSync(ownerFile, JSON.stringify({ name: "replacement", untouched: true }));
        return contents;
      });
    remediateOpenClawRuntimeDependencies(root, { updateLock: true });
    expect(JSON.parse(readFileSync(ownerFile, "utf8"))).toEqual({
      name: "replacement",
      untouched: true,
    });
    expect(JSON.parse(readFileSync(opened, "utf8")).dependencies).toEqual({
      undici: "8.12.3",
      npm: "12.2.1",
    });
    expect(
      JSON.parse(readFileSync(lockfile, "utf8")).packages["node_modules/openclaw"].dependencies,
    ).toEqual({ undici: "8.12.3", npm: "12.2.1" });
    expect(createHash("sha256").update(readFileSync(workspace)).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
  });

  it("rejects workspace source drift without changing the file", () => {
    const { root } = fixture();
    const owner = join(root, "node_modules/openclaw");
    writeFileSync(
      join(owner, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
    );
    const workspace = join(owner, "pnpm-workspace.yaml");
    writeFileSync(workspace, "overrides: {}\n");
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("source integrity mismatch");
    expect(readFileSync(workspace, "utf8")).toBe("overrides: {}\n");
  });
});
