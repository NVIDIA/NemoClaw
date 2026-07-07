// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildDirectSandboxGpuProofCommands } from "../../../src/lib/onboard/initial-policy";
import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE,
} from "../../../src/lib/onboard/openshell-feature-gate";
import {
  createHermesGpuFallbackWrapper,
  extractHermesGpuDiagnosticsDirectory,
  HERMES_GPU_FALLBACK_EVENTS,
  HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF,
  readHermesGpuFallbackEvents,
  resolveHermesGpuStartupScenario,
} from "../live/hermes-gpu-startup-fallback.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body, { encoding: "utf8", mode: 0o700 });
}

function runWrapperConcurrently(
  wrapperPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(wrapperPath, args, { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

describe("Hermes GPU startup scenario selection", () => {
  it.each([
    [undefined, false, { route: "native-success", scenario: "native" }],
    ["native", false, { route: "native-success", scenario: "native" }],
    ["fallback", false, { route: "compatibility-fallback", scenario: "fallback" }],
    ["compatibility-only", false, { route: "compatibility-only", scenario: "compatibility-only" }],
    ["native", true, { route: "compatibility-only", scenario: "native" }],
  ] as const)("maps scenario %s and compatibility=%s", (scenario, forced, expected) => {
    expect(resolveHermesGpuStartupScenario(scenario, forced)).toEqual(expected);
  });

  it.each([
    ["unknown", false, /must be native, fallback, or compatibility-only/],
    ["fallback", true, /requires automatic GPU routing/],
  ] as const)("rejects invalid scenario/control combination %s", (scenario, forced, expected) => {
    expect(() => resolveHermesGpuStartupScenario(scenario, forced)).toThrow(expected);
  });
});

describe("Hermes GPU startup failure diagnostics", () => {
  it("recognizes native GPU diagnostics when no compatibility bundle exists", () => {
    expect(
      extractHermesGpuDiagnosticsDirectory(
        "Native GPU diagnostics saved: /tmp/nemoclaw-native-gpu-diagnostics\n",
      ),
    ).toBe("/tmp/nemoclaw-native-gpu-diagnostics");
  });

  it("prefers final compatibility diagnostics when both attempt bundles exist", () => {
    expect(
      extractHermesGpuDiagnosticsDirectory(
        [
          "Native GPU diagnostics saved: /tmp/nemoclaw-native-gpu-diagnostics",
          "Pre-rollback diagnostics saved: /tmp/nemoclaw-compatibility-diagnostics",
        ].join("\n"),
      ),
    ).toBe("/tmp/nemoclaw-compatibility-diagnostics");
  });

  it("returns an empty directory when install output has no saved bundle", () => {
    expect(extractHermesGpuDiagnosticsDirectory("GPU setup failed before diagnostics\n")).toBe("");
  });
});

describe("Hermes GPU startup fallback OpenShell wrapper", () => {
  it("tracks the exact production nvidia-smi proof argv", () => {
    const proof = buildDirectSandboxGpuProofCommands("alpha").find(
      (candidate) => candidate.id === "nvidia-smi",
    );
    expect(proof?.args).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
      HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF,
    ]);
  });

  it("creates native state without GPU, rejects one exact proof, and delegates compatibility", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gpu-fallback-test-"));
    roots.push(root);
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir);
    const delegateMarkerLog = path.join(root, "delegate-markers.log");
    const realOpenshell = path.join(realDir, "openshell");
    writeExecutable(
      realOpenshell,
      [
        "#!/usr/bin/env bash",
        "marker=delegated",
        'if [[ "${1:-}" == "sandbox" && "${2:-}" == "create" ]]; then',
        "  marker=create-without-gpu",
        '  for arg in "$@"; do',
        '    if [[ "$arg" == "--gpu" ]]; then exit 97; fi',
        "  done",
        "fi",
        `printf '%s\\n' "$marker" >>"$E2E_FAKE_DELEGATE_LOG"`,
        "",
      ].join("\n"),
    );
    writeExecutable(path.join(realDir, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(realDir, "openshell-sandbox"), "#!/usr/bin/env bash\nexit 0\n");

    const wrapper = createHermesGpuFallbackWrapper(realOpenshell, {
      rootDir: path.join(root, "wrapper"),
    });
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAKE_DELEGATE_LOG: delegateMarkerLog,
    };
    const secretMarkers = [
      "must-not-enter-wrapper-events",
      "sk-wrapper-api-key",
      "must-not-enter-wrapper-password",
    ];

    const nativeCreate = spawnSync(
      wrapper.wrapperPath,
      [
        "sandbox",
        "create",
        "--from",
        "image",
        "--gpu",
        "--",
        `TOKEN=${secretMarkers[0]}`,
        `OPENAI_API_KEY=${secretMarkers[1]}`,
        `PASSWORD=${secretMarkers[2]}`,
      ],
      { encoding: "utf8", env },
    );
    expect(nativeCreate.status, nativeCreate.stderr).toBe(0);

    const nearMissProof = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", "nvidia-smi"],
      { encoding: "utf8", env },
    );
    expect(nearMissProof.status, nearMissProof.stderr).toBe(0);

    const rejectedProof = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF],
      { encoding: "utf8", env },
    );
    expect(rejectedProof.status).toBe(1);
    expect(rejectedProof.stderr).toContain(
      "Failed to initialize NVML: Driver/library version mismatch",
    );

    const compatibility = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      { encoding: "utf8", env },
    );
    expect(compatibility.status, compatibility.stderr).toBe(0);

    const compatibilityProof = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF],
      { encoding: "utf8", env },
    );
    expect(compatibilityProof.status, compatibilityProof.stderr).toBe(0);

    const version = spawnSync(wrapper.wrapperPath, ["--version"], {
      encoding: "utf8",
      env,
    });
    expect(version.status, version.stderr).toBe(0);
    expect(readHermesGpuFallbackEvents(wrapper.eventsPath)).toEqual([
      HERMES_GPU_FALLBACK_EVENTS.delegateNativeCreateWithoutGpu,
      HERMES_GPU_FALLBACK_EVENTS.rejectNativeNvidiaSmiProof,
      HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate,
      HERMES_GPU_FALLBACK_EVENTS.delegateNvidiaSmiProofAfterRejection,
    ]);
    const wrapperArtifacts = fs
      .readdirSync(path.dirname(wrapper.eventsPath), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.readFileSync(path.join(path.dirname(wrapper.eventsPath), entry.name), "utf8"),
      )
      .join("\n");
    for (const secretMarker of secretMarkers) {
      expect(wrapperArtifacts).not.toContain(secretMarker);
    }
    expect(wrapperArtifacts).not.toMatch(/(?:TOKEN|API_KEY|PASSWORD)=/u);
    // The fake delegate records a constant marker only; it never serializes argv.
    expect(fs.readFileSync(delegateMarkerLog, "utf8").split(/\r?\n/u).filter(Boolean)).toEqual([
      "create-without-gpu",
      "delegated",
      "create-without-gpu",
      "delegated",
      "delegated",
    ]);
  });

  it("rejects exactly one native nvidia-smi proof when wrapper calls race", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gpu-fallback-race-test-"));
    roots.push(root);
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir);
    const realOpenshell = path.join(realDir, "openshell");
    writeExecutable(realOpenshell, "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(realDir, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(realDir, "openshell-sandbox"), "#!/usr/bin/env bash\nexit 0\n");

    const wrapper = createHermesGpuFallbackWrapper(realOpenshell, {
      rootDir: path.join(root, "wrapper"),
    });
    const nativeCreate = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu"],
      { encoding: "utf8", env: { ...process.env, ...wrapper.componentEnv } },
    );
    expect(nativeCreate.status, nativeCreate.stderr).toBe(0);
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        runWrapperConcurrently(
          wrapper.wrapperPath,
          ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF],
          { ...process.env, ...wrapper.componentEnv },
        ),
      ),
    );

    expect(statuses.filter((status) => status === 1)).toHaveLength(1);
    expect(statuses.filter((status) => status === 0)).toHaveLength(7);
    const events = readHermesGpuFallbackEvents(wrapper.eventsPath);
    expect(
      events.filter((event) => event === HERMES_GPU_FALLBACK_EVENTS.delegateNativeCreateWithoutGpu),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event === HERMES_GPU_FALLBACK_EVENTS.rejectNativeNvidiaSmiProof),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event === HERMES_GPU_FALLBACK_EVENTS.delegateNvidiaSmiProofAfterRejection,
      ),
    ).toHaveLength(7);
  });

  it("preserves OpenShell version and capability detection without private wrapper env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gpu-fallback-feature-test-"));
    roots.push(root);
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir);
    const realOpenshell = path.join(realDir, "openshell");
    const versionScript = "#!/usr/bin/env bash\nprintf '%s\\n' 'openshell 0.0.72'\n";
    writeExecutable(realOpenshell, versionScript);
    writeExecutable(path.join(realDir, "openshell-gateway"), versionScript);
    writeExecutable(
      path.join(realDir, "openshell-sandbox"),
      `${versionScript}# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`,
    );

    const wrapper = createHermesGpuFallbackWrapper(realOpenshell, {
      rootDir: path.join(root, "wrapper"),
    });
    expect(
      hasRequiredOpenshellMessagingFeatures({
        openshellBin: wrapper.wrapperPath,
        gatewayBin: path.join(realDir, "openshell-gateway"),
        sandboxBin: path.join(realDir, "openshell-sandbox"),
        allowExternalGatewayBin: true,
        allowExternalSandboxBin: true,
      }),
    ).toBe(true);
  });
});
