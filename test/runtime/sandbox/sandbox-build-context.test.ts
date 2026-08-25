// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockerSpawnSync } from "../../../src/lib/adapters/docker/exec";
import { createAgentSandbox } from "../../../src/lib/agent/base-image";
import type { AgentDefinition } from "../../../src/lib/agent/defs";
import { isWsl } from "../../../src/lib/platform";
import {
  collectBuildContextStats,
  normalizeReadModesForDockerCopy,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
} from "../../../src/lib/sandbox/build-context";

interface BuildxCommand {
  command: string;
  args: string[];
}

function resolveBuildxCommand(): BuildxCommand | null {
  return (
    [
      { command: "docker", args: ["buildx"] },
      { command: "docker-buildx", args: [] },
    ].find((candidate) => {
      const args = [...candidate.args, "version"];
      const result =
        candidate.command === "docker"
          ? dockerSpawnSync(args, { encoding: "utf8" })
          : spawnSync(candidate.command, args, { encoding: "utf8" });
      return result.status === 0;
    }) ?? null
  );
}

const SUPPORTED_BUILDX_HOST = process.platform === "linux" && !isWsl();
const REVIEWED_RUNTIME_LICENSE_COPY =
  "COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/THIRD_PARTY_LICENSES.txt /opt/mcp-tool-discovery-runtime/dist/";
const BUILDX_COMMAND = SUPPORTED_BUILDX_HOST ? resolveBuildxCommand() : null;
const DOCKER_CAPABLE_LINUX_CI = process.env.CI === "true" && SUPPORTED_BUILDX_HOST;

function buildTarget(
  buildx: BuildxCommand,
  stagedDockerfile: string,
  buildCtx: string,
  target: string,
  outputDir: string,
) {
  const args = [
    ...buildx.args,
    "build",
    "--progress=plain",
    `--target=${target}`,
    `--output=type=local,dest=${outputDir}`,
    "--file",
    stagedDockerfile,
    buildCtx,
  ];
  const options = { encoding: "utf8" as const, maxBuffer: 20 * 1024 * 1024 };
  return buildx.command === "docker"
    ? dockerSpawnSync(args, options)
    : spawnSync(buildx.command, args, options);
}

function writeReviewedRuntimeBuildTarget(stagedDockerfile: string): string {
  const boundaryDockerfile = stagedDockerfile + ".reviewed-runtime";
  fs.writeFileSync(
    boundaryDockerfile,
    [
      fs.readFileSync(stagedDockerfile, "utf8").trimEnd(),
      "",
      "FROM scratch AS reviewed-runtime-artifacts",
      "COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /opt/mcp-tool-discovery-runtime/dist/",
      "COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /out/managed-startup-image-runtime.cjs",
      "",
    ].join("\n"),
  );
  return boundaryDockerfile;
}

describe("sandbox build context staging", () => {
  function runtimeManifestFixture(runtimeName: string, fileName: string) {
    return `${JSON.stringify({ runtimeName, fileName })}\n`;
  }

  function writeBuildContextFixture(sourceRoot: string) {
    const blueprintManifestDir = path.join(
      sourceRoot,
      "nemoclaw-blueprint",
      "model-specific-setup",
      "openclaw",
    );

    function writeFixture(relativePath: string, content = "fixture\n", mode = 0o644) {
      const target = path.join(sourceRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode });
      fs.chmodSync(target, mode);
    }

    writeFixture("Dockerfile");
    writeFixture("tsconfig.runtime-preloads.json", "{}\n");
    writeFixture(path.join("agents", "openclaw", "state-lock-plan.json"), "{}\n");
    writeFixture(
      path.join("ci", "npm-audit-exceptions.json"),
      `${JSON.stringify({ schemaVersion: 1, exceptions: [] })}\n`,
    );
    for (const runtimeName of [
      "managed-image-messaging-runtime",
      "mcporter-runtime",
      "openclaw-runtime",
      "wechat-runtime",
    ]) {
      for (const fileName of ["package.json", "package-lock.json"]) {
        writeFixture(
          path.join("agents", "openclaw", runtimeName, fileName),
          runtimeManifestFixture(runtimeName, fileName),
        );
      }
    }
    writeFixture(
      path.join(
        "agents",
        "openclaw",
        "managed-image-messaging-runtime",
        "npm-cache-seed",
        ".gitkeep",
      ),
    );
    for (const fileName of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "install-reviewed-runtime.sh",
      "npm-ci-locked.sh",
      "build-runtime.ts",
      "mcp-tool-discovery.ts",
      "streamable-http-client.test.ts",
      "tool-discovery-core.ts",
    ]) {
      writeFixture(
        path.join("tools", "mcp-tool-discovery-runtime", fileName),
        "fixture\n",
        ["install-reviewed-runtime.sh", "npm-ci-locked.sh"].includes(fileName) ? 0o755 : 0o644,
      );
    }
    for (const seedDirectory of ["mcp-runtime-npm-cache-seed", "npm-cache-seed"]) {
      writeFixture(path.join("tools", "mcp-tool-discovery-runtime", seedDirectory, ".gitkeep"));
    }
    for (const relativePath of [
      "managed-startup-image-runtime.bundle",
      path.join("mcp-tool-discovery", "BUNDLED_PACKAGES.json"),
      path.join("mcp-tool-discovery", "THIRD_PARTY_LICENSES.txt"),
      path.join("mcp-tool-discovery", "mcp-tool-discovery.bundle"),
    ]) {
      writeFixture(
        path.join("tools", "mcp-tool-discovery-runtime", "reviewed-runtime-bundle", relativePath),
        `reviewed fixture: ${relativePath}\n`,
      );
    }
    writeFixture(
      path.join(
        "tools",
        "mcp-tool-discovery-runtime",
        "reviewed-runtime-bundle",
        "unreviewed-runtime.bundle",
      ),
    );
    for (const fileName of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "openclaw.plugin.json",
    ]) {
      writeFixture(path.join("nemoclaw", fileName), "{}\n", 0o600);
    }
    writeFixture(path.join("nemoclaw", "src", "index.ts"), "fixture\n", 0o600);
    fs.chmodSync(path.join(sourceRoot, "nemoclaw"), 0o700);
    fs.chmodSync(path.join(sourceRoot, "nemoclaw", "src"), 0o700);
    writeFixture(path.join("nemoclaw-blueprint", "blueprint.yaml"));
    writeFixture(path.join("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"));
    writeFixture(path.join("nemoclaw-blueprint", "scripts", "http-proxy-fix.js"));
    writeFixture(
      path.join(
        "nemoclaw-blueprint",
        "openclaw-plugins",
        "kimi-inference-compat",
        "openclaw.plugin.json",
      ),
      "{}\n",
    );
    writeFixture(
      path.join("nemoclaw-blueprint", "openclaw-plugins", "kimi-inference-compat", "index.js"),
      "fixture\n",
      0o600,
    );
    writeFixture(
      path.join(
        "nemoclaw-blueprint",
        "model-specific-setup",
        "openclaw",
        "kimi-k2.6-managed-inference.json",
      ),
      "{}\n",
      0o600,
    );
    fs.chmodSync(path.join(sourceRoot, "nemoclaw-blueprint", "model-specific-setup"), 0o700);
    fs.chmodSync(blueprintManifestDir, 0o700);
    writeFixture(path.join("scripts", "nemoclaw-start.sh"));
    writeFixture(path.join("scripts", "managed-startup-hold.sh"));
    writeFixture(path.join("scripts", "managed-bootstrap-entrypoint.c"));
    writeFixture(path.join("scripts", "managed-bootstrap-trampoline.sh"));
    writeFixture(path.join("scripts", "gateway-control.sh"));
    writeFixture(path.join("scripts", "managed-gateway-control.py"));
    writeFixture(path.join("scripts", "state-dir-guard.py"));
    writeFixture(path.join("scripts", "openclaw-config-guard.py"));
    writeFixture(path.join("scripts", "codex-acp-wrapper.sh"));
    writeFixture(path.join("scripts", "generate-openclaw-config.mts"));
    writeFixture(path.join("scripts", "validate-openclaw-tool-search.mts"));
    writeFixture(
      path.join("scripts", "checks", "verify-openshell-policy-boundary-dependencies.mts"),
    );
    writeFixture(path.join("scripts", "checks", "materialize-locked-npm-cache-seed.mts"));
    writeFixture(path.join("scripts", "lib", "sandbox-init.sh"));
    writeFixture(path.join("scripts", "lib", "corporate-ca-runtime.sh"));
    writeFixture(path.join("scripts", "lib", "entrypoint-env-wrapper.sh"));
    writeFixture(path.join("scripts", "lib", "gateway-supervisor.sh"));
    writeFixture(path.join("scripts", "lib", "sandbox-rlimits.sh"));
    writeFixture(path.join("scripts", "lib", "openclaw_device_approval_policy.py"));
    writeFixture(path.join("scripts", "lib", "clean_runtime_shell_env_shim.py"));
    writeFixture(path.join("scripts", "lib", "normalize_mutable_config_perms.py"));
    writeFixture(
      path.join("src", "lib", "messaging", "applier", "build", "messaging-build-applier.mts"),
    );
    writeFixture(
      path.join("src", "lib", "messaging", "channels", "fixture", "hooks", "example.ts"),
    );
    writeFixture(path.join("src", "lib", "tool-disclosure.ts"));
    for (const relativePath of [
      path.join("core", "json-types.ts"),
      path.join("core", "ports.ts"),
      path.join("onboard", "managed-bootstrap", "envelope.ts"),
      path.join("onboard", "managed-bootstrap", "image-runtime.ts"),
      path.join("onboard", "managed-startup", "image-runtime.ts"),
      path.join("security", "credential-hash.ts"),
      path.join("state", "paths.ts"),
      path.join("state", "state-root.ts"),
    ]) {
      writeFixture(path.join("src", "lib", relativePath));
    }
    writeFixture(path.join("scripts", "patch-openclaw-tool-catalog.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-chat-send.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-mcp-npx.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-mcp-reliability.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-mcp-tools-list-timeout.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-issue-4434-diagnostics.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-managed-transport-diagnostics.mts"));
    writeFixture(path.join("scripts", "patch-openclaw-device-self-approval.mts"));
    writeFixture(path.join("scripts", "openclaw", "patch-gateway-daemon-dialback.mts"));
    writeFixture(path.join("scripts", "extract-semver.sh"));
    writeFixture(path.join("scripts", "patch-openclaw-shared-state-permissions.mts"));
    writeFixture(path.join("scripts", "patch-bundled-npm-brace-expansion.mts"));
    writeFixture(path.join("scripts", "lib", "patch-bundled-npm-ip-address.mts"));
    writeFixture(path.join("scripts", "patch-bundled-npm-tar.mts"));
    writeFixture(path.join("scripts", "upgrade-bundled-npm.mts"));
    writeFixture(path.join("scripts", "verify-wechat-runtime-lock.mts"));
    writeFixture(path.join("scripts", "lib", "reviewed-npm-archive.mts"), "fixture\n", 0o700);
    writeFixture(path.join("scripts", "lib", "bundled-npm-package.mts"), "fixture\n", 0o700);
    writeFixture(path.join("scripts", "lib", "seed-reviewed-npm-cache.mts"), "fixture\n", 0o700);
    writeFixture(path.join("scripts", "lib", "reviewed-npm-audit.mts"), "fixture\n", 0o700);
    writeFixture(path.join("scripts", "lib", "openclaw-npm-remediation.mts"), "fixture\n", 0o700);
    fs.chmodSync(path.join(sourceRoot, "scripts"), 0o700);
    fs.chmodSync(path.join(sourceRoot, "scripts", "lib"), 0o700);
  }

  function makeBuildContextFixtureGroupWritable(sourceRoot: string) {
    for (const relativePath of [
      "scripts",
      path.join("scripts", "lib"),
      "src",
      path.join("src", "lib"),
    ]) {
      fs.chmodSync(path.join(sourceRoot, relativePath), 0o775);
    }
    fs.chmodSync(path.join(sourceRoot, "scripts", "patch-bundled-npm-tar.mts"), 0o775);
    fs.chmodSync(path.join(sourceRoot, "src", "lib", "tool-disclosure.ts"), 0o664);
  }

  function expectStagedNemoclawModes(buildCtx: string) {
    const stagedNemoclaw = path.join(buildCtx, "nemoclaw");
    const stagedSrc = path.join(stagedNemoclaw, "src");
    const stagedPackageJson = path.join(stagedNemoclaw, "package.json");
    const stagedIndexTs = path.join(stagedSrc, "index.ts");

    const stagedNemoclawMode = fs.statSync(stagedNemoclaw).mode & 0o777;
    expect(stagedNemoclawMode & 0o555).toBe(0o555);
    expect(stagedNemoclawMode & 0o002).toBe(0);
    const stagedSrcMode = fs.statSync(stagedSrc).mode & 0o777;
    expect(stagedSrcMode & 0o555).toBe(0o555);
    expect(stagedSrcMode & 0o002).toBe(0);
    expect((fs.statSync(stagedPackageJson).mode & 0o777).toString(8)).toBe("644");
    expect((fs.statSync(stagedIndexTs).mode & 0o777).toString(8)).toBe("644");
  }

  function expectStagedBlueprintModes(buildCtx: string) {
    const stagedBlueprint = path.join(buildCtx, "nemoclaw-blueprint");
    const stagedManifestDir = path.join(stagedBlueprint, "model-specific-setup", "openclaw");
    const stagedManifest = path.join(stagedManifestDir, "kimi-k2.6-managed-inference.json");
    const stagedPlugin = path.join(
      stagedBlueprint,
      "openclaw-plugins",
      "kimi-inference-compat",
      "index.js",
    );

    const stagedManifestDirMode = fs.statSync(stagedManifestDir).mode & 0o777;
    expect(stagedManifestDirMode & 0o555).toBe(0o555);
    expect(stagedManifestDirMode & 0o002).toBe(0);
    expect((fs.statSync(stagedManifest).mode & 0o777).toString(8)).toBe("644");
    expect((fs.statSync(stagedPlugin).mode & 0o777).toString(8)).toBe("644");
  }

  function expectStagedOpenClawRuntimeGraphs(buildCtx: string, sourceRoot: string) {
    for (const runtimeName of ["mcporter-runtime", "openclaw-runtime", "wechat-runtime"]) {
      const runtimeDir = path.join(buildCtx, "agents", "openclaw", runtimeName);
      expect(fs.readdirSync(runtimeDir).sort()).toEqual(["package-lock.json", "package.json"]);
      for (const fileName of ["package.json", "package-lock.json"]) {
        expect(fs.readFileSync(path.join(runtimeDir, fileName), "utf8")).toBe(
          fs.readFileSync(
            path.join(sourceRoot, "agents", "openclaw", runtimeName, fileName),
            "utf8",
          ),
        );
      }
      expect((fs.statSync(path.join(runtimeDir, "package.json")).mode & 0o777).toString(8)).toBe(
        "644",
      );
      expect(
        (fs.statSync(path.join(runtimeDir, "package-lock.json")).mode & 0o777).toString(8),
      ).toBe("644");
    }

    const managedRuntimeDir = path.join(
      buildCtx,
      "agents",
      "openclaw",
      "managed-image-messaging-runtime",
    );
    expect(fs.readdirSync(managedRuntimeDir).sort()).toEqual([
      "npm-cache-seed",
      "package-lock.json",
      "package.json",
    ]);
    for (const fileName of ["package.json", "package-lock.json"]) {
      expect(fs.readFileSync(path.join(managedRuntimeDir, fileName), "utf8")).toBe(
        fs.readFileSync(
          path.join(sourceRoot, "agents", "openclaw", "managed-image-messaging-runtime", fileName),
          "utf8",
        ),
      );
    }
    expect(
      fs.readFileSync(path.join(managedRuntimeDir, "npm-cache-seed", ".gitkeep"), "utf8"),
    ).toBe(
      fs.readFileSync(
        path.join(
          sourceRoot,
          "agents",
          "openclaw",
          "managed-image-messaging-runtime",
          "npm-cache-seed",
          ".gitkeep",
        ),
        "utf8",
      ),
    );
  }

  function expectStagedMcpToolDiscoveryRuntime(buildCtx: string, sourceRoot: string) {
    const runtimeDir = path.join(buildCtx, "tools", "mcp-tool-discovery-runtime");
    expect(fs.readdirSync(runtimeDir).sort()).toEqual([
      "build-runtime.ts",
      "install-reviewed-runtime.sh",
      "mcp-runtime-npm-cache-seed",
      "mcp-tool-discovery.ts",
      "npm-cache-seed",
      "npm-ci-locked.sh",
      "package-lock.json",
      "package.json",
      "reviewed-runtime-bundle",
      "streamable-http-client.test.ts",
      "tool-discovery-core.ts",
      "tsconfig.json",
    ]);
    for (const fileName of [
      "build-runtime.ts",
      "install-reviewed-runtime.sh",
      "mcp-tool-discovery.ts",
      "npm-ci-locked.sh",
      "package-lock.json",
      "package.json",
      "streamable-http-client.test.ts",
      "tool-discovery-core.ts",
      "tsconfig.json",
    ]) {
      expect(fs.readFileSync(path.join(runtimeDir, fileName), "utf8")).toBe(
        fs.readFileSync(
          path.join(sourceRoot, "tools", "mcp-tool-discovery-runtime", fileName),
          "utf8",
        ),
      );
      expect((fs.statSync(path.join(runtimeDir, fileName)).mode & 0o777).toString(8)).toBe(
        ["install-reviewed-runtime.sh", "npm-ci-locked.sh"].includes(fileName) ? "755" : "644",
      );
    }
    for (const seedDirectory of ["mcp-runtime-npm-cache-seed", "npm-cache-seed"]) {
      const sourceSeedDirectory = path.join(
        sourceRoot,
        "tools",
        "mcp-tool-discovery-runtime",
        seedDirectory,
      );
      const stagedSeedDirectory = path.join(runtimeDir, seedDirectory);
      const sourceEntries = fs.readdirSync(sourceSeedDirectory).sort();
      expect(sourceEntries.length).toBeGreaterThan(0);
      expect(fs.readdirSync(stagedSeedDirectory).sort()).toEqual(sourceEntries);
      expect(fs.readFileSync(path.join(stagedSeedDirectory, sourceEntries[0]))).toEqual(
        fs.readFileSync(path.join(sourceSeedDirectory, sourceEntries[0])),
      );
    }

    const reviewedRuntimeDir = path.join(runtimeDir, "reviewed-runtime-bundle");
    expect(fs.readdirSync(reviewedRuntimeDir).sort()).toEqual([
      "managed-startup-image-runtime.bundle",
      "mcp-tool-discovery",
    ]);
    const reviewedRuntimeFiles = [
      "managed-startup-image-runtime.bundle",
      path.join("mcp-tool-discovery", "BUNDLED_PACKAGES.json"),
      path.join("mcp-tool-discovery", "THIRD_PARTY_LICENSES.txt"),
      path.join("mcp-tool-discovery", "mcp-tool-discovery.bundle"),
    ];
    expect(fs.readdirSync(path.join(reviewedRuntimeDir, "mcp-tool-discovery")).sort()).toEqual([
      "BUNDLED_PACKAGES.json",
      "THIRD_PARTY_LICENSES.txt",
      "mcp-tool-discovery.bundle",
    ]);
    for (const relativePath of reviewedRuntimeFiles) {
      const stagedPath = path.join(reviewedRuntimeDir, relativePath);
      const sourcePath = path.join(
        sourceRoot,
        "tools",
        "mcp-tool-discovery-runtime",
        "reviewed-runtime-bundle",
        relativePath,
      );
      expect(fs.lstatSync(stagedPath).isFile(), relativePath).toBe(true);
      expect(fs.readFileSync(stagedPath), relativePath).toEqual(fs.readFileSync(sourcePath));
      expect((fs.statSync(stagedPath).mode & 0o777).toString(8), relativePath).toBe("644");
    }
  }

  function expectStagedToolDisclosureContract(buildCtx: string) {
    expect(fs.existsSync(path.join(buildCtx, "src", "lib", "tool-disclosure.ts"))).toBe(true);
  }

  function expectStagedManagedStartupRuntimeSources(buildCtx: string, sourceRoot: string) {
    for (const relativePath of [
      path.join("src", "lib", "core", "json-types.ts"),
      path.join("src", "lib", "core", "ports.ts"),
      path.join("src", "lib", "onboard", "managed-bootstrap", "envelope.ts"),
      path.join("src", "lib", "onboard", "managed-bootstrap", "image-runtime.ts"),
      path.join("src", "lib", "onboard", "managed-startup", "image-runtime.ts"),
      path.join("src", "lib", "security", "credential-hash.ts"),
      path.join("src", "lib", "state", "paths.ts"),
      path.join("src", "lib", "state", "state-root.ts"),
    ]) {
      const stagedPath = path.join(buildCtx, relativePath);
      expect(fs.readFileSync(stagedPath, "utf8"), relativePath).toBe(
        fs.readFileSync(path.join(sourceRoot, relativePath), "utf8"),
      );
      expect((fs.statSync(stagedPath).mode & 0o777).toString(8), relativePath).toBe("644");
    }
  }

  function expectStagedScriptModes(buildCtx: string) {
    const stagedScripts = path.join(buildCtx, "scripts");
    const stagedLib = path.join(stagedScripts, "lib");
    const stagedHelper = path.join(stagedLib, "reviewed-npm-archive.mts");
    const stagedPackageHelper = path.join(stagedLib, "bundled-npm-package.mts");
    const stagedSeed = path.join(stagedLib, "seed-reviewed-npm-cache.mts");

    expect((fs.statSync(stagedScripts).mode & 0o777).toString(8)).toBe("755");
    expect((fs.statSync(stagedLib).mode & 0o777).toString(8)).toBe("755");
    expect((fs.statSync(stagedHelper).mode & 0o777).toString(8)).toBe("755");
    expect((fs.statSync(stagedPackageHelper).mode & 0o777).toString(8)).toBe("755");
    expect((fs.statSync(stagedSeed).mode & 0o777).toString(8)).toBe("755");
  }

  function expectStagedGroupWritablePayloadModes(buildCtx: string) {
    expect((fs.statSync(path.join(buildCtx, "scripts")).mode & 0o777).toString(8)).toBe("755");
    expect(
      (
        fs.statSync(path.join(buildCtx, "scripts", "patch-bundled-npm-tar.mts")).mode & 0o777
      ).toString(8),
    ).toBe("755");
    expect(
      (fs.statSync(path.join(buildCtx, "src", "lib", "tool-disclosure.ts")).mode & 0o777).toString(
        8,
      ),
    ).toBe("644");
  }

  it("normalizes restrictive and group-writable modes for Docker COPY", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-unit-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    const manifestDir = path.join(blueprintDir, "model-specific-setup", "openclaw");
    const manifestPath = path.join(manifestDir, "kimi-k2.6-managed-inference.json");
    const executablePath = path.join(blueprintDir, "scripts", "helper.sh");
    const groupWritableDir = path.join(blueprintDir, "group-writable");
    const groupWritableFile = path.join(groupWritableDir, "manifest.json");
    const groupWritableExecutable = path.join(groupWritableDir, "helper.sh");
    const symlinkPath = path.join(blueprintDir, "manifest-link.json");

    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.mkdirSync(path.dirname(executablePath), { recursive: true });
      fs.mkdirSync(groupWritableDir, { mode: 0o775 });
      fs.writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
      fs.writeFileSync(executablePath, "#!/bin/sh\n", { mode: 0o700 });
      fs.writeFileSync(groupWritableFile, "{}\n", { mode: 0o664 });
      fs.writeFileSync(groupWritableExecutable, "#!/bin/sh\n", { mode: 0o775 });
      fs.symlinkSync(manifestPath, symlinkPath);
      fs.chmodSync(blueprintDir, 0o700);
      fs.chmodSync(path.join(blueprintDir, "model-specific-setup"), 0o700);
      fs.chmodSync(manifestDir, 0o700);
      fs.chmodSync(manifestPath, 0o600);
      fs.chmodSync(executablePath, 0o700);
      fs.chmodSync(groupWritableDir, 0o775);
      fs.chmodSync(groupWritableFile, 0o664);
      fs.chmodSync(groupWritableExecutable, 0o775);

      normalizeReadModesForDockerCopy(blueprintDir);

      expect((fs.statSync(blueprintDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(executablePath).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(groupWritableDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(groupWritableFile).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(groupWritableExecutable).mode & 0o777).toString(8)).toBe("755");
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging makes copied blueprint manifests world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageOptimizedSandboxBuildContext(sourceRoot, tmpDir);
      expectStagedBlueprintModes(buildCtx);
      expectStagedOpenClawRuntimeGraphs(buildCtx, sourceRoot);
      expectStagedMcpToolDiscoveryRuntime(buildCtx, sourceRoot);
      expectStagedToolDisclosureContract(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging makes copied nemoclaw plugin sources world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-nemoclaw-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageOptimizedSandboxBuildContext(sourceRoot, tmpDir);
      expectStagedNemoclawModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging makes copied blueprint manifests world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-legacy-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
      expectStagedBlueprintModes(buildCtx);
      expectStagedOpenClawRuntimeGraphs(buildCtx, sourceRoot);
      expectStagedMcpToolDiscoveryRuntime(buildCtx, sourceRoot);
      expectStagedToolDisclosureContract(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging makes copied nemoclaw plugin sources world-readable", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-build-context-legacy-nemoclaw-mode-"),
    );

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
      expectStagedNemoclawModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging supplies the managed-startup runtime Dockerfile sources", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-build-context-legacy-managed-startup-"),
    );

    try {
      writeBuildContextFixture(sourceRoot);
      const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
      expectStagedManagedStartupRuntimeSources(buildCtx, sourceRoot);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging makes copied scripts readable under a restrictive umask (#7071)", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-script-mode-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const previousUmask = process.umask(0o077);
      try {
        const { buildCtx } = stageOptimizedSandboxBuildContext(sourceRoot, tmpDir);
        expectStagedScriptModes(buildCtx);
      } finally {
        process.umask(previousUmask);
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging makes copied scripts readable under a restrictive umask (#7071)", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-build-context-legacy-script-mode-"),
    );

    try {
      writeBuildContextFixture(sourceRoot);
      const previousUmask = process.umask(0o077);
      try {
        const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
        expectStagedScriptModes(buildCtx);
      } finally {
        process.umask(previousUmask);
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging strips group and other write bits from copied payloads", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-group-write-"));

    try {
      writeBuildContextFixture(sourceRoot);
      makeBuildContextFixtureGroupWritable(sourceRoot);
      const { buildCtx } = stageOptimizedSandboxBuildContext(sourceRoot, tmpDir);
      expectStagedGroupWritablePayloadModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy staging strips group and other write bits from copied payloads", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-build-context-legacy-group-write-"),
    );

    try {
      writeBuildContextFixture(sourceRoot);
      makeBuildContextFixtureGroupWritable(sourceRoot);
      const { buildCtx } = stageLegacySandboxBuildContext(sourceRoot, tmpDir);
      expectStagedGroupWritablePayloadModes(buildCtx);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked reviewed runtime artifact", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-source-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-symlink-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-runtime-outside-"));

    try {
      writeBuildContextFixture(sourceRoot);
      const outsideTarget = path.join(outsideDir, "outside-license.txt");
      const outsideContents = "outside target must remain unchanged\n";
      fs.writeFileSync(outsideTarget, outsideContents);
      const reviewedArtifact = path.join(
        sourceRoot,
        "tools",
        "mcp-tool-discovery-runtime",
        "reviewed-runtime-bundle",
        "mcp-tool-discovery",
        "THIRD_PARTY_LICENSES.txt",
      );
      fs.rmSync(reviewedArtifact);
      fs.symlinkSync(outsideTarget, reviewedArtifact);

      expect(() => stageOptimizedSandboxBuildContext(sourceRoot, tmpDir)).toThrow();
      expect(fs.readFileSync(outsideTarget, "utf8")).toBe(outsideContents);
      const stagedDirectories = fs.readdirSync(tmpDir);
      expect(stagedDirectories).toHaveLength(1);
      expect(
        fs.existsSync(
          path.join(
            tmpDir,
            stagedDirectories[0],
            "tools",
            "mcp-tool-discovery-runtime",
            "reviewed-runtime-bundle",
            "mcp-tool-discovery",
            "THIRD_PARTY_LICENSES.txt",
          ),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    { scenario: "JSON types" },
    { scenario: "ports" },
    { scenario: "bootstrap envelope" },
    { scenario: "bootstrap image runtime" },
    { scenario: "startup image runtime" },
    { scenario: "credential hash" },
    { scenario: "state paths" },
    { scenario: "state root" },
  ])(
    "optimized staging excludes blueprint .venv and extra scripts while preserving required files [$scenario]",
    ({ scenario }) => {
      const repoRoot = path.join(import.meta.dirname, "../../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-opt-"));

      try {
        const { buildCtx } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
        const relativePath = (
          {
            "JSON types": path.join("src", "lib", "core", "json-types.ts"),
            ports: path.join("src", "lib", "core", "ports.ts"),
            "bootstrap envelope": path.join(
              "src",
              "lib",
              "onboard",
              "managed-bootstrap",
              "envelope.ts",
            ),
            "bootstrap image runtime": path.join(
              "src",
              "lib",
              "onboard",
              "managed-bootstrap",
              "image-runtime.ts",
            ),
            "startup image runtime": path.join(
              "src",
              "lib",
              "onboard",
              "managed-startup",
              "image-runtime.ts",
            ),
            "credential hash": path.join("src", "lib", "security", "credential-hash.ts"),
            "state paths": path.join("src", "lib", "state", "paths.ts"),
            "state root": path.join("src", "lib", "state", "state-root.ts"),
          } as const
        )[scenario]!;
        expect(fs.existsSync(path.join(buildCtx, relativePath)), relativePath).toBe(true);

        expect(fs.existsSync(path.join(buildCtx, "tsconfig.runtime-preloads.json"))).toBe(true);
        expect(
          fs.readFileSync(path.join(buildCtx, "ci", "npm-audit-exceptions.json"), "utf8"),
        ).toBe(fs.readFileSync(path.join(repoRoot, "ci", "npm-audit-exceptions.json"), "utf8"));
        expectStagedOpenClawRuntimeGraphs(buildCtx, repoRoot);
        expectStagedMcpToolDiscoveryRuntime(buildCtx, repoRoot);
        expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
        expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", "blueprint.yaml"))).toBe(
          true,
        );
        expect(
          fs.existsSync(
            path.join(buildCtx, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", "scripts", "http-proxy-fix.js")),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(
              buildCtx,
              "nemoclaw-blueprint",
              "openclaw-plugins",
              "kimi-inference-compat",
              "openclaw.plugin.json",
            ),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(
              buildCtx,
              "nemoclaw-blueprint",
              "openclaw-plugins",
              "gemini-inference-compat",
              "openclaw.plugin.json",
            ),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(
              buildCtx,
              "nemoclaw-blueprint",
              "openclaw-plugins",
              "gemini-inference-compat",
              "index.ts",
            ),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(
              buildCtx,
              "nemoclaw-blueprint",
              "model-specific-setup",
              "openclaw",
              "kimi-k2.6-managed-inference.json",
            ),
          ),
        ).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "managed-bootstrap-entrypoint.c")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "managed-bootstrap-trampoline.sh")),
        ).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "gateway-control.sh"))).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "managed-gateway-control.py"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(buildCtx, "scripts", "state-dir-guard.py"))).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "agents", "openclaw", "state-lock-plan.json")),
        ).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "openclaw-config-guard.py"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(buildCtx, "scripts", "codex-acp-wrapper.sh"))).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "generate-openclaw-config.mts"))).toBe(
          true,
        );
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "validate-openclaw-tool-search.mts")),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(
              buildCtx,
              "src",
              "lib",
              "messaging",
              "applier",
              "build",
              "messaging-build-applier.mts",
            ),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "src", "lib", "messaging", "hooks", "common", "static-outputs.ts"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "scripts", "lib", "openclaw_device_approval_policy.py"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "lib", "clean_runtime_shell_env_shim.py")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "lib", "normalize_mutable_config_perms.py")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-tool-catalog.mts")),
        ).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-chat-send.mts"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-chat-send.js"))).toBe(
          false,
        );
        expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-mcp-npx.mts"))).toBe(
          true,
        );
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-mcp-reliability.mts")),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "scripts", "patch-openclaw-mcp-tools-list-timeout.mts"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "scripts", "patch-openclaw-issue-4434-diagnostics.mts"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "scripts", "patch-openclaw-managed-transport-diagnostics.mts"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-device-self-approval.mts")),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "scripts", "openclaw", "patch-gateway-daemon-dialback.mts"),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(buildCtx, "scripts", "patch-openclaw-shared-state-permissions.mts"),
          ),
        ).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-bundled-npm-tar.mts"))).toBe(
          true,
        );
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "patch-bundled-npm-brace-expansion.mts")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "lib", "patch-bundled-npm-ip-address.mts")),
        ).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "upgrade-bundled-npm.mts"))).toBe(true);
        expect(
          fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-device-self-approval.ts")),
        ).toBe(false);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "lib", "sandbox-init.sh"))).toBe(true);
        expect(fs.existsSync(path.join(buildCtx, "scripts", "lib", "gateway-supervisor.sh"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(buildCtx, "scripts", "lib", "sandbox-rlimits.sh"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(buildCtx, "scripts", "setup.sh"))).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(DOCKER_CAPABLE_LINUX_CI)("provides Buildx on Docker-capable Linux CI", () => {
    expect(BUILDX_COMMAND).not.toBeNull();
  });

  it.skipIf(!SUPPORTED_BUILDX_HOST || BUILDX_COMMAND === null)(
    "BuildKit imports reviewed runtime artifacts from each generated build context (#8669)",
    {
      timeout: 120_000,
    },
    () => {
      const buildx = BUILDX_COMMAND as BuildxCommand;
      const repoRoot = path.join(import.meta.dirname, "../../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-runtime-build-"));
      const reviewedRuntimeSource = path.join(
        repoRoot,
        "tools",
        "mcp-tool-discovery-runtime",
        "reviewed-runtime-bundle",
      );
      const hermesAgent = {
        name: "hermes",
        displayName: "Hermes",
        dockerfileBasePath: null,
        dockerfilePath: path.join(repoRoot, "agents", "hermes", "Dockerfile"),
      } as AgentDefinition;
      const hermesBuild = createAgentSandbox(hermesAgent, { rootDir: repoRoot });

      try {
        ([
          ["openclaw", stageOptimizedSandboxBuildContext(repoRoot, tmpDir)],
          ["hermes", hermesBuild],
        ] as const).forEach(([name, staged]) => {
          const { buildCtx, stagedDockerfile } = staged;
          expect(fs.readFileSync(stagedDockerfile, "utf8")).toContain(
            REVIEWED_RUNTIME_LICENSE_COPY,
          );
          const output = path.join(tmpDir, name + "-reviewed-runtime-output");
          const build = buildTarget(
            buildx,
            writeReviewedRuntimeBuildTarget(stagedDockerfile),
            buildCtx,
            "reviewed-runtime-artifacts",
            output,
          );
          expect(build.status, [build.stdout, build.stderr].join("\n")).toBe(0);

          for (const [sourceRelativePath, outputRelativePath] of [
            [
              path.join("mcp-tool-discovery", "BUNDLED_PACKAGES.json"),
              path.join("opt", "mcp-tool-discovery-runtime", "dist", "BUNDLED_PACKAGES.json"),
            ],
            [
              path.join("mcp-tool-discovery", "THIRD_PARTY_LICENSES.txt"),
              path.join("opt", "mcp-tool-discovery-runtime", "dist", "THIRD_PARTY_LICENSES.txt"),
            ],
            [
              path.join("mcp-tool-discovery", "mcp-tool-discovery.bundle"),
              path.join("opt", "mcp-tool-discovery-runtime", "dist", "mcp-tool-discovery.mjs"),
            ],
            [
              "managed-startup-image-runtime.bundle",
              path.join("out", "managed-startup-image-runtime.cjs"),
            ],
          ] as const) {
            expect(fs.readFileSync(path.join(output, outputRelativePath))).toEqual(
              fs.readFileSync(path.join(reviewedRuntimeSource, sourceRelativePath)),
            );
          }
        });
      } finally {
        fs.rmSync(hermesBuild.buildCtx, { recursive: true, force: true });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("build context stats honor filters without descending into excluded directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-stats-"));

    try {
      fs.mkdirSync(path.join(tmpDir, "include"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "skip", "nested"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "include", "a.txt"), "1234");
      fs.writeFileSync(path.join(tmpDir, "skip", "nested", "b.txt"), "567890");

      const stats = collectBuildContextStats(
        tmpDir,
        (entryPath) => !entryPath.split(path.sep).includes("skip"),
      );

      expect(stats).toEqual({ fileCount: 1, totalBytes: 4 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimized staging is smaller than the legacy build context", { timeout: 120_000 }, () => {
    const repoRoot = path.join(import.meta.dirname, "../../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-compare-"));

    try {
      const legacy = stageLegacySandboxBuildContext(repoRoot, tmpDir);
      const optimized = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);
      const legacyStats = collectBuildContextStats(legacy.buildCtx);
      const optimizedStats = collectBuildContextStats(optimized.buildCtx);

      expect(optimizedStats.fileCount).toBeLessThan(legacyStats.fileCount);
      expect(optimizedStats.totalBytes).toBeLessThan(legacyStats.totalBytes);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
