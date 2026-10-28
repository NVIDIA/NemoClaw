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
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  interruptMetadataWrite,
  replaceAfterMetadataRead,
  failMetadataDirectorySync,
} from "../support/metadata-write-faults";
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
  return {
    root,
    legacy,
    replacement,
    lockfile,
    replacementManifest: join(replacement, "package.json"),
    backupManifest: join(
      root,
      "node_modules/openclaw/node_modules/.undici-security-remediation-backup/package.json",
    ),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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

  it("retries retained backup cleanup after verifying the replacement", () => {
    const target = fixture();
    const backup = join(
      fs.realpathSync(target.root),
      "node_modules/openclaw/node_modules/.undici-security-remediation-backup",
    );
    const originalLock = readFileSync(target.lockfile);
    const replacement = readFileSync(target.replacementManifest);
    const failure = vi.spyOn(fs, "rmSync").mockImplementation((filename) => {
      expect(filename).toBe(backup);
      throw new Error("injected backup cleanup failure");
    });
    syncBuiltinESMExports();
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(/cleanup/);
    expect(existsSync(target.legacy)).toBe(false);
    expect(readFileSync(join(backup, "original.js"), "utf8")).toBe("original");
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(backup);
    expect(readFileSync(join(backup, "original.js"), "utf8")).toBe("original");
    failure.mockRestore();
    syncBuiltinESMExports();

    remediateOpenClawRuntimeDependencies(target.root);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(target.legacy)).toBe(false);
    expect(readFileSync(target.replacementManifest)).toEqual(replacement);
    expect(readFileSync(target.lockfile)).toEqual(originalLock);
  });

  it.each([
    {
      condition: "wrong identity",
      mutate: (target: ReturnType<typeof fixture>, backup: string) =>
        writeFileSync(
          join(backup, "package.json"),
          JSON.stringify({ name: "other", version: "8.10.2" }),
        ),
    },
    {
      condition: "unsafe member",
      mutate: (target: ReturnType<typeof fixture>, backup: string) =>
        symlinkSync(target.replacement, join(backup, "unsafe")),
    },
    {
      condition: "linked backup",
      mutate: (target: ReturnType<typeof fixture>, backup: string) => {
        const retained = join(target.root, "retained");
        fs.renameSync(backup, retained);
        symlinkSync(retained, backup);
      },
    },
    {
      condition: "linked parent",
      mutate: (target: ReturnType<typeof fixture>) => {
        const parent = join(target.root, "node_modules/openclaw/node_modules");
        const retained = join(target.root, "retained-dependencies");
        fs.renameSync(parent, retained);
        symlinkSync(retained, parent);
      },
    },
    {
      condition: "invalid replacement",
      mutate: (target: ReturnType<typeof fixture>) =>
        writeFileSync(
          target.replacementManifest,
          JSON.stringify({ name: "undici", version: "8.10.2" }),
        ),
    },
    {
      condition: "both copies",
      mutate: (target: ReturnType<typeof fixture>, backup: string) =>
        fs.cpSync(backup, target.legacy, { recursive: true }),
    },
  ])("preserves a retained backup when recovery finds $condition", ({ condition, mutate }) => {
    const target = fixture();
    const backup = join(
      fs.realpathSync(target.root),
      "node_modules/openclaw/node_modules/.undici-security-remediation-backup",
    );
    const originalLock = readFileSync(target.lockfile);
    fs.renameSync(target.legacy, backup);
    mutate(target, backup);
    const before = readFileSync(target.backupManifest);
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow();
    expect(readFileSync(join(backup, "original.js"), "utf8")).toBe("original");
    expect(readFileSync(target.backupManifest)).toEqual(before);
    expect(readFileSync(target.lockfile)).toEqual(originalLock);
    expect(existsSync(target.legacy)).toBe(condition === "both copies");
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

  it("rejects a replaced lock pathname without changing either file", () => {
    const target = fixture();
    const opened = join(target.root, "opened-lock.json");
    const originalLock = readFileSync(target.lockfile);
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((descriptor) => {
      const contents = originalRead(descriptor, "utf8");
      fs.renameSync(target.lockfile, opened);
      writeFileSync(target.lockfile, "replacement must remain unchanged");
      return contents;
    });
    expect(() => remediateOpenClawRuntimeDependencies(target.root, { updateLock: true })).toThrow(
      "changed before writing",
    );
    expect(readFileSync(target.lockfile, "utf8")).toBe("replacement must remain unchanged");
    expect(readFileSync(opened)).toEqual(originalLock);
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

function readWorkspaceSnapshot(workspace: string) {
  const descriptor = fs.openSync(workspace, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return { contents: readFileSync(descriptor), mode: fs.fstatSync(descriptor).mode & 0o777 };
  } finally {
    fs.closeSync(descriptor);
  }
}

describe("OpenClaw managed plugin security overrides", () => {
  it("preserves a workspace changed while replacement bytes are being staged", () => {
    const { owner, workspace } = workspaceFixture();
    const entries = fs.readdirSync(owner).sort();
    const write = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementationOnce((descriptor, bytes, ...args) => {
      const written = write(descriptor, bytes, ...args);
      writeFileSync(workspace, "concurrent owner data");
      return written;
    });
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("changed before writing");
    expect(readFileSync(workspace, "utf8")).toBe("concurrent owner data");
    expect(fs.readdirSync(owner).sort()).toEqual(entries);
  });

  it.each(["fchmodSync", "fsyncSync", "renameSync"] as const)(
    "preserves the workspace when %s fails before replacement and permits retry",
    (operation) => {
      const { owner, workspace } = workspaceFixture();
      const original = readWorkspaceSnapshot(workspace);
      const entries = fs.readdirSync(owner).sort();
      const failure = vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error("injected metadata publication failure");
      });
      expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow(
        "injected metadata publication failure",
      );
      expect(readWorkspaceSnapshot(workspace)).toEqual(original);
      expect(fs.readdirSync(owner).sort()).toEqual(entries);
      failure.mockRestore();
      patchOpenClawManagedPluginOverrides(owner);
      expect(createHash("sha256").update(readFileSync(workspace)).digest("hex")).toBe(
        "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
      );
      expect(readWorkspaceSnapshot(workspace).mode).toBe(original.mode);
    },
  );

  it("rejects corrupted staging bytes without replacing the workspace", () => {
    const { owner, workspace } = workspaceFixture();
    const original = readWorkspaceSnapshot(workspace);
    const entries = fs.readdirSync(owner).sort();
    const write = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementationOnce((descriptor, bytes) =>
      write(descriptor, Buffer.alloc(bytes.length)),
    );
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow(
      "staged contents failed verification",
    );
    expect(readWorkspaceSnapshot(workspace)).toEqual(original);
    expect(fs.readdirSync(owner).sort()).toEqual(entries);
  });

  // source-shape-contract: compatibility -- Exact runtime metadata bytes must survive interrupted remediation so the original package manager can retry safely.
  it.each(["workspace", "manifest", "lock"] as const)(
    "preserves %s metadata after a partial write failure and permits retry",
    (kind) => {
      const { root, owner, workspace } = workspaceFixture();
      const manifest = join(owner, "package.json");
      const lock = join(root, "package-lock.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          name: "openclaw",
          version: "2026.10.5",
          dependencies: { undici: "8.11.2", npm: "12.2.0" },
        }),
      );
      writeFileSync(
        lock,
        JSON.stringify({
          lockfileVersion: 3,
          packages: { "node_modules/openclaw": { version: "2026.10.5" } },
        }),
      );
      const filename = { workspace, manifest, lock }[kind];
      const original = readFileSync(filename);
      const entries = fs.readdirSync(kind === "lock" ? root : owner).sort();
      const marker = {
        workspace: "overrides:\n",
        manifest: '"name": "openclaw"',
        lock: '"lockfileVersion"',
      }[kind];
      const prefixLength = {
        workspace: (contents: string) => contents.indexOf("@azure/msal-node") + 10,
        manifest: (_contents: string) => 7,
        lock: (_contents: string) => 7,
      }[kind];
      const failure = interruptMetadataWrite(marker, prefixLength);
      expect(() => remediateOpenClawRuntimeDependencies(root, { updateLock: true })).toThrow(
        "injected partial metadata write failure",
      );
      expect(readWorkspaceSnapshot(filename).contents).toEqual(original);
      expect(fs.readdirSync(kind === "lock" ? root : owner).sort()).toEqual(entries);
      failure.mockRestore();
      remediateOpenClawRuntimeDependencies(root, { updateLock: true });
      expect(createHash("sha256").update(readFileSync(workspace)).digest("hex")).toBe(
        "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
      );
      expect(JSON.parse(readFileSync(manifest, "utf8")).dependencies).toEqual({
        undici: "8.12.3",
        npm: "12.2.1",
      });
      expect(
        JSON.parse(readFileSync(lock, "utf8")).packages["node_modules/openclaw"].dependencies,
      ).toEqual({
        undici: "8.12.3",
        npm: "12.2.1",
      });
    },
  );

  it("reports directory sync failure and retries complete published metadata", () => {
    const { owner, workspace } = workspaceFixture();
    const entries = fs.readdirSync(owner).sort();
    const failure = failMetadataDirectorySync();
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("directory sync failed");
    expect(createHash("sha256").update(readFileSync(workspace)).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
    expect(fs.readdirSync(owner).sort()).toEqual(entries);
    // Already patched bytes must not hide an incomplete directory publication on retry.
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("directory sync failed");
    failure.mockRestore();
    patchOpenClawManagedPluginOverrides(owner);
    expect(createHash("sha256").update(readFileSync(workspace)).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
    expect(fs.readdirSync(owner).sort()).toEqual(entries);
  });

  it("patches the reviewed workspace and remains idempotent", () => {
    const { owner, workspace } = workspaceFixture();
    patchOpenClawManagedPluginOverrides(owner);
    const patched = readWorkspaceSnapshot(workspace);
    expect(createHash("sha256").update(patched.contents).digest("hex")).toBe(
      "c48734878ccb1de613af3307aa42f26cb8d6add6ca1e2dc95a2761ff671e20bb",
    );
    expect(patched.mode).toBe(0o600);
    patchOpenClawManagedPluginOverrides(owner);
    expect(readWorkspaceSnapshot(workspace)).toEqual(patched);
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
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("changed before writing");
    expect(readFileSync(workspace, "utf8")).toBe("replacement must remain unchanged");
    expect(readFileSync(opened, "utf8")).toBe(OPENCLAW_MANAGED_PLUGIN_WORKSPACE);
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
    const opened = vi.spyOn(fs, "openSync");
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("write made no progress");
    expect(opened.mock.results).toHaveLength(2);
    expect(opened.mock.results[0].type).toBe("return");
    expect(opened.mock.results[1].type).toBe("return");
    expect(() => fs.fstatSync(opened.mock.results[0].value)).toThrow();
    expect(() => fs.fstatSync(opened.mock.results[1].value)).toThrow();
    expect(readFileSync(workspace, "utf8")).toBe(OPENCLAW_MANAGED_PLUGIN_WORKSPACE);
  });

  it("rejects a missing workspace without creating it", () => {
    const { owner, workspace } = workspaceFixture();
    rmSync(workspace);
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow();
    expect(existsSync(workspace)).toBe(false);
  });

  it("rejects a replaced runtime manifest without changing either file or the lock", () => {
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
    const originalLock = readFileSync(lockfile);
    replaceAfterMetadataRead('"npm":"12.2.0"', () => {
      fs.renameSync(ownerFile, opened);
      writeFileSync(ownerFile, JSON.stringify({ name: "replacement", untouched: true }));
    });
    expect(() => remediateOpenClawRuntimeDependencies(root, { updateLock: true })).toThrow(
      "changed before writing",
    );
    expect(JSON.parse(readFileSync(ownerFile, "utf8"))).toEqual({
      name: "replacement",
      untouched: true,
    });
    expect(JSON.parse(readFileSync(opened, "utf8")).dependencies).toEqual({
      undici: "8.11.2",
      npm: "12.2.0",
    });
    expect(readFileSync(lockfile)).toEqual(originalLock);
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
