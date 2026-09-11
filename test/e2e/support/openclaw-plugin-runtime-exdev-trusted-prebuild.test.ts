// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  isForwardServiceListenerOwner,
  type ForwardServiceTarget,
} from "../../../src/lib/adapters/openshell/forward-service.ts";
import { patchStagedDockerfile } from "../../../src/lib/onboard/dockerfile-patch.ts";
import { ordinaryOpenClawPairingIncompleteMessage } from "../../../src/lib/onboard/machine/finalization-deps.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { captureIssue4462FailureDiagnostics } from "../fixtures/issue-4462-diagnostics.ts";
import { runOpenClawPluginWithFailureEvidence } from "../fixtures/openclaw-plugin-runtime-exdev-onboard.ts";
import { withCanonicalOpenShellEnv } from "../../helpers/openshell-components.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  acceptTrustedPluginFixturePrebuild,
  buildOpenClawPluginLifecycleOnboardArgs,
  createTrustedPluginFixtureHandoff,
  createTrustedPluginFixtureHostMountSource,
  createTrustedPluginFixtureDockerfile,
  crossDevicePluginInstall,
  extractTrustedPluginFixtureToHost,
  normalizeSandboxStdoutFrames,
  parseCrossDeviceInstallEvidence,
  registerTrustedPluginFixtureImageCleanup,
  renderTrustedPluginFixtureHandoffDockerfile,
  TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR,
  TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR,
  trustedExdevImageRef,
  writeTrustedPluginFixtureHandoff,
} from "../live/openclaw-plugin-runtime-exdev-trusted-prebuild.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const IMAGE_ID_V2 = `sha256:${"b".repeat(64)}`;
const CONTAINER_ID = "c".repeat(64);
const ONBOARD_OPERATION = "openclaw-plugin-runtime-exdev.onboard-pairing";
const RECREATE_OPERATION = "openclaw-plugin-runtime-exdev.recreate-pairing";

function canonicalListenerProbe(commandLine: string) {
  return vi
    .fn()
    .mockReturnValueOnce({ status: 0, stdout: "4321\n" })
    .mockReturnValueOnce({ status: 0, stdout: `p4321\nftxt\nn${process.execPath}\n` })
    .mockReturnValueOnce({ status: 0, stdout: commandLine })
    .mockReturnValueOnce({ status: 0, stdout: "4321\n" });
}

afterEach(() => vi.unstubAllEnvs());

it("restores sandbox as the generated Dockerfile's final user (#9844)", () => {
  const dockerfile = createTrustedPluginFixtureDockerfile({
    crossDeviceVersionSourceName: "weather-version-v2.ts",
    pluginDirName: "weather-plugin",
    source: "FROM ${BASE_IMAGE}\nUSER sandbox\n",
    versionSourceName: "weather-version-v1.ts",
  });

  expect(dockerfile).toContain("FROM ${BASE_IMAGE} AS nemoclaw-runtime");
  expect(dockerfile.trimEnd()).toMatch(/USER sandbox$/);
});

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

  it("does not capture pairing diagnostics for a non-pairing onboarding failure (#9844)", async () => {
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

  it("preserves the pairing failure when diagnostic execution throws (#9844)", async () => {
    const sandboxName = "fixture-sandbox";
    const run = vi.fn(async () =>
      onboardResult(
        1,
        ordinaryOpenClawPairingIncompleteMessage(sandboxName, "pairing-unavailable"),
      ),
    );
    const diagnosticExec = vi.fn(async () => {
      throw new Error("diagnostics unavailable");
    });

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
  });
});

describe("OpenClaw plugin recreation pairing evidence", () => {
  it("records successful recreation without diagnostics (#9844)", async () => {
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

  it("captures diagnostics and stops when recreation scope warm-up fails (#9844)", async () => {
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

describe("trusted EXDEV immutable image handoff", () => {
  it("renders the validated immutable base and required tool-disclosure contract (#11547)", () => {
    expect(renderTrustedPluginFixtureHandoffDockerfile(IMAGE_ID)).toBe(
      `FROM ${IMAGE_ID}\nARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=\${NEMOCLAW_TOOL_DISCLOSURE}\n`,
    );
  });

  it.each([
    "openshell/nemoclaw-sandbox:test",
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
  ])("rejects an untrusted immutable-image handoff value: %s (#11547)", (invalid) => {
    expect(() => renderTrustedPluginFixtureHandoffDockerfile(invalid)).toThrow(
      "trusted EXDEV fixture requires an immutable local image ID",
    );
  });

  it("keeps the image ID intact through custom Dockerfile patching and atomic replacement (#11547)", async () => {
    const cleanup = new CleanupRegistry();
    const handoff = createTrustedPluginFixtureHandoff(cleanup);
    writeTrustedPluginFixtureHandoff(handoff, {
      imageId: IMAGE_ID,
      imageRef: trustedExdevImageRef("handoff-v1"),
    });

    patchStagedDockerfile(
      handoff.dockerfilePath,
      "fixture-model",
      "http://127.0.0.1:18789",
      "fixture-build",
      "custom",
      "openai-completions",
      null,
      null,
      false,
      null,
      [],
      { requireToolDisclosureContract: true, toolDisclosure: "direct" },
    );
    expect(fs.readFileSync(handoff.dockerfilePath, "utf8")).toBe(
      `FROM ${IMAGE_ID}\nARG NEMOCLAW_TOOL_DISCLOSURE=direct\nENV NEMOCLAW_TOOL_DISCLOSURE=\${NEMOCLAW_TOOL_DISCLOSURE}\n`,
    );

    writeTrustedPluginFixtureHandoff(handoff, {
      imageId: IMAGE_ID_V2,
      imageRef: trustedExdevImageRef("handoff-v2"),
    });
    const replacement = fs.readFileSync(handoff.dockerfilePath, "utf8");
    expect(replacement).toContain(`FROM ${IMAGE_ID_V2}`);
    expect(replacement).not.toContain(IMAGE_ID);
    expect(fs.readdirSync(handoff.directory)).toEqual(["Dockerfile"]);
    expect(await cleanup.runAll()).toEqual({
      failures: [],
      passed: ["remove trusted EXDEV image handoff"],
    });
  });

  it("selects the canonical CLI as the owner of a canonical listener (#11547)", () => {
    const wrapper = "/tmp/openshell-wrapper";
    const components = {
      cli: process.execPath,
      gateway: "/opt/openshell/bin/openshell-gateway",
      sandbox: "/opt/openshell/bin/openshell-sandbox",
    };
    const environment = withCanonicalOpenShellEnv(
      { PATH: "/usr/bin", NEMOCLAW_OPENSHELL_BIN: wrapper },
      components,
    );
    const target: ForwardServiceTarget = {
      executable: String(environment.NEMOCLAW_OPENSHELL_BIN),
      gatewayName: "nemoclaw",
      localHost: "127.0.0.1",
      localPort: 18_789,
      sandboxName: "e2e-oc-exdev",
      targetHost: "127.0.0.1",
      targetPort: 18_789,
      workspace: "default",
    };
    const canonicalCommand = [components.cli, ...buildForwardServiceArgs(target)].join(" ");

    expect(environment).toEqual({
      PATH: "/usr/bin",
      NEMOCLAW_OPENSHELL_BIN: components.cli,
      NEMOCLAW_OPENSHELL_GATEWAY_BIN: components.gateway,
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: components.sandbox,
    });
    expect(
      isForwardServiceListenerOwner(target, {
        platform: "darwin",
        probe: canonicalListenerProbe(`${canonicalCommand}\n`),
      }),
    ).toBe(true);
    expect(
      isForwardServiceListenerOwner(
        { ...target, executable: wrapper },
        {
          platform: "darwin",
          probe: canonicalListenerProbe(`${canonicalCommand}\n`),
        },
      ),
    ).toBe(false);
  });

  it("constructs fresh and recreation commands with the same read-only host mount (#11547)", () => {
    const options = {
      cliEntrypoint: "/workspace/bin/nemoclaw.js",
      dockerfilePath: "/tmp/handoff/Dockerfile",
      hostMountSource: "/dev/shm/nemoclaw-exdev-source-test",
      sandboxName: "e2e-oc-exdev",
    };
    const initial = buildOpenClawPluginLifecycleOnboardArgs({ ...options, recreate: false });
    const recreate = buildOpenClawPluginLifecycleOnboardArgs({ ...options, recreate: true });

    expect(initial).toEqual([
      options.cliEntrypoint,
      "onboard",
      "--fresh",
      "--non-interactive",
      "--yes",
      "--yes-i-accept-third-party-software",
      "--name",
      options.sandboxName,
      "--agent",
      "openclaw",
      "--from",
      options.dockerfilePath,
      "--host-mount",
      `${options.hostMountSource}:${TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR}`,
    ]);
    expect(recreate).toEqual([
      options.cliEntrypoint,
      "onboard",
      "--fresh",
      "--recreate-sandbox",
      ...initial.slice(3),
    ]);
  });

  it("normalizes framed output and parses only explicit device evidence (#11547)", () => {
    const normalized = normalizeSandboxStdoutFrames(
      "[stdout] source_device=11 target_device=22\nstdout: installed\n",
    );

    expect(normalized).toBe("source_device=11 target_device=22\ninstalled\n");
    expect(parseCrossDeviceInstallEvidence(normalized)).toEqual({
      sourceDevice: "11",
      targetDevice: "22",
    });
    expect(parseCrossDeviceInstallEvidence("installed without stat evidence")).toEqual({
      sourceDevice: null,
      targetDevice: null,
    });
    expect(String(crossDevicePluginInstall)).toContain(
      `openclaw plugins install ${TRUSTED_PLUGIN_FIXTURE_MOUNT_DIR} --force`,
    );
    expect(String(crossDevicePluginInstall)).not.toMatch(/EXDEV guard|rm -rf|cp -R|tmpfs/);
  });
});

function commandResult(exitCode = 0, stderr = "", stdout = ""): ShellProbeResult {
  return {
    artifacts: { result: "result.json", stderr: "stderr.txt", stdout: "stdout.txt" },
    command: ["docker"],
    exitCode,
    signal: null,
    stderr,
    stdout,
    timedOut: false,
  };
}

function populateExtractedFixture(directory: string): void {
  fs.mkdirSync(path.join(directory, "dist"));
  fs.writeFileSync(path.join(directory, "package.json"), "{}\n");
  fs.writeFileSync(path.join(directory, "openclaw.plugin.json"), "{}\n");
  fs.writeFileSync(path.join(directory, "dist", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(directory, "dist", "version.js"), "export const version = 1;\n");
}

function writeContainerIdentity(args: string[], containerId = CONTAINER_ID): void {
  const cidfile = args[args.indexOf("--cidfile") + 1]!;
  fs.writeFileSync(cidfile, `${containerId}\n`);
}

const invalidExtractionDestinations = [
  {
    label: "non-empty",
    prepare: (root: string, cleanup: CleanupRegistry) => {
      const directory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      fs.writeFileSync(path.join(directory, "unexpected"), "occupied\n");
      return directory;
    },
  },
  {
    label: "symbolic-link",
    prepare: (root: string, cleanup: CleanupRegistry) => {
      const directory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const link = path.join(root, "source-link");
      fs.symlinkSync(directory, link);
      return link;
    },
  },
];

describe("trusted EXDEV host mount extraction", () => {
  it("extracts by immutable container identity and removes the stopped container (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const calls: string[][] = [];
      const command = vi
        .fn()
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          writeContainerIdentity(args);
          return commandResult(0, "", "ignored-create-stdout\n");
        })
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          populateExtractedFixture(sourceDirectory);
          return commandResult();
        })
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          return commandResult();
        });
      const host = {
        command,
      };

      await extractTrustedPluginFixtureToHost({
        environment: { PATH: "/usr/bin" },
        host,
        image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
        sourceDirectory,
      });

      expect(calls).toEqual([
        [
          "create",
          "--cidfile",
          expect.stringMatching(/\/nemoclaw-exdev-container-identity-[^/]+\/container\.cid$/),
          "--entrypoint",
          "/bin/true",
          IMAGE_ID,
        ],
        ["cp", `${CONTAINER_ID}:${TRUSTED_PLUGIN_FIXTURE_IMAGE_DIR}/.`, sourceDirectory],
        ["rm", CONTAINER_ID],
      ]);
      expect(fs.statSync(path.join(sourceDirectory, "dist", "index.js")).mode & 0o777).toBe(0o644);
      expect(fs.existsSync(path.dirname(calls[0]![2]!))).toBe(false);
      expect(await cleanup.runAll()).toEqual({
        failures: [],
        passed: ["remove trusted EXDEV host mount source"],
      });
      expect(fs.existsSync(sourceDirectory)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the temporary container after copy failure without using a mutable name (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const calls: string[][] = [];
      const command = vi
        .fn()
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          writeContainerIdentity(args);
          return commandResult();
        })
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          return commandResult(1, "copy failed");
        })
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          return commandResult();
        });
      const host = {
        command,
      };

      await expect(
        extractTrustedPluginFixtureToHost({
          environment: { PATH: "/usr/bin" },
          host,
          image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
          sourceDirectory,
        }),
      ).rejects.toThrow("copy failed");
      expect(calls.at(-1)).toEqual(["rm", CONTAINER_ID]);
      expect(await cleanup.runAll()).toEqual({
        failures: [],
        passed: ["remove trusted EXDEV host mount source"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports both copy and immutable cleanup failures (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const command = vi
        .fn()
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          writeContainerIdentity(args);
          return commandResult();
        })
        .mockImplementationOnce(async () => commandResult(1, "copy failed"))
        .mockImplementationOnce(async () => commandResult(1, "remove failed"));
      const host = {
        command,
      };

      await expect(
        extractTrustedPluginFixtureToHost({
          environment: { PATH: "/usr/bin" },
          host,
          image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
          sourceDirectory,
        }),
      ).rejects.toThrow(/copy failed[\s\S]*remove failed/);
      await cleanup.runAll();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses validated create output only to clean up an unproven cidfile identity (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const calls: string[][] = [];
      const command = vi
        .fn()
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          writeContainerIdentity(args, "short-container-id");
          return commandResult(0, "", `${CONTAINER_ID}\n`);
        })
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          return commandResult();
        });
      const host = {
        command,
      };

      await expect(
        extractTrustedPluginFixtureToHost({
          environment: { PATH: "/usr/bin" },
          host,
          image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
          sourceDirectory,
        }),
      ).rejects.toThrow("returned an invalid identity");
      expect(calls.map((args) => args[0])).toEqual(["create", "rm"]);
      expect(calls.at(-1)).toEqual(["rm", CONTAINER_ID]);
      expect(await cleanup.runAll()).toEqual({
        failures: [],
        passed: ["remove trusted EXDEV host mount source"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the exact cidfile container after create reports failure (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const calls: string[][] = [];
      const command = vi
        .fn()
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          writeContainerIdentity(args);
          return commandResult(1, "create failed");
        })
        .mockImplementationOnce(async (_command: string, args: string[]) => {
          calls.push(args);
          return commandResult();
        });
      const host = {
        command,
      };

      await expect(
        extractTrustedPluginFixtureToHost({
          environment: { PATH: "/usr/bin" },
          host,
          image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
          sourceDirectory,
        }),
      ).rejects.toThrow("trusted EXDEV fixture extraction failed");
      expect(calls.map((args) => args[0])).toEqual(["create", "rm"]);
      expect(calls.at(-1)).toEqual(["rm", CONTAINER_ID]);
      expect(await cleanup.runAll()).toEqual({
        failures: [],
        passed: ["remove trusted EXDEV host mount source"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a thrown container create without attempting copy or cleanup (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const host = {
        command: vi.fn(async () => {
          throw new Error("docker unavailable");
        }),
      };

      await expect(
        extractTrustedPluginFixtureToHost({
          environment: { PATH: "/usr/bin" },
          host,
          image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
          sourceDirectory,
        }),
      ).rejects.toThrow("trusted EXDEV fixture extraction failed");
      expect(host.command).toHaveBeenCalledOnce();
      expect(await cleanup.runAll()).toEqual({
        failures: [],
        passed: ["remove trusted EXDEV host mount source"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(invalidExtractionDestinations)(
    "rejects a $label extraction destination before invoking Docker (#11547)",
    async ({ prepare }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
      const cleanup = new CleanupRegistry();
      try {
        const sourceDirectory = prepare(root, cleanup);
        const host = { command: vi.fn() };

        await expect(
          extractTrustedPluginFixtureToHost({
            environment: { PATH: "/usr/bin" },
            host,
            image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
            sourceDirectory,
          }),
        ).rejects.toThrow(
          "trusted EXDEV extraction destination must be an empty canonical directory",
        );
        expect(host.command).not.toHaveBeenCalled();
        await cleanup.runAll();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an untrusted image value before invoking Docker (#11547)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
    const cleanup = new CleanupRegistry();
    try {
      const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
      const host = { command: vi.fn() };

      await expect(
        extractTrustedPluginFixtureToHost({
          environment: { PATH: "/usr/bin" },
          host,
          image: { imageId: "--help", imageRef: trustedExdevImageRef("extract-v1") },
          sourceDirectory,
        }),
      ).rejects.toThrow("trusted EXDEV fixture requires an immutable local image ID");
      expect(host.command).not.toHaveBeenCalled();
      await cleanup.runAll();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "missing required payload",
      populate: (directory: string) => {
        populateExtractedFixture(directory);
        fs.rmSync(path.join(directory, "openclaw.plugin.json"));
      },
      message: "trusted EXDEV fixture is missing openclaw.plugin.json",
    },
    {
      label: "symbolic link",
      populate: (directory: string) => {
        populateExtractedFixture(directory);
        fs.symlinkSync("package.json", path.join(directory, "unexpected-link"));
      },
      message: "trusted EXDEV fixture contains an unsupported entry: unexpected-link",
    },
  ])(
    "removes the exact container before rejecting a $label (#11547)",
    async ({ populate, message }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-root-"));
      const cleanup = new CleanupRegistry();
      try {
        const sourceDirectory = createTrustedPluginFixtureHostMountSource(cleanup, root);
        const calls: string[][] = [];
        const command = vi
          .fn()
          .mockImplementationOnce(async (_command: string, args: string[]) => {
            calls.push(args);
            writeContainerIdentity(args);
            return commandResult();
          })
          .mockImplementationOnce(async (_command: string, args: string[]) => {
            calls.push(args);
            populate(sourceDirectory);
            return commandResult();
          })
          .mockImplementationOnce(async (_command: string, args: string[]) => {
            calls.push(args);
            return commandResult();
          });
        const host = {
          command,
        };

        await expect(
          extractTrustedPluginFixtureToHost({
            environment: { PATH: "/usr/bin" },
            host,
            image: { imageId: IMAGE_ID, imageRef: trustedExdevImageRef("extract-v1") },
            sourceDirectory,
          }),
        ).rejects.toThrow(message);
        expect(calls.at(-1)).toEqual(["rm", CONTAINER_ID]);
        expect(await cleanup.runAll()).toEqual({
          failures: [],
          passed: ["remove trusted EXDEV host mount source"],
        });
        expect(fs.existsSync(sourceDirectory)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

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
    createTrustedPluginFixtureHandoff(cleanup);
    createTrustedPluginFixtureHostMountSource(cleanup, os.tmpdir());
    expect(() => images.track("docker.io/untrusted:latest", "v1")).toThrow();
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
        "remove trusted EXDEV host mount source",
        "remove trusted EXDEV image handoff",
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
    ).toThrow("trusted EXDEV fixture requires an immutable local image ID");

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
