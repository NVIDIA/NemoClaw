// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

const OPENCLAW_GOOGLECHAT_2026_9_1_INTEGRITY =
  "sha512-Q5VTAJpfcrI7BSEw5Ugq3wf7JEg5QhTBwpi+BByGbfZsTTVjwZc7OIvNbKsVTh16I5/EWqHEnD+0WNeHqsteqw==";
const TEST_PATH = process.env.PATH || "/usr/bin:/bin";

it("installs Google Chat through exact official npm provenance for the 2026.9.1 ingress API", () => {
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
      'if (command === "view" && fieldOrFlag === "dist.integrity") { process.stdout.write(`${process.env.OPENCLAW_GOOGLECHAT_INTEGRITY}\\n`); process.exit(0); }',
      'if (command === "view" && fieldOrFlag === "dist.tarball") { process.stdout.write("https://registry.npmjs.org/@openclaw/googlechat/-/googlechat-2026.9.1.tgz\\n"); process.exit(0); }',
      'if (command === "pack") { const name = "googlechat-2026.9.1.tgz"; fs.writeFileSync(path.join(destination, name), "reviewed googlechat archive"); process.stdout.write(JSON.stringify([{ filename: name, integrity: process.env.OPENCLAW_GOOGLECHAT_INTEGRITY }]) + "\\n"); process.exit(0); }',
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
      'fs.appendFileSync(process.env.OPENCLAW_TRACE, `openclaw|${args.join("|")}|prefer-offline=${process.env.NPM_CONFIG_PREFER_OFFLINE || ""}\\n`);',
      'if (args[0] === "plugins" && args[1] === "install") process.exit(args[4] === "npm:@openclaw/googlechat@2026.9.1" ? 0 : 41);',
      'if (args[0] === "plugins" && args[1] === "inspect") { process.stdout.write(JSON.stringify({ plugin: { id: "googlechat", trustedOfficialInstall: true }, install: { source: "npm", resolvedSpec: "@openclaw/googlechat@2026.9.1", integrity: process.env.OPENCLAW_GOOGLECHAT_INTEGRITY } })); process.exit(0); }',
      "process.exit(42);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const plan = {
    schemaVersion: 1,
    sandboxName: "test-sandbox",
    agent: "openclaw",
    channels: [{ channelId: "googlechat", active: true }],
    credentialBindings: [],
    agentRender: [],
    buildSteps: [
      {
        channelId: "googlechat",
        kind: "package-install",
        outputId: "openclawPluginPackage",
        required: true,
        value: {
          manager: "openclaw-plugin",
          spec: "npm:@openclaw/googlechat@{{openclaw.version}}",
          pin: true,
        },
      },
    ],
  };

  try {
    const env = {
      PATH: `${tmp}:${TEST_PATH}`,
      OPENCLAW_TRACE: tracePath,
      OPENCLAW_GOOGLECHAT_INTEGRITY: OPENCLAW_GOOGLECHAT_2026_9_1_INTEGRITY,
      OPENCLAW_VERSION: "2026.9.1",
      NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
    };
    const serializedPlan = readMessagingBuildPlanFromEnv(env, "openclaw");

    expect(applyMessagingBuildPhase(serializedPlan, "agent-install", env)).toEqual([]);
    const trace = fs.readFileSync(tracePath, "utf-8");
    expect(trace).toContain("npm|pack|@openclaw/googlechat@2026.9.1|--pack-destination");
    expect(trace).toContain(
      "openclaw|plugins|install|--force|--accept-capabilities|npm:@openclaw/googlechat@2026.9.1|prefer-offline=true",
    );
    expect(trace).toContain("openclaw|plugins|inspect|googlechat|--json|prefer-offline=true");
    expect(trace).not.toContain("npm-pack:");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
