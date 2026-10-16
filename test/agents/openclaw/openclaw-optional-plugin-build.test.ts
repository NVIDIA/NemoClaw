// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { dockerRunCommandBetween, runLoggedDockerShell } from "../../helpers/dockerfile-run-shell";
import { writeReviewedNpmFixture } from "../../helpers/reviewed-npm-fixture";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BRAVE_INTEGRITY =
  "sha512-6416aPlfnAKlu8IBrrjgfoiss/10xB32ywFwnIf/fkVMQE61qsmzA/qxUniQuDwOB6EBFNEkNs54DhIT7g3UVg==";
const BRAVE_TARBALL =
  "https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.9.2.tgz";
const TAVILY_INTEGRITY =
  "sha512-FYK2e7aXagwcGiTRQfidS3PThIfJkAQoqYEtlkadiGxmgeChYY71YLeD6nQAHZKHmTAOw9U7njDxMBvYyXPf5w==";
const TAVILY_TARBALL =
  "https://registry.npmjs.org/@openclaw/tavily-plugin/-/tavily-plugin-2026.9.2.tgz";

it.each([
  {
    provider: "brave",
    integrity: BRAVE_INTEGRITY,
    tarball: BRAVE_TARBALL,
    credential: "BRAVE_API_KEY",
  },
  {
    provider: "tavily",
    integrity: TAVILY_INTEGRITY,
    tarball: TAVILY_TARBALL,
    credential: "TAVILY_API_KEY",
  },
])(
  "pins $provider and preserves its placeholder during build-time doctor (#11294)",
  ({ provider, integrity, tarball, credential }) => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Install non-messaging OpenClaw plugins",
      "USER root\nCOPY src/lib/messaging/ /src/lib/messaging/",
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-search-plugin-install-"));
    const log = path.join(tmp, "calls.log");
    try {
      const npmFixture = path.join(tmp, "npm-fixture");
      writeReviewedNpmFixture(npmFixture, log, [
        {
          integrity,
          packageSpec: `@openclaw/${provider}-plugin@2026.9.2`,
          tarballUrl: tarball,
        },
      ]);
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'openclaw() { printf "%s|BRAVE_API_KEY=%s|TAVILY_API_KEY=%s\\n" "$*" "${BRAVE_API_KEY:-}" "${TAVILY_API_KEY:-}" >> "$PLUGIN_CALL_LOG"; }',
        command
          .replace(
            "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives;",
            "unset NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR;",
          )
          .replaceAll(
            "/scripts/lib/reviewed-npm-archive.mts",
            path.join(ROOT, "scripts", "lib", "reviewed-npm-archive.mts"),
          ),
      ].join("\n");
      const scriptPath = path.join(tmp, "run.sh");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PLUGIN_CALL_LOG: log,
          BRAVE_API_KEY: "",
          TAVILY_API_KEY: "",
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0",
          NEMOCLAW_OPENCLAW_OTEL: "0",
          NEMOCLAW_REVIEWED_NPM_EXECUTABLE: npmFixture,
          NEMOCLAW_WEB_SEARCH_ENABLED: "1",
          NEMOCLAW_WEB_SEARCH_PROVIDER: provider,
          NODE_OPTIONS: "",
          OPENCLAW_BRAVE_PLUGIN_2026_9_2_INTEGRITY: BRAVE_INTEGRITY,
          OPENCLAW_TAVILY_PLUGIN_2026_9_2_INTEGRITY: TAVILY_INTEGRITY,
          OPENCLAW_VERSION: "2026.9.2",
        },
      });
      const calls = fs.readFileSync(log, "utf-8");
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain(`npm view @openclaw/${provider}-plugin@2026.9.2 dist.integrity`);
      expect(calls).toContain(`npm pack @openclaw/${provider}-plugin@2026.9.2 --pack-destination`);
      expect(calls).toContain("plugins install --force --accept-capabilities npm-pack:");
      expect(calls).toContain("doctor --fix --non-interactive|");
      expect(calls).toContain(`${credential}=openshell:resolve:env:${credential}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

it.each([
  {
    scenario: "selected Tavily",
    provider: "tavily",
    union: "0",
    content: "reviewed plugin fixture",
    version: "2026.9.2",
    status: 0,
    installed: ["tavily-plugin"],
    doctor: "doctor --fix --non-interactive|||\n",
    diagnostic: /^$/u,
  },
  {
    scenario: "the managed image",
    provider: "tavily",
    union: "1",
    content: "reviewed plugin fixture",
    version: "2026.9.2",
    status: 0,
    installed: ["diagnostics-otel", "brave-plugin", "tavily-plugin"],
    doctor: "",
    diagnostic: /^$/u,
  },
  {
    scenario: "a modified Tavily archive",
    provider: "tavily",
    union: "0",
    content: "modified plugin fixture",
    version: "2026.9.2",
    status: 1,
    installed: [],
    doctor: "",
    diagnostic: /integrity mismatch for .*tavily-plugin-2026\.9\.2\.tgz/u,
  },
  {
    scenario: "a modified Brave archive",
    provider: "brave",
    union: "0",
    content: "modified plugin fixture",
    version: "2026.9.2",
    status: 1,
    installed: [],
    doctor: "",
    diagnostic: /integrity mismatch for .*brave-plugin-2026\.9\.2\.tgz/u,
  },
  {
    scenario: "an unpinned Tavily version",
    provider: "tavily",
    union: "0",
    content: "reviewed plugin fixture",
    version: "2099.1.1",
    status: 1,
    installed: [],
    doctor: "",
    diagnostic: /@openclaw\/tavily-plugin@2099\.1\.1 has no committed npm integrity pin/u,
  },
])(
  "uses only verified offline archives for $scenario (#11294)",
  ({ provider, union, content, version, status, installed, doctor, diagnostic }) => {
    const command = dockerRunCommandBetween(
      fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8"),
      "# Install non-messaging OpenClaw plugins",
      "USER root\nCOPY src/lib/messaging/ /src/lib/messaging/",
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-offline-search-plugin-"));
    const log = path.join(tmp, "calls.log");
    const archiveDirectory = path.join(tmp, "archives");
    const integrity = `sha512-${createHash("sha512").update("reviewed plugin fixture").digest("base64")}`;
    try {
      fs.mkdirSync(archiveDirectory);
      fs.writeFileSync(
        path.join(archiveDirectory, "diagnostics-otel-2026.9.2.tgz"),
        "reviewed plugin fixture",
      );
      fs.writeFileSync(
        path.join(archiveDirectory, "brave-plugin-2026.9.2.tgz"),
        "reviewed plugin fixture",
      );
      fs.writeFileSync(
        path.join(archiveDirectory, "tavily-plugin-2026.9.2.tgz"),
        "reviewed plugin fixture",
      );
      fs.writeFileSync(path.join(archiveDirectory, `${provider}-plugin-2026.9.2.tgz`), content);
      fs.writeFileSync(log, "");
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'openclaw() { printf "%s|%s|%s|%s\\n" "$*" "${NPM_CONFIG_OFFLINE:-}" "${NPM_CONFIG_IGNORE_SCRIPTS:-}" "${npm_config_ignore_scripts:-}" >> "$PLUGIN_CALL_LOG"; }',
        command.replace(
          "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives;",
          'export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR="$PLUGIN_ARCHIVE_DIR";',
        ),
      ].join("\n");
      const scriptPath = path.join(tmp, "run.sh");
      fs.writeFileSync(scriptPath, script);
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          PLUGIN_CALL_LOG: log,
          PLUGIN_ARCHIVE_DIR: archiveDirectory,
          NPM_CONFIG_OFFLINE: "",
          NPM_CONFIG_IGNORE_SCRIPTS: "",
          npm_config_ignore_scripts: "",
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: union,
          NEMOCLAW_OPENCLAW_OTEL: "0",
          NEMOCLAW_WEB_SEARCH_ENABLED: "1",
          NEMOCLAW_WEB_SEARCH_PROVIDER: provider,
          OPENCLAW_VERSION: version,
          OPENCLAW_DIAGNOSTICS_OTEL_2026_9_2_INTEGRITY: integrity,
          OPENCLAW_BRAVE_PLUGIN_2026_9_2_INTEGRITY: integrity,
          OPENCLAW_TAVILY_PLUGIN_2026_9_2_INTEGRITY: integrity,
        },
      });
      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).toMatch(diagnostic);
      const expectedInstalls = installed
        .map(
          (plugin) =>
            `plugins install --force --accept-capabilities npm-pack:${archiveDirectory}/${plugin}-2026.9.2.tgz|true|true|true\n`,
        )
        .join("");
      expect(fs.readFileSync(log, "utf8")).toBe(expectedInstalls + doctor);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "reports an unsafe messaging cache path before invoking the build applier",
  () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-cache-safety-"));
    const unsafeCacheEntry = path.join(tmp, "unsafe-cache-entry");
    const installCacheTemplate = path.join(tmp, "install-cache.XXXXXX");

    try {
      fs.writeFileSync(unsafeCacheEntry, "fixture\n", { mode: 0o600 });
      fs.chmodSync(unsafeCacheEntry, 0o666);
      const command = dockerRunCommandBetween(
        dockerfile,
        "RUN --mount=from=openclaw-managed-messaging-npm-cache",
        "# Copy the full candidate runtime payload after the stable offline plugin",
      )
        .replaceAll("/opt/nemoclaw-managed-messaging-npm-cache", unsafeCacheEntry)
        .replaceAll("/usr/local/share/nemoclaw/wechat-npm-cache", unsafeCacheEntry)
        .replaceAll("/tmp/nemoclaw-wechat-npm-cache.XXXXXX", installCacheTemplate);
      const { calls, result } = runLoggedDockerShell(
        command,
        tmp,
        ['node() { printf "node %s\\n" "$*" >> "$call_log"; }'],
        {
          env: {
            NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ERROR: trusted messaging cache is unsafe phase=before-install",
      );
      expect(result.stderr).toContain(`path=${unsafeCacheEntry}`);
      expect(result.stderr).toContain("reason=not-root-owned-or-group-world-writable");
      expect(calls).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

it.each([
  { expectedPhase: "agent-install", union: "0" },
  { expectedPhase: "managed-image-capability-union", union: "1" },
])("selects only the $expectedPhase messaging install phase", ({ expectedPhase, union }) => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-phase-selection-"));
  const trustedCache = path.join(tmp, "trusted-cache");
  const installCacheTemplate = path.join(tmp, "install-cache.XXXXXX");

  try {
    fs.mkdirSync(trustedCache);
    fs.writeFileSync(path.join(trustedCache, "fixture"), "fixture\n");
    const command = dockerRunCommandBetween(
      dockerfile,
      "RUN --mount=from=openclaw-managed-messaging-npm-cache",
      "# Copy the full candidate runtime payload after the stable offline plugin",
    )
      .replaceAll("/opt/nemoclaw-managed-messaging-npm-cache", trustedCache)
      .replaceAll("/usr/local/share/nemoclaw/wechat-npm-cache", trustedCache)
      .replaceAll("/tmp/nemoclaw-wechat-npm-cache.XXXXXX", installCacheTemplate);
    const { calls, result } = runLoggedDockerShell(
      command,
      tmp,
      ["find() { :; }", 'node() { printf "node %s\\n" "$*" >> "$call_log"; }'],
      {
        env: {
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: union,
          OPENCLAW_VERSION: "2026.9.2",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(calls.trim().split("\n")).toEqual([
      `node /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase ${expectedPhase}`,
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
