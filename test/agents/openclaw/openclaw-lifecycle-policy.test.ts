// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import policy from "../../../ci/reviewed-npm-lifecycle-allowlist.json";
import { reviewedOpenClawPluginIntegrityByPackageSpec } from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
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
  const scripts = [...block.matchAll(
    /^\s*([0-9]+(?:\.[0-9]+){2}(?:\|[0-9]+(?:\.[0-9]+){2})*)\)\s+(node [^;]+postinstall-bundled-plugins\.mjs)\s+;;/gm,
  )].flatMap((match) =>
    match[1].split("|").map((version) => ({
      packageSpec: "openclaw@" + version,
      explicitCommand: match[2],
    })),
  );
  const lockedRuntimeCommand =
    "node /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs";
  if (
    block.includes("npm --prefix /usr/local/lib/nemoclaw/openclaw-runtime ci") &&
    block.includes(lockedRuntimeCommand)
  ) {
    const manifest = JSON.parse(
      fs.readFileSync("agents/openclaw/openclaw-runtime/package.json", "utf8"),
    );
    scripts.push({
      packageSpec: "openclaw@" + manifest.dependencies.openclaw,
      explicitCommand: lockedRuntimeCommand,
    });
  }
  return scripts.sort((left, right) => left.packageSpec.localeCompare(right.packageSpec));
}

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const dockerfileBase = fs.readFileSync("Dockerfile.base", "utf8");
const messagingApplier = fs.readFileSync(
  "src/lib/messaging/applier/build/messaging-build-applier.mts",
  "utf8",
);

const codexBlock = between(
  dockerfile,
  "AS codex-acp-runtime",
  "AS wechat-npm-cache",
);
const runtimeBlock = dockerfile;
const baseBlock = dockerfileBase;
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

const codexMatch = dockerfile.match(
  /ADD --checksum=sha256:[0-9a-f]{64} https:\/\/registry\.npmjs\.org\/@zed-industries\/codex-acp\/-\/codex-acp-0\.11\.1\.tgz/,
);
const optionalPluginSpecs = [...optionalPluginBlock.matchAll(
    /"(@openclaw\/[^"\s]+@[0-9]+(?:\.[0-9]+){2})"\)\s+expected_integrity=/g,
  )].map((match) => match[1]).sort();

console.log(JSON.stringify({
  codexPackageSpec: codexMatch ? "@zed-industries/codex-acp@0.11.1" : null,
  runtimeCoreSpecs: corePackageSpecs(runtimeBlock),
  baseCoreSpecs: corePackageSpecs(baseBlock),
  optionalPluginSpecs,
  runtimeLifecycleScripts: explicitLifecycleScripts(runtimeBlock),
  baseLifecycleScripts: explicitLifecycleScripts(baseBlock),
  scriptsSuppressed: {
    codex: /npm install -g --offline --no-audit --no-fund --no-progress --ignore-scripts/.test(codexBlock),
    runtime: /npm install -g --no-audit --no-fund --no-progress --ignore-scripts --allow-git=root "\$OPENCLAW_PACK_PATH"/.test(runtimeBlock),
    base: /npm install -g --ignore-scripts --allow-git=root "\$OPENCLAW_PACK_PATH"/.test(baseBlock),
    optionalPlugin: /NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true\s+\\\s*openclaw plugins install --force --accept-capabilities "npm-pack:/.test(optionalPluginBlock) &&
      optionalPluginBlock.includes('openclaw plugins install --force --accept-capabilities "npm-pack:\${plugin_install_archive}"'),
    messagingPlugin: [
      '"--force",',
      '"--accept-capabilities",',
      '\`npm-pack:\${packed.archivePath}\`',
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
  it("selects the system npm owner only for native OpenClaw self-update", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-wrapper-"));
    const fakeNode = path.join(root, "node");
    const wrapper = path.join(root, "openclaw");
    const source = fs
      .readFileSync(path.join(REPO_ROOT, "scripts", "openclaw-cli-wrapper.sh"), "utf8")
      .replace("/usr/local/bin/node", fakeNode)
      .replace(
        "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
        "/reviewed/openclaw/openclaw.mjs",
      );
    fs.writeFileSync(
      fakeNode,
      [
        "#!/bin/sh",
        'printf "upper=%s\\nlower=%s\\n" "${NPM_CONFIG_PREFIX-}" "${npm_config_prefix-}"',
        'printf "arg=%s\\n" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(wrapper, source, { mode: 0o755 });

    try {
      const update = spawnSync(wrapper, ["update", "--dry-run"], {
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_CONFIG_PREFIX: "/sandbox/.local",
          npm_config_prefix: "/hostile/lowercase",
        },
      });
      expect(update.status, update.stderr).toBe(0);
      expect(update.stdout).toContain("upper=/usr/local\nlower=\n");
      expect(update.stdout).toContain("arg=/reviewed/openclaw/openclaw.mjs\n");
      expect(update.stdout).toContain("arg=update\narg=--dry-run\n");

      const list = spawnSync(wrapper, ["agents", "list"], {
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_PREFIX: "/sandbox/.local" },
      });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toContain("upper=/sandbox/.local\n");
      expect(list.stdout).toContain("arg=agents\narg=list\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- Every executable archive install must match the reviewed fail-closed lifecycle allowlist
  it("cross-checks the allowlist against every production archive install boundary", () => {
    expect(policy).toMatchObject({ schemaVersion: 1, defaultPolicy: "deny" });
    expect(policy.allowedLifecycleScripts).not.toHaveLength(0);
    expect(
      policy.allowedLifecycleScripts.every(
        ({ event, manifestCommand }) =>
          event === "postinstall" &&
          manifestCommand === "node scripts/postinstall-bundled-plugins.mjs",
      ),
    ).toBe(true);

    const messagingPackageSpecs = Object.keys(
      reviewedOpenClawPluginIntegrityByPackageSpec({
        OPENCLAW_VERSION: "2026.9.1",
      }),
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
      .map(({ packageSpec, explicitCommand }) => ({
        packageSpec,
        explicitCommand,
      }))
      .sort((left, right) => left.packageSpec.localeCompare(right.packageSpec));
    expect(audit.runtimeLifecycleScripts).toEqual(audit.baseLifecycleScripts);
    expect(audit.runtimeLifecycleScripts).toEqual(allowedLifecycleScripts);
    expect(audit.legacyCoreRunsNoLifecycle).toBe(true);
    expect(audit.unknownCoreVersionFailsClosed).toBe(true);
  });
});
