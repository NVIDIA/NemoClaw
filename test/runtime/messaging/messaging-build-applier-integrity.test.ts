// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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

import { officialPluginInspectionShell } from "./official-plugin-inspection-fixture";

const { applySlackProxyAddrRemediation } = vi.hoisted(() => ({
  applySlackProxyAddrRemediation: vi.fn(),
}));

vi.mock("../../../scripts/lib/openclaw-npm-remediation.mts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../scripts/lib/openclaw-npm-remediation.mts")>();
  return {
    ...original,
    applyOpenClawSlackProxyAddrRemediation: applySlackProxyAddrRemediation,
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

describe("messaging-build-applier.mts: plugin archive integrity", () => {
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

  it.each([
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-remediation-"));
    const packageDirectory = path.join(
      tmp,
      root,
      "npm/projects/project/node_modules/@openclaw/slack",
    );
    fs.mkdirSync(packageDirectory, { recursive: true });
    // The ordinary managed OpenClaw peer link is legal below the package root.
    fs.mkdirSync(path.join(packageDirectory, "node_modules"));
    fs.symlinkSync(tmp, path.join(packageDirectory, "node_modules/openclaw"));
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
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_SLACK_2026_9_2_INTEGRITY,
          OPENCLAW_VERSION: "2026.9.2",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
        },
        "openclaw",
      );
      const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

      expect(applyMessagingBuildPhase(plan, "agent-install", env)).toEqual([]);
      expect(applySlackProxyAddrRemediation).toHaveBeenCalledOnce();
      expect(applySlackProxyAddrRemediation).toHaveBeenCalledWith(
        expect.objectContaining({
          packageDirectory: fs.realpathSync(packageDirectory),
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-install-denial-"));
    try {
      const packageDirectory = path.join(
        tmp,
        ".openclaw/npm/projects/project/node_modules/@openclaw/slack",
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
          : "OpenClaw Slack remediation requires a valid managed npm package directory";
      expect(failure).toThrow(expect.objectContaining({ message: expectedMessage }));
      expect(applySlackProxyAddrRemediation).not.toHaveBeenCalled();
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
