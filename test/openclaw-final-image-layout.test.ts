// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectManagedBootstrapNativeImageContract } from "./support/managed-bootstrap-image-contract";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

function indexOfRequired(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function hasBuildKitRunMount(dockerfile: string): boolean {
  return dockerfile
    .replace(/\\\r?\n[ \t]*/gu, " ")
    .split(/\r?\n/u)
    .some((instruction) => {
      const runOptionPrefix = instruction.match(/^\s*RUN((?:\s+--\S+)*)/iu)?.[1] ?? "";
      return /(?:^|\s)--mount(?:=|$)/iu.test(runOptionPrefix);
    });
}

describe("OpenClaw final image layout", () => {
  it.each([
    ["same-line", "RUN --network=none --mount=type=cache,target=/tmp true", true],
    ["line-continuation", "RUN --security=sandbox \\\n  --mount=type=secret,id=token true", true],
    ["shell-command argument", "RUN printf '%s' --mount=type=cache", false],
  ] as const)("recognizes BuildKit mounts only in the RUN option prefix for %s form (#7611)", (_form, dockerfile, expected) => {
    expect(hasBuildKitRunMount(dockerfile)).toBe(expected);
  });

  // source-shape-contract: compatibility -- Legacy-compatible grouped payload copies preserve cold-onboard export work while retaining intentional cache and scan boundaries
  it("uses grouped legacy-compatible payload layers at their cache boundaries (#7611)", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const stages = dockerfile.split(/(?=^FROM )/mu).filter((stage) => stage.startsWith("FROM "));
    const finalStageIndex = stages.findIndex((stage) => stage.startsWith("FROM ${BASE_IMAGE}"));
    const finalStage = stages[finalStageIndex] ?? "";
    const entrypoint = fs.readFileSync(path.join(ROOT, "scripts", "nemoclaw-start.sh"), "utf-8");
    const payloads = [
      {
        stage: "openclaw-dependency-payload",
        copies: [
          "COPY agents/openclaw/openclaw-runtime/package.json /usr/local/lib/nemoclaw/openclaw-runtime/package.json",
          "COPY agents/openclaw/openclaw-runtime/package-lock.json /usr/local/lib/nemoclaw/openclaw-runtime/package-lock.json",
          "COPY agents/openclaw/mcporter-runtime/package.json /usr/local/lib/nemoclaw/mcporter-runtime/package.json",
          "COPY agents/openclaw/mcporter-runtime/package-lock.json /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json",
          "COPY agents/openclaw/wechat-runtime/package.json /usr/local/lib/nemoclaw/wechat-runtime/package.json",
          "COPY agents/openclaw/wechat-runtime/package-lock.json /usr/local/lib/nemoclaw/wechat-runtime/package-lock.json",
          "COPY ci/npm-audit-exceptions.json /scripts/npm-audit-exceptions.json",
          "COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts",
          "COPY scripts/lib/reviewed-npm-audit.mts /scripts/lib/reviewed-npm-audit.mts",
          "COPY scripts/lib/openclaw-npm-remediation.mts /scripts/lib/openclaw-npm-remediation.mts",
          "COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts",
          "COPY scripts/lib/patch-bundled-npm-ip-address.mts /scripts/lib/patch-bundled-npm-ip-address.mts",
          "COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts",
        ],
      },
      {
        stage: "openclaw-plugin-payload",
        copies: [
          "COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/",
          "COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/",
          "COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/",
        ],
      },
      {
        stage: "openclaw-patch-payload",
        copies: [
          "COPY scripts/patch-openclaw-tool-catalog.mts /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts",
          "COPY scripts/patch-openclaw-chat-send.mts /usr/local/lib/nemoclaw/patch-openclaw-chat-send.mts",
          "COPY scripts/patch-openclaw-mcp-npx.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-npx.mts",
          "COPY scripts/patch-openclaw-mcp-reliability.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts",
          "COPY scripts/patch-openclaw-mcp-tools-list-timeout.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts",
          "COPY scripts/patch-openclaw-issue-4434-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts",
          "COPY scripts/patch-openclaw-managed-transport-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-managed-transport-diagnostics.mts",
          "COPY scripts/patch-openclaw-device-self-approval.mts /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts",
          "COPY scripts/extract-semver.sh /usr/local/lib/nemoclaw/extract-semver",
          "COPY scripts/patch-openclaw-shared-state-permissions.mts /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts",
          "COPY scripts/verify-wechat-runtime-lock.mts /usr/local/lib/nemoclaw/verify-wechat-runtime-lock.mts",
        ],
      },
      {
        stage: "openclaw-runtime-payload",
        copies: [
          "COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh",
          "COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh",
          "COPY scripts/lib/gateway-supervisor.sh /usr/local/lib/nemoclaw/gateway-supervisor.sh",
          "COPY scripts/lib/sandbox-rlimits.sh /usr/local/lib/nemoclaw/sandbox-rlimits.sh",
          "COPY scripts/lib/openclaw_device_approval_policy.py /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py",
          "COPY scripts/lib/clean_runtime_shell_env_shim.py /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py",
          "COPY scripts/lib/normalize_mutable_config_perms.py /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py",
          "COPY scripts/state-dir-guard.py /usr/local/lib/nemoclaw/state-dir-guard.py",
          "COPY agents/openclaw/state-lock-plan.json /usr/local/share/nemoclaw/state-lock-plan.json",
          "COPY scripts/openclaw-config-guard.py /usr/local/lib/nemoclaw/openclaw-config-guard.py",
          "COPY scripts/managed-gateway-control.py /usr/local/lib/nemoclaw/managed-gateway-control.py",
          "COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start",
          "COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold",
          "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap",
          "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
          "COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control",
          "COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/",
          "COPY --from=runtime-preload-builder /opt/nemoclaw-root/dist/lib/messaging/channels/ /usr/local/lib/nemoclaw/preloads-compiled-channels/",
          "COPY scripts/codex-acp-wrapper.sh /usr/local/bin/nemoclaw-codex-acp",
          "COPY scripts/generate-openclaw-config.mts /scripts/generate-openclaw-config.mts",
          "COPY scripts/validate-openclaw-tool-search.mts /scripts/validate-openclaw-tool-search.mts",
          "COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
          "COPY src/lib/tool-disclosure.ts /src/lib/tool-disclosure.ts",
          "COPY src/lib/messaging/ /src/lib/messaging/",
          "COPY nemoclaw-blueprint/openclaw-plugins/ /usr/local/share/nemoclaw/openclaw-plugins/",
          "COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/",
        ],
      },
    ] as const;
    const dependencyCopy = "COPY --from=openclaw-dependency-payload / /";
    const pluginCopy = "COPY --from=openclaw-plugin-payload / /";
    const patchCopy = "COPY --from=openclaw-patch-payload / /";
    const runtimeCopy = "COPY --from=openclaw-runtime-payload / /";
    const scanCopy =
      "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts";

    expect(finalStageIndex).toBe(stages.length - 1);
    expect(hasBuildKitRunMount(dockerfile)).toBe(false);
    expectManagedBootstrapNativeImageContract(dockerfile);
    expect(finalStage).not.toMatch(/^\s*ENV\b[^\n]*(?:\\\n[^\n]*)*NODE_OPTIONS=/mu);
    expect(finalStage).toContain("RUN NODE_OPTIONS=--dns-result-order=ipv4first \\");
    expect(entrypoint).toContain('export NODE_OPTIONS="--dns-result-order=ipv4first"');
    expect(
      indexOfRequired(entrypoint, 'export NODE_OPTIONS="--dns-result-order=ipv4first"'),
    ).toBeLessThan(indexOfRequired(entrypoint, "# managed-entrypoint-env-wrapper begin"));
    for (const payload of payloads) {
      const stage = stages.find((entry) => entry.startsWith(`FROM scratch AS ${payload.stage}`));
      expect(stage?.match(/^COPY\b.*$/gmu)).toEqual(payload.copies);
      expect(finalStage).toContain(`COPY --from=${payload.stage} / /`);
    }
    expect(finalStage.match(/^COPY\b.*$/gmu)).toEqual([
      "COPY --from=builder /usr/local/bin/node /usr/local/bin/node",
      dependencyCopy,
      "COPY nemoclaw/package.json nemoclaw/package-lock.json /opt/nemoclaw/",
      "COPY tools/mcp-tool-discovery-runtime/npm-ci-locked.sh /usr/local/lib/nemoclaw-build-tools/npm-ci-locked.sh",
      pluginCopy,
      patchCopy,
      runtimeCopy,
      scanCopy,
    ]);
    for (const metadataContract of [
      "/scripts/patch-bundled-npm-brace-expansion.mts 'root:root:755'",
      "/scripts/lib/patch-bundled-npm-ip-address.mts 'root:root:755'",
      "/scripts/patch-bundled-npm-tar.mts 'root:root:755'",
      "/opt/nemoclaw/openclaw.plugin.json 'root:root:644'",
      "/usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts 'root:root:755'",
      "/usr/local/bin/nemoclaw-managed-bootstrap 'root:root:755'",
      "/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh 'root:root:444'",
      "/usr/local/bin/nemoclaw-gateway-control 'root:root:700'",
      "/usr/local/lib/nemoclaw/state-dir-guard.py 'root:root:500'",
      "/usr/local/share/nemoclaw/state-lock-plan.json 'root:root:444'",
      "/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js 'root:root:644'",
      "/scripts/checks/node-tar-image-scan.mts 'root:root:755'",
    ]) {
      expect(finalStage).toContain(`check_metadata ${metadataContract}`);
    }

    const dependency = indexOfRequired(finalStage, dependencyCopy);
    const plugin = indexOfRequired(finalStage, pluginCopy);
    const patch = indexOfRequired(finalStage, patchCopy);
    const runtime = indexOfRequired(finalStage, runtimeCopy);
    const scan = indexOfRequired(finalStage, scanCopy);
    const tarPatch = indexOfRequired(
      finalStage,
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
    );
    const braceExpansionPatch = indexOfRequired(
      finalStage,
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts",
    );
    const ipAddressPatch = indexOfRequired(
      finalStage,
      "node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts",
    );
    const pluginInstall = indexOfRequired(
      finalStage,
      "RUN NODE_OPTIONS=--dns-result-order=ipv4first \\",
    );
    const managedMessagingUnionInstall = indexOfRequired(
      finalStage,
      "--agent openclaw --phase managed-image-capability-union",
    );
    const messagingPostInstall = indexOfRequired(
      finalStage,
      "--agent openclaw --phase post-agent-install",
    );
    const neutralConfigRegeneration = indexOfRequired(
      finalStage,
      "# A managed image is a neutral capability carrier",
    );
    const pluginChmod = indexOfRequired(
      finalStage,
      "RUN chmod -R a+rX /opt/nemoclaw /opt/nemoclaw-blueprint/",
    );
    const wechatInstall = indexOfRequired(
      finalStage,
      "RUN npm ci --prefix /usr/local/lib/nemoclaw/wechat-runtime",
    );
    const patchChmod = indexOfRequired(
      finalStage,
      "RUN chmod 755 /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts",
    );
    const blueprintSetup = indexOfRequired(
      finalStage,
      "RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0",
    );
    const managedRuntimeDirectory = indexOfRequired(
      finalStage,
      "&& install -d -o root -g root -m 0755 /run/nemoclaw",
    );
    const runtimeChmod = indexOfRequired(finalStage, "RUN chmod 755 /usr/local/bin/nemoclaw-start");
    const metadataCheck = indexOfRequired(finalStage, "RUN check_metadata()");

    expect(dependency).toBeLessThan(tarPatch);
    expect(tarPatch).toBeLessThan(braceExpansionPatch);
    expect(braceExpansionPatch).toBeLessThan(ipAddressPatch);
    expect(plugin).toBeGreaterThan(pluginInstall);
    expect(plugin).toBeLessThan(pluginChmod);
    expect(managedMessagingUnionInstall).toBeLessThan(messagingPostInstall);
    expect(messagingPostInstall).toBeLessThan(neutralConfigRegeneration);
    expect(finalStage.slice(neutralConfigRegeneration)).toContain(
      "openclaw config validate --json",
    );
    expect(finalStage).toContain("packageManifest.openclaw?.channel?.id");
    expect(finalStage).toContain("if (!fs.existsSync(packagePath)) return []");
    expect(finalStage).toContain('channelId === "imessage"');
    expect(finalStage).toContain("bundled OpenClaw channel is not neutral");
    expect(patch).toBeGreaterThan(wechatInstall);
    expect(patch).toBeLessThan(patchChmod);
    expect(runtime).toBeGreaterThan(blueprintSetup);
    expect(runtime).toBeLessThan(managedRuntimeDirectory);
    expect(managedRuntimeDirectory).toBeLessThan(runtimeChmod);
    expect(finalStage).toContain("/usr/local/bin/nemoclaw-managed-bootstrap");
    expect(dockerfile).toContain(
      "COPY src/lib/onboard/managed-bootstrap/ ./src/lib/onboard/managed-bootstrap/",
    );
    expect(dockerfile).toContain("src/lib/onboard/managed-bootstrap/image-runtime.ts");
    expect(runtime).toBeLessThan(runtimeChmod);
    expect(scan).toBeLessThan(metadataCheck);
  });
});
