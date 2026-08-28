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
const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "..", "..", "scripts", "install.sh");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body, { encoding: "utf8", mode: 0o700 });
}

function createWrapperFixture(
  prefix: string,
  scripts: { openshell?: string; gateway?: string; sandbox?: string } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const realDir = path.join(root, "real");
  fs.mkdirSync(realDir);
  const fallback = "#!/usr/bin/env bash\nexit 0\n";
  const realOpenshell = path.join(realDir, "openshell");
  writeExecutable(realOpenshell, scripts.openshell ?? fallback);
  writeExecutable(path.join(realDir, "openshell-gateway"), scripts.gateway ?? fallback);
  writeExecutable(path.join(realDir, "openshell-sandbox"), scripts.sandbox ?? fallback);
  return {
    realDir,
    realOpenshell,
    root,
    wrapper: createHermesGpuFallbackWrapper(realOpenshell, { rootDir: path.join(root, "wrapper") }),
  };
}

function runWrapper(wrapperPath: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(wrapperPath, args, { encoding: "utf8", env });
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
  it.each([
    [
      "recognizes native diagnostics",
      "Native GPU diagnostics saved: /tmp/nemoclaw-native-gpu-diagnostics\n",
      "/tmp/nemoclaw-native-gpu-diagnostics",
    ],
    [
      "prefers final compatibility diagnostics",
      "Native GPU diagnostics saved: /tmp/native\nPre-rollback diagnostics saved: /tmp/compatibility",
      "/tmp/compatibility",
    ],
    ["returns empty without a bundle", "GPU setup failed before diagnostics\n", ""],
  ])("extracts %s", (_name, output, expected) => {
    expect(extractHermesGpuDiagnosticsDirectory(output)).toBe(expected);
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

  it("rejects native create before progress and delegates one compatibility attempt (#10155)", () => {
    const { root, wrapper } = createWrapperFixture("hermes-gpu-fallback-test-", {
      openshell: [
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
    });
    const delegateMarkerLog = path.join(root, "delegate-markers.log");
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

    const nativeCreate = runWrapper(
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
      env,
    );
    expect(nativeCreate.status).toBe(2);
    expect(nativeCreate.stderr).toContain("error: unexpected argument '--gpu' found");

    const nearMissProof = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", "nvidia-smi"],
      env,
    );
    expect(nearMissProof.status, nearMissProof.stderr).toBe(0);

    const compatibility = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      env,
    );
    expect(compatibility.status, compatibility.stderr).toBe(0);

    const compatibilityProof = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF],
      env,
    );
    expect(compatibilityProof.status, compatibilityProof.stderr).toBe(0);

    const version = runWrapper(wrapper.wrapperPath, ["--version"], env);
    expect(version.status, version.stderr).toBe(0);
    expect(readHermesGpuFallbackEvents(wrapper.eventsPath)).toEqual([
      HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreateBeforeProgress,
      HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate,
      HERMES_GPU_FALLBACK_EVENTS.delegateNvidiaSmiProofAfterFallback,
    ]);
    const wrapperArtifacts = fs
      .readdirSync(path.dirname(wrapper.eventsPath), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.readFileSync(path.join(path.dirname(wrapper.eventsPath), entry.name), "utf8"),
      )
      .join("\n");
    expect(secretMarkers.every((secretMarker) => !wrapperArtifacts.includes(secretMarker))).toBe(true);
    expect(wrapperArtifacts).not.toMatch(/(?:TOKEN|API_KEY|PASSWORD)=/u);
    // The fake delegate records a constant marker only; it never serializes argv.
    expect(fs.readFileSync(delegateMarkerLog, "utf8").split(/\r?\n/u).filter(Boolean)).toEqual([
      "delegated",
      "create-without-gpu",
      "delegated",
      "delegated",
    ]);
  });

  it("preserves the fallback wrapper while staging the existing OpenShell service (#7140)", () => {
    const { realDir, root, wrapper } = createWrapperFixture(
      "hermes-gpu-fallback-installer-selection-",
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          'source "$INSTALLER_PAYLOAD" 2>/dev/null',
          "install_nemoclaw_openshell_gateway_user_service() {",
          '  printf "service-selection=%s\\n" "$NEMOCLAW_OPENSHELL_BIN"',
          '  printf "service-gateway=%s\\n" "$NEMOCLAW_OPENSHELL_GATEWAY_BIN"',
          '  printf "service-path=%s\\n" "$PATH"',
          "}",
          "maybe_install_openshell_during_install if-missing",
          'printf "final-selection=%s\\n" "$NEMOCLAW_OPENSHELL_BIN"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...wrapper.componentEnv,
          HOME: root,
          INSTALLER_PAYLOAD,
          PATH: `${realDir}:/usr/bin:/bin`,
          XDG_BIN_HOME: realDir,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`service-selection=${wrapper.wrapperPath}\n`);
    expect(result.stdout).toContain(`service-gateway=${path.join(realDir, "openshell-gateway")}\n`);
    expect(result.stdout.match(/^service-path=(.*)$/mu)?.[1]?.split(":")[0]).toBe(realDir);
    expect(result.stdout).toContain(`final-selection=${wrapper.wrapperPath}\n`);
  });

  it("rejects a relative fallback wrapper selection during service staging (#7140)", () => {
    const { realDir, root, wrapper } = createWrapperFixture(
      "hermes-gpu-fallback-relative-selection-",
    );
    const relativeBin = path.join(root, "relative-openshell");
    writeExecutable(relativeBin, "#!/usr/bin/env bash\nexit 0\n");
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          'source "$INSTALLER_PAYLOAD" 2>/dev/null',
          "install_nemoclaw_openshell_gateway_user_service() { :; }",
          "maybe_install_openshell_during_install if-missing",
          'printf "final-selection=%s\\n" "$NEMOCLAW_OPENSHELL_BIN"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...wrapper.componentEnv,
          HOME: root,
          INSTALLER_PAYLOAD,
          NEMOCLAW_OPENSHELL_BIN: "./relative-openshell",
          PATH: `${realDir}:/usr/bin:/bin`,
          XDG_BIN_HOME: realDir,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`final-selection=${path.join(realDir, "openshell")}\n`);
  });

  it("rejects an absolute directory fallback selection during service staging (#7140)", () => {
    const { realDir, root, wrapper } = createWrapperFixture(
      "hermes-gpu-fallback-directory-selection-",
    );
    const directoryBin = path.join(root, "openshell-directory");
    fs.mkdirSync(directoryBin, { mode: 0o700 });
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          'source "$INSTALLER_PAYLOAD" 2>/dev/null',
          "install_nemoclaw_openshell_gateway_user_service() { :; }",
          "maybe_install_openshell_during_install if-missing",
          'printf "final-selection=%s\\n" "$NEMOCLAW_OPENSHELL_BIN"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...wrapper.componentEnv,
          HOME: root,
          INSTALLER_PAYLOAD,
          NEMOCLAW_OPENSHELL_BIN: directoryBin,
          PATH: `${realDir}:/usr/bin:/bin`,
          XDG_BIN_HOME: realDir,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`final-selection=${path.join(realDir, "openshell")}\n`);
  });

  it("records one pre-progress rejection event when native create calls race (#10155)", async () => {
    const { wrapper } = createWrapperFixture("hermes-gpu-fallback-race-test-");
    const env = { ...process.env, ...wrapper.componentEnv };
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        runWrapperConcurrently(
          wrapper.wrapperPath,
          ["sandbox", "create", "--from", "image", "--gpu"],
          env,
        ),
      ),
    );

    expect(statuses).toEqual(Array.from({ length: 8 }, () => 2));
    const events = readHermesGpuFallbackEvents(wrapper.eventsPath);
    expect(
      events.filter(
        (event) => event === HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreateBeforeProgress,
      ),
    ).toHaveLength(1);
  });

  it("preserves OpenShell version and capability detection without private wrapper env", () => {
    const versionScript = "#!/usr/bin/env bash\nprintf '%s\\n' 'openshell 0.0.72'\n";
    const { realDir, wrapper } = createWrapperFixture("hermes-gpu-fallback-feature-test-", {
      openshell: versionScript,
      gateway: versionScript,
      sandbox: `${versionScript}# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`,
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
