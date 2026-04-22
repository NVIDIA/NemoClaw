// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginLogger } from "../index.js";
import { setConfigValue } from "./migration-state.js";

// ---------------------------------------------------------------------------
// fs mock — thin in-memory store keyed by absolute path
// ---------------------------------------------------------------------------

interface FsEntry {
  type: "file" | "dir" | "symlink";
  content?: string;
}

const store = new Map<string, FsEntry>();

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addSymlink(p: string): void {
  store.set(p, { type: "symlink" });
}

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn((p: string) => {
      addDir(p);
    }),
    chmodSync: vi.fn(),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      if (entry?.type !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, { type: "file", content: data });
    }),
    copyFileSync: vi.fn((src: string, dest: string) => {
      const entry = store.get(src);
      if (!entry) throw new Error(`ENOENT: ${src}`);
      store.set(dest, { ...entry });
    }),
    cpSync: vi.fn((src: string, dest: string, opts?: { filter?: (source: string) => boolean }) => {
      // Shallow copy: copy all entries whose path starts with src
      for (const [k, v] of store) {
        if (k === src || k.startsWith(src + "/")) {
          if (opts?.filter && !opts.filter(k)) continue;
          const relative = k.slice(src.length);
          store.set(dest + relative, { ...v });
        }
      }
    }),
    rmSync: vi.fn(),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      for (const [k, v] of store) {
        if (k === oldPath || k.startsWith(oldPath + "/")) {
          const relative = k.slice(oldPath.length);
          store.set(newPath + relative, v);
          store.delete(k);
        }
      }
    }),
    lstatSync: (p: string) => {
      const entry = store.get(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return {
        isSymbolicLink: () => entry.type === "symlink",
        isDirectory: () => entry.type === "dir",
        isFile: () => entry.type === "file",
      };
    },
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const entries = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const firstSegment = rest.split("/")[0];
          if (firstSegment) entries.add(firstSegment);
        }
      }
      return [...entries].sort();
    },
    unlinkSync: vi.fn((p: string) => {
      store.delete(p);
    }),
    chmodSync: vi.fn(),
  };
});

// Mock tar to avoid real archive creation
vi.mock("tar", () => ({
  create: vi.fn(async () => {}),
}));

import {
  detectHostOpenClaw,
  createSnapshotBundle,
  cleanupSnapshotBundle,
  createArchiveFromDirectory,
  loadSnapshotManifest,
  restoreSnapshotToHost,
  type HostOpenClawState,
  type SnapshotManifest,
} from "./migration-state.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("commands/migration-state", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // detectHostOpenClaw
  // -------------------------------------------------------------------------

  describe("detectHostOpenClaw", () => {
    it("returns exists=false when no state dir or config", () => {
      const env = { HOME: "/home/user" };
      const result = detectHostOpenClaw(env);
      expect(result.exists).toBe(false);
      expect(result.stateDir).toBeNull();
      expect(result.configPath).toBeNull();
    });

    it("detects existing state directory", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));
      const result = detectHostOpenClaw(env);
      expect(result.exists).toBe(true);
      expect(result.stateDir).toBe("/home/user/.openclaw");
      expect(result.configPath).toBe("/home/user/.openclaw/openclaw.json");
      expect(result.homeDir).toBe("/home/user");
    });

    it("respects OPENCLAW_HOME override", () => {
      const env = { HOME: "/home/user", OPENCLAW_HOME: "/custom/home" };
      addDir("/custom/home/.openclaw");
      const result = detectHostOpenClaw(env);
      expect(result.exists).toBe(true);
      expect(result.homeDir).toBe("/custom/home");
      expect(result.stateDir).toBe("/custom/home/.openclaw");
    });

    it("resolves OPENCLAW_HOME=~ to HOME", () => {
      const env = { HOME: "/home/user", OPENCLAW_HOME: "~" };
      addDir("/home/user/.openclaw");
      const result = detectHostOpenClaw(env);
      expect(result.homeDir).toBe("/home/user");
    });

    it("resolves OPENCLAW_HOME=~/subdir", () => {
      const env = { HOME: "/home/user", OPENCLAW_HOME: "~/subdir" };
      addDir("/home/user/subdir/.openclaw");
      const result = detectHostOpenClaw(env);
      expect(result.homeDir).toBe("/home/user/subdir");
    });

    it("respects OPENCLAW_STATE_DIR override", () => {
      const env = { HOME: "/home/user", OPENCLAW_STATE_DIR: "/custom/state" };
      addDir("/custom/state");
      addFile("/custom/state/openclaw.json", JSON.stringify({}));
      const result = detectHostOpenClaw(env);
      expect(result.stateDir).toBe("/custom/state");
    });

    it("respects OPENCLAW_CONFIG_PATH override", () => {
      const env = { HOME: "/home/user", OPENCLAW_CONFIG_PATH: "/etc/openclaw.json" };
      addDir("/home/user/.openclaw");
      addFile("/etc/openclaw.json", JSON.stringify({}));
      const result = detectHostOpenClaw(env);
      expect(result.configPath).toBe("/etc/openclaw.json");
      expect(result.hasExternalConfig).toBe(true);
    });

    it("reports error when state dir missing but config exists", () => {
      const env = { HOME: "/home/user" };
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({}));
      const result = detectHostOpenClaw(env);
      expect(result.exists).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("does not exist");
    });

    it("reports error when config is invalid JSON", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", "not valid json");
      const result = detectHostOpenClaw(env);
      expect(result.errors.some((e) => e.includes("Failed to parse"))).toBe(true);
    });

    it("reports error when config is an array", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", "[1, 2, 3]");
      const result = detectHostOpenClaw(env);
      expect(result.errors.some((e) => e.includes("not a JSON object"))).toBe(true);
    });

    it("detects extensions, skills, and hooks dirs when present", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addDir("/home/user/.openclaw/extensions");
      addDir("/home/user/.openclaw/skills");
      addDir("/home/user/.openclaw/hooks");
      const result = detectHostOpenClaw(env);
      expect(result.extensionsDir).toBe("/home/user/.openclaw/extensions");
      expect(result.skillsDir).toBe("/home/user/.openclaw/skills");
      expect(result.hooksDir).toBe("/home/user/.openclaw/hooks");
    });

    it("returns null for missing optional dirs", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      const result = detectHostOpenClaw(env);
      expect(result.extensionsDir).toBeNull();
      expect(result.skillsDir).toBeNull();
      expect(result.hooksDir).toBeNull();
    });

    it("detects workspace from config", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: { defaults: { workspace: "/home/user/my-workspace" } },
        }),
      );
      addDir("/home/user/my-workspace");
      const result = detectHostOpenClaw(env);
      expect(result.workspaceDir).toBe("/home/user/my-workspace");
    });

    it("uses default workspace path when not configured", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({}));
      addDir("/home/user/.openclaw/workspace");
      const result = detectHostOpenClaw(env);
      expect(result.workspaceDir).toBe("/home/user/.openclaw/workspace");
    });

    it("uses profiled workspace path with OPENCLAW_PROFILE", () => {
      const env = { HOME: "/home/user", OPENCLAW_PROFILE: "dev" };
      addDir("/home/user/.openclaw");
      addDir("/home/user/.openclaw/workspace-dev");
      const result = detectHostOpenClaw(env);
      expect(result.workspaceDir).toBe("/home/user/.openclaw/workspace-dev");
    });

    it("collects external roots from agent list workspaces", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: {
            list: [
              { id: "agent-1", workspace: "/external/ws1" },
              { id: "agent-2", agentDir: "/external/agentdir" },
            ],
          },
        }),
      );
      addDir("/external/ws1");
      addDir("/external/agentdir");
      const result = detectHostOpenClaw(env);
      expect(result.externalRoots.length).toBe(2);
      expect(result.externalRoots.some((r) => r.kind === "workspace")).toBe(true);
      expect(result.externalRoots.some((r) => r.kind === "agentDir")).toBe(true);
    });

    it("collects external roots from skills.load.extraDirs", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          skills: { load: { extraDirs: ["/external/skills1"] } },
        }),
      );
      addDir("/external/skills1");
      const result = detectHostOpenClaw(env);
      expect(result.externalRoots.some((r) => r.kind === "skillsExtraDir")).toBe(true);
    });

    it("resolves external roots against the provided env", () => {
      const env = { HOME: "/home/user", OPENCLAW_HOME: "/custom/home" };
      addDir("/custom/home/.openclaw");
      addFile(
        "/custom/home/.openclaw/openclaw.json",
        JSON.stringify({
          skills: { load: { extraDirs: ["~/skills-extra"] } },
        }),
      );
      addDir("/custom/home/skills-extra");

      const result = detectHostOpenClaw(env);
      expect(result.externalRoots[0]?.sourcePath).toBe("/custom/home/skills-extra");
    });

    it("warns about symlinks in workspace", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addDir("/home/user/.openclaw/workspace");
      addSymlink("/home/user/.openclaw/workspace/link");
      const result = detectHostOpenClaw(env);
      expect(result.warnings.some((w) => w.includes("symlink"))).toBe(true);
    });

    it("reports error for missing required external root", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: { list: [{ id: "a1", workspace: "/missing/ws" }] },
        }),
      );
      // Don't add /missing/ws to store
      const result = detectHostOpenClaw(env);
      expect(result.errors.some((e) => e.includes("missing"))).toBe(true);
    });

    it("reports error when external root is not a directory", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: { list: [{ id: "a1", workspace: "/external/notdir" }] },
        }),
      );
      addFile("/external/notdir", "not a dir");
      const result = detectHostOpenClaw(env);
      expect(result.errors.some((e) => e.includes("not a directory"))).toBe(true);
    });

    it("warns about symlinks in external roots", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: { list: [{ id: "a1", workspace: "/external/ws" }] },
        }),
      );
      addDir("/external/ws");
      addSymlink("/external/ws/link");
      const result = detectHostOpenClaw(env);
      expect(result.warnings.some((w) => w.includes("symlink"))).toBe(true);
    });

    it("deduplicates roots that resolve to the same path", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: {
            defaults: { workspace: "/external/ws" },
            list: [{ id: "a1", workspace: "/external/ws" }],
          },
        }),
      );
      addDir("/external/ws");
      const result = detectHostOpenClaw(env);
      const wsRoots = result.externalRoots.filter((r) => r.sourcePath === "/external/ws");
      expect(wsRoots.length).toBe(1);
      // But it should have two bindings
      expect(wsRoots[0].bindings.length).toBe(2);
    });

    it("skips agent list entries that are not objects", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          agents: { list: [null, "string", 42] },
        }),
      );
      const result = detectHostOpenClaw(env);
      // Should not throw, no external roots from invalid entries
      expect(result.exists).toBe(true);
    });

    it("skips extraDirs entries that are not strings", () => {
      const env = { HOME: "/home/user" };
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          skills: { load: { extraDirs: [null, 42, ""] } },
        }),
      );
      const result = detectHostOpenClaw(env);
      expect(result.exists).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // createSnapshotBundle
  // -------------------------------------------------------------------------

  describe("createSnapshotBundle", () => {
    it("returns null when stateDir is missing", () => {
      const logger = makeLogger();
      const hostState: HostOpenClawState = {
        exists: false,
        homeDir: "/home/user",
        stateDir: null,
        configDir: null,
        configPath: null,
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };
      expect(createSnapshotBundle(hostState, logger, { persist: false })).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it("creates a snapshot bundle for a basic host state", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: true });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }
      expect(bundle.manifest.version).toBe(3);
      expect(bundle.manifest.homeDir).toBe("/home/user");
      expect(bundle.temporary).toBe(false);
    });

    it("snapshots external config when hasExternalConfig", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile("/etc/openclaw.json", JSON.stringify({ external: true }));

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/etc/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: true,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }
      expect(bundle.manifest.hasExternalConfig).toBe(true);
      expect(bundle.temporary).toBe(true);
    });

    it("snapshots external roots", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addDir("/external/ws");

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: null,
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [
          {
            id: "workspaces-ws",
            kind: "workspace",
            label: "ws",
            sourcePath: "/external/ws",
            snapshotRelativePath: "external/workspaces-ws",
            sandboxPath: "/sandbox/.nemoclaw/migration/workspaces/workspaces-ws",
            symlinkPaths: [],
            bindings: [{ configPath: "agents.list[0].workspace" }],
          },
        ],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }
      expect(bundle.manifest.externalRoots.length).toBe(1);
    });

    it("excludes auth-profiles.json from snapshot", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));
      addDir("/home/user/.openclaw/agents/main/agent");
      addFile(
        "/home/user/.openclaw/agents/main/agent/auth-profiles.json",
        JSON.stringify({ "nvidia:manual": { type: "api_key" } }),
      );
      addFile(
        "/home/user/.openclaw/agents/main/agent/config.json",
        JSON.stringify({ name: "main" }),
      );

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }

      // auth-profiles.json should not exist anywhere in the snapshot
      const snapshotKeys = [...store.keys()].filter((k) => k.startsWith(bundle.snapshotDir));
      const authProfileKeys = snapshotKeys.filter((k) => k.endsWith("auth-profiles.json"));
      expect(authProfileKeys).toHaveLength(0);

      // config.json should still be present
      const configKeys = snapshotKeys.filter((k) => k.endsWith("agents/main/agent/config.json"));
      expect(configKeys.length).toBeGreaterThan(0);
    });

    it("strips gateway key and credential fields from sandbox openclaw.json", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          version: 1,
          gateway: { auth: { token: "secret123" } },
          nvidia: { apiKey: "nvapi-test-key" },
          agents: { defaults: { model: { primary: "test-model" } } },
        }),
      );

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }

      // Read the sandbox-bundle openclaw.json
      const sandboxConfigEntry = store.get(bundle.preparedStateDir + "/openclaw.json");
      if (!sandboxConfigEntry?.content) {
        expect.unreachable("sandbox config entry should exist with content");
        return;
      }
      const sandboxConfig = JSON.parse(sandboxConfigEntry.content);
      // gateway key should be removed entirely
      expect(sandboxConfig).not.toHaveProperty("gateway");
      // credential fields should be stripped
      expect(sandboxConfig.nvidia.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
      // non-credential fields should be preserved
      expect(sandboxConfig.version).toBe(1);
      expect(sandboxConfig.agents.defaults.model.primary).toBe("test-model");
    });

    it("strips pattern-matched credential fields (accessToken, privateKey, etc.)", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          version: 1,
          provider: {
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
            privateKey: "test-private-key",
            clientSecret: "test-client-secret",
            displayName: "should-be-preserved",
          },
        }),
      );

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }

      const sandboxConfigEntry = store.get(bundle.preparedStateDir + "/openclaw.json");
      if (!sandboxConfigEntry?.content) {
        expect.unreachable("sandbox config entry should exist with content");
        return;
      }
      const sandboxConfig = JSON.parse(sandboxConfigEntry.content);
      expect(sandboxConfig.provider.accessToken).toBe("[STRIPPED_BY_MIGRATION]");
      expect(sandboxConfig.provider.refreshToken).toBe("[STRIPPED_BY_MIGRATION]");
      expect(sandboxConfig.provider.privateKey).toBe("[STRIPPED_BY_MIGRATION]");
      expect(sandboxConfig.provider.clientSecret).toBe("[STRIPPED_BY_MIGRATION]");
      expect(sandboxConfig.provider.displayName).toBe("should-be-preserved");
    });

    it("records blueprintDigest when blueprintPath is provided", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));
      addFile("/test/blueprint.yaml", "version: 0.1.0\ndigest: ''\n");

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, {
        persist: false,
        blueprintPath: "/test/blueprint.yaml",
      });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }
      expect(typeof bundle.manifest.blueprintDigest).toBe("string");
      expect((bundle.manifest.blueprintDigest ?? "").length).toBeGreaterThan(0);
    });

    it("blueprintDigest is undefined when no blueprintPath given", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }
      expect(bundle.manifest.blueprintDigest).toBeUndefined();
    });

    it("fails when blueprintPath is provided but file is missing", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      // /test/nonexistent.yaml does not exist in store
      const bundle = createSnapshotBundle(hostState, logger, {
        persist: false,
        blueprintPath: "/test/nonexistent.yaml",
      });
      expect(bundle).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it("sanitizes credentials in the snapshot directory itself (not just sandbox-bundle)", () => {
      const logger = makeLogger();
      addDir("/home/user/.openclaw");
      addFile(
        "/home/user/.openclaw/openclaw.json",
        JSON.stringify({
          version: 1,
          gateway: { auth: { token: "secret123" } },
          nvidia: { apiKey: "nvapi-test-key" },
        }),
      );

      const hostState: HostOpenClawState = {
        exists: true,
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/openclaw.json",
        workspaceDir: null,
        extensionsDir: null,
        skillsDir: null,
        hooksDir: null,
        externalRoots: [],
        warnings: [],
        errors: [],
        hasExternalConfig: false,
      };

      const bundle = createSnapshotBundle(hostState, logger, { persist: false });
      if (bundle === null) {
        expect.unreachable("bundle should not be null");
        return;
      }

      // Check the snapshot-level openclaw.json (not sandbox-bundle)
      const snapshotConfigEntry = store.get(bundle.snapshotDir + "/openclaw/openclaw.json");
      if (!snapshotConfigEntry?.content) {
        expect.unreachable("snapshot config entry should exist with content");
        return;
      }
      const snapshotConfig = JSON.parse(snapshotConfigEntry.content);
      expect(snapshotConfig).not.toHaveProperty("gateway");
      expect(snapshotConfig.nvidia.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
      expect(snapshotConfig.version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // cleanupSnapshotBundle
  // -------------------------------------------------------------------------

  describe("cleanupSnapshotBundle", () => {
    it("removes temporary snapshot directory", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.rmSync).mockClear();
      cleanupSnapshotBundle({
        snapshotDir: "/tmp/snapshot",
        snapshotPath: "/tmp/snapshot/snapshot.json",
        preparedStateDir: "/tmp/snapshot/sandbox-bundle/openclaw",
        archivesDir: "/tmp/snapshot/sandbox-bundle/archives",
        manifest: {} as SnapshotManifest,
        temporary: true,
      });
      expect(fs.rmSync).toHaveBeenCalledWith("/tmp/snapshot", { recursive: true, force: true });
    });

    it("does not remove persistent snapshot directory", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.rmSync).mockClear();
      cleanupSnapshotBundle({
        snapshotDir: "/tmp/snapshot",
        snapshotPath: "/tmp/snapshot/snapshot.json",
        preparedStateDir: "/tmp/snapshot/sandbox-bundle/openclaw",
        archivesDir: "/tmp/snapshot/sandbox-bundle/archives",
        manifest: {} as SnapshotManifest,
        temporary: false,
      });
      expect(fs.rmSync).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // createArchiveFromDirectory
  // -------------------------------------------------------------------------

  describe("createArchiveFromDirectory", () => {
    it("calls tar.create with correct options", async () => {
      const { create } = await import("tar");
      await createArchiveFromDirectory("/src", "/dest/archive.tar");
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/src",
          file: "/dest/archive.tar",
          portable: true,
          follow: false,
          noMtime: true,
        }),
        ["."],
      );
    });
  });

  // -------------------------------------------------------------------------
  // loadSnapshotManifest / restoreSnapshotToHost
  // -------------------------------------------------------------------------

  describe("loadSnapshotManifest", () => {
    it("reads and parses snapshot.json", () => {
      const manifest: SnapshotManifest = {
        version: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      };
      addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
      const loaded = loadSnapshotManifest("/snapshots/snap1");
      expect(loaded).toEqual(manifest);
    });
  });

  describe("restoreSnapshotToHost", () => {
    it("returns false when snapshot openclaw dir is missing", () => {
      const logger = makeLogger();
      const manifest: SnapshotManifest = {
        version: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        homeDir: "/home/user",
        stateDir: "/home/user/.openclaw",
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      };
      addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
      // Don't add /snapshots/snap1/openclaw
      const result = restoreSnapshotToHost("/snapshots/snap1", logger);
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });

    it("restores state directory from snapshot", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");
        addFile("/snapshots/snap1/openclaw/openclaw.json", JSON.stringify({ restored: true }));
        // Existing state dir to be archived
        addDir("/home/user/.openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("restored"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("restores external config when hasExternalConfig", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      const origConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.HOME = "/home/user";
      process.env.OPENCLAW_CONFIG_PATH = "/etc/openclaw.json";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: "/etc/openclaw.json",
          hasExternalConfig: true,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");
        addFile("/snapshots/snap1/config/openclaw.json", JSON.stringify({ external: true }));

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("external config"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
        if (origConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
        }
      }
    });

    it("rejects when homeDir is outside trusted root", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/tmp/evil",
          stateDir: "/tmp/evil/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("homeDir is outside"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("rejects when stateDir is outside trusted root", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/tmp/evil/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("stateDir is outside"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("rejects when stateDir does not match OPENCLAW_STATE_DIR", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      const origStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.HOME = "/home/user";
      process.env.OPENCLAW_STATE_DIR = "/home/user/.custom-state";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("does not match OPENCLAW_STATE_DIR"),
        );
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
        if (origStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = origStateDir;
        }
      }
    });

    it("rejects when hasExternalConfig is true but configPath is null", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: true,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("configPath is missing"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("rejects when configPath is outside trusted root", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: "/tmp/evil/openclaw.json",
          hasExternalConfig: true,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("configPath is outside"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("rejects when configPath does not match OPENCLAW_CONFIG_PATH", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      const origConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.HOME = "/home/user";
      process.env.OPENCLAW_CONFIG_PATH = "/home/user/my-config.json";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: "/etc/openclaw.json",
          hasExternalConfig: true,
          externalRoots: [],
          warnings: [],
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("does not match OPENCLAW_CONFIG_PATH"),
        );
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
        if (origConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
        }
      }
    });

    it("restore succeeds when blueprint digest matches", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const blueprintContent = "version: 0.1.0\ndigest: ''\n";
        addFile("/test/blueprint.yaml", blueprintContent);

        // First create a snapshot with blueprintPath to get the real digest
        addDir("/home/user/.openclaw");
        addFile("/home/user/.openclaw/openclaw.json", JSON.stringify({ version: 1 }));
        const hostState: HostOpenClawState = {
          exists: true,
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configDir: "/home/user/.openclaw",
          configPath: "/home/user/.openclaw/openclaw.json",
          workspaceDir: null,
          extensionsDir: null,
          skillsDir: null,
          hooksDir: null,
          externalRoots: [],
          warnings: [],
          errors: [],
          hasExternalConfig: false,
        };
        const bundle = createSnapshotBundle(hostState, logger, {
          persist: false,
          blueprintPath: "/test/blueprint.yaml",
        });
        if (bundle === null) {
          expect.unreachable("bundle should not be null");
          return;
        }
        const digest = bundle.manifest.blueprintDigest;
        expect(digest).toBeTruthy();

        // Now set up for restore with matching digest
        store.clear();
        const manifest: SnapshotManifest = {
          version: 3,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
          blueprintDigest: digest,
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");
        addFile("/snapshots/snap1/openclaw/openclaw.json", JSON.stringify({ restored: true }));
        addFile("/test/blueprint.yaml", blueprintContent);

        const result = restoreSnapshotToHost("/snapshots/snap1", logger, {
          blueprintPath: "/test/blueprint.yaml",
        });
        expect(result).toBe(true);
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("restore fails when blueprint digest mismatches", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 3,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
          blueprintDigest: "wrong-hash-value",
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");
        addFile("/test/blueprint.yaml", "version: 0.1.0\n");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger, {
          blueprintPath: "/test/blueprint.yaml",
        });
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("digest mismatch"));
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("restore fails when manifest has empty string blueprintDigest", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 3,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
          blueprintDigest: "",
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("invalid blueprintDigest"),
        );
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("restore fails when manifest has digest but no blueprintPath provided", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 3,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
          blueprintDigest: "abc123",
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("no blueprint is available"),
        );
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("restore succeeds when manifest has no blueprintDigest (backward compat)", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        const manifest: SnapshotManifest = {
          version: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
          // no blueprintDigest field
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");
        addFile("/snapshots/snap1/openclaw/openclaw.json", JSON.stringify({ restored: true }));

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(true);
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });

    it("restore succeeds for v3 snapshot created without blueprintPath", () => {
      const logger = makeLogger();
      const origHome = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        // v3 manifest with no blueprintDigest field — created without a blueprint
        const manifest: SnapshotManifest = {
          version: 3,
          createdAt: "2026-03-01T00:00:00.000Z",
          homeDir: "/home/user",
          stateDir: "/home/user/.openclaw",
          configPath: null,
          hasExternalConfig: false,
          externalRoots: [],
          warnings: [],
          // blueprintDigest intentionally omitted
        };
        addFile("/snapshots/snap1/snapshot.json", JSON.stringify(manifest));
        addDir("/snapshots/snap1/openclaw");
        addFile("/snapshots/snap1/openclaw/openclaw.json", JSON.stringify({ restored: true }));

        const result = restoreSnapshotToHost("/snapshots/snap1", logger);
        expect(result).toBe(true);
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
      }
    });
  });

  // ── setConfigValue prototype pollution guard ─────────────────────

  describe("setConfigValue", () => {
    const expectPrototypeClean = (): void => {
      const probe: Record<string, unknown> = {};
      for (const key of ["polluted", "isAdmin", "bar"]) {
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, key)).toBe(false);
        expect(probe[key]).toBeUndefined();
      }
    };

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects unsafe path segment: %s",
      (segment) => {
        const doc: Record<string, unknown> = {};
        expect(() => {
          setConfigValue(doc, `${segment}.polluted`, "true");
        }).toThrow(/Unsafe config path segment/);
        expectPrototypeClean();
      },
    );

    it("rejects __proto__ in nested position", () => {
      const doc: Record<string, unknown> = {};
      expect(() => {
        setConfigValue(doc, "agents.__proto__.isAdmin", "true");
      }).toThrow(/Unsafe config path segment/);
      expectPrototypeClean();
    });

    it.each(["foo.prototype.bar", "foo.constructor.bar"])(
      "rejects unsafe segment in nested path: %s",
      (configPath) => {
        const doc: Record<string, unknown> = {};
        expect(() => {
          setConfigValue(doc, configPath, "true");
        }).toThrow(/Unsafe config path segment/);
        expectPrototypeClean();
      },
    );

    it("allows legitimate dotted paths", () => {
      const doc: Record<string, unknown> = {};
      setConfigValue(doc, "agents.list[0].workspace", "/tmp/ws");
      const agents = doc.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      expect(list[0].workspace).toBe("/tmp/ws");
    });

    it("allows simple top-level keys", () => {
      const doc: Record<string, unknown> = {};
      setConfigValue(doc, "theme", "dark");
      expect(doc.theme).toBe("dark");
    });
  });
});
