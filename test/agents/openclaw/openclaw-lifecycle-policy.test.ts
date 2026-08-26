// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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
const candidateRuntimeBlock = between(
  dockerfile,
  "FROM scratch AS openclaw-runtime-payload",
  "# Stage 3: Runtime image",
);
const finalImage = dockerfile.slice(dockerfile.indexOf("FROM \${BASE_IMAGE}"));
const optionalPluginInstallIndex = finalImage.indexOf(
  "RUN --network=none --mount=from=openclaw-optional-plugin-archives",
);
const messagingPluginInstallIndex = finalImage.indexOf(
  "RUN --mount=from=openclaw-managed-messaging-npm-cache",
);
const candidateRuntimeCopyIndex = finalImage.indexOf(
  "COPY --from=openclaw-runtime-payload / /",
);
const localPluginInstallIndex = finalImage.indexOf("openclaw plugins install /opt/nemoclaw");
const runtimeAssertionIndex = finalImage.indexOf(
  "managed-startup-image-runtime.cjs || managed_runtime_assertion_failed regular-file",
);
const configInputCopyIndex = finalImage.indexOf(
  "COPY scripts/generate-openclaw-config.mts /scripts/generate-openclaw-config.mts",
);
const integrationPluginCopyIndex = finalImage.indexOf(
  "COPY nemoclaw-blueprint/openclaw-plugins/ /usr/local/share/nemoclaw/openclaw-plugins/",
);
const messagingInputCopyIndex = finalImage.indexOf(
  "COPY src/lib/messaging/ /src/lib/messaging/",
);
const messagingInputCopyCount = finalImage.split(
  "COPY src/lib/messaging/ /src/lib/messaging/",
).length - 1;

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
    runtime: /npm install -g --no-audit --no-fund --no-progress --ignore-scripts "\$OPENCLAW_PACK_PATH"/.test(runtimeBlock),
    base: /npm install -g --ignore-scripts "\$OPENCLAW_PACK_PATH"/.test(baseBlock),
    optionalPlugin: /NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true\s+\\\s*openclaw plugins install "npm-pack:/.test(optionalPluginBlock) &&
      optionalPluginBlock.includes('openclaw plugins install "npm-pack:\${plugin_install_archive}"'),
    messagingPlugin: [
      '["openclaw", "plugins", "install", \`npm-pack:\${packed.archivePath}\`]',
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
  runtimeCacheBoundary: {
    configInputsBeforeOptional:
      configInputCopyIndex >= 0 &&
      integrationPluginCopyIndex >= 0 &&
      configInputCopyIndex < optionalPluginInstallIndex &&
      integrationPluginCopyIndex < optionalPluginInstallIndex,
    messagingInputsAfterOptional:
      optionalPluginInstallIndex >= 0 &&
      messagingInputCopyIndex > optionalPluginInstallIndex &&
      messagingInputCopyIndex < messagingPluginInstallIndex,
    candidateRuntimeExcludesMessaging:
      candidateRuntimeBlock.length > 0 &&
      !candidateRuntimeBlock.includes("COPY src/lib/messaging/ /src/lib/messaging/"),
    singleFinalMessagingInputCopy: messagingInputCopyCount === 1,
    optionalBeforeMessaging:
      optionalPluginInstallIndex >= 0 &&
      optionalPluginInstallIndex < messagingPluginInstallIndex,
    messagingBeforeCandidateRuntime:
      messagingPluginInstallIndex >= 0 &&
      messagingPluginInstallIndex < candidateRuntimeCopyIndex,
    candidateRuntimeBeforeLocalPlugin:
      candidateRuntimeCopyIndex >= 0 && candidateRuntimeCopyIndex < localPluginInstallIndex,
    candidateRuntimeAsserted:
      runtimeAssertionIndex > candidateRuntimeCopyIndex &&
      runtimeAssertionIndex < localPluginInstallIndex,
  },
}));
`;

describe("reviewed npm lifecycle policy", () => {
  // source-shape-contract: security -- Every executable archive install must match the reviewed fail-closed lifecycle allowlist, and the exact candidate runtime must replace stable install inputs before local registration.
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
      reviewedOpenClawPluginIntegrityByPackageSpec({ OPENCLAW_VERSION: "2026.7.1" }),
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
    expect(audit.runtimeCacheBoundary).toEqual({
      configInputsBeforeOptional: true,
      messagingInputsAfterOptional: true,
      candidateRuntimeExcludesMessaging: true,
      singleFinalMessagingInputCopy: true,
      optionalBeforeMessaging: true,
      messagingBeforeCandidateRuntime: true,
      candidateRuntimeBeforeLocalPlugin: true,
      candidateRuntimeAsserted: true,
    });
  });
});
