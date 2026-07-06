// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE,
} from "../../../src/lib/onboard/openshell-feature-gate";
import {
  createHermesGpuFallbackWrapper,
  HERMES_GPU_FALLBACK_EVENTS,
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
    ["native", true, { route: "compatibility-only", scenario: "native" }],
  ] as const)("maps scenario %s and compatibility=%s", (scenario, forced, expected) => {
    expect(resolveHermesGpuStartupScenario(scenario, forced)).toEqual(expected);
  });

  it.each([
    ["unknown", false, /must be native or fallback/],
    ["fallback", true, /requires automatic GPU routing/],
  ] as const)("rejects invalid scenario/control combination %s", (scenario, forced, expected) => {
    expect(() => resolveHermesGpuStartupScenario(scenario, forced)).toThrow(expected);
  });
});

describe("Hermes GPU startup fallback OpenShell wrapper", () => {
  it("rejects only the first sandbox create with exact --gpu and delegates every other call", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gpu-fallback-test-"));
    roots.push(root);
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir);
    const delegateLog = path.join(root, "delegate.log");
    const realOpenshell = path.join(realDir, "openshell");
    writeExecutable(
      realOpenshell,
      "#!/usr/bin/env bash\nprintf '%s\\n' delegated >>\"$E2E_FAKE_DELEGATE_LOG\"\n",
    );
    writeExecutable(path.join(realDir, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(realDir, "openshell-sandbox"), "#!/usr/bin/env bash\nexit 0\n");

    const wrapper = createHermesGpuFallbackWrapper(realOpenshell, {
      rootDir: path.join(root, "wrapper"),
    });
    const env = {
      ...process.env,
      ...wrapper.componentEnv,
      E2E_FAKE_DELEGATE_LOG: delegateLog,
    };
    const secretMarker = "must-not-enter-wrapper-events";

    const rejected = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu", "--", `TOKEN=${secretMarker}`],
      { encoding: "utf8", env },
    );
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("error: unexpected argument '--gpu' found");
    expect(fs.existsSync(delegateLog)).toBe(false);

    const secondNative = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu"],
      { encoding: "utf8", env },
    );
    expect(secondNative.status, secondNative.stderr).toBe(0);

    const compatibility = spawnSync(
      wrapper.wrapperPath,
      ["sandbox", "create", "--from", "image", "--gpu-device", "all"],
      { encoding: "utf8", env },
    );
    expect(compatibility.status, compatibility.stderr).toBe(0);

    const version = spawnSync(wrapper.wrapperPath, ["--version"], {
      encoding: "utf8",
      env,
    });
    expect(version.status, version.stderr).toBe(0);
    expect(readHermesGpuFallbackEvents(wrapper.eventsPath)).toEqual([
      HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreate,
      HERMES_GPU_FALLBACK_EVENTS.delegateNativeCreate,
      HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate,
    ]);
    expect(fs.readFileSync(wrapper.eventsPath, "utf8")).not.toContain(secretMarker);
    expect(fs.readFileSync(delegateLog, "utf8").split(/\r?\n/u).filter(Boolean)).toEqual([
      "delegated",
      "delegated",
      "delegated",
    ]);
  });

  it("rejects exactly one native create when wrapper calls race", async () => {
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
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        runWrapperConcurrently(
          wrapper.wrapperPath,
          ["sandbox", "create", "--from", "image", "--gpu"],
          { ...process.env, ...wrapper.componentEnv },
        ),
      ),
    );

    expect(statuses.filter((status) => status === 2)).toHaveLength(1);
    expect(statuses.filter((status) => status === 0)).toHaveLength(7);
    const events = readHermesGpuFallbackEvents(wrapper.eventsPath);
    expect(
      events.filter((event) => event === HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreate),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event === HERMES_GPU_FALLBACK_EVENTS.delegateNativeCreate),
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
