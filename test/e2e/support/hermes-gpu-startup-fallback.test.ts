// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

function spawnWrapper(wrapperPath: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawn(wrapperPath, args, { env, stdio: "ignore" });
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function waitForFile(filePath: string): Promise<void> {
  await vi.waitUntil(() => fs.existsSync(filePath), { interval: 20, timeout: 5_000 });
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

  it("keeps the real OpenShell CLI at the wrapper path after compatibility create succeeds (#11239)", () => {
    const { realOpenshell, root, wrapper } = createWrapperFixture("hermes-gpu-fallback-test-", {
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
        `printf '%s\\n' "$0" >>"$E2E_FAKE_DELEGATE_EXECUTABLE_LOG"`,
        "",
      ].join("\n"),
    });
    const delegateMarkerLog = path.join(root, "delegate-markers.log");
    const delegateExecutableLog = path.join(root, "delegate-executables.log");
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAKE_DELEGATE_LOG: delegateMarkerLog,
      E2E_FAKE_DELEGATE_EXECUTABLE_LOG: delegateExecutableLog,
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
    expect(fs.lstatSync(wrapper.wrapperPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(wrapper.wrapperPath)).toBe(fs.realpathSync(realOpenshell));

    const repeatedCompatibility = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      env,
    );
    expect(repeatedCompatibility.status, repeatedCompatibility.stderr).toBe(0);

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
      HERMES_GPU_FALLBACK_EVENTS.commitCompatibilityHandoff,
    ]);
    const wrapperArtifacts = fs
      .readdirSync(path.dirname(wrapper.eventsPath), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.readFileSync(path.join(path.dirname(wrapper.eventsPath), entry.name), "utf8"),
      )
      .join("\n");
    expect(secretMarkers.every((secretMarker) => !wrapperArtifacts.includes(secretMarker))).toBe(
      true,
    );
    expect(wrapperArtifacts).not.toMatch(/(?:TOKEN|API_KEY|PASSWORD)=/u);
    // The fake delegate records a constant marker only; it never serializes argv.
    expect(fs.readFileSync(delegateMarkerLog, "utf8").split(/\r?\n/u).filter(Boolean)).toEqual([
      "delegated",
      "create-without-gpu",
      "create-without-gpu",
      "delegated",
      "delegated",
    ]);
    expect(fs.readFileSync(delegateExecutableLog, "utf8").split(/\r?\n/u).filter(Boolean)).toEqual([
      realOpenshell,
      realOpenshell,
      wrapper.wrapperPath,
      wrapper.wrapperPath,
      wrapper.wrapperPath,
    ]);
  });

  it("keeps native fault injection when the exact proof precedes compatibility create (#11239)", () => {
    const { wrapper } = createWrapperFixture("hermes-gpu-fallback-order-test-");
    const env = { ...process.env, ...wrapper.componentEnv };

    const firstNativeCreate = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu"],
      env,
    );
    expect(firstNativeCreate.status).toBe(2);

    const prematureProof = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "exec", "-n", "alpha", "--", "sh", "-lc", HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF],
      env,
    );
    expect(prematureProof.status, prematureProof.stderr).toBe(0);
    expect(fs.lstatSync(wrapper.wrapperPath).isFile()).toBe(true);

    const secondNativeCreate = runWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu"],
      env,
    );
    expect(secondNativeCreate.status).toBe(2);
    expect(readHermesGpuFallbackEvents(wrapper.eventsPath)).toEqual([
      HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreateBeforeProgress,
    ]);
  });

  it("keeps native fault injection when compatibility create fails (#11239)", () => {
    const { wrapper } = createWrapperFixture("hermes-gpu-fallback-failed-create-test-", {
      openshell: [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "sandbox" && "${2:-}" == "create" ]]; then exit 23; fi',
        "exit 0",
        "",
      ].join("\n"),
    });
    const env = { ...process.env, ...wrapper.componentEnv };

    expect(
      runWrapper(wrapper.wrapperPath, ["sandbox", "create", "--from", "image", "--gpu"], env)
        .status,
    ).toBe(2);
    expect(
      runWrapper(
        wrapper.wrapperPath,
        ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
        env,
      ).status,
    ).toBe(23);
    expect(fs.lstatSync(wrapper.wrapperPath).isFile()).toBe(true);
    expect(
      runWrapper(wrapper.wrapperPath, ["sandbox", "create", "--from", "image", "--gpu"], env)
        .status,
    ).toBe(2);
  });

  it("rejects a native create while compatibility handoff is still pending (#11239)", async () => {
    const { root, wrapper } = createWrapperFixture("hermes-gpu-fallback-pending-test-", {
      openshell: [
        "#!/usr/bin/env bash",
        'for arg in "$@"; do',
        '  if [[ "$arg" == "--gpu" ]]; then',
        `    printf '%s\\n' native-bypass >>"$E2E_FAKE_DELEGATE_LOG"`,
        "    exit 97",
        "  fi",
        "done",
        `printf '%s\\n' compatibility >>"$E2E_FAKE_DELEGATE_LOG"`,
        ': >"$E2E_FAKE_READY"',
        'while [[ ! -f "$E2E_FAKE_RELEASE" ]]; do sleep 0.02; done',
        "exit 0",
        "",
      ].join("\n"),
    });
    const ready = path.join(root, "compatibility-ready");
    const release = path.join(root, "compatibility-release");
    const delegateLog = path.join(root, "delegate.log");
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAKE_DELEGATE_LOG: delegateLog,
      E2E_FAKE_READY: ready,
      E2E_FAKE_RELEASE: release,
    };
    const compatibility = spawnWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      env,
    );
    const compatibilityStatus = waitForChild(compatibility);
    await waitForFile(ready);

    expect(fs.lstatSync(wrapper.wrapperPath).isFile()).toBe(true);
    expect(
      runWrapper(wrapper.wrapperPath, ["sandbox", "create", "--from", "image", "--gpu"], env)
        .status,
    ).toBe(2);
    expect(fs.readFileSync(delegateLog, "utf8").trim()).toBe("compatibility");

    fs.writeFileSync(release, "");
    expect(await compatibilityStatus).toBe(0);
    expect(fs.lstatSync(wrapper.wrapperPath).isSymbolicLink()).toBe(true);
  });

  it("retains the successful handoff when an overlapping compatibility create fails (#11239)", async () => {
    const { root, wrapper } = createWrapperFixture("hermes-gpu-fallback-overlap-test-", {
      openshell: [
        "#!/usr/bin/env bash",
        "mode=failure",
        'for arg in "$@"; do [[ "$arg" == "--fixture-success" ]] && mode=success; done',
        'if [[ "$mode" == "success" ]]; then',
        '  ready="$E2E_SUCCESS_READY"',
        '  release="$E2E_SUCCESS_RELEASE"',
        "else",
        '  ready="$E2E_FAILURE_READY"',
        '  release="$E2E_FAILURE_RELEASE"',
        "fi",
        ': >"$ready"',
        'while [[ ! -f "$release" ]]; do sleep 0.02; done',
        '[[ "$mode" == "success" ]] && exit 0',
        "exit 23",
        "",
      ].join("\n"),
    });
    const successReady = path.join(root, "success-ready");
    const successRelease = path.join(root, "success-release");
    const failureReady = path.join(root, "failure-ready");
    const failureRelease = path.join(root, "failure-release");
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAILURE_READY: failureReady,
      E2E_FAILURE_RELEASE: failureRelease,
      E2E_SUCCESS_READY: successReady,
      E2E_SUCCESS_RELEASE: successRelease,
    };
    const successful = spawnWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all", "--fixture-success"],
      env,
    );
    const successfulStatus = waitForChild(successful);
    const failing = spawnWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      env,
    );
    const failingStatus = waitForChild(failing);
    await Promise.all([waitForFile(successReady), waitForFile(failureReady)]);

    fs.writeFileSync(successRelease, "");
    expect(await successfulStatus).toBe(0);
    expect(fs.lstatSync(wrapper.wrapperPath).isSymbolicLink()).toBe(true);
    fs.writeFileSync(failureRelease, "");
    expect(await failingStatus).toBe(23);
    expect(fs.lstatSync(wrapper.wrapperPath).isSymbolicLink()).toBe(true);
  });

  it("leaves native fault injection installed when compatibility create is interrupted (#11239)", async () => {
    const { root, wrapper } = createWrapperFixture("hermes-gpu-fallback-interrupt-test-", {
      openshell: [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "sandbox" && "${2:-}" == "get" ]]; then exit 1; fi',
        "trap 'exit 143' HUP INT TERM",
        ': >"$E2E_FAKE_READY"',
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
    });
    const ready = path.join(root, "compatibility-ready");
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAKE_READY: ready,
    };
    const compatibility = spawnWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      env,
    );
    const compatibilityStatus = waitForChild(compatibility);
    await waitForFile(ready);

    expect(compatibility.kill("SIGTERM")).toBe(true);
    expect(await compatibilityStatus).toBe(143);
    expect(fs.lstatSync(wrapper.wrapperPath).isFile()).toBe(true);
    expect(
      runWrapper(wrapper.wrapperPath, ["sandbox", "create", "--from", "image", "--gpu"], env)
        .status,
    ).toBe(2);
  });

  it("commits the handoff when the create client is terminated after Ready (#11239)", async () => {
    const { realOpenshell, root, wrapper } = createWrapperFixture(
      "hermes-gpu-fallback-ready-termination-test-",
      {
        openshell: [
          "#!/usr/bin/env bash",
          'if [[ "${1:-}" == "sandbox" && "${2:-}" == "get" ]]; then',
          "  printf '%s\\n' 'Phase: Ready'",
          "  exit 0",
          "fi",
          "trap 'exit 143' HUP INT TERM",
          ': >"$E2E_FAKE_READY"',
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
      },
    );
    const ready = path.join(root, "compatibility-ready");
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAKE_READY: ready,
    };
    const compatibility = spawnWrapper(
      wrapper.wrapperPath,
      [
        "sandbox",
        "create",
        "--from",
        "image",
        "--gpu-device",
        "all",
        "--",
        "NEMOCLAW_SANDBOX_NAME=alpha",
      ],
      env,
    );
    const compatibilityStatus = waitForChild(compatibility);
    await waitForFile(ready);

    expect(compatibility.kill("SIGTERM")).toBe(true);
    expect(await compatibilityStatus).toBe(143);
    expect(fs.lstatSync(wrapper.wrapperPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(wrapper.wrapperPath)).toBe(fs.realpathSync(realOpenshell));
    expect(readHermesGpuFallbackEvents(wrapper.eventsPath)).toEqual([
      HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate,
      HERMES_GPU_FALLBACK_EVENTS.commitCompatibilityHandoff,
    ]);
  });

  it("bounds a stuck Ready query and retains native fault injection (#11239)", async () => {
    const { root, wrapper } = createWrapperFixture("hermes-gpu-fallback-ready-timeout-test-", {
      openshell: [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "sandbox" && "${2:-}" == "get" ]]; then exec sleep 30; fi',
        "trap 'exit 143' HUP INT TERM",
        ': >"$E2E_FAKE_READY"',
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
    });
    const ready = path.join(root, "compatibility-ready");
    const env = { ...process.env, ...wrapper.componentEnv, E2E_FAKE_READY: ready };
    const compatibility = spawnWrapper(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--", "NEMOCLAW_SANDBOX_NAME=alpha"],
      env,
    );
    const compatibilityStatus = waitForChild(compatibility);
    await waitForFile(ready);
    const terminatedAt = Date.now();

    expect(compatibility.kill("SIGTERM")).toBe(true);
    expect(await compatibilityStatus).toBe(143);
    expect(Date.now() - terminatedAt).toBeLessThan(4_000);
    expect(fs.lstatSync(wrapper.wrapperPath).isFile()).toBe(true);
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
        waitForChild(
          spawnWrapper(
            wrapper.wrapperPath,
            ["sandbox", "create", "--from", "image", "--gpu"],
            env,
          ),
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
