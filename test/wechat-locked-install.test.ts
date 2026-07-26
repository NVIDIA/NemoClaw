// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { wechatManifest } from "../src/lib/messaging/channels/wechat/manifest.ts";
import {
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
  requireWritableRuntimeInstallCache,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

const WECHAT_INTEGRITY =
  "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==";
const WECHAT_TARBALL =
  "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz";

function executable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

const INVALID_INSTALL_CACHE_CASES = [
  {
    name: "relative paths",
    prepare: () => "relative-cache",
    expected: "NEMOCLAW_WECHAT_NPM_INSTALL_CACHE must be an absolute path",
  },
  {
    name: "symbolic links",
    prepare: (tmp: string) => {
      const target = path.join(tmp, "symlink-target");
      const link = path.join(tmp, "symlink-cache");
      fs.mkdirSync(target);
      fs.symlinkSync(target, link);
      return link;
    },
    expected: "symbolic links are not allowed",
  },
  {
    name: "non-directory paths",
    prepare: (tmp: string) => {
      const file = path.join(tmp, "cache-file");
      fs.writeFileSync(file, "not a directory");
      return file;
    },
    expected: "path is not a directory",
  },
  {
    name: "non-writable directories",
    prepare: (tmp: string) => {
      const directory = path.join(tmp, "read-only-cache");
      fs.mkdirSync(directory, { mode: 0o500 });
      return directory;
    },
    expected: "must be a writable, searchable directory",
  },
] as const;

const TRUSTED_INSTALL_CACHE_CASES = [
  {
    name: "the trusted cache itself",
    prepare: (trustedCache: string) => trustedCache,
  },
  {
    name: "trusted-cache descendants",
    prepare: (trustedCache: string) => {
      const descendant = path.join(trustedCache, "child");
      fs.mkdirSync(descendant);
      return descendant;
    },
  },
] as const;

describe("locked WeChat plugin installation (#5896)", () => {
  it("routes archive retrieval and install through the disposable offline cache", () => {
    const runtimeLock = wechatManifest.agentPackages.find(
      (pkg) => pkg.agent === "openclaw",
    )?.runtimeLock;
    expect(runtimeLock).toEqual({
      cachePath: "/usr/local/share/nemoclaw/wechat-npm-cache",
      installCacheEnvKey: "NEMOCLAW_WECHAT_NPM_INSTALL_CACHE",
      legacyPeerDeps: true,
      lockFile: "/usr/local/lib/nemoclaw/wechat-runtime/package-lock.json",
      offline: true,
      projectsRoot: "/sandbox/.openclaw/npm/projects",
      verifierPath: "/usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts",
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-install-"));
    const installCache = path.join(tmp, "wechat-install-cache");
    const home = path.join(tmp, "home");
    const trace = path.join(tmp, "trace");
    fs.mkdirSync(installCache);
    fs.mkdirSync(home);
    executable(
      path.join(tmp, "npm"),
      `#!/bin/sh
set -eu
printf 'npm|%s|%s|cache=%s|offline=%s\n' "$1" "\${2:-}" "$NPM_CONFIG_CACHE" "$NPM_CONFIG_OFFLINE" >> "$TRACE"
mkdir -p "$NPM_CONFIG_CACHE/_cacache/tmp"
printf '%s\n' "$1" >> "$NPM_CONFIG_CACHE/_cacache/tmp/nemoclaw-retrieval-probe"
if [ "$1" = view ] && [ "$3" = dist.integrity ]; then printf '%s\n' "$WECHAT_INTEGRITY"; exit 0; fi
if [ "$1" = view ] && [ "$3" = dist.tarball ]; then printf '%s\n' "$WECHAT_TARBALL"; exit 0; fi
if [ "$1" = pack ]; then
  printf 'archive' > "$4/wechat.tgz"
  printf '[{"filename":"wechat.tgz","integrity":"%s"}]\n' "$WECHAT_INTEGRITY"
  exit 0
fi
exit 1
`,
    );
    executable(
      path.join(tmp, "openclaw"),
      `#!/bin/sh
mkdir -p "$NPM_CONFIG_CACHE/_cacache/tmp"
printf 'writable\n' > "$NPM_CONFIG_CACHE/_cacache/tmp/nemoclaw-install-probe"
printf 'install|%s|offline=%s|peer=%s|cache=%s\n' "$3" "$NPM_CONFIG_OFFLINE" "$NPM_CONFIG_LEGACY_PEER_DEPS" "$NPM_CONFIG_CACHE" >> "$TRACE"
`,
    );
    executable(
      path.join(tmp, "node"),
      `#!/bin/sh
printf 'verify|%s|%s|openclaw=%s|offline=%s|cache=%s\n' "$3" "$4" "$5" "$NPM_CONFIG_OFFLINE" "$NPM_CONFIG_CACHE" >> "$TRACE"
`,
    );

    const plan = {
      schemaVersion: 1,
      sandboxName: "wechat-test",
      agent: "openclaw",
      channels: [{ channelId: "wechat", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "wechat",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
          },
        },
      ],
    };
    const env = {
      PATH: `${tmp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      TRACE: trace,
      WECHAT_INTEGRITY,
      WECHAT_TARBALL,
      OPENCLAW_VERSION: "2026.6.10",
      NEMOCLAW_WECHAT_NPM_INSTALL_CACHE: installCache,
      NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
    };

    try {
      const serialized = readMessagingBuildPlanFromEnv(env, "openclaw");
      expect(applyMessagingBuildPhase(serialized, "agent-install", env)).toEqual([]);
      const calls = fs.readFileSync(trace, "utf8");
      expect(calls).toContain("install|npm-pack:");
      expect(calls).toContain(
        `npm|view|@tencent-weixin/openclaw-weixin@2.4.3|cache=${fs.realpathSync(installCache)}|offline=true`,
      );
      expect(calls).toContain(
        `npm|pack|${WECHAT_TARBALL}|cache=${fs.realpathSync(installCache)}|offline=true`,
      );
      expect(calls).toContain(`offline=true|peer=true|cache=${fs.realpathSync(installCache)}`);
      expect(calls).toContain(
        "verify|/usr/local/lib/nemoclaw/wechat-runtime/package-lock.json|/sandbox/.openclaw/npm/projects|openclaw=2026.6.10|offline=true",
      );
      expect(calls).not.toContain("cache=/usr/local/share/nemoclaw/wechat-npm-cache");
      expect(fs.existsSync(path.join(home, ".npm"))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(installCache, "_cacache", "tmp", "nemoclaw-retrieval-probe"),
          "utf8",
        ),
      ).toBe("view\nview\npack\n");
      expect(
        fs.readFileSync(
          path.join(installCache, "_cacache", "tmp", "nemoclaw-install-probe"),
          "utf8",
        ),
      ).toBe("writable\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(INVALID_INSTALL_CACHE_CASES)("rejects $name before package tooling runs", ({
    prepare,
    expected,
  }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-invalid-cache-"));
    const trace = path.join(tmp, "trace");
    executable(path.join(tmp, "npm"), '#!/bin/sh\nprintf "npm\\n" >> "$TRACE"\n');
    executable(path.join(tmp, "openclaw"), '#!/bin/sh\nprintf "openclaw\\n" >> "$TRACE"\n');
    executable(path.join(tmp, "node"), '#!/bin/sh\nprintf "node\\n" >> "$TRACE"\n');

    const plan = {
      schemaVersion: 1,
      sandboxName: "wechat-invalid-cache",
      agent: "openclaw",
      channels: [{ channelId: "wechat", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "wechat",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
          },
        },
      ],
    };
    const env = {
      PATH: `${tmp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TRACE: trace,
      NEMOCLAW_WECHAT_NPM_INSTALL_CACHE: prepare(tmp),
      NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
    };

    try {
      const serialized = readMessagingBuildPlanFromEnv(env, "openclaw");
      expect(() => applyMessagingBuildPhase(serialized, "agent-install", env)).toThrow(expected);
      expect(fs.existsSync(trace)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(TRUSTED_INSTALL_CACHE_CASES)("rejects $name", ({ prepare }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-trusted-cache-"));
    const trustedCache = path.join(tmp, "trusted-cache");
    fs.mkdirSync(trustedCache);
    const runtimeLock = {
      ...wechatManifest.agentPackages[0].runtimeLock!,
      cachePath: trustedCache,
    };

    try {
      expect(() =>
        requireWritableRuntimeInstallCache(runtimeLock, {
          NEMOCLAW_WECHAT_NPM_INSTALL_CACHE: prepare(trustedCache),
        }),
      ).toThrow("NEMOCLAW_WECHAT_NPM_INSTALL_CACHE must not make the trusted npm cache writable");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
