// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type fs from "node:fs";
const SNAP = "/snap/20260323";

// ── In-memory filesystem ────────────────────────────────────────

interface FsEntry {
  type: "file" | "dir" | "symlink";
  content?: string;
  target?: string;
}

const store = new Map<string, FsEntry>();

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

function addSymlink(p: string, target: string): void {
  store.set(p, { type: "symlink", target });
}

const FAKE_HOME = "/fakehome";

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    lstatSync: (p: string) => {
      const entry = store.get(p);
      if (!entry) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${p}'`), {
          code: "ENOENT",
        });
      }
      return {
        isSymbolicLink: () => entry.type === "symlink",
        isDirectory: () => entry.type === "dir",
        isFile: () => entry.type === "file",
      };
    },
    readlinkSync: (p: string) => {
      const entry = store.get(p);
      if (entry?.type !== "symlink") {
        throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${p}'`), {
          code: "EINVAL",
        });
      }
      return entry.target ?? "";
    },
    mkdirSync: vi.fn((p: string) => {
      addDir(p);
    }),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      if (entry?.type !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, { type: "file", content: data });
    }),
    cpSync: vi.fn((src: string, dest: string) => {
      for (const [k, v] of store) {
        if (k === src || k.startsWith(src + "/")) {
          const relative = k.slice(src.length);
          store.set(dest + relative, { ...v });
        }
      }
    }),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      for (const [k, v] of [...store]) {
        if (k === oldPath || k.startsWith(oldPath + "/")) {
          const relative = k.slice(oldPath.length);
          store.set(newPath + relative, v);
          store.delete(k);
        }
      }
    }),
    rmSync: vi.fn((target: string) => {
      for (const k of [...store.keys()]) {
        if (k === target || k.startsWith(target + "/")) {
          store.delete(k);
        }
      }
    }),
    readdirSync: (p: string, opts?: { withFileTypes?: boolean }) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const childTypes = new Map<string, "file" | "dir" | "symlink">();
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const name = rest.split("/")[0];
          if (!name) continue;
          const isNested = rest.includes("/");
          if (!childTypes.has(name)) {
            childTypes.set(name, isNested ? "dir" : v.type);
          } else if (isNested) {
            childTypes.set(name, "dir");
          }
        }
      }
      if (childTypes.size === 0 && !store.has(p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      if (opts?.withFileTypes) {
        return [...childTypes].map(([name, type]) => ({
          name,
          isDirectory: () => type === "dir",
          isFile: () => type === "file",
          isSymbolicLink: () => type === "symlink",
        }));
      }
      return [...childTypes.keys()].sort();
    },
  };
});

const mockExeca = vi.fn();
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));

const {
  createSnapshot,
  restoreIntoSandbox,
  cutoverHost,
  rollbackFromSnapshot,
  listSnapshots,
  moveSync,
} = await import("./snapshot.js");

const OPENCLAW_DIR = `${FAKE_HOME}/.openclaw`;
const SNAPSHOTS_DIR = `${FAKE_HOME}/.nemoclaw/snapshots`;

// ── Tests ───────────────────────────────────────────────────────

describe("snapshot", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createSnapshot", () => {
    it("returns null when ~/.openclaw does not exist", () => {
      expect(createSnapshot()).toBeNull();
    });

    it("copies ~/.openclaw and writes manifest", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"version":"1"}');
      addFile(`${OPENCLAW_DIR}/hooks/demo/HOOK.md`, "# hook");

      const result = createSnapshot();

      expect(result).not.toBeNull();
      if (!result) throw new Error("createSnapshot returned null");

      expect(result.startsWith(SNAPSHOTS_DIR)).toBe(true);

      // Manifest was written
      const manifestPath = `${result}/snapshot.json`;
      const entry = store.get(manifestPath);
      if (!entry?.content) throw new Error("manifest not written");
      const manifest = JSON.parse(entry.content);
      expect(manifest.source).toBe(OPENCLAW_DIR);
      expect(manifest.file_count).toBe(2);
      expect(manifest.contents).toContain("openclaw.json");
      expect(manifest.contents).toContain("hooks/demo/HOOK.md");
    });

    it("rejects when ~/.openclaw is a symlink", () => {
      addSymlink(OPENCLAW_DIR, "/etc");

      expect(() => createSnapshot()).toThrow(/symbolic link/);
    });

    it("rejects when an ancestor of ~/.nemoclaw is a symlink", () => {
      addDir(OPENCLAW_DIR);
      addSymlink(`${FAKE_HOME}/.nemoclaw`, "/attacker-controlled");

      expect(() => createSnapshot()).toThrow(/symbolic link/);
    });

    it("records symlinks in manifest when present in tree", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"version":"1"}');
      addSymlink(`${OPENCLAW_DIR}/evil`, "/etc/shadow");

      const result = createSnapshot();
      expect(result).not.toBeNull();
      if (!result) throw new Error("createSnapshot returned null");

      const manifestPath = `${result}/snapshot.json`;
      const entry = store.get(manifestPath);
      if (!entry?.content) throw new Error("manifest not written");
      const manifest = JSON.parse(entry.content);
      expect(manifest.file_count).toBe(1);
      expect(manifest.contents).toContain("openclaw.json");
      expect(manifest.symlinks).toContain("evil");
    });
  });

  describe("restoreIntoSandbox", () => {
    it("returns false when snapshot has no openclaw dir", async () => {
      addDir(SNAP);
      expect(await restoreIntoSandbox(SNAP)).toBe(false);
    });

    it("calls openshell sandbox cp and returns true on success", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 0 });

      expect(await restoreIntoSandbox(SNAP, "mybox")).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "cp", `${SNAP}/openclaw`, "mybox:/sandbox/.openclaw"],
        { reject: false },
      );
    });

    it("returns false when openshell fails", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 1 });

      expect(await restoreIntoSandbox(SNAP)).toBe(false);
    });

    it("uses default sandbox name 'openclaw'", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 0 });

      await restoreIntoSandbox(SNAP);
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        expect.arrayContaining(["openclaw:/sandbox/.openclaw"]),
        expect.anything(),
      );
    });

    it("repairs legacy symlinks before best-effort chown after successful copy", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // cp
        .mockResolvedValueOnce({ exitCode: 0, stderr: "" }) // legacy symlink repair
        .mockResolvedValueOnce({ exitCode: 0, stderr: "" }); // chown

      expect(await restoreIntoSandbox(SNAP, "mybox")).toBe(true);
      expect(mockExeca).toHaveBeenCalledTimes(3);
      expect(mockExeca).toHaveBeenNthCalledWith(
        2,
        "openshell",
        expect.arrayContaining(["sandbox", "exec", "mybox", "--", "bash", "-lc"]),
        { reject: false },
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        3,
        "openshell",
        ["sandbox", "exec", "mybox", "--", "chown", "-R", "sandbox:sandbox", "/sandbox/.openclaw"],
        { reject: false },
      );
    });

    it("returns true even when chown fails (best-effort)", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // cp succeeds
        .mockResolvedValueOnce({ exitCode: 0, stderr: "" }) // legacy symlink repair
        .mockResolvedValueOnce({ exitCode: 1, stderr: "chown: operation not permitted" }); // chown fails

      expect(await restoreIntoSandbox(SNAP, "mybox")).toBe(true);
    });

    it("does not call chown when cp fails", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValueOnce({ exitCode: 1 }); // cp fails

      expect(await restoreIntoSandbox(SNAP)).toBe(false);
      expect(mockExeca).toHaveBeenCalledTimes(1);
    });
  });

  describe("moveSync", () => {
    it("uses renameSync when on the same device", () => {
      addDir("/src-dir");
      addFile("/src-dir/file.txt", "hello");

      moveSync("/src-dir", "/dest-dir");

      expect(store.has("/dest-dir/file.txt")).toBe(true);
      expect(store.has("/src-dir")).toBe(false);
    });

    it("falls back to cpSync + rmSync when renameSync throws EXDEV", async () => {
      addDir("/xdev-src");
      addFile("/xdev-src/file.txt", "cross-device");

      const fs = await import("node:fs");
      const { renameSync: mockRename, cpSync: mockCp } = vi.mocked(fs);

      // First call: throw EXDEV (cross-device)
      const exdevError = Object.assign(new Error("EXDEV: cross-device link not permitted"), {
        code: "EXDEV",
        errno: -18,
        syscall: "rename",
      });
      mockRename.mockImplementationOnce(() => {
        throw exdevError;
      });

      // cpSync mock: copy entries from src to dest (default mock behavior)
      // rmSync mock: exists via import

      moveSync("/xdev-src", "/xdev-dest");

      // cpSync should have been called as fallback
      expect(mockCp).toHaveBeenCalledWith("/xdev-src", "/xdev-dest", { recursive: true });
    });

    it("re-throws non-EXDEV errors from renameSync", async () => {
      addDir("/eperm-src");

      const fs = await import("node:fs");
      const { renameSync: mockRename } = vi.mocked(fs);

      mockRename.mockImplementationOnce(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      });

      expect(() => {
        moveSync("/eperm-src", "/eperm-dest");
      }).toThrow("EPERM");
    });
  });

  describe("cutoverHost", () => {
    it("returns true when ~/.openclaw does not exist", () => {
      expect(cutoverHost()).toBe(true);
    });

    it("renames ~/.openclaw to archive path", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, "{}");

      expect(cutoverHost()).toBe(true);
      expect(store.has(OPENCLAW_DIR)).toBe(false);

      // Archived under a .openclaw.pre-nemoclaw.* name
      const archived = [...store.keys()].find((k) => k.includes(".openclaw.pre-nemoclaw."));
      expect(archived).toBeDefined();
    });

    it("returns false when rename fails", async () => {
      addDir(OPENCLAW_DIR);
      const fs = await import("node:fs");
      const { renameSync } = vi.mocked(fs);
      renameSync.mockImplementationOnce(() => {
        throw new Error("EPERM");
      });

      expect(cutoverHost()).toBe(false);
    });
  });

  describe("rollbackFromSnapshot", () => {
    it("returns false when snapshot openclaw dir is missing", () => {
      addDir(SNAP);
      expect(rollbackFromSnapshot(SNAP)).toBe(false);
    });

    it("restores snapshot to ~/.openclaw with content", () => {
      addDir(`${SNAP}/openclaw`);
      addFile(`${SNAP}/openclaw/openclaw.json`, '{"restored":true}');

      expect(rollbackFromSnapshot(SNAP)).toBe(true);

      const restored = store.get(`${OPENCLAW_DIR}/openclaw.json`);
      if (!restored) throw new Error("openclaw.json not restored");
      expect(restored.content).toBe('{"restored":true}');
    });

    it("archives existing ~/.openclaw before restoring", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"old":true}');
      addDir(`${SNAP}/openclaw`);
      addFile(`${SNAP}/openclaw/openclaw.json`, '{"restored":true}');

      expect(rollbackFromSnapshot(SNAP)).toBe(true);

      const archived = [...store.keys()].find((k) => k.includes(".openclaw.nemoclaw-archived."));
      expect(archived).toBeDefined();
    });

    it("returns false when ~/.openclaw is a symlink", () => {
      addDir(`${SNAP}/openclaw`);
      addFile(`${SNAP}/openclaw/openclaw.json`, '{"restored":true}');
      addSymlink(OPENCLAW_DIR, "/attacker-controlled");

      expect(rollbackFromSnapshot(SNAP)).toBe(false);
    });
  });

  describe("listSnapshots", () => {
    it("returns empty array when snapshots dir does not exist", () => {
      expect(listSnapshots()).toEqual([]);
    });

    it("returns manifests sorted newest-first", () => {
      const snap1 = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      const snap2 = `${SNAPSHOTS_DIR}/20260201T000000Z`;
      addDir(snap1);
      addFile(
        `${snap1}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: ["a.txt"],
        }),
      );
      addDir(snap2);
      addFile(
        `${snap2}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260201T000000Z",
          source: OPENCLAW_DIR,
          file_count: 2,
          contents: ["a.txt", "b.txt"],
        }),
      );

      const result = listSnapshots();
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe("20260201T000000Z");
      expect(result[1].timestamp).toBe("20260101T000000Z");
      expect(result[0].path).toBe(snap2);
    });

    it("skips snapshots with corrupt manifests", () => {
      const snap1 = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      addDir(snap1);
      addFile(`${snap1}/snapshot.json`, "NOT VALID JSON");

      expect(listSnapshots()).toEqual([]);
    });

    it("skips non-directory entries", () => {
      addFile(`${SNAPSHOTS_DIR}/stray-file.txt`, "oops");

      expect(listSnapshots()).toEqual([]);
    });
  });
});
