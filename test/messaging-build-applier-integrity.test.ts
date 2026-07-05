// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMessagingBuildPhase,
  OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY,
  readMessagingBuildPlanFromEnv,
  reviewedOpenClawPluginTarballUrlByPackageSpec,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { testTimeout } from "./helpers/timeouts";
import { withLegacyMessagingPlanEnvDirect } from "./messaging-plan-test-helper";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const OPENCLAW_SLACK_2026_6_10_INTEGRITY =
  "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==";
const OPENCLAW_SLACK_2026_6_10_TARBALL =
  "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.6.10.tgz";

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
    '  reported_filename="${OPENCLAW_PACK_FILENAME_OVERRIDE:-slack-2026.6.10.tgz}";',
    '  printf "fake plugin tarball" > "$pack_dir/slack-2026.6.10.tgz";',
    '  printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$reported_filename" "$OPENCLAW_PACK_INTEGRITY_OVERRIDE";',
    "  exit 0",
    "fi",
    'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_SLACK_INTEGRITY"; exit 0; fi',
    `if [ "\${1:-}" = "view" ] && [ "\${3:-}" = "dist.tarball" ]; then printf "%s\\n" "\${OPENCLAW_REGISTRY_TARBALL_URL:-${OPENCLAW_SLACK_2026_6_10_TARBALL}}"; exit 0; fi`,
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
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), { mode: 0o755 });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
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
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_VERSION: "2026.6.10",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(env, "openclaw");

        expect(applyMessagingBuildPhase(plan, "agent-install", env)).toEqual([]);
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.integrity");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.tarball");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.10|--pack-destination");
        expect(trace).toContain("openclaw|plugins|install");
        expect(trace).toContain("slack-2026.6.10.tgz|--pin");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it("pins the registry tarball URL for every trusted built-in messaging plugin", () => {
    expect(
      reviewedOpenClawPluginTarballUrlByPackageSpec({ OPENCLAW_VERSION: "2026.6.10" }),
    ).toEqual({
      "@openclaw/discord@2026.6.10":
        "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.6.10.tgz",
      "@openclaw/msteams@2026.6.10":
        "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz",
      "@openclaw/slack@2026.6.10": OPENCLAW_SLACK_2026_6_10_TARBALL,
      "@openclaw/whatsapp@2026.6.10":
        "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.6.10.tgz",
      "@tencent-weixin/openclaw-weixin@2.4.3":
        "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz",
    });
  });

  it(
    "fails closed before installing when the messaging plugin registry tarball URL drifts",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-tarball-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), { mode: 0o755 });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
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
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_REGISTRY_TARBALL_URL:
              "https://unexpected.invalid/openclaw/slack-2026.6.10.tgz",
            OPENCLAW_VERSION: "2026.6.10",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(env, "openclaw");
        const message = thrownMessage(() => applyMessagingBuildPhase(plan, "agent-install", env));

        expect(message).toContain(
          "OpenClaw plugin @openclaw/slack@2026.6.10 npm tarball URL mismatch",
        );
        expect(message).toContain(`Expected: ${OPENCLAW_SLACK_2026_6_10_TARBALL}`);
        expect(message).toContain(
          "Actual: https://unexpected.invalid/openclaw/slack-2026.6.10.tgz",
        );
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.integrity");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.tarball");
        expect(trace).not.toContain("npm|pack|");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it(
    "fails closed before installing the 2026.6.10 Slack plugin when the packed archive integrity drifts",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-slack-pack-"));
      const tracePath = path.join(tmp, "openclaw.trace");
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), { mode: 0o755 });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
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
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: "sha512-packed-drift",
            OPENCLAW_VERSION: "2026.6.10",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const plan = readMessagingBuildPlanFromEnv(env, "openclaw");
        const message = thrownMessage(() => applyMessagingBuildPhase(plan, "agent-install", env));

        expect(message).toContain(
          "OpenClaw plugin @openclaw/slack@2026.6.10 downloaded tarball integrity mismatch",
        );
        expect(message).toContain(`Expected: ${OPENCLAW_SLACK_2026_6_10_INTEGRITY}`);
        expect(message).toContain("Actual: sha512-packed-drift");
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.integrity");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.10|--pack-destination");
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
      fs.writeFileSync(path.join(tmp, "npm"), fakeSlackNpmScript(), { mode: 0o755 });
      fs.writeFileSync(
        path.join(tmp, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'openclaw|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" >> "$OPENCLAW_TRACE"',
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
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_6_10_INTEGRITY,
            OPENCLAW_PACK_FILENAME_OVERRIDE: "../slack-2026.6.10.tgz",
            OPENCLAW_VERSION: "2026.6.10",
            NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
          },
          "openclaw",
        );
        const result = spawnSync(
          "node",
          [
            "--experimental-strip-types",
            SCRIPT_PATH,
            "--agent",
            "openclaw",
            "--phase",
            "agent-install",
          ],
          {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            env,
            timeout: 10_000,
          },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "npm pack @openclaw/slack@2026.6.10 reported unsafe archive filename: ../slack-2026.6.10.tgz",
        );
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.10|dist.integrity");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.10|--pack-destination");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );
});
