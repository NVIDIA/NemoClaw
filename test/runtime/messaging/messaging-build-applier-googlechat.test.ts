// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

vi.mock("../../../scripts/lib/openclaw-npm-remediation.mts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../scripts/lib/openclaw-npm-remediation.mts")>();
  return {
    ...actual,
    remediateReviewedOpenClawPluginArchive: vi.fn(() => {
      throw new Error("Official npm installs must not remediate a discarded archive.");
    }),
  };
});

import {
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

import { BUILT_IN_CHANNEL_MANIFESTS } from "../../../src/lib/messaging/channels/built-ins";
import type { ChannelManifest } from "../../../src/lib/messaging/manifest/types";
const TEST_PATH = process.env.PATH || "/usr/bin:/bin";

function officialPluginFixture(channelId: string, version = "2026.9.1") {
  const manifest: ChannelManifest = BUILT_IN_CHANNEL_MANIFESTS.find(
    (entry) => entry.id === channelId,
  )!;
  const pkg = manifest.agentPackages!.find((entry) => entry.agent === "openclaw")!;
  const packageSpec = pkg.spec.replace("npm:", "").replace("{{openclaw.version}}", version);
  const pluginId = manifest.runtime!.openclaw!.channelName!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-googlechat-official-npm-"));
  const tracePath = path.join(tmp, "commands.trace");
  fs.writeFileSync(
    path.join(tmp, "npm"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const [command, packageSpec, fieldOrFlag, destination] = process.argv.slice(2);",
      'fs.appendFileSync(process.env.OPENCLAW_TRACE, `npm|${command}|${packageSpec}|${fieldOrFlag || ""}\\n`);',
      'if (command === "view" && fieldOrFlag === "dist.integrity") { process.stdout.write(`${process.env.OPENCLAW_PLUGIN_INTEGRITY}\\n`); process.exit(0); }',
      'if (command === "view" && fieldOrFlag === "dist.tarball") { process.stdout.write(`${process.env.OPENCLAW_PLUGIN_TARBALL}\\n`); process.exit(0); }',
      'if (command === "pack") { fs.appendFileSync(process.env.OPENCLAW_PACKED_DIRECTORIES, destination + "\\n"); const name = `${process.env.OPENCLAW_PLUGIN_ID}-${process.env.OPENCLAW_VERSION}.tgz`; fs.writeFileSync(path.join(destination, name), "reviewed googlechat archive"); process.stdout.write(JSON.stringify([{ filename: name, integrity: process.env.OPENCLAW_PLUGIN_INTEGRITY }]) + "\\n"); process.exit(0); }',
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const packedDirectories = path.join(tmp, "packed-directories");
  fs.writeFileSync(
    path.join(tmp, "openclaw"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'fs.appendFileSync(process.env.OPENCLAW_TRACE, `openclaw|${args.join("|")}|offline=${process.env.NPM_CONFIG_OFFLINE || ""}/${process.env.npm_config_offline || ""}\\n`);',
      'if (args[0] === "plugins" && args[1] === "install" && process.env.OPENCLAW_CACHE_MISS === "1") { if (process.env.NPM_CONFIG_OFFLINE !== "true" || process.env.npm_config_offline !== "true") fs.appendFileSync(process.env.OPENCLAW_TRACE, "registry-fallback\\n"); process.stdout.write(process.env.OPENCLAW_INSPECTION_CANARY || ""); process.stderr.write("npm error code ENOTCACHED\\nnpm error request to https://registry.npmjs.org/@openclaw%2fdiscord?token=" + process.env.OPENCLAW_INSPECTION_CANARY); process.exit(44); }',
      'if (args[0] === "plugins" && args[1] === "install") process.exit(args[4] === `npm:${process.env.OPENCLAW_PLUGIN_SPEC}` ? 0 : 41);',
      'if (args[1] === "inspect" && process.env.OPENCLAW_INSPECTION_HANG === "1") { setInterval(() => {}, 1000); return; }',
      'if (args[0] === "plugins" && args[1] === "inspect") { process.stderr.write(process.env.OPENCLAW_INSPECTION_CANARY || ""); process.stdout.write(JSON.stringify({ plugin: { id: process.env.OPENCLAW_PLUGIN_ID, trustedOfficialInstall: process.env.OPENCLAW_TRUSTED !== "false", diagnostic: process.env.OPENCLAW_INSPECTION_CANARY }, install: { ...(process.env.OPENCLAW_ARCHIVE_FIELD ? { [process.env.OPENCLAW_ARCHIVE_FIELD]: "retained-local-archive" } : {}), source: "npm", resolvedSpec: process.env.OPENCLAW_PLUGIN_SPEC, integrity: process.env.OPENCLAW_PLUGIN_INTEGRITY, installPath: process.env.OPENCLAW_PLUGIN_INSTALL_PATH } })); process.exit(0); }',
      "process.exit(42);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const plan = {
    schemaVersion: 1,
    sandboxName: "test-sandbox",
    agent: "openclaw",
    channels: [{ channelId, active: true }],
    credentialBindings: [],
    agentRender: [],
    buildSteps: [
      {
        channelId,
        kind: "package-install",
        outputId: "openclawPluginPackage",
        required: true,
        value: {
          manager: "openclaw-plugin",
          spec: pkg.spec,
          pin: true,
        },
      },
    ],
  };

  const env = {
    PATH: `${tmp}:${TEST_PATH}`,
    OPENCLAW_TRACE: tracePath,
    OPENCLAW_PACKED_DIRECTORIES: packedDirectories,
    OPENCLAW_PLUGIN_INTEGRITY: pkg.integrityByVersion![version]!,
    OPENCLAW_PLUGIN_ID: pluginId,
    OPENCLAW_PLUGIN_SPEC: packageSpec,
    OPENCLAW_PLUGIN_TARBALL: pkg.tarballUrlByVersion![version]!,
    OPENCLAW_VERSION: version,
    npm_config_offline: "false",
    NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
  };
  const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

  return { tmp, env, serializedPlan, tracePath, packedDirectories, packageSpec, pluginId };
}

function remainingPackedDirectories(file: string): string[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(fs.existsSync);
}

const CLI_ARGS = [
  path.resolve(
    import.meta.dirname,
    "../../../src/lib/messaging/applier/build/messaging-build-applier.mts",
  ),
  "--agent",
  "openclaw",
  "--phase",
  "agent-install",
];

it.each(["slack", "discord", "teams", "whatsapp", "googlechat"])(
  "installs %s with official npm provenance for the channel ingress API (#12284)",
  (channelId) => {
    const { tmp, env, serializedPlan, tracePath, packedDirectories, packageSpec, pluginId } =
      officialPluginFixture(channelId);
    try {
      expect(applyMessagingBuildPhase(serializedPlan, "agent-install", env)).toEqual([]);
      const trace = fs.readFileSync(tracePath, "utf-8");
      expect(trace).toContain(`npm|pack|${packageSpec}|--pack-destination`);
      expect(trace).toContain(
        `openclaw|plugins|install|--force|--accept-capabilities|npm:${packageSpec}|offline=true/true`,
      );
      expect(trace).toContain(`openclaw|plugins|inspect|${pluginId}|--json|offline=true/true`);
      expect(trace).not.toContain("npm-pack:");
      expect(() =>
        applyMessagingBuildPhase(serializedPlan, "agent-install", {
          ...env,
          OPENCLAW_TRUSTED: "false",
        }),
      ).toThrow("did not retain trusted exact registry provenance");
      expect(() =>
        applyMessagingBuildPhase(serializedPlan, "agent-install", {
          ...env,
          OPENCLAW_ARCHIVE_FIELD: "sourcePath",
        }),
      ).toThrow("did not retain trusted exact registry provenance");
      expect(() =>
        applyMessagingBuildPhase(serializedPlan, "agent-install", {
          ...env,
          OPENCLAW_ARCHIVE_FIELD: "artifactKind",
        }),
      ).toThrow("did not retain trusted exact registry provenance");
      const canary = "OPENAI_API_KEY=official-plugin-diagnostic-canary";
      const failedInspection = spawnSync(process.execPath, CLI_ARGS, {
        encoding: "utf8",
        env: { ...env, OPENCLAW_TRUSTED: "false", OPENCLAW_INSPECTION_CANARY: canary },
      });
      expect(failedInspection.status).toBe(2);
      expect(failedInspection.stderr).toContain(
        `Official OpenClaw plugin '${pluginId}' did not retain trusted exact registry provenance`,
      );
      expect(failedInspection.stderr).toContain(
        "Report this failure, the plugin name and your NemoClaw version",
      );
      expect(failedInspection.stdout + failedInspection.stderr).not.toContain(canary);
      const failedInstall = spawnSync(process.execPath, CLI_ARGS, {
        encoding: "utf8",
        env: { ...env, OPENCLAW_CACHE_MISS: "1", OPENCLAW_INSPECTION_CANARY: canary },
      });
      expect(failedInstall.status).toBe(2);
      expect(failedInstall.stderr).toContain('"exitCode":44');
      expect(failedInstall.stderr).toContain('"npmCodes":["ENOTCACHED"]');
      expect(failedInstall.stderr).toContain('"registryPaths":["/@openclaw%2fdiscord"]');
      expect(failedInstall.stdout + failedInstall.stderr).not.toContain(canary);
      expect(fs.readFileSync(tracePath, "utf8")).not.toContain("registry-fallback");
      expect(remainingPackedDirectories(packedDirectories)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

it("bounds a hung official-plugin inspection and removes its packed archive", () => {
  const { tmp, env, packedDirectories } = officialPluginFixture("slack");
  try {
    const timedOut = spawnSync(process.execPath, CLI_ARGS, {
      encoding: "utf8",
      timeout: 70_000,
      killSignal: "SIGKILL",
      env: { ...env, OPENCLAW_INSPECTION_HANG: "1" },
    });
    expect(timedOut.status).toBe(2);
    expect(timedOut.stderr).toContain("Official OpenClaw plugin 'slack' inspection timed out");
    expect(remainingPackedDirectories(packedDirectories)).toEqual([]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 75_000);

it("patches the installed official Slack bundle only after registry provenance is verified", async () => {
  const fixture = officialPluginFixture("slack", "2026.9.2");
  const installed = path.join(
    fixture.tmp,
    ".openclaw",
    "npm",
    "projects",
    "openclaw-slack-b25c10c1bd",
    "node_modules",
    "@openclaw",
    "slack",
  );
  const target = path.join(installed, "node_modules/@slack/bolt/node_modules/proxy-addr");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(installed, "package.json"),
    JSON.stringify({
      name: "@openclaw/slack",
      version: "2026.9.2",
      dependencies: { "@slack/bolt": "5.0.0" },
      bundledDependencies: ["@slack/bolt"],
    }),
  );
  const boltDirectory = path.join(installed, "node_modules/@slack/bolt");
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
  const metadata = {
    name: "proxy-addr",
    dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
    license: "MIT",
    engines: { node: ">= 0.10" },
  };
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ ...metadata, version: "2.0.7" }),
  );
  fs.writeFileSync(path.join(target, "index.js"), "vulnerable");
  const outside = path.join(fixture.tmp, "outside");
  fs.cpSync(installed, outside, { recursive: true });
  const env = {
    ...fixture.env,
    HOME: fixture.tmp,
    OPENCLAW_PLUGIN_INSTALL_PATH: installed,
    NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: path.resolve(
      import.meta.dirname,
      "../../fixtures/npm/proxy-addr-2.0.8",
    ),
  };

  try {
    expect(() =>
      applyMessagingBuildPhase(fixture.serializedPlan, "agent-install", {
        ...env,
        OPENCLAW_TRUSTED: "false",
      }),
    ).toThrow("did not retain trusted exact registry provenance");
    expect(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version).toBe(
      "2.0.7",
    );
    expect(fs.readFileSync(path.join(target, "index.js"), "utf8")).toBe("vulnerable");
    applyMessagingBuildPhase(fixture.serializedPlan, "agent-install", env);
    expect(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version).toBe(
      "2.0.8",
    );
    const expectedContent = spawnSync(
      "tar",
      [
        "-xOf",
        path.join(env.NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR, "proxy-addr-2.0.8.tgz"),
        "package/index.js",
      ],
      { encoding: "utf8" },
    );
    expect(expectedContent.status, expectedContent.stderr).toBe(0);
    expect(fs.readFileSync(path.join(target, "index.js"), "utf8")).toBe(expectedContent.stdout);
    expect(() =>
      applyMessagingBuildPhase(fixture.serializedPlan, "agent-install", {
        ...env,
        OPENCLAW_PLUGIN_INSTALL_PATH: outside,
      }),
    ).toThrow(
      "OpenClaw Slack remediation requires a valid managed npm package directory and reviewed dependency graph",
    );
    const alias = path.join(path.dirname(installed), "slack-alias");
    fs.symlinkSync(installed, alias, "dir");
    expect(() =>
      applyMessagingBuildPhase(fixture.serializedPlan, "agent-install", {
        ...env,
        OPENCLAW_PLUGIN_INSTALL_PATH: alias,
      }),
    ).toThrow(
      "OpenClaw Slack remediation requires a valid managed npm package directory and reviewed dependency graph",
    );
    expect(fs.readFileSync(path.join(target, "index.js"), "utf8")).toBe(expectedContent.stdout);
    const outsideDependency = path.join(
      outside,
      "node_modules/@slack/bolt/node_modules/proxy-addr",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(outsideDependency, "package.json"), "utf8")).version,
    ).toBe("2.0.7");
    expect(fs.readFileSync(path.join(outsideDependency, "index.js"), "utf8")).toBe("vulnerable");
  } finally {
    fs.rmSync(fixture.tmp, { force: true, recursive: true });
  }
});
