// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests prove the runtime call-site contract: setting `NEMOCLAW_INSTANCE`
// before importing the modules that capture the active instance at module load
// must route their on-disk paths under `~/.nemoclaw-<instance>` for the
// migrated surfaces (credentials store, local inference adapter state, Ollama
// auth-proxy token reader, rebuild backups, shields state). The pure resolver
// tests in `instance.test.ts` / `paths.test.ts` / `gateway-binding.test.ts`
// cover the underlying helpers; this file pins the integration so a regression
// in a downstream import would surface here.
//
// One test per migrated surface — each test gets a fresh tmpdir HOME, a fresh
// module graph (`vi.resetModules()`), and a fresh `process.env.NEMOCLAW_INSTANCE`,
// then dynamically imports the affected module so the module-load-time
// instance capture sees the configured value.

const ORIGINAL_ENV = { ...process.env };

async function withFreshHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-instance-runtime-"));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("runtime call-site coverage under NEMOCLAW_INSTANCE", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  // The bare-default ("unset NEMOCLAW_INSTANCE") behaviour is pinned by the
  // pure resolver tests in src/lib/state/paths.test.ts and
  // src/lib/onboard/gateway-binding.test.ts. This file asserts only the
  // non-default-instance integration path because Vitest's per-file module
  // graph captures the first-seen instance constant and does not re-evaluate
  // it on subsequent in-file imports of CommonJS dist modules.

  it("getCredsDir() lands the credentials store under .nemoclaw-<instance>", async () => {
    await withFreshHome(async (home) => {
      process.env.HOME = home;
      process.env.NEMOCLAW_INSTANCE = "agent-a";
      const { getCredsDir, getCredsFile } = await import("../../../dist/lib/credentials/store");
      expect(getCredsDir()).toBe(path.join(home, ".nemoclaw-agent-a"));
      expect(getCredsFile()).toBe(path.join(home, ".nemoclaw-agent-a", "credentials.json"));
    });
  });

  it("DEFAULT_LOCAL_ADAPTER_STATE_DIR lands under .nemoclaw-<instance>", async () => {
    await withFreshHome(async (home) => {
      process.env.HOME = home;
      process.env.NEMOCLAW_INSTANCE = "agent-a";
      const { DEFAULT_LOCAL_ADAPTER_STATE_DIR } = await import(
        "../../../dist/lib/inference/local-adapter-lifecycle"
      );
      expect(DEFAULT_LOCAL_ADAPTER_STATE_DIR).toBe(path.join(home, ".nemoclaw-agent-a"));
    });
  });

  it("Ollama auth-proxy reader and writer agree on the instance-scoped home dir", async () => {
    await withFreshHome(async (home) => {
      process.env.HOME = home;
      process.env.NEMOCLAW_INSTANCE = "agent-a";
      const { resolveNemoclawHomeDir } = await import("../../../dist/lib/state/paths");
      const { DEFAULT_LOCAL_ADAPTER_STATE_DIR } = await import(
        "../../../dist/lib/inference/local-adapter-lifecycle"
      );
      // The writer (inference/ollama/proxy.ts) composes ollama-proxy-token
      // under DEFAULT_LOCAL_ADAPTER_STATE_DIR. The reader
      // (defaultLoadOllamaProxyToken in inference/local.ts) composes it under
      // resolveNemoclawHomeDir(). Both must compose the same parent dir under
      // the active instance so the probe sees the token the writer persists.
      expect(DEFAULT_LOCAL_ADAPTER_STATE_DIR).toBe(resolveNemoclawHomeDir());
      expect(DEFAULT_LOCAL_ADAPTER_STATE_DIR).toBe(path.join(home, ".nemoclaw-agent-a"));
    });
  });

  it("state/sandbox.ts captures REBUILD_BACKUPS_DIR under .nemoclaw-<instance>/rebuild-backups", async () => {
    await withFreshHome(async (home) => {
      process.env.HOME = home;
      process.env.NEMOCLAW_INSTANCE = "agent-a";
      const { REBUILD_BACKUPS_DIR } = await import("../../../dist/lib/state/sandbox");
      expect(REBUILD_BACKUPS_DIR).toBe(path.join(home, ".nemoclaw-agent-a", "rebuild-backups"));
    });
  });

  it("shields/audit.ts captures AUDIT_DIR / AUDIT_FILE under .nemoclaw-<instance>/state", async () => {
    await withFreshHome(async (home) => {
      process.env.HOME = home;
      process.env.NEMOCLAW_INSTANCE = "agent-a";
      const { AUDIT_DIR, AUDIT_FILE } = await import("../../../dist/lib/shields/audit");
      const expectedStateDir = path.join(home, ".nemoclaw-agent-a", "state");
      expect(AUDIT_DIR).toBe(expectedStateDir);
      expect(AUDIT_FILE).toBe(path.join(expectedStateDir, "shields-audit.jsonl"));
      // shields/index.ts and shields/timer.ts capture their own STATE_DIR
      // constants from the same `resolveNemoclawStateDir()` call, so the
      // audit module's captured value is the canonical observable: a
      // regression in the resolver, the helper, or the import order would
      // surface here too.
    });
  });
});
