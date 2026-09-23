// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

import { BUILT_IN_CHANNEL_MANIFESTS } from "../../../src/lib/messaging/channels/built-ins";
import type { ChannelManifest } from "../../../src/lib/messaging/manifest/types";
const TEST_PATH = process.env.PATH || "/usr/bin:/bin";

it.each(["slack", "discord", "teams", "whatsapp", "googlechat"])(
  "installs %s with official npm provenance for the channel ingress API (#12284)",
  (channelId) => {
    const manifest: ChannelManifest = BUILT_IN_CHANNEL_MANIFESTS.find(
      (entry) => entry.id === channelId,
    )!;
    const pkg = manifest.agentPackages!.find((entry) => entry.agent === "openclaw")!;
    const packageSpec = pkg.spec.replace("npm:", "").replace("{{openclaw.version}}", "2026.9.1");
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
        'if (command === "pack") { const name = `${process.env.OPENCLAW_PLUGIN_ID}-2026.9.1.tgz`; fs.writeFileSync(path.join(destination, name), "reviewed googlechat archive"); process.stdout.write(JSON.stringify([{ filename: name, integrity: process.env.OPENCLAW_PLUGIN_INTEGRITY }]) + "\\n"); process.exit(0); }',
        "process.exit(1);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "openclaw"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, `openclaw|${args.join("|")}|offline=${process.env.NPM_CONFIG_OFFLINE || ""}/${process.env.npm_config_offline || ""}\\n`);',
        'if (args[0] === "plugins" && args[1] === "install" && process.env.OPENCLAW_CACHE_MISS === "1") { if (process.env.NPM_CONFIG_OFFLINE !== "true" || process.env.npm_config_offline !== "true") fs.appendFileSync(process.env.OPENCLAW_TRACE, "registry-fallback\\n"); process.exit(44); }',
        'if (args[0] === "plugins" && args[1] === "install") process.exit(args[4] === `npm:${process.env.OPENCLAW_PLUGIN_SPEC}` ? 0 : 41);',
        'if (args[0] === "plugins" && args[1] === "inspect") { process.stderr.write(process.env.OPENCLAW_INSPECTION_CANARY || ""); process.stdout.write(JSON.stringify({ plugin: { id: process.env.OPENCLAW_PLUGIN_ID, trustedOfficialInstall: process.env.OPENCLAW_TRUSTED !== "false", diagnostic: process.env.OPENCLAW_INSPECTION_CANARY }, install: { source: "npm", resolvedSpec: process.env.OPENCLAW_PLUGIN_SPEC, integrity: process.env.OPENCLAW_PLUGIN_INTEGRITY } })); process.exit(0); }',
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

    try {
      const env = {
        PATH: `${tmp}:${TEST_PATH}`,
        OPENCLAW_TRACE: tracePath,
        OPENCLAW_PLUGIN_INTEGRITY: pkg.integrityByVersion!["2026.9.1"]!,
        OPENCLAW_PLUGIN_ID: pluginId,
        OPENCLAW_PLUGIN_SPEC: packageSpec,
        OPENCLAW_PLUGIN_TARBALL: pkg.tarballUrlByVersion!["2026.9.1"]!,
        OPENCLAW_VERSION: "2026.9.1",
        npm_config_offline: "false",
        NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      };
      const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

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
      const canary = "OPENAI_API_KEY=official-plugin-diagnostic-canary";
      const failedInspection = spawnSync(
        process.execPath,
        [
          path.resolve(
            import.meta.dirname,
            "../../../src/lib/messaging/applier/build/messaging-build-applier.mts",
          ),
          "--agent",
          "openclaw",
          "--phase",
          "agent-install",
        ],
        {
          encoding: "utf8",
          env: { ...env, OPENCLAW_TRUSTED: "false", OPENCLAW_INSPECTION_CANARY: canary },
        },
      );
      expect(failedInspection.status).toBe(2);
      expect(failedInspection.stderr).toContain(
        `Official OpenClaw plugin '${pluginId}' did not retain trusted exact registry provenance`,
      );
      expect(failedInspection.stderr).toContain("reviewed npm cache, then rebuild");
      expect(failedInspection.stdout + failedInspection.stderr).not.toContain(canary);
      expect(() =>
        applyMessagingBuildPhase(serializedPlan, "agent-install", {
          ...env,
          OPENCLAW_CACHE_MISS: "1",
        }),
      ).toThrow();
      expect(fs.readFileSync(tracePath, "utf8")).not.toContain("registry-fallback");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);
