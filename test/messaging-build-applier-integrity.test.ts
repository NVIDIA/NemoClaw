// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY } from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { testTimeout } from "./helpers/timeouts";
import { withLegacyMessagingPlanEnv } from "./messaging-plan-test-helper";

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
const OPENCLAW_SLACK_2026_6_9_INTEGRITY =
  "sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==";

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
    '  reported_filename="${OPENCLAW_PACK_FILENAME_OVERRIDE:-slack-2026.6.9.tgz}";',
    '  printf "fake plugin tarball" > "$pack_dir/slack-2026.6.9.tgz";',
    '  printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$reported_filename" "$OPENCLAW_PACK_INTEGRITY_OVERRIDE";',
    "  exit 0",
    "fi",
    'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.integrity" ]; then printf "%s\\n" "$OPENCLAW_SLACK_INTEGRITY"; exit 0; fi',
    'if [ "${1:-}" = "view" ] && [ "${3:-}" = "dist.tarball" ]; then printf "%s\\n" "$OPENCLAW_UNEXPECTED_TARBALL_URL"; exit 0; fi',
    "exit 1",
    "",
  ].join("\n");
}

describe("messaging-build-applier.mts: plugin archive integrity", () => {
  it(
    "accepts the explicit SRI-only registry provenance boundary without querying dist.tarball",
    () => {
      expect(OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY).toEqual({
        schemaVersion: 1,
        packageIdentity: "exact-npm-package-spec",
        registryIntegrityField: "dist.integrity",
        packedArchiveIntegrity: "must-match-committed-sri",
        registryTarballUrl: "not-pinned",
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
        const env = withLegacyMessagingPlanEnv(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_9_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_6_9_INTEGRITY,
            OPENCLAW_UNEXPECTED_TARBALL_URL:
              "https://unexpected.invalid/openclaw/slack-2026.6.9.tgz",
            OPENCLAW_VERSION: "2026.6.9",
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

        expect(result.status, result.stderr).toBe(0);
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.9|dist.integrity");
        expect(trace).not.toContain("dist.tarball");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.9|--pack-destination");
        expect(trace).toContain("openclaw|plugins|install");
        expect(trace).toContain("slack-2026.6.9.tgz|--pin");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it(
    "fails closed before installing the 2026.6.9 Slack plugin when the packed archive integrity drifts",
    () => {
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
        const env = withLegacyMessagingPlanEnv(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_9_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: "sha512-packed-drift",
            OPENCLAW_VERSION: "2026.6.9",
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
          "OpenClaw plugin @openclaw/slack@2026.6.9 downloaded tarball integrity mismatch",
        );
        expect(result.stderr).toContain(`Expected: ${OPENCLAW_SLACK_2026_6_9_INTEGRITY}`);
        expect(result.stderr).toContain("Actual: sha512-packed-drift");
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.9|dist.integrity");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.9|--pack-destination");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );

  it(
    "rejects packed archive filenames outside the fresh pack directory",
    () => {
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
        const env = withLegacyMessagingPlanEnv(
          {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_SLACK_INTEGRITY: OPENCLAW_SLACK_2026_6_9_INTEGRITY,
            OPENCLAW_PACK_INTEGRITY_OVERRIDE: OPENCLAW_SLACK_2026_6_9_INTEGRITY,
            OPENCLAW_PACK_FILENAME_OVERRIDE: "../slack-2026.6.9.tgz",
            OPENCLAW_VERSION: "2026.6.9",
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
          "npm pack @openclaw/slack@2026.6.9 reported unsafe archive filename: ../slack-2026.6.9.tgz",
        );
        const trace = fs.readFileSync(tracePath, "utf-8");
        expect(trace).toContain("npm|view|@openclaw/slack@2026.6.9|dist.integrity");
        expect(trace).toContain("npm|pack|@openclaw/slack@2026.6.9|--pack-destination");
        expect(trace).not.toContain("openclaw|plugins|install");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    testTimeout(15_000),
  );
});
