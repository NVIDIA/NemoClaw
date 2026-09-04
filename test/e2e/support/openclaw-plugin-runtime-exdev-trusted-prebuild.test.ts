// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_MCP_FEATURES,
  REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE,
} from "../../../src/lib/onboard/openshell-feature-gate.ts";
import { ordinaryOpenClawPairingIncompleteMessage } from "../../../src/lib/onboard/machine/finalization-deps.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { captureIssue4462FailureDiagnostics } from "../fixtures/issue-4462-diagnostics.ts";
import { runOpenClawPluginWithFailureEvidence } from "../fixtures/openclaw-plugin-runtime-exdev-onboard.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  acceptTrustedPluginFixturePrebuild,
  createOpenShellTrustedImageWrapper,
  createTrustedPluginFixtureDockerfile,
  registerTrustedPluginFixtureImageCleanup,
  trustedExdevImageRef,
} from "../live/openclaw-plugin-runtime-exdev-trusted-prebuild.ts";
import {
  resolveOpenShellSiblingComponents,
  withOpenShellDriverConfigWrapperEnv,
} from "../live/openshell-driver-config-test-wrapper.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const ONBOARD_OPERATION = "openclaw-plugin-runtime-exdev.onboard-pairing";
const RECREATE_OPERATION = "openclaw-plugin-runtime-exdev.recreate-pairing";
const DRIVER_CONFIG_JSON = JSON.stringify({
  docker: { mounts: [{ options: ["noexec"], target: "/tmp/exdev", type: "tmpfs" }] },
  podman: { mounts: [{ options: ["noexec"], target: "/tmp/exdev", type: "tmpfs" }] },
});

afterEach(() => vi.unstubAllEnvs());

it("rejects a managed Dockerfile without the runtime anchor (#9844)", () => {
  expect(() =>
    createTrustedPluginFixtureDockerfile({
      crossDeviceVersionSourceName: "weather-version-v2.ts",
      pluginDirName: "weather-plugin",
      source: "FROM scratch AS builder\n",
      versionSourceName: "weather-version-v1.ts",
    }),
  ).toThrow("trusted EXDEV fixture requires the managed runtime anchor");
});

it("restores sandbox as the generated Dockerfile's final user (#9844)", () => {
  const dockerfile = createTrustedPluginFixtureDockerfile({
    crossDeviceVersionSourceName: "weather-version-v2.ts",
    pluginDirName: "weather-plugin",
    source: "FROM ${BASE_IMAGE}\nUSER sandbox\n",
    versionSourceName: "weather-version-v1.ts",
  });

  expect(dockerfile.trimEnd()).toMatch(/USER sandbox$/);
});

function onboardResult(exitCode: number, stderr = ""): ShellProbeResult {
  return {
    artifacts: { result: "result.json", stderr: "stderr.txt", stdout: "stdout.txt" },
    command: ["node", "bin/nemoclaw.js", "onboard"],
    exitCode,
    signal: null,
    stderr,
    stdout: "",
    timedOut: false,
  };
}

describe("OpenClaw plugin onboarding pairing evidence", () => {
  it("records first-attempt success without diagnostics (#9844)", async () => {
    const run = vi.fn(async () => onboardResult(0));
    const captureDiagnostics = vi.fn(async () => true);
    const onEvidence = vi.fn();

    const result = await runOpenClawPluginWithFailureEvidence({
      captureDiagnostics,
      operation: ONBOARD_OPERATION,
      sandboxName: "fixture-sandbox",
      run,
      onEvidence,
    });

    expect(result.outcome).toBe("passed");
    expect(run).toHaveBeenCalledOnce();
    expect(captureDiagnostics).not.toHaveBeenCalled();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
        operation: ONBOARD_OPERATION,
        outcome: "passed-first-attempt",
      }),
    );
  });

  it("captures diagnostics and fails without retrying ambiguous pairing (#9844)", async () => {
    const sandboxName = "fixture-sandbox";
    const run = vi.fn(async () =>
      onboardResult(
        1,
        ordinaryOpenClawPairingIncompleteMessage(sandboxName, "pairing-unavailable"),
      ),
    );
    const captureDiagnostics = vi.fn(async () => false);
    const onEvidence = vi.fn();

    const result = await runOpenClawPluginWithFailureEvidence({
      captureDiagnostics,
      operation: ONBOARD_OPERATION,
      sandboxName,
      run,
      onEvidence,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(captureDiagnostics).toHaveBeenCalledOnce();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
        outcome: "failed-no-retry",
        attempts: [
          expect.objectContaining({
            failureClass: "ambiguous-mutation",
            retryScheduled: false,
          }),
        ],
      }),
    );
  });

  it("does not capture diagnostics for another onboarding failure (#9844)", async () => {
    const captureDiagnostics = vi.fn(async () => true);

    const result = await runOpenClawPluginWithFailureEvidence({
      captureDiagnostics,
      operation: ONBOARD_OPERATION,
      sandboxName: "fixture-sandbox",
      run: vi.fn(async () => onboardResult(1, "provider registration failed")),
      onEvidence: vi.fn(),
    });

    expect(result.outcome).toBe("failed");
    expect(captureDiagnostics).not.toHaveBeenCalled();
  });

  it.each([
    [
      "throws",
      async () => {
        throw new Error("diagnostics unavailable");
      },
    ],
    ["returns nonzero", async () => ({ ...onboardResult(1), stdout: "" })],
  ])(
    "preserves the pairing failure when diagnostic execution %s (#9844)",
    async (_condition, diagnosticExecution) => {
      const sandboxName = "fixture-sandbox";
      const run = vi.fn(async () =>
        onboardResult(
          1,
          ordinaryOpenClawPairingIncompleteMessage(sandboxName, "pairing-unavailable"),
        ),
      );
      const diagnosticExec = vi.fn(diagnosticExecution);

      const result = await runOpenClawPluginWithFailureEvidence({
        captureDiagnostics: () =>
          captureIssue4462FailureDiagnostics({ exec: diagnosticExec } as never, {
            env: { PATH: "/usr/bin" },
            redactionValues: ["secret-api-key"],
            sandboxName,
          }),
        operation: ONBOARD_OPERATION,
        sandboxName,
        run,
        onEvidence: vi.fn(),
      });

      expect(result.outcome).toBe("failed");
      expect(run).toHaveBeenCalledOnce();
      expect(diagnosticExec).toHaveBeenCalledExactlyOnceWith(
        sandboxName,
        ["node", "-e", expect.any(String), "/tmp/auto-pair.log", "/tmp/gateway.log"],
        expect.objectContaining({
          artifactName: "failure-openclaw-pairing-diagnostics",
          redactionValues: ["secret-api-key"],
        }),
      );
    },
  );
});

describe("OpenClaw plugin recreation pairing evidence", () => {
  it("records the recreation operation without diagnostics (#9844)", async () => {
    const captureDiagnostics = vi.fn(async () => true);
    const run = vi.fn(async () => onboardResult(0));
    const onEvidence = vi.fn();

    const result = await runOpenClawPluginWithFailureEvidence({
      captureDiagnostics,
      operation: RECREATE_OPERATION,
      run,
      sandboxName: "fixture-sandbox",
      onEvidence,
    });

    expect(result.outcome).toBe("passed");
    expect(run).toHaveBeenCalledOnce();
    expect(captureDiagnostics).not.toHaveBeenCalled();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: RECREATE_OPERATION,
        outcome: "passed-first-attempt",
      }),
    );
  });

  it("captures recreation diagnostics and fails without resuming (#9844)", async () => {
    const sandboxName = "fixture-sandbox";
    const captureDiagnostics = vi.fn(async () => true);
    const onEvidence = vi.fn();
    const run = vi.fn(async () =>
      onboardResult(
        1,
        ordinaryOpenClawPairingIncompleteMessage(sandboxName, "scope-warmup-failed"),
      ),
    );

    const result = await runOpenClawPluginWithFailureEvidence({
      captureDiagnostics,
      operation: RECREATE_OPERATION,
      run,
      sandboxName,
      onEvidence,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(captureDiagnostics).toHaveBeenCalledOnce();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: RECREATE_OPERATION,
        outcome: "failed-no-retry",
        attempts: [
          expect.objectContaining({
            failureClass: "ambiguous-mutation",
            retryScheduled: false,
          }),
        ],
      }),
    );
  });
});

function createWrapperFixture(
  canonicalCapabilityMarkers: readonly string[] = REQUIRED_OPENSHELL_MCP_FEATURES,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-wrapper-test-"));
  const delegate = path.join(directory, "real-openshell");
  const imageIdPath = path.join(directory, "resolved-image-id");
  const nextImageIdPath = path.join(directory, "next-resolved-image-id");
  const gateway = path.join(directory, "openshell-gateway");
  const sandbox = path.join(directory, "openshell-sandbox");
  fs.writeFileSync(imageIdPath, `${IMAGE_ID}\n`, { encoding: "utf8", mode: 0o600 });
  const executableSource = `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 'openshell 0.0.106'; exit 0; fi
if [ "\${1:-}" = "image" ]; then
  cat ${JSON.stringify(imageIdPath)}
  if [ -f ${JSON.stringify(nextImageIdPath)} ]; then
    mv ${JSON.stringify(nextImageIdPath)} ${JSON.stringify(imageIdPath)}
  fi
  exit 0
fi
printf '%s\\n' "$@"
`;
  const canonicalCapabilityComments = canonicalCapabilityMarkers
    .map((marker) => `# ${marker}`)
    .join("\n");
  fs.writeFileSync(delegate, `${executableSource}${canonicalCapabilityComments}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  fs.writeFileSync(gateway, executableSource, { encoding: "utf8", mode: 0o700 });
  fs.writeFileSync(sandbox, `${executableSource}# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  const components = resolveOpenShellSiblingComponents(delegate);
  let wrapper: ReturnType<typeof createOpenShellTrustedImageWrapper>;
  try {
    wrapper = createOpenShellTrustedImageWrapper({
      driverConfigJson: DRIVER_CONFIG_JSON,
      imageInspectorPath: components.cli,
      realOpenshellPath: components.cli,
    });
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
  return {
    components,
    directory,
    remove: () => {
      wrapper.remove();
      fs.rmSync(directory, { force: true, recursive: true });
    },
    setResolvedImageId: (imageId: string) => {
      fs.writeFileSync(imageIdPath, `${imageId}\n`, { encoding: "utf8", mode: 0o600 });
    },
    retagAfterNextInspection: (imageId: string) => {
      fs.writeFileSync(nextImageIdPath, `${imageId}\n`, { encoding: "utf8", mode: 0o600 });
    },
    wrapper,
  };
}

describe("trusted EXDEV OpenShell wrapper", () => {
  it("rejects incomplete canonical OpenShell components before creating a wrapper", () => {
    expect(() => createWrapperFixture(REQUIRED_OPENSHELL_MCP_FEATURES.slice(1))).toThrow(
      "trusted EXDEV image wrapper requires feature-complete canonical OpenShell components",
    );
  });

  it("rewrites sandbox creation to the verified image ID and injects driver config", () => {
    const fixture = createWrapperFixture();
    try {
      const imageRef = trustedExdevImageRef("wrapper-contract-v1");
      fixture.wrapper.selectImage({ imageId: IMAGE_ID, imageRef });
      const result = spawnSync(
        fixture.wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile", "--name", "demo"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      const forwarded = result.stdout.trimEnd().split("\n");
      const valuesFor = (option: string) =>
        forwarded.flatMap((argument, index) => (argument === option ? [forwarded[index + 1]] : []));
      expect(forwarded.slice(0, 2)).toEqual(["sandbox", "create"]);
      expect(valuesFor("--driver-config-json")).toEqual([DRIVER_CONFIG_JSON]);
      expect(valuesFor("--from")).toEqual([IMAGE_ID]);
      expect(valuesFor("--name")).toEqual(["demo"]);
    } finally {
      fixture.remove();
    }
  });

  it("rejects missing and untrusted selected image refs", () => {
    const fixture = createWrapperFixture();
    try {
      const missingImage = spawnSync(
        fixture.wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(missingImage.status).toBe(64);
      expect(missingImage.stderr).toContain("rejected the selected image ref");
      expect(() =>
        fixture.wrapper.selectImage({
          imageId: IMAGE_ID,
          imageRef: "docker.io/untrusted:latest",
        }),
      ).toThrow();
    } finally {
      fixture.remove();
    }
  });

  it.each([
    ["absent", ["sandbox", "create", "--name", "demo"]],
    [
      "repeated",
      ["sandbox", "create", "--from", "/tmp/staged/Dockerfile", "--from", "/tmp/other/Dockerfile"],
    ],
    ["valueless", ["sandbox", "create", "--from"]],
  ])("rejects a --from option that is %s", (_condition, args) => {
    const fixture = createWrapperFixture();
    try {
      fixture.wrapper.selectImage({
        imageId: IMAGE_ID,
        imageRef: trustedExdevImageRef("wrapper-contract-v1"),
      });
      const result = spawnSync(fixture.wrapper.executable, args, {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 30_000,
      });
      expect(result.status, args.join(" ")).toBe(64);
      expect(result.stderr).toContain("requires exactly one --from value");
    } finally {
      fixture.remove();
    }
  });

  it("rejects duplicate driver configuration", () => {
    const fixture = createWrapperFixture();
    try {
      fixture.wrapper.selectImage({
        imageId: IMAGE_ID,
        imageRef: trustedExdevImageRef("wrapper-contract-v1"),
      });
      const duplicateConfig = spawnSync(
        fixture.wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile", "--driver-config-json", "{}"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(duplicateConfig.status).toBe(64);
      expect(duplicateConfig.stderr).toContain("refusing duplicate --driver-config-json");
    } finally {
      fixture.remove();
    }
  });

  it("fails closed when the selected tag no longer resolves to its verified image ID", () => {
    const fixture = createWrapperFixture();
    try {
      const imageRef = trustedExdevImageRef("wrapper-contract-v1");
      fixture.wrapper.selectImage({ imageId: IMAGE_ID, imageRef });
      fixture.setResolvedImageId(`sha256:${"b".repeat(64)}`);

      const result = spawnSync(
        fixture.wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile", "--name", "demo"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );

      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("immutable identity mismatch");
    } finally {
      fixture.remove();
    }
  });

  it("delegates the verified image ID when the selected tag changes after inspection", () => {
    const fixture = createWrapperFixture();
    try {
      const imageRef = trustedExdevImageRef("wrapper-contract-v1");
      fixture.wrapper.selectImage({ imageId: IMAGE_ID, imageRef });
      fixture.retagAfterNextInspection(`sha256:${"b".repeat(64)}`);

      const result = spawnSync(
        fixture.wrapper.executable,
        ["sandbox", "create", "--from", "/tmp/staged/Dockerfile", "--name", "demo"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      const forwarded = result.stdout.trimEnd().split("\n");
      const fromIndex = forwarded.indexOf("--from");
      expect(forwarded[fromIndex + 1]).toBe(IMAGE_ID);
    } finally {
      fixture.remove();
    }
  });

  it("passes the OpenShell feature gate for a coherent component set", () => {
    const fixture = createWrapperFixture();
    try {
      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: fixture.components.cli,
          gatewayBin: fixture.components.gateway,
          sandboxBin: fixture.components.sandbox,
        }),
      ).toBe(true);
      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: fixture.wrapper.executable,
          gatewayBin: fixture.components.gateway,
          sandboxBin: fixture.components.sandbox,
          allowExternalGatewayBin: true,
          allowExternalSandboxBin: true,
        }),
      ).toBe(true);
    } finally {
      fixture.remove();
    }
    expect(fs.existsSync(fixture.wrapper.directory)).toBe(false);
  });

  it("prepends the wrapper path and sets OpenShell component variables", () => {
    const fixture = createWrapperFixture();
    try {
      expect(
        withOpenShellDriverConfigWrapperEnv(
          { PATH: "/usr/bin" },
          fixture.wrapper,
          fixture.components,
        ),
      ).toMatchObject({
        PATH: `${fixture.wrapper.directory}${path.delimiter}/usr/bin`,
        NEMOCLAW_OPENSHELL_BIN: fixture.wrapper.executable,
        NEMOCLAW_OPENSHELL_GATEWAY_BIN: fixture.components.gateway,
        NEMOCLAW_OPENSHELL_SANDBOX_BIN: fixture.components.sandbox,
      });
    } finally {
      fixture.remove();
    }
    expect(fs.existsSync(fixture.wrapper.directory)).toBe(false);
  });
});

function commandResult(exitCode = 0, stderr = ""): ShellProbeResult {
  return {
    artifacts: { result: "result.json", stderr: "stderr.txt", stdout: "stdout.txt" },
    command: ["docker", "image", "rm"],
    exitCode,
    signal: null,
    stderr,
    stdout: "",
    timedOut: false,
  };
}

describe("trusted EXDEV fixture image cleanup", () => {
  it("keeps gateway registration through managed destroy and continues through its failure", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry();
    const host = {
      cleanupGatewayRegistration: vi.fn(async () => {
        calls.push("gateway");
      }),
      cleanupSandbox: vi.fn(async () => {
        calls.push("managed-sandbox");
        throw new Error("managed destroy failed");
      }),
      command: vi.fn(async (_command: string, args: string[]) => {
        calls.push(`image:${args.at(-1)}`);
        return commandResult();
      }),
    };
    const images = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: { PATH: "/usr/bin" },
      host,
    });
    const image = trustedExdevImageRef("cleanup-order");
    images.track(image, "v1");
    cleanup.trackGateway(host, "nemoclaw");
    cleanup.trackDisposable("delete OpenShell sandbox fixture-sandbox", () => {
      calls.push("direct-sandbox");
    });
    cleanup.trackSandbox(host, "fixture-sandbox");

    const result = await cleanup.runAll();

    expect(calls).toEqual(["managed-sandbox", "direct-sandbox", "gateway", `image:${image}`]);
    expect(result).toEqual({
      failures: [{ message: "managed destroy failed", name: "destroy sandbox fixture-sandbox" }],
      passed: [
        "delete OpenShell sandbox fixture-sandbox",
        "remove gateway nemoclaw",
        "remove trusted EXDEV fixture images",
      ],
    });
  });

  it("reclaims an image whose immutable identity assertion fails in LIFO order", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry();
    const host = {
      command: vi.fn(async (_command: string, args: string[]) => {
        calls.push(`image:${args.at(-1)}`);
        return commandResult();
      }),
    };
    const images = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: { PATH: "/usr/bin" },
      host,
    });
    cleanup.add("delete fixture sandbox", () => {
      calls.push("sandbox");
    });

    const imageV1 = trustedExdevImageRef("cleanup-v1");
    const imageV2 = trustedExdevImageRef("cleanup-v2");
    expect(
      acceptTrustedPluginFixturePrebuild({
        images,
        prebuild: {
          createArgs: ["--from", imageV1, "--name", "fixture-sandbox"],
          imageId: IMAGE_ID,
          imageRef: imageV1,
        },
        sandboxName: "fixture-sandbox",
        version: "v1",
      }),
    ).toEqual({ imageId: IMAGE_ID, imageRef: imageV1 });
    expect(() =>
      acceptTrustedPluginFixturePrebuild({
        images,
        prebuild: {
          createArgs: ["--from", imageV2, "--name", "fixture-sandbox"],
          imageId: null,
          imageRef: imageV2,
        },
        sandboxName: "fixture-sandbox",
        version: "v2",
      }),
    ).toThrow("trusted EXDEV fixture prebuild must retain its immutable local image identity");

    expect(await cleanup.runAll()).toEqual({
      failures: [],
      passed: ["delete fixture sandbox", "remove trusted EXDEV fixture images"],
    });
    expect(calls).toEqual(["sandbox", `image:${imageV2}`, `image:${imageV1}`]);
    expect(host.command).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["image", "rm", "--force", imageV2],
      expect.objectContaining({ artifactName: "cleanup-trusted-exdev-image-v2" }),
    );
  });

  it("continues reclaiming images after a removal fails and reports the failure", async () => {
    const cleanup = new CleanupRegistry();
    let removal = 0;
    const host = {
      command: vi.fn(async () => {
        removal += 1;
        return removal === 1 ? commandResult(1, "removal denied") : commandResult();
      }),
    };
    const images = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: { PATH: "/usr/bin" },
      host,
    });
    const imageV1 = trustedExdevImageRef("cleanup-failure-v1");
    const imageV2 = trustedExdevImageRef("cleanup-failure-v2");
    images.track(imageV1, "v1");
    images.track(imageV2, "v2");

    const result = await cleanup.runAll();

    expect(result.passed).toEqual([]);
    expect(result.failures).toEqual([
      {
        message: expect.stringContaining(`${imageV2}: removal denied`),
        name: "remove trusted EXDEV fixture images",
      },
    ]);
    expect(host.command).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["image", "rm", "--force", imageV2],
      expect.objectContaining({ artifactName: "cleanup-trusted-exdev-image-v2" }),
    );
    expect(host.command).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["image", "rm", "--force", imageV1],
      expect.objectContaining({ artifactName: "cleanup-trusted-exdev-image-v1" }),
    );
  });
});
