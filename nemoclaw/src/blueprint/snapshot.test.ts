// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── In-memory filesystem ────────────────────────────────────────

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

const store = new Map<string, FsEntry>();

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

const FAKE_HOME = "/fakehome";

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
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
    readdirSync: (p: string, opts?: { withFileTypes?: boolean }) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const childTypes = new Map<string, "file" | "dir">();
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
        }));
      }
      return [...childTypes.keys()].sort();
    },
  };
});

const mockExeca = vi.fn();
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));

const { createSnapshot, restoreIntoSandbox, cutoverHost, rollbackFromSnapshot, listSnapshots } =
  await import("./snapshot.js");

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
  });

  describe("restoreIntoSandbox", () => {
    it("returns false when snapshot has no openclaw dir", async () => {
      addDir("/snap/20260323");
      expect(await restoreIntoSandbox("/snap/20260323")).toBe(false);
    });

    it("calls openshell sandbox cp and returns true on success", async () => {
      addDir("/snap/20260323/openclaw");
      mockExeca.mockResolvedValue({ exitCode: 0 });

      expect(await restoreIntoSandbox("/snap/20260323", "mybox")).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "cp", "/snap/20260323/openclaw", "mybox:/sandbox/.openclaw"],
        { reject: false },
      );
    });

    it("returns false when openshell fails", async () => {
      addDir("/snap/20260323/openclaw");
      mockExeca.mockResolvedValue({ exitCode: 1 });

      expect(await restoreIntoSandbox("/snap/20260323")).toBe(false);
    });

    it("uses default sandbox name 'openclaw'", async () => {
      addDir("/snap/20260323/openclaw");
      mockExeca.mockResolvedValue({ exitCode: 0 });

      await restoreIntoSandbox("/snap/20260323");
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        expect.arrayContaining(["openclaw:/sandbox/.openclaw"]),
        expect.anything(),
      );
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
      addDir("/snap/20260323");
      expect(rollbackFromSnapshot("/snap/20260323")).toBe(false);
    });

    it("restores snapshot to ~/.openclaw with content", () => {
      addDir("/snap/20260323/openclaw");
      addFile("/snap/20260323/openclaw/openclaw.json", '{"restored":true}');

      expect(rollbackFromSnapshot("/snap/20260323")).toBe(true);

      const restored = store.get(`${OPENCLAW_DIR}/openclaw.json`);
      if (!restored) throw new Error("openclaw.json not restored");
      expect(restored.content).toBe('{"restored":true}');
    });

    it("archives existing ~/.openclaw before restoring", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"old":true}');
      addDir("/snap/20260323/openclaw");
      addFile("/snap/20260323/openclaw/openclaw.json", '{"restored":true}');

      expect(rollbackFromSnapshot("/snap/20260323")).toBe(true);

      const archived = [...store.keys()].find((k) => k.includes(".openclaw.nemoclaw-archived."));
      expect(archived).toBeDefined();
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
