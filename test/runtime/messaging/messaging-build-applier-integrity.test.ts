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

const { applySlackProxyAddrRemediation } = vi.hoisted(() => ({
  applySlackProxyAddrRemediation: vi.fn(),
}));

vi.mock("../../../scripts/lib/openclaw-npm-remediation.mts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../scripts/lib/openclaw-npm-remediation.mts")>();
  return {
    ...original,
    remediateInstalledOfficialOpenClawPlugin: applySlackProxyAddrRemediation,
    remediateReviewedOpenClawPluginArchive: ({ archivePath }: { archivePath: string }) => ({
      archivePath,
      integrity: "sha512-messaging-integrity-test-remediation",
      remediated: false,
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  applySlackProxyAddrRemediation.mockReset();
});

const SLACK_PROJECT = `openclaw-slack-${createHash("sha256").update("@openclaw/slack").digest("hex").slice(0, 10)}`;

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
const OPENCLAW_SLACK_2026_9_2_INTEGRITY =
  "sha512-6M1M6gL3iXahpalNsYAUuA+wvnV8lbMlNNH2ToegFvaSJcIll4S9kFa5mv3GFoquhMRHQjEjnkXPHP/pXwaWcA==";
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

  it.each<{ name: string; overrides: Record<string, string>; root: string }>([
    { name: "HOME", overrides: {}, root: ".openclaw" },
    { name: "state override", overrides: { OPENCLAW_STATE_DIR: "~/state" }, root: "state" },
    {
      name: "config override",
      overrides: { OPENCLAW_CONFIG_PATH: "~/config/openclaw.json" },
      root: "config",
    },
    {
      name: "home override",
      overrides: { OPENCLAW_HOME: "~/alternate" },
      root: "alternate/.openclaw",
    },
    {
      name: "state precedence and effective home expansion",
      overrides: {
        OPENCLAW_HOME: "~/alternate",
        OPENCLAW_STATE_DIR: "~/state",
        OPENCLAW_CONFIG_PATH: "~/ignored/config.json",
      },
      root: "alternate/state",
    },
  ])("remediates the verified managed Slack install using $name", async ({ overrides, root }) => {
    const original = await vi.importActual<
      typeof import("../../../scripts/lib/openclaw-npm-remediation.mts")
    >("../../../scripts/lib/openclaw-npm-remediation.mts");
    applySlackProxyAddrRemediation.mockImplementation(
      original.remediateInstalledOfficialOpenClawPlugin,
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-remediation-"));
    const packageDirectory = path.join(
      tmp,
      root,
      `npm/projects/${SLACK_PROJECT}/node_modules/@openclaw/slack`,
    );
    fs.mkdirSync(packageDirectory, { recursive: true });
    // The ordinary managed OpenClaw peer link is legal below the package root.
    fs.mkdirSync(path.join(packageDirectory, "node_modules"));
    fs.symlinkSync(tmp, path.join(packageDirectory, "node_modules/openclaw"));
    const dependencyDirectory = path.join(
      packageDirectory,
      "node_modules/@slack/bolt/node_modules/proxy-addr",
    );
    fs.mkdirSync(dependencyDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "@openclaw/slack",
        version: "2026.9.2",
        dependencies: { "@slack/bolt": "5.0.0" },
        bundledDependencies: ["@slack/bolt"],
      }),
    );
    const boltDirectory = path.join(packageDirectory, "node_modules/@slack/bolt");
    const expressDirectory = path.join(boltDirectory, "node_modules/express");
    fs.mkdirSync(expressDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(boltDirectory, "package.json"),
      JSON.stringify({
        name: "@slack/bolt",
        version: "5.0.0",
        dependencies: { express: "^5.0.0" },
        license: "MIT",
        engines: { node: ">=20" },
      }),
    );
    fs.writeFileSync(
      path.join(expressDirectory, "package.json"),
      JSON.stringify({
        name: "express",
        version: "5.2.1",
        dependencies: { "proxy-addr": "^2.0.7" },
        license: "MIT",
        engines: { node: ">= 18" },
      }),
    );
    fs.writeFileSync(
      path.join(dependencyDirectory, "package.json"),
      JSON.stringify({
        name: "proxy-addr",
        version: "2.0.7",
        dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
        license: "MIT",
        engines: { node: ">= 0.10" },
      }),
    );
    fs.writeFileSync(path.join(dependencyDirectory, "index.js"), "vulnerable-canary");
    const tracePath = path.join(tmp, "openclaw.trace");
    const inspection = JSON.stringify({
      plugin: { id: "slack", trustedOfficialInstall: true },
      install: {
        source: "npm",
        installPath: packageDirectory,
        resolvedSpec: "@openclaw/slack@2026.9.2",
        integrity: OPENCLAW_SLACK_2026_9_2_INTEGRITY,
      },
    });
    fs.writeFileSync(
      path.join(tmp, "npm"),
      [
        "#!/bin/sh",
        'printf \'npm|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$OPENCLAW_TRACE"',
        'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_SLACK_2026_9_2_INTEGRITY"; exit 0; fi',
        'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.tarball" ]; then printf "%s\\n" "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.9.2.tgz"; exit 0; fi',
        'if [ "${1:-}" = "pack" ]; then pack_dir="${4:-}"; printf "fake plugin tarball" > "$pack_dir/slack-2026.9.2.tgz"; printf \'[{"filename":"slack-2026.9.2.tgz","integrity":"%s"}]\\n\' "$OPENCLAW_SLACK_2026_9_2_INTEGRITY"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'openclaw|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "$5" >> "$OPENCLAW_TRACE"',
        'if [ "${1:-}" = "plugins" ] && [ "${2:-}" = "inspect" ] && [ "${3:-}" = "slack" ]; then',
        `  printf '%s\\n' '${inspection}'`,
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: tmp,
          ...overrides,
          NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: path.resolve(
            import.meta.dirname,
            "../../fixtures/npm/proxy-addr-2.0.8",
          ),
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_SLACK_2026_9_2_INTEGRITY,
          OPENCLAW_VERSION: "2026.9.2",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
        },
        "openclaw",
      );
      const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(applyMessagingBuildPhase(plan, "agent-install", env)).toEqual([]);
      expect(
        JSON.parse(fs.readFileSync(path.join(dependencyDirectory, "package.json"), "utf8")).version,
      ).toBe("2.0.8");
      expect(fs.readFileSync(path.join(dependencyDirectory, "index.js"), "utf8")).not.toContain(
        "vulnerable-canary",
      );
      expect(
        fs.lstatSync(path.join(packageDirectory, "node_modules/openclaw")).isSymbolicLink(),
      ).toBe(true);
      expect(applySlackProxyAddrRemediation).toHaveBeenCalledOnce();
      expect(applySlackProxyAddrRemediation).toHaveBeenCalledWith(
        expect.objectContaining({
          packageDirectory,
          trustedStateRoot: path.join(tmp, root),
        }),
      );
      const remediationRequest = applySlackProxyAddrRemediation.mock.calls[0]?.[0] as {
        env: Record<string, string | undefined>;
      };
      expect(remediationRequest.env.NPM_CONFIG_OFFLINE).toBeUndefined();
      const trace = fs.readFileSync(tracePath, "utf-8");
      expect(trace.indexOf("openclaw|plugins|inspect|slack")).toBeGreaterThan(
        trace.indexOf("openclaw|plugins|install"),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    "missing",
    "empty",
    "relative",
    "nonexistent",
    "outside",
    "traversal",
    "wrong package",
    "package symlink",
    "escaping parent symlink",
    "file",
    "untrusted provenance",
  ])("refuses Slack remediation before mutation for %s", async (scenario) => {
    const original = await vi.importActual<
      typeof import("../../../scripts/lib/openclaw-npm-remediation.mts")
    >("../../../scripts/lib/openclaw-npm-remediation.mts");
    applySlackProxyAddrRemediation.mockImplementation(
      original.remediateInstalledOfficialOpenClawPlugin,
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-install-denial-"));
    try {
      const packageDirectory = path.join(
        tmp,
        `.openclaw/npm/projects/${SLACK_PROJECT}/node_modules/@openclaw/slack`,
      );
      fs.mkdirSync(packageDirectory, { recursive: true });
      const sentinel = path.join(packageDirectory, "untouched");
      fs.writeFileSync(sentinel, "original");
      const installPaths: Record<string, string | undefined> = {
        missing: undefined,
        empty: "",
        relative: "project/node_modules/@openclaw/slack",
        nonexistent: path.join(tmp, ".openclaw/npm/projects/absent/node_modules/@openclaw/slack"),
        outside: path.join(tmp, "outside/node_modules/@openclaw/slack"),
        traversal:
          path.join(tmp, ".openclaw/npm/projects") +
          "/../projects/project/node_modules/@openclaw/slack",
        "wrong package": path.join(
          tmp,
          ".openclaw/npm/projects/project/node_modules/@openclaw/discord",
        ),
        "package symlink": path.join(
          tmp,
          ".openclaw/npm/projects/link/node_modules/@openclaw/slack",
        ),
        "escaping parent symlink": path.join(
          tmp,
          ".openclaw/npm/projects/escape/node_modules/@openclaw/slack",
        ),
        file: path.join(tmp, ".openclaw/npm/projects/file/node_modules/@openclaw/slack"),
        "untrusted provenance": packageDirectory,
      };
      const linkPath = installPaths["package symlink"]!;
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(packageDirectory, linkPath);
      const outsideProject = path.join(tmp, "outside");
      fs.mkdirSync(path.join(outsideProject, "node_modules/@openclaw/slack"), { recursive: true });
      fs.symlinkSync(outsideProject, path.join(tmp, ".openclaw/npm/projects/escape"));
      fs.mkdirSync(path.dirname(installPaths.file!), { recursive: true });
      fs.writeFileSync(installPaths.file!, "not a directory");
      const inspection = JSON.stringify({
        plugin: { id: "slack", trustedOfficialInstall: scenario !== "untrusted provenance" },
        install: {
          source: "npm",
          resolvedSpec: "@openclaw/slack@2026.9.2",
          integrity: OPENCLAW_SLACK_2026_9_2_INTEGRITY,
          installPath: installPaths[scenario],
        },
      });
      fs.writeFileSync(
        path.join(tmp, "npm"),
        [
          "#!/bin/sh",
          'if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then printf "%s" "$TEST_INTEGRITY"; exit 0; fi',
          'if [ "$1" = "view" ]; then printf "%s" "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.9.2.tgz"; exit 0; fi',
          `if [ "$1" = "pack" ]; then printf "archive" > "$4/slack.tgz"; printf '[{"filename":"slack.tgz","integrity":"%s"}]' "$TEST_INTEGRITY"; exit 0; fi`,
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'if [ "$2" = "inspect" ]; then printf "%s" "$TEST_INSPECTION"; fi',
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: tmp,
          TEST_INTEGRITY: OPENCLAW_SLACK_2026_9_2_INTEGRITY,
          TEST_INSPECTION: inspection,
          OPENCLAW_VERSION: "2026.9.2",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
        },
        "openclaw",
      );
      const plan = readMessagingBuildPlanFromEnv(env, "openclaw");
      const failure = () => applyMessagingBuildPhase(plan, "agent-install", env);
      const expectedMessage =
        scenario === "untrusted provenance"
          ? "OpenClaw official npm plugin slack did not retain trusted exact registry provenance"
          : "OpenClaw Slack remediation requires a valid managed npm package directory and reviewed dependency graph";
      expect(failure).toThrow(expect.objectContaining({ message: expectedMessage }));

      expect(fs.readFileSync(sentinel, "utf8")).toBe("original");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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
