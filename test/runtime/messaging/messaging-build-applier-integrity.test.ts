// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMessagingBuildPhase,
  OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY,
  readMessagingBuildPlanFromEnv,
  reviewedOpenClawPluginTarballUrlByPackageSpec,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { testTimeout } from "../../helpers/timeouts";
import { withLegacyMessagingPlanEnvDirect } from "../../messaging-plan-test-helper";

import { createSlackRemediationFixture } from "../../support/slack-remediation-fixture";

import { officialPluginInspectionShell } from "./official-plugin-inspection-fixture";

vi.mock("../../../scripts/lib/openclaw-npm-remediation.mts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../scripts/lib/openclaw-npm-remediation.mts")>();
  return {
    ...original,
    remediateReviewedOpenClawPluginArchive: ({ archivePath }: { archivePath: string }) => ({
      archivePath,
      integrity: "sha512-messaging-integrity-test-remediation",
      remediated: false,
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const OPENCLAW_SLACK_2026_9_1_INTEGRITY =
  "sha512-tU372jE40nnPcKQ6oxmDHf2/UhGtdz8ysi4JKsRZIO1QBAEkZd2YfsOw8aucmb2r0B0vjcFD3OmIV/Qzb57COg==";
const OPENCLAW_SLACK_2026_9_1_TARBALL =
  "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.9.1.tgz";
const REPO_ROOT = path.join(import.meta.dirname, "../../..");

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function fakeSlackNpmScript(): string {
  return [
    "#!/bin/sh",
    'printf \'npm|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
    'if [ "${1:-}" = "pack" ]; then',
    '  pack_dir="${4:-}";',
    '  test -n "$pack_dir";',
    '  reported_filename="${OPENCLAW_PACK_FILENAME_OVERRIDE:-slack-2026.9.1.tgz}";',
    '  printf "fake plugin tarball" > "$pack_dir/slack-2026.9.1.tgz";',
    '  printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$reported_filename" "$OPENCLAW_PACK_INTEGRITY_OVERRIDE";',
    "  exit 0",
    "fi",
    'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_SLACK_INTEGRITY"; exit 0; fi',
    `if [ "\${1:-}" = "view" ] && [ "\${3:-}" = "dist.tarball" ]; then printf "%s\\n" "\${OPENCLAW_REGISTRY_TARBALL_URL:-${OPENCLAW_SLACK_2026_9_1_TARBALL}}"; exit 0; fi`,
    "exit 1",
    "",
  ].join("\n");
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to throw");
}

function renameFailureHook(root: string, destination: string, failRestore: boolean): string {
  const hookPath = path.join(root, "rename-failure-hook.mjs");
  const canonicalDestination = path.join(fs.realpathSync(root), path.relative(root, destination));
  fs.writeFileSync(
    hookPath,
    [
      'import { createRequire, syncBuiltinESMExports } from "node:module";',
      'import path from "node:path";',
      'const fs = createRequire(import.meta.url)("node:fs");',
      "const originalRenameSync = fs.renameSync;",
      `const target = ${JSON.stringify(canonicalDestination)};`,
      `const trace = ${JSON.stringify(path.join(root, "rename.trace"))};`,
      "let failedPromotion = false;",
      "let failedRestore = false;",
      "fs.renameSync = (source, destination) => {",
      '  fs.appendFileSync(trace, source + "\\t" + destination + "\\n");',
      "  const targetMatches = path.resolve(destination) === target;",
      '  if (!failedPromotion && path.basename(source) === "replacement" && targetMatches) {',
      "    failedPromotion = true;",
      '    throw Object.assign(new Error("simulated replacement promotion failure"), { code: "EIO" });',
      "  }",
      `  if (${failRestore} && !failedRestore && path.basename(source) === "previous" && targetMatches) {`,
      "    failedRestore = true;",
      '    throw Object.assign(new Error("simulated original package restoration failure"), { code: "EIO" });',
      "  }",
      "  return originalRenameSync(source, destination);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return hookPath;
}

function recoveryCleanupFailureHook(root: string, recoveryDirectory: string): string {
  const hookPath = path.join(root, "recovery-cleanup-failure-hook.mjs");
  const canonicalRecoveryDirectory = path.join(
    fs.realpathSync(root),
    path.relative(root, recoveryDirectory),
  );
  const trace = path.join(root, "recovery-cleanup.trace");
  fs.writeFileSync(
    hookPath,
    [
      'import { createRequire, syncBuiltinESMExports } from "node:module";',
      'import path from "node:path";',
      'const fs = createRequire(import.meta.url)("node:fs");',
      "const originalRmSync = fs.rmSync;",
      `const recoveryDirectory = ${JSON.stringify(canonicalRecoveryDirectory)};`,
      `const trace = ${JSON.stringify(trace)};`,
      "let failed = false;",
      "fs.rmSync = (target, options) => {",
      '  fs.appendFileSync(trace, path.resolve(target) + "\\n");',
      "  if (!failed && path.resolve(target) === recoveryDirectory) {",
      "    failed = true;",
      '    throw Object.assign(new Error("simulated stale recovery cleanup failure"), { code: "EACCES" });',
      "  }",
      "  return originalRmSync(target, options);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return hookPath;
}

function previousPackageCleanupFailureHook(root: string, packageParent: string): string {
  const hookPath = path.join(root, "previous-package-cleanup-failure-hook.mjs");
  const canonicalPackageParent = path.join(
    fs.realpathSync(root),
    path.relative(root, packageParent),
  );
  fs.writeFileSync(
    hookPath,
    [
      'import { createRequire, syncBuiltinESMExports } from "node:module";',
      'import path from "node:path";',
      'const fs = createRequire(import.meta.url)("node:fs");',
      "const originalRmSync = fs.rmSync;",
      `const packageParent = ${JSON.stringify(canonicalPackageParent)};`,
      `const trace = ${JSON.stringify(path.join(root, "previous-package-cleanup.trace"))};`,
      "let failed = false;",
      "fs.rmSync = (target, options) => {",
      "  const resolved = path.resolve(target);",
      '  fs.appendFileSync(trace, resolved + "\\n");',
      "  const recoveryRoot = path.dirname(resolved);",
      '  if (!failed && path.basename(resolved) === "previous" && path.dirname(recoveryRoot) === packageParent && path.basename(recoveryRoot).startsWith(".proxy-addr-replacement-")) {',
      "    failed = true;",
      '    throw Object.assign(new Error("simulated prior package cleanup failure"), { code: "EACCES" });',
      "  }",
      "  return originalRmSync(target, options);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return hookPath;
}

function verifyOriginalSlackDependencyBytes(
  fixture: Awaited<ReturnType<typeof createSlackRemediationFixture>>,
  installedDirectory = fixture.proxyAddrDirectory,
): void {
  const sourceRelativeProxyAddrDirectory = path.relative(
    fixture.env.TEST_SLACK_INSTALL!,
    fixture.proxyAddrDirectory,
  );
  const installedRelativeProxyAddrDirectory = path.relative(
    fixture.env.TEST_SLACK_INSTALL!,
    installedDirectory,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto"); const sourceRelative = ${JSON.stringify(sourceRelativeProxyAddrDirectory)}; const installedRelative = ${JSON.stringify(installedRelativeProxyAddrDirectory)}; const digest = (root, relative, file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative, file))).digest("hex"); console.log(JSON.stringify({ packageJson: digest(process.env.TEST_SLACK_SOURCE, sourceRelative, "package.json") === digest(process.env.TEST_SLACK_INSTALL, installedRelative, "package.json"), index: digest(process.env.TEST_SLACK_SOURCE, sourceRelative, "index.js") === digest(process.env.TEST_SLACK_INSTALL, installedRelative, "index.js") }));`,
    ],
    { env: fixture.env, encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ packageJson: true, index: true });
}

describe("messaging-build-applier.mts: plugin archive integrity", () => {
  it.each(["reviewed archive", "npm"])(
    "replaces Slack's bundled proxy-addr using %s after inspection",
    async (source) => {
      const fixture = await createSlackRemediationFixture();
      try {
        const result = spawnSync(
          process.execPath,
          [SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR:
                source === "npm" ? undefined : fixture.env.NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR,
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(
          createHash("sha256")
            .update(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "package.json")))
            .digest("hex"),
        ).toBe("b2e305ca817ae4e8b088e07f38c5df1d7ad77aa3473809e4c37a9a1c83600225");
        expect(
          createHash("sha256")
            .update(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "index.js")))
            .digest("hex"),
        ).toBe("aa7efd29bbd61cbcc1bdafde9e674db28ead077864f33bfad3cdd19bb5a3778c");
        expect(fs.readFileSync(fixture.trace, "utf8")).toBe("installed\ninspected-unpatched\n");
        expect(fs.readdirSync(fixture.env.TMPDIR)).toEqual([]);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "preserves the installed Slack dependency when copying its replacement fails",
    async () => {
      const fixture = await createSlackRemediationFixture();
      const copyFailureHook = path.join(fixture.root, "copy-failure-hook.mjs");
      fs.writeFileSync(
        copyFailureHook,
        [
          'import { createRequire, syncBuiltinESMExports } from "node:module";',
          'import path from "node:path";',
          'const fs = createRequire(import.meta.url)("node:fs");',
          "const originalCpSync = fs.cpSync;",
          "let failedReplacementCopy = false;",
          "fs.cpSync = (source, destination, options) => {",
          "  try {",
          '    const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));',
          '    if (!failedReplacementCopy && metadata.name === "proxy-addr" && metadata.version === "2.0.8") {',
          "      failedReplacementCopy = true;",
          "      fs.mkdirSync(destination, { recursive: true });",
          '      fs.writeFileSync(path.join(destination, "partial-copy"), "incomplete replacement");',
          '      throw Object.assign(new Error("simulated replacement copy failure"), { code: "EIO" });',
          "    }",
          "  } catch (error) {",
          '    if (error?.code !== "ENOENT") throw error;',
          "  }",
          "  return originalCpSync(source, destination, options);",
          "};",
          "syncBuiltinESMExports();",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const relativeProxyAddrDirectory = path.relative(
        path.join(
          fixture.env.HOME!,
          ".openclaw/npm/projects/openclaw-slack-b25c10c1bd/node_modules/@openclaw/slack",
        ),
        fixture.proxyAddrDirectory,
      );

      try {
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            copyFailureHook,
            SCRIPT_PATH,
            "--agent",
            "openclaw",
            "--phase",
            "agent-install",
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("Messaging build applier failed.");
        const verifyInstalledBytes = spawnSync(
          process.execPath,
          [
            "--eval",
            `const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto"); const relative = ${JSON.stringify(relativeProxyAddrDirectory)}; const digest = (root, file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative, file))).digest("hex"); console.log(JSON.stringify({ packageJson: digest(process.env.TEST_SLACK_SOURCE, "package.json") === digest(process.env.TEST_SLACK_INSTALL, "package.json"), index: digest(process.env.TEST_SLACK_SOURCE, "index.js") === digest(process.env.TEST_SLACK_INSTALL, "index.js") }));`,
          ],
          { env: fixture.env, encoding: "utf8", timeout: 5_000 },
        );
        expect(verifyInstalledBytes.error).toBeUndefined();
        expect(verifyInstalledBytes.status, verifyInstalledBytes.stderr).toBe(0);
        expect(JSON.parse(verifyInstalledBytes.stdout)).toEqual({
          packageJson: true,
          index: true,
        });
        expect(fs.readdirSync(fixture.env.TMPDIR)).toEqual([]);
        expect(fs.readdirSync(path.dirname(fixture.proxyAddrDirectory)).sort()).toEqual([
          "express",
          "proxy-addr",
        ]);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    testTimeout(30_000),
  );

  it.each([false, true])(
    "restores or preserves the original Slack dependency when replacement promotion fails (restore failure: %s)",
    async (failRestore) => {
      const fixture = await createSlackRemediationFixture();
      const canonicalProxyAddrDirectory = path.join(
        fs.realpathSync(fixture.root),
        path.relative(fixture.root, fixture.proxyAddrDirectory),
      );
      const renameHook = renameFailureHook(fixture.root, fixture.proxyAddrDirectory, failRestore);

      try {
        const result = spawnSync(
          process.execPath,
          ["--import", renameHook, SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
              NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: "OPENAI_API_KEY=rename-failure-canary",
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(result.error).toBeUndefined();
        const renameTrace = fs.existsSync(path.join(fixture.root, "rename.trace"))
          ? fs.readFileSync(path.join(fixture.root, "rename.trace"), "utf8")
          : "no rename calls observed";
        expect(result.status, `${result.stderr}\n${renameTrace}`).toBe(2);
        expect(renameTrace).toContain(`${path.sep}replacement\t${canonicalProxyAddrDirectory}`);
        failRestore &&
          expect(renameTrace).toContain(`${path.sep}previous\t${canonicalProxyAddrDirectory}`);
        expect(fs.readdirSync(fixture.env.TMPDIR)).toEqual([]);

        const packageParent = path.dirname(fixture.proxyAddrDirectory);
        const recoveryDirectories = fs
          .readdirSync(packageParent)
          .filter((entry) => entry.startsWith(".proxy-addr-replacement-"));
        expect(recoveryDirectories).toHaveLength(failRestore ? 1 : 0);
        const preservedPackage = path.join(packageParent, recoveryDirectories[0] ?? "", "previous");
        verifyOriginalSlackDependencyBytes(
          fixture,
          failRestore ? preservedPackage : fixture.proxyAddrDirectory,
        );
        expect(result.stderr).toContain(
          failRestore
            ? "OpenClaw dependency 'proxy-addr' could not be replaced."
            : "Messaging build applier failed.",
        );
        failRestore &&
          expect(result.stderr).toContain(
            "The previous package is preserved at '.proxy-addr-replacement-",
          );
        failRestore &&
          expect(result.stderr).toContain(
            "Rerun the original onboarding or rebuild command; its managed plugin-install phase restores the previous package before retrying the replacement.",
          );
        expect(result.stderr).not.toContain(fixture.root);
        expect(result.stderr).not.toContain("rename-failure-canary");
        expect(fs.readdirSync(packageParent).sort()).toEqual(
          failRestore ? ["express", recoveryDirectories[0]!].sort() : ["express", "proxy-addr"],
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    testTimeout(30_000),
  );

  it(
    "reconciles a preserved Slack dependency after a successful retry",
    async () => {
      const fixture = await createSlackRemediationFixture();
      const renameHook = renameFailureHook(fixture.root, fixture.proxyAddrDirectory, true);

      try {
        const failedAttempt = spawnSync(
          process.execPath,
          ["--import", renameHook, SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(failedAttempt.error).toBeUndefined();
        expect(failedAttempt.status).toBe(2);
        const packageParent = path.dirname(fixture.proxyAddrDirectory);
        const recoveryDirectories = fs
          .readdirSync(packageParent)
          .filter((entry) => entry.startsWith(".proxy-addr-replacement-"));
        expect(recoveryDirectories).toHaveLength(1);
        verifyOriginalSlackDependencyBytes(
          fixture,
          path.join(packageParent, recoveryDirectories[0]!, "previous"),
        );

        const retry = spawnSync(
          process.execPath,
          [SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(retry.error).toBeUndefined();
        expect(retry.status, retry.stderr).toBe(0);
        expect(
          createHash("sha256")
            .update(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "package.json")))
            .digest("hex"),
        ).toBe("b2e305ca817ae4e8b088e07f38c5df1d7ad77aa3473809e4c37a9a1c83600225");
        expect(
          createHash("sha256")
            .update(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "index.js")))
            .digest("hex"),
        ).toBe("aa7efd29bbd61cbcc1bdafde9e674db28ead077864f33bfad3cdd19bb5a3778c");
        expect(
          fs
            .readdirSync(packageParent)
            .filter((entry) => entry.startsWith(".proxy-addr-replacement-")),
        ).toEqual([]);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    testTimeout(45_000),
  );

  it(
    "reports and reconciles stale recovery state after a successful replacement",
    async () => {
      const fixture = await createSlackRemediationFixture();
      const packageParent = path.dirname(fixture.proxyAddrDirectory);
      const staleRecoveryDirectory = path.join(packageParent, ".proxy-addr-replacement-stale");
      const previousPackage = path.join(staleRecoveryDirectory, "previous");
      fs.mkdirSync(staleRecoveryDirectory, { recursive: true });
      fs.cpSync(
        path.join(
          fixture.env.TEST_SLACK_SOURCE!,
          path.relative(fixture.env.TEST_SLACK_INSTALL!, fixture.proxyAddrDirectory),
        ),
        previousPackage,
        { recursive: true },
      );
      const cleanupHook = recoveryCleanupFailureHook(fixture.root, staleRecoveryDirectory);

      try {
        const failedAttempt = spawnSync(
          process.execPath,
          ["--import", cleanupHook, SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
              NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: "OPENAI_API_KEY=cleanup-failure-canary",
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(failedAttempt.error).toBeUndefined();
        const cleanupTrace = fs.readFileSync(
          path.join(fixture.root, "recovery-cleanup.trace"),
          "utf8",
        );
        expect(failedAttempt.status, `${failedAttempt.stderr}\n${cleanupTrace}`).toBe(2);
        expect(cleanupTrace).toContain(".proxy-addr-replacement-stale");
        expect(failedAttempt.stderr).toContain(
          "OpenClaw dependency 'proxy-addr' was replaced, but recovery-directory cleanup failed",
        );
        expect(failedAttempt.stderr).toContain(
          "Rerun the original onboarding or rebuild command so the managed plugin-install phase can reconcile recovery state.",
        );
        expect(failedAttempt.stderr).not.toContain("OPENAI_API_KEY=cleanup-failure-canary");
        expect(failedAttempt.stderr).not.toContain(fixture.root);
        expect(fs.existsSync(staleRecoveryDirectory)).toBe(true);
        expect(
          createHash("sha256")
            .update(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "index.js")))
            .digest("hex"),
        ).toBe("aa7efd29bbd61cbcc1bdafde9e674db28ead077864f33bfad3cdd19bb5a3778c");

        const retry = spawnSync(
          process.execPath,
          [SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: { ...fixture.env, NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(retry.error).toBeUndefined();
        expect(retry.status, retry.stderr).toBe(0);
        expect(fs.existsSync(staleRecoveryDirectory)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    testTimeout(45_000),
  );

  it(
    "reports and reconciles prior-package cleanup failure after replacement promotion",
    async () => {
      const fixture = await createSlackRemediationFixture();
      const packageParent = path.dirname(fixture.proxyAddrDirectory);
      const cleanupHook = previousPackageCleanupFailureHook(fixture.root, packageParent);

      try {
        const failedAttempt = spawnSync(
          process.execPath,
          ["--import", cleanupHook, SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
              NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: "OPENAI_API_KEY=prior-package-cleanup-canary",
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(failedAttempt.error).toBeUndefined();
        expect(failedAttempt.status, failedAttempt.stderr).toBe(2);
        expect(failedAttempt.stderr).toContain(
          "OpenClaw dependency 'proxy-addr' was replaced, but recovery-directory cleanup failed",
        );
        expect(failedAttempt.stderr).toContain(
          "Rerun the original onboarding or rebuild command so the managed plugin-install phase can reconcile recovery state.",
        );
        expect(failedAttempt.stderr).not.toContain("OPENAI_API_KEY=prior-package-cleanup-canary");
        expect(failedAttempt.stderr).not.toContain(fixture.root);

        const recoveryDirectories = fs
          .readdirSync(packageParent)
          .filter((entry) => entry.startsWith(".proxy-addr-replacement-"));
        expect(recoveryDirectories).toHaveLength(1);
        const retainedPreviousPackage = path.join(
          packageParent,
          recoveryDirectories[0]!,
          "previous",
        );
        expect(fs.existsSync(retainedPreviousPackage)).toBe(true);
        expect(
          createHash("sha256")
            .update(fs.readFileSync(path.join(fixture.proxyAddrDirectory, "index.js")))
            .digest("hex"),
        ).toBe("aa7efd29bbd61cbcc1bdafde9e674db28ead077864f33bfad3cdd19bb5a3778c");

        const retry = spawnSync(
          process.execPath,
          [SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: { ...fixture.env, NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(retry.error).toBeUndefined();
        expect(retry.status, retry.stderr).toBe(0);
        expect(fs.existsSync(retainedPreviousPackage)).toBe(false);
        expect(fs.existsSync(path.dirname(retainedPreviousPackage))).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    testTimeout(45_000),
  );

  it(
    "preserves remediation timeouts through official plugin installation and the CLI exit path",
    async () => {
      const fixture = await createSlackRemediationFixture();
      const timeoutHook = path.join(fixture.root, "timeout-hook.mjs");
      fs.writeFileSync(
        timeoutHook,
        [
          'import { createRequire, syncBuiltinESMExports } from "node:module";',
          'const childProcess = createRequire(import.meta.url)("node:child_process");',
          "const originalSpawnSync = childProcess.spawnSync;",
          "childProcess.spawnSync = (command, args, options) => {",
          '  if (command === "npm" && Array.isArray(args) && args[0] === "view" && args[1] === "proxy-addr@2.0.8") {',
          '    return { error: Object.assign(new Error(process.env.NEMOCLAW_FATAL_DIAGNOSTIC_CANARY), { code: "ETIMEDOUT" }) };',
          "  }",
          "  return originalSpawnSync(command, args, options);",
          "};",
          "syncBuiltinESMExports();",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      try {
        const result = spawnSync(
          process.execPath,
          ["--import", timeoutHook, SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            cwd: REPO_ROOT,
            env: {
              ...fixture.env,
              NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: undefined,
              NEMOCLAW_FATAL_DIAGNOSTIC_CANARY: "OPENAI_API_KEY=process-boundary-canary-0123456789",
            },
            encoding: "utf8",
            timeout: 15_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          "Official OpenClaw plugin 'slack' remediation operation 'fetch replacement' timed out after 15 minutes.",
        );
        expect(result.stderr).not.toContain("OPENAI_API_KEY=process-boundary-canary-0123456789");
        expect(result.stderr).not.toContain(fixture.root);
        expect(fs.readdirSync(fixture.env.TMPDIR)).toEqual([]);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    testTimeout(20_000),
  );

  it("loads the real build applier from the Hermes image module boundary", () => {
    const dockerfile = fs.readFileSync(
      path.join(REPO_ROOT, "agents", "hermes", "Dockerfile"),
      "utf8",
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-applier-boundary-"));
    const messagingRoot = path.join(root, "src", "lib", "messaging");
    try {
      [
        ...dockerfile.matchAll(
          /^COPY (src\/lib\/messaging\/|scripts\/lib\/(?:openclaw-npm-remediation|reviewed-npm-archive)\.mts) (\/\S+)$/gm,
        ),
      ].forEach((copy) => {
        const source = copy[1] ?? "";
        const destination = copy[2] ?? "";
        const sourcePath = path.join(REPO_ROOT, source);
        const destinationPath = path.join(root, destination.replace(/^\//, ""));
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.cpSync(sourcePath, destinationPath, { recursive: true });
      });
      const stagedApplier = path.join(
        messagingRoot,
        "applier",
        "build",
        "messaging-build-applier.mts",
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(pathToFileURL(stagedApplier).href)})`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "accepts the reviewed messaging plugin registry tarball URL before install",
    async () => {
      expect(OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY).toEqual({
        schemaVersion: 1,
        packageIdentity: "exact-npm-package-spec",
        registryIntegrityField: "dist.integrity",
        packedArchiveIntegrity: "must-match-committed-sri",
        registryTarballField: "dist.tarball",
        registryTarballUrl: "must-match-committed-url",
      });

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-provenance-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "$5" >> "$OPENCLAW_TRACE"',
          ...officialPluginInspectionShell(),
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const env = await withLegacyMessagingPlanEnvDirect(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_VERSION: "2026.9.1",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

        expect(applyMessagingBuildPhase(plan, "agent-install", env)).toEqual([]);
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.9.1|dist.integrity");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.9.1|dist.tarball");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.9.1|--pack-destination");
        expect(trace).toContain(
          "openclaw|plugins|install|--force|--accept-capabilities|npm:@openclaw/",
        );
        expect(trace).toContain("slack@2026.9.1");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it("pins the registry tarball URL for every trusted built-in messaging plugin", () => {
    expect(
      reviewedOpenClawPluginTarballUrlByPackageSpec({
        OPENCLAW_VERSION: "2026.9.1",
      }),
    ).toEqual({
      "@openclaw/discord@2026.9.1":
        "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.9.1.tgz",
      "@openclaw/googlechat@2026.9.1":
        "https://registry.npmjs.org/@openclaw/googlechat/-/googlechat-2026.9.1.tgz",
      "@openclaw/msteams@2026.9.1":
        "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.9.1.tgz",
      "@openclaw/slack@2026.9.1": OPENCLAW_SLACK_2026_9_1_TARBALL,
      "@openclaw/whatsapp@2026.9.1":
        "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.9.1.tgz",
      "@tencent-weixin/openclaw-weixin@2.4.9":
        "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz",
    });
  });

  it(
    "fails closed before installing when the messaging plugin registry tarball URL drifts",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-tarball-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "$5" >> "$OPENCLAW_TRACE"',
          ...officialPluginInspectionShell(),
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const env = await withLegacyMessagingPlanEnvDirect(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_REGISTRY_TARBALL_URL: "https://unexpected.invalid/openclaw/slack-2026.9.1.tgz",
            OPENCLAW_VERSION: "2026.9.1",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(env, "openclaw");
        const message = thrownMessage(() => applyMessagingBuildPhase(plan, "agent-install", env));

        expect(message).toContain(
          "OpenClaw plugin @openclaw/slack@2026.9.1 npm tarball URL mismatch",
        );
        expect(message).toContain(`Expected: ${OPENCLAW_SLACK_2026_9_1_TARBALL}`);
        expect(message).toContain(
          "Actual:   https://unexpected.invalid/openclaw/slack-2026.9.1.tgz",
        );
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.9.1|dist.integrity");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.9.1|dist.tarball");
        expect(trace).not.toContain("npm|pack|");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it(
    "fails closed before installing the 2026.9.1 Slack plugin when the packed archive integrity drifts",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-pack-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "$5" >> "$OPENCLAW_TRACE"',
          ...officialPluginInspectionShell(),
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const env = await withLegacyMessagingPlanEnvDirect(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: "sha512-packed-drift",
            OPENCLAW_VERSION: "2026.9.1",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(env, "openclaw");
        const message = thrownMessage(() => applyMessagingBuildPhase(plan, "agent-install", env));

        expect(message).toContain(
          "OpenClaw plugin @openclaw/slack@2026.9.1 downloaded tarball integrity mismatch",
        );
        expect(message).toContain(`Expected: ${OPENCLAW_SLACK_2026_9_1_INTEGRITY}`);
        expect(message).toContain("Actual:   sha512-packed-drift");
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.9.1|dist.integrity");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.9.1|--pack-destination");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it(
    "rejects packed archive filenames outside the fresh pack directory",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-pack-path-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "$5" >> "$OPENCLAW_TRACE"',
          ...officialPluginInspectionShell(),
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const env = await withLegacyMessagingPlanEnvDirect(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_9_1_INTEGRITY,
            OPENCLAW_PACK_FILENAME_OVERRIDE: "../slack-2026.9.1.tgz",
            OPENCLAW_VERSION: "2026.9.1",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const result = spawnSync(
          "node",
          [SCRIPT_PATH, "--agent", "openclaw", "--phase", "agent-install"],
          {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            env,
            timeout: 10_000,
          },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Messaging build applier failed.");
        expect(result.stderr).not.toContain("../slack-2026.9.1.tgz");
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.9.1|dist.integrity");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.9.1|--pack-destination");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );
});
