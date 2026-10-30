// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { afterEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ test: vi.fn() }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: Object.assign(captured.test, {
    skipIf: (skip: boolean) => (skip ? vi.fn() : captured.test),
  }),
}));
vi.mock("../fixtures/managed-image-receipt.ts", () => ({
  selectedE2eManagedImageReference: () => "example.invalid/openclaw@sha256:" + "a".repeat(64),
}));

const disposables: Array<() => unknown> = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  for (const dispose of disposables.splice(0).reverse()) await dispose();
  vi.doUnmock("../live/openclaw-inference-switch-helpers.ts");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function loadNativeSwitchRun(nativeCustom = false) {
  vi.resetModules();
  captured.test.mockClear();
  vi.stubEnv(
    "NEMOCLAW_SWITCH_PROVIDER",
    nativeCustom ? "compatible-anthropic-endpoint" : "nvidia-prod",
  );
  vi.stubEnv("NEMOCLAW_SWITCH_MOCK_ANTHROPIC", nativeCustom ? "1" : "0");
  vi.stubEnv("NEMOCLAW_SWITCH_NATIVE_CUSTOM", nativeCustom ? "1" : "0");
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    String(file).endsWith("bin/nemoclaw.js") ? true : exists(file),
  );
  await import("../live/openclaw-inference-switch.test.ts");
  const { startTestProgress } = await import("../fixtures/progress.ts");
  const progress = startTestProgress(
    "native switch baseline",
    captured.test.mock.calls[0]![1].meta.e2ePhases,
    { logLine: () => undefined },
  );
  disposables.push(() => progress.stop());
  const run = captured.test.mock.calls[0]![2] as (input: object) => Promise<void>;
  return { progress, run };
}

it.each(
  [false, true].flatMap((nativeCustom) =>
    ["6.8.0-generic", "6.6.87.2-microsoft-standard-WSL2"].flatMap((release) =>
      ["docker", "podman"].map((runtime) => ({ nativeCustom, release, runtime })),
    ),
  ),
)(
  "selects the authenticated baseline with native custom=$nativeCustom on $runtime and $release",
  async ({ nativeCustom, release, runtime }) => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", runtime);
    vi.stubEnv("OPENSHELL_PODMAN_SOCKET", "/run/user/1001/podman/podman.sock");
    const { progress, run } = await loadNativeSwitchRun(nativeCustom);
    const result = { exitCode: 0, stdout: "", stderr: "" };
    const stop = new Error("onboarding captured");
    const nemoclaw = vi.fn(
      async (_args: string[], _options: { env: NodeJS.ProcessEnv; redactionValues: string[] }) => {
        throw stop;
      },
    );
    const required = vi.fn((name: string) => {
      expect(name).toBe("NVIDIA_API_KEY");
      return "nvapi-public-fixture-key";
    });
    await expect(
      run({
        artifacts: { target: { declare: vi.fn() } },
        cleanup: {
          trackDisposable: (_name: string, dispose: () => unknown) => disposables.push(dispose),
          trackGateway: vi.fn(),
          trackSandbox: vi.fn(),
        },
        host: {
          nemoclaw,
          command: vi.fn(async (_cmd, _args, options) =>
            options?.artifactName === "native-baseline-endpoint-address"
              ? { ...result, stdout: "route 10.20.30.40" }
              : result,
          ),
        },
        progress,
        runtimeProvider: { id: runtime, requireAvailable: vi.fn() },
        sandbox: { openshell: vi.fn(async () => result), cleanupSandbox: vi.fn() },
        secrets: { required },
      }),
    ).rejects.toBe(stop);
    expect(required.mock.calls).toEqual(nativeCustom ? [] : [["NVIDIA_API_KEY"]]);
    const args = nemoclaw.mock.calls[0]![0];
    expect(args).toEqual([
      "onboard",
      "--non-interactive",
      "--yes",
      ...(runtime === "docker" ? ["--from", expect.any(String)] : []),
    ]);
    const customDockerfile = args[4];
    expect(customDockerfile ? fs.readFileSync(customDockerfile, "utf8") : null).toEqual(
      runtime === "docker" ? expect.stringContaining("ARG NEMOCLAW_MESSAGING_PLAN_B64=") : null,
    );
    const options = nemoclaw.mock.calls[0]![1];
    const environment = options.env;
    expect(environment.NEMOCLAW_PROVIDER).toBe("custom");
    expect(new URL(environment.NEMOCLAW_ENDPOINT_URL!).hostname).toBe(
      nativeCustom ? "10.20.30.40" : "host.openshell.internal",
    );
    expect(environment.NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS).toBe(
      nativeCustom ? "10.20.30.40" : undefined,
    );
    expect(environment.NEMOCLAW_MODEL).toBe("openclaw-switch-baseline-model");
    expect(environment.COMPATIBLE_API_KEY).toBe("openclaw-switch-baseline-credential");
    expect(environment.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(environment.NVIDIA_API_KEY).toBeUndefined();
    expect(options.redactionValues.includes("nvapi-public-fixture-key")).toBe(!nativeCustom);
    expect(options.redactionValues).toContain("openclaw-switch-baseline-credential");
  },
);

it.each([
  {
    label: "invalid",
    required: () => "invalid-key",
    expected: "NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key",
  },
  {
    label: "missing",
    required: () => {
      throw new Error("NVIDIA_API_KEY unavailable");
    },
    expected: "NVIDIA_API_KEY unavailable",
  },
])(
  "rejects a $label NVIDIA key before starting the baseline provider",
  async ({ required, expected }) => {
    const startBaseline = vi.fn();
    vi.doMock("../live/openclaw-inference-switch-helpers.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../live/openclaw-inference-switch-helpers.ts")>()),
      startMockOpenClawBaselineProvider: startBaseline,
    }));
    const { progress, run } = await loadNativeSwitchRun();
    const getKey = vi.fn(required);
    await expect(
      run({
        artifacts: { target: { declare: vi.fn() } },
        cleanup: { trackDisposable: vi.fn() },
        progress,
        runtimeProvider: { requireAvailable: vi.fn() },
        secrets: { required: getKey },
      }),
    ).rejects.toThrow(expected);
    expect(getKey).toHaveBeenCalledExactlyOnceWith("NVIDIA_API_KEY");
    expect(startBaseline).not.toHaveBeenCalled();
  },
);
