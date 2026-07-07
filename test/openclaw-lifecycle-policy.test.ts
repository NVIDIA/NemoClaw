// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import policy from "../ci/reviewed-npm-lifecycle-allowlist.json";
import { reviewedOpenClawPluginIntegrityByPackageSpec } from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const PRODUCTION_BOUNDARY_AUDIT = String.raw`
const fs = require("node:fs");
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

function corePackageSpecs(block) {
  return [...block.matchAll(
    /if \[ "\$OPENCLAW_VERSION" = "([0-9]+(?:\.[0-9]+){2})" \]; then EXPECTED_INTEGRITY=/g,
  )].map((match) => "openclaw@" + match[1]).sort();
}

function explicitLifecycleScripts(block) {
  return [...block.matchAll(
    /^\s*([0-9]+(?:\.[0-9]+){2}(?:\|[0-9]+(?:\.[0-9]+){2})*)\)\s+(node [^;]+postinstall-bundled-plugins\.mjs)\s+;;/gm,
  )].flatMap((match) =>
    match[1].split("|").map((version) => ({
      packageSpec: "openclaw@" + version,
      explicitCommand: match[2],
    })),
  ).sort((left, right) => left.packageSpec.localeCompare(right.packageSpec));
}

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const dockerfileBase = fs.readFileSync("Dockerfile.base", "utf8");
const messagingApplier = fs.readFileSync(
  "src/lib/messaging/applier/build/messaging-build-applier.mts",
  "utf8",
);

const codexBlock = between(
  dockerfile,
  "# Pre-install the codex-acp package",
  "# Upgrade OpenClaw if the base image is stale.",
);
const runtimeBlock = between(
  dockerfile,
  "# Upgrade OpenClaw if the base image is stale.",
  "# Patch OpenClaw media fetch for proxy-only sandbox",
);
const baseBlock = between(
  dockerfileBase,
  "# Install OpenClaw CLI + PyYAML.",
  "# Baseline health check.",
);
const optionalPluginBlock = between(
  dockerfile,
  "# Install non-messaging OpenClaw plugins that need to match the runtime.",
  "# Lock down npm for the next RUN",
);
const messagingInstallBlock = between(
  messagingApplier,
  "export function installOpenClawMessagingPlugins",
  "export function runOpenClawMessagingDoctor",
);

const codexMatch = codexBlock.match(/CODEX_ACP_SPEC='([^']+)'/);
const optionalPluginSpecs = [...optionalPluginBlock.matchAll(
    /"(@openclaw\/[^"\s]+@[0-9]+(?:\.[0-9]+){2})"\)\s+expected_integrity=/g,
  )].map((match) => match[1]).sort();

console.log(JSON.stringify({
  codexPackageSpec: codexMatch?.[1] ?? null,
  runtimeCoreSpecs: corePackageSpecs(runtimeBlock),
  baseCoreSpecs: corePackageSpecs(baseBlock),
  optionalPluginSpecs,
  runtimeLifecycleScripts: explicitLifecycleScripts(runtimeBlock),
  baseLifecycleScripts: explicitLifecycleScripts(baseBlock),
  scriptsSuppressed: {
    codex: /npm install -g --no-audit --no-fund --no-progress --ignore-scripts\s+\\\s*"\$CODEX_ACP_PACK_PATH"/.test(codexBlock),
    runtime: /npm install -g --no-audit --no-fund --no-progress --ignore-scripts "\$OPENCLAW_PACK_PATH"/.test(runtimeBlock),
    base: /npm install -g --ignore-scripts "\$OPENCLAW_PACK_PATH"/.test(baseBlock),
    optionalPlugin: /NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true\s+\\\s*openclaw plugins install "\$plugin_archive" --pin/.test(optionalPluginBlock),
    messagingPlugin: [
      '["openclaw", "plugins", "install", packed.archivePath',
      'NPM_CONFIG_IGNORE_SCRIPTS: "true"',
      'npm_config_ignore_scripts: "true"',
    ].every((marker) => messagingInstallBlock.includes(marker)),
  },
  legacyCoreRunsNoLifecycle: [runtimeBlock, baseBlock].every((block) =>
    /^\s*2026\.3\.11\)\s+;;/m.test(block),
  ),
  unknownCoreVersionFailsClosed: [runtimeBlock, baseBlock].every((block) =>
    /^\s*\*\).*no reviewed lifecycle policy.*exit 1/m.test(block),
  ),
}));
`;

describe("reviewed npm lifecycle policy", () => {
  it("keeps the exact archive and explicit-script allowlist", () => {
    expect(policy).toEqual({
      schemaVersion: 1,
      defaultPolicy: "deny",
      reviewedArchivePackages: [
        "@openclaw/brave-plugin@2026.6.10",
        "@openclaw/diagnostics-otel@2026.6.10",
        "@openclaw/discord@2026.6.10",
        "@openclaw/msteams@2026.6.10",
        "@openclaw/slack@2026.6.10",
        "@openclaw/whatsapp@2026.6.10",
        "@tencent-weixin/openclaw-weixin@2.4.3",
        "@zed-industries/codex-acp@0.11.1",
        "openclaw@2026.3.11",
        "openclaw@2026.4.24",
        "openclaw@2026.6.10",
      ],
      allowedLifecycleScripts: [
        {
          packageSpec: "openclaw@2026.4.24",
          event: "postinstall",
          manifestCommand: "node scripts/postinstall-bundled-plugins.mjs",
          explicitCommand:
            "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
        },
        {
          packageSpec: "openclaw@2026.6.10",
          event: "postinstall",
          manifestCommand: "node scripts/postinstall-bundled-plugins.mjs",
          explicitCommand:
            "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
        },
      ],
    });
  });

  it("cross-checks the allowlist against every production archive install boundary", () => {
    const messagingPackageSpecs = Object.keys(
      reviewedOpenClawPluginIntegrityByPackageSpec({ OPENCLAW_VERSION: "2026.6.10" }),
    );
    const result = spawnSync(process.execPath, ["-e", PRODUCTION_BOUNDARY_AUDIT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const audit = JSON.parse(result.stdout);
    expect(audit.runtimeCoreSpecs).toEqual(audit.baseCoreSpecs);
    expect(
      [
        audit.codexPackageSpec,
        ...audit.runtimeCoreSpecs,
        ...audit.optionalPluginSpecs,
        ...messagingPackageSpecs,
      ].sort(),
    ).toEqual([...policy.reviewedArchivePackages].sort());
    expect(audit.scriptsSuppressed).toEqual({
      codex: true,
      runtime: true,
      base: true,
      optionalPlugin: true,
      messagingPlugin: true,
    });
    const allowedLifecycleScripts = policy.allowedLifecycleScripts
      .map(({ packageSpec, explicitCommand }) => ({ packageSpec, explicitCommand }))
      .sort((left, right) => left.packageSpec.localeCompare(right.packageSpec));
    expect(audit.runtimeLifecycleScripts).toEqual(audit.baseLifecycleScripts);
    expect(audit.runtimeLifecycleScripts).toEqual(allowedLifecycleScripts);
    expect(audit.legacyCoreRunsNoLifecycle).toBe(true);
    expect(audit.unknownCoreVersionFailsClosed).toBe(true);
  });
});
