// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import { ROOT } from "../../runner";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import {
  finalizePreparedRebuildImageMessagingPlan,
  type PreparedRebuildImage,
  preflightRebuildImage,
  type RebuildImagePreflightResult,
} from "./rebuild-custom-image-preflight";
import {
  createBuildContextVerifier,
  disposePreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";

type SuccessfulPreflight = Extract<RebuildImagePreflightResult, { ok: true }>;

function successful(result: RebuildImagePreflightResult): SuccessfulPreflight {
  expect(result.ok).toBe(true);
  return result as SuccessfulPreflight;
}

function input(fromDockerfile: string | null) {
  return {
    agent: null,
    fromDockerfile,
    model: "model",
    provider: "ollama-local",
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    webSearchConfig: null,
    toolDisclosure: "progressive" as const,
    hermesToolGateways: [],
    sandboxGpuConfig: {
      mode: "0" as const,
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    gatewayPort: 8080,
    chatUiUrl: "http://127.0.0.1:18789",
  };
}

function hermesMessagingPlan() {
  return {
    schemaVersion: 1 as const,
    sandboxName: "alpha",
    agent: "hermes" as const,
    workflow: "rebuild" as const,
    channels: [
      {
        channelId: "slack",
        displayName: "Slack",
        authMode: "token-paste" as const,
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("preflightRebuildImage", () => {
  it("carries verified base provenance into the retained managed context (#7144)", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-provenance-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const metadata = {
      schema: 1,
      key: "current-base",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      ref: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      source: "pinned",
      pinnedRemoteRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      imageId: `sha256:${"b".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    } satisfies SandboxBaseImageResolutionMetadata;
    const prepareDockerfilePatch = vi.fn(async () => ({
      buildId: "provenance",
      dashboardRemoteBindPrepared: false,
      resolvedBaseImage: null,
    }));
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    try {
      const result = successful(
        await preflightRebuildImage(
          { ...input(null), preResolvedBaseImageMetadata: metadata },
          {
            stageBuildContext: vi.fn(() => ({
              buildCtx,
              stagedDockerfile,
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch,
            buildImage: vi.fn(() => ({ status: 0 }) as never),
            removeImage: vi.fn(() => ({ status: 0 }) as never),
          },
        ),
      );

      expect(prepareDockerfilePatch).toHaveBeenCalledWith(
        expect.objectContaining({ preResolvedBaseImageMetadata: metadata }),
      );
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("prebuilds the managed OpenClaw image instead of deferring its first build until delete", async () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-preflight-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\n");
    const buildImage = vi.fn(() => ({ status: 0 }) as never);
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const stageBuildContext = vi.fn(() => ({
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx,
      origin: "generated" as const,
    }));
    try {
      const result = successful(
        await preflightRebuildImage(input(null), {
          stageBuildContext,
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      expect(stageBuildContext).toHaveBeenCalledWith(
        expect.objectContaining({ root: ROOT, agent: null }),
      );
      expect(buildImage).toHaveBeenCalledOnce();
      expect(cleanupBuildCtx).not.toHaveBeenCalled();
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
      expect(cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked build-context root before the preflight build",
    async () => {
      const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-root-link-"));
      const targetBuildCtx = path.join(testRoot, "target");
      const linkedBuildCtx = path.join(testRoot, "context");
      fs.mkdirSync(targetBuildCtx);
      fs.writeFileSync(path.join(targetBuildCtx, "Dockerfile"), "FROM scratch\n");
      fs.symlinkSync(targetBuildCtx, linkedBuildCtx, "dir");
      const cleanupBuildCtx = vi.fn(() => {
        fs.rmSync(linkedBuildCtx, { force: true });
        return true;
      });
      const buildImage = vi.fn(() => ({ status: 0 }) as never);

      try {
        await expect(
          preflightRebuildImage(input(null), {
            stageBuildContext: vi.fn(() => ({
              buildCtx: linkedBuildCtx,
              stagedDockerfile: path.join(linkedBuildCtx, "Dockerfile"),
              cleanupBuildCtx,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "root-link",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            buildImage,
            removeImage: vi.fn(() => ({ status: 0 }) as never),
          }),
        ).resolves.toEqual({
          ok: false,
          detail: "build-context root must be a real directory",
        });
        expect(buildImage).not.toHaveBeenCalled();
        expect(cleanupBuildCtx).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["malformed syntax", "THIS IS NOT A DOCKERFILE"],
    ["missing COPY context", "FROM scratch\nCOPY missing.txt /missing.txt\n"],
  ])("fails before delete for %s", async (_label, dockerfileContents) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, dockerfileContents);
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "1",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage: vi.fn(() => ({ status: 1, stderr: "dockerfile validation failed" }) as never),
        removeImage,
      });
      expect(result).toEqual({ ok: false, detail: "dockerfile validation failed" });
      expect(removeImage).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces redacted Buffer diagnostics when the replacement image build fails (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-diagnostic-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    const credential = ["release", "diagnostic", "credential"].join("-");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    try {
      const result = await preflightRebuildImage(input(dockerfile), {
        prepareDockerfilePatch: vi.fn(async () => ({
          buildId: "1",
          dashboardRemoteBindPrepared: false,
          resolvedBaseImage: null,
        })),
        buildImage: vi.fn(
          () =>
            ({
              status: 1,
              stderr: Buffer.from(
                `failed to solve: build context unavailable at ${os.homedir()}/private-context\n` +
                  `Authorization: Bearer ${credential}`,
              ),
            }) as never,
        ),
        removeImage: vi.fn(() => ({ status: 0 }) as never),
      });

      expect(result).toEqual({
        ok: false,
        detail:
          "failed to solve: build context unavailable at ~/private-context\n" +
          "Authorization: Bearer <REDACTED>",
      });
      expect(JSON.stringify(result)).not.toContain(credential);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates rebuild preflight from an unavailable WSL Docker Desktop helper (#7111)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-rebuild-preflight-"));
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
    const dockerfile = path.join(dir, "Dockerfile");
    const originalConfig = JSON.stringify({
      auths: { "registry.example.com": { auth: "must-remain-private" } },
      credsStore: "desktop.exe",
    });
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    fs.writeFileSync(path.join(dockerConfig, "config.json"), originalConfig);
    let isolatedConfig = "";
    const credentialHelperResponds = vi.fn(() => false);
    try {
      const result = successful(
        await preflightRebuildImage(input(null), {
          stageBuildContext: vi.fn(() => ({
            buildCtx: dir,
            stagedDockerfile: dockerfile,
            cleanupBuildCtx: () => true,
            origin: "generated" as const,
          })),
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "wsl-safe-preflight",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage: vi.fn((_dockerfile, _tag, _context, options) => {
            isolatedConfig = String(options.env?.DOCKER_CONFIG);
            expect(isolatedConfig).toContain("nemoclaw-wsl-buildkit-docker-config-");
            expect(isolatedConfig).not.toBe(dockerConfig);
            expect(options.env?.DOCKER_HOST).toBe("unix:///selected-docker.sock");
            expect(options.env?.DOCKER_CONTEXT).toBeUndefined();
            expect(options.env?.DOCKER_BUILDKIT).toBe("1");
            expect(
              JSON.parse(fs.readFileSync(path.join(isolatedConfig, "config.json"), "utf8")),
            ).toEqual({ auths: {} });
            return { status: 0 } as never;
          }),
          removeImage: vi.fn(() => ({ status: 0 }) as never),
          env: {
            DOCKER_CONFIG: dockerConfig,
            DOCKER_CONTEXT: "ambient-remote",
            DOCKER_HOST: "unix:///selected-docker.sock",
            WSL_DISTRO_NAME: "Ubuntu",
          },
          credentialHelperResponds,
          isWslHost: true,
        }),
      );

      expect(credentialHelperResponds).toHaveBeenCalledOnce();
      expect(fs.existsSync(isolatedConfig)).toBe(false);
      expect(fs.readFileSync(path.join(dockerConfig, "config.json"), "utf8")).toBe(originalConfig);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dockerConfig, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "uses the isolated config across the WSL helper and Docker subprocess boundary (#7111)",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-rebuild-process-"));
      const executableRoot = path.join(root, "bin");
      const dockerConfig = path.join(root, "docker-config");
      const buildCtx = path.join(root, "context");
      const dockerfile = path.join(buildCtx, "Dockerfile");
      const helperMarker = path.join(root, "helper-invoked");
      const dockerMarker = path.join(root, "docker-config-used");
      fs.mkdirSync(executableRoot);
      fs.mkdirSync(dockerConfig);
      fs.mkdirSync(buildCtx);
      fs.writeFileSync(dockerfile, "FROM scratch\n");
      fs.writeFileSync(
        path.join(dockerConfig, "config.json"),
        JSON.stringify({
          auths: { "registry.example.com": { auth: "must-remain-private" } },
          credsStore: "desktop.exe",
        }),
      );
      fs.writeFileSync(
        path.join(executableRoot, "docker-credential-desktop.exe"),
        ["#!/bin/sh", `printf 'invoked\\n' > "${helperMarker}"`, "exit 1", ""].join("\n"),
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(executableRoot, "docker"),
        [
          "#!/bin/sh",
          "set -eu",
          'if [ "$1" = "build" ]; then',
          '  [ "$DOCKER_HOST" = "unix:///selected-docker.sock" ]',
          '  [ -z "${DOCKER_CONTEXT+x}" ]',
          '  [ -n "${DOCKER_CONFIG:-}" ]',
          `  [ "$DOCKER_CONFIG" != "${dockerConfig}" ]`,
          '  grep -Fqx \'{"auths":{}}\' "$DOCKER_CONFIG/config.json"',
          `  printf '%s\\n' "$DOCKER_CONFIG" > "${dockerMarker}"`,
          "fi",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      vi.stubEnv(
        "PATH",
        `${executableRoot}${path.delimiter}${String(process.env.PATH ?? "")}`,
      );

      try {
        const result = successful(
          await preflightRebuildImage(input(null), {
            stageBuildContext: vi.fn(() => ({
              buildCtx,
              stagedDockerfile: dockerfile,
              cleanupBuildCtx: () => true,
              origin: "generated" as const,
            })),
            prepareDockerfilePatch: vi.fn(async () => ({
              buildId: "wsl-process-boundary",
              dashboardRemoteBindPrepared: false,
              resolvedBaseImage: null,
            })),
            env: {
              DOCKER_CONFIG: dockerConfig,
              DOCKER_CONTEXT: "ambient-remote",
              DOCKER_HOST: "unix:///selected-docker.sock",
              WSL_DISTRO_NAME: "Ubuntu",
            },
            isWslHost: true,
          }),
        );

        expect(fs.readFileSync(helperMarker, "utf8")).toBe("invoked\n");
        const isolatedConfig = fs.readFileSync(dockerMarker, "utf8").trim();
        expect(isolatedConfig).toContain("nemoclaw-wsl-buildkit-docker-config-");
        expect(fs.existsSync(isolatedConfig)).toBe(false);
        expect(disposePreparedBuildContext(result.prepared)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves Docker credentials while building the exact staged custom context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-"));
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-docker-config-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    const originalConfig = JSON.stringify({
      auths: { "private.example.com": { auth: "required-by-custom-image" } },
      credsStore: "desktop.exe",
    });
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    fs.writeFileSync(path.join(dockerConfig, "config.json"), originalConfig);
    const buildImage = vi.fn((_dockerfile, _tag, _context, options) => {
      expect(options.env?.DOCKER_CONFIG).toBe(dockerConfig);
      return { status: 0 } as never;
    });
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    const credentialHelperResponds = vi.fn(() => false);
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage,
          removeImage,
          env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
          credentialHelperResponds,
          isWslHost: true,
        }),
      );
      expect(buildImage).toHaveBeenCalledWith(
        expect.stringContaining("Dockerfile"),
        expect.stringMatching(/^nemoclaw-rebuild-preflight:/),
        expect.any(String),
        expect.objectContaining({ ignoreError: true }),
      );
      expect(removeImage).toHaveBeenCalledOnce();
      expect(credentialHelperResponds).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(dockerConfig, "config.json"), "utf8")).toBe(originalConfig);
      expect(fs.existsSync(result.prepared.buildCtx)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dockerConfig, { recursive: true, force: true });
    }
  });

  it("pins a symlinked Dockerfile before the source link can be swapped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-link-"));
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(path.join(dir, "Dockerfile.safe"), "FROM scratch\n# safe\n");
    fs.writeFileSync(path.join(dir, "Dockerfile.changed"), "FROM scratch\n# changed\n");
    fs.symlinkSync("Dockerfile.safe", dockerfile);
    const builtDockerfiles: string[] = [];
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: false,
            resolvedBaseImage: null,
          })),
          buildImage: vi.fn((stagedDockerfile) => {
            builtDockerfiles.push(fs.readFileSync(stagedDockerfile, "utf8"));
            return { status: 0 } as never;
          }),
          removeImage: vi.fn(() => ({ status: 0 }) as never),
        }),
      );

      fs.unlinkSync(dockerfile);
      fs.symlinkSync("Dockerfile.changed", dockerfile);

      expect(builtDockerfiles).toEqual(["FROM scratch\n# safe\n"]);
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      const stagedFd = fs.openSync(
        result.prepared.stagedDockerfile,
        fs.constants.O_RDONLY | noFollow,
      );
      try {
        expect(fs.fstatSync(stagedFd).isFile()).toBe(true);
        expect(fs.readFileSync(stagedFd, "utf8")).toBe("FROM scratch\n# safe\n");
      } finally {
        fs.closeSync(stagedFd);
      }
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and retries at process exit when a built preflight image cannot be removed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preflight-cleanup-"));
    const dockerfile = path.join(dir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const removeImage = vi
      .fn()
      .mockReturnValueOnce({ status: 1 } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerExitHandler = vi.fn((listener: () => void) => {
      listener();
    });
    try {
      const result = successful(
        await preflightRebuildImage(input(dockerfile), {
          prepareDockerfilePatch: vi.fn(async () => ({
            buildId: "1",
            dashboardRemoteBindPrepared: true,
            resolvedBaseImage: null,
          })),
          buildImage: vi.fn(() => ({ status: 0 }) as never),
          removeImage,
          registerExitHandler,
        }),
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to remove temporary rebuild preflight image"),
      );
      expect(registerExitHandler).toHaveBeenCalledWith(expect.any(Function));
      expect(removeImage).toHaveBeenCalledTimes(2);
      expect(result.prepared.dashboardRemoteBindPrepared).toBe(true);
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finalizePreparedRebuildImageMessagingPlan", () => {
  it("rebuilds backup-captured home channels with the WSL-safe Docker environment (#7111, #7803)", () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-finalize-"));
    const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-finalize-wsl-config-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const originalDockerConfig = JSON.stringify({ credsStore: "desktop.exe" });
    fs.writeFileSync(stagedDockerfile, "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=old\n");
    fs.writeFileSync(path.join(dockerConfig, "config.json"), originalDockerConfig);
    const cleanupBuildCtx = vi.fn(() => {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    });
    const originalFingerprint = fingerprintBuildContext(buildCtx);
    const prepared: PreparedRebuildImage = {
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx,
      buildId: "finalize",
      origin: "generated",
      contextFingerprint: originalFingerprint,
      verifyBuildCtx: createBuildContextVerifier(buildCtx, originalFingerprint),
      rebuildTarget: { agentName: "hermes", fromDockerfile: null },
    };
    const builtDockerfiles: string[] = [];
    let isolatedConfig = "";
    const removeImage = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = successful(
        finalizePreparedRebuildImageMessagingPlan(
          prepared,
          hermesMessagingPlan(),
          [
            {
              path: ".env",
              assignments: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID=123.456"],
            },
          ],
          {
            buildImage: vi.fn((dockerfile, _tag, _context, options) => {
              builtDockerfiles.push(fs.readFileSync(dockerfile, "utf8"));
              isolatedConfig = String(options.env?.DOCKER_CONFIG);
              expect(isolatedConfig).not.toBe(dockerConfig);
              expect(
                JSON.parse(fs.readFileSync(path.join(isolatedConfig, "config.json"), "utf8")),
              ).toEqual({ auths: {} });
              return { status: 0 } as never;
            }),
            removeImage,
            env: { DOCKER_CONFIG: dockerConfig, WSL_DISTRO_NAME: "Ubuntu" },
            credentialHelperResponds: () => false,
            isWslHost: true,
          },
        ),
      );

      const encodedPlan = builtDockerfiles[0]
        ?.split("\n")
        .find((line) => line.startsWith("ARG NEMOCLAW_MESSAGING_PLAN_B64="))
        ?.split("=")[1];
      const imagePlan = JSON.parse(Buffer.from(encodedPlan ?? "", "base64").toString("utf8")) as {
        agentRender: Array<{ renderId?: string; lines?: string[] }>;
      };
      expect(imagePlan.agentRender[0]).toMatchObject({
        renderId: "hermes-preserved-home-channels",
        lines: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID=123.456"],
      });
      expect(result.prepared.contextFingerprint).not.toBe(originalFingerprint);
      expect(verifyPreparedBuildContext(result.prepared)).toBe(true);
      expect(removeImage).toHaveBeenCalledOnce();
      expect(fs.existsSync(isolatedConfig)).toBe(false);
      expect(fs.readFileSync(path.join(dockerConfig, "config.json"), "utf8")).toBe(
        originalDockerConfig,
      );
      expect(disposePreparedBuildContext(result.prepared)).toBe(true);
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      fs.rmSync(dockerConfig, { recursive: true, force: true });
    }
  });

  it("refuses to bless a retained context that changed before backup finalization", () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-finalize-drift-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=old\n");
    const contextFingerprint = fingerprintBuildContext(buildCtx);
    const prepared: PreparedRebuildImage = {
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx: () => true,
      buildId: "drift",
      origin: "generated",
      contextFingerprint,
      verifyBuildCtx: createBuildContextVerifier(buildCtx, contextFingerprint),
      rebuildTarget: { agentName: "hermes", fromDockerfile: null },
    };
    const buildImage = vi.fn();
    try {
      fs.writeFileSync(path.join(buildCtx, "changed"), "changed");

      expect(
        finalizePreparedRebuildImageMessagingPlan(
          prepared,
          hermesMessagingPlan(),
          [{ path: ".env", assignments: ["SLACK_HOME_CHANNEL=C0123"] }],
          { buildImage },
        ),
      ).toEqual({
        ok: false,
        detail: "replacement build context changed before backup finalization",
      });
      expect(buildImage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });

  it("retries finalization image cleanup at process exit", () => {
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-finalize-cleanup-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=old\n");
    const contextFingerprint = fingerprintBuildContext(buildCtx);
    const prepared: PreparedRebuildImage = {
      buildCtx,
      stagedDockerfile,
      cleanupBuildCtx: () => true,
      buildId: "finalize-cleanup",
      origin: "generated",
      contextFingerprint,
      verifyBuildCtx: createBuildContextVerifier(buildCtx, contextFingerprint),
      rebuildTarget: { agentName: "hermes", fromDockerfile: null },
    };
    const removeImage = vi
      .fn()
      .mockReturnValueOnce({ status: 1 } as never)
      .mockReturnValueOnce({ status: 0 } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerExitHandler = vi.fn((listener: () => void) => {
      listener();
    });
    try {
      expect(
        finalizePreparedRebuildImageMessagingPlan(
          prepared,
          hermesMessagingPlan(),
          [{ path: ".env", assignments: ["SLACK_HOME_CHANNEL=C0123"] }],
          {
            buildImage: vi.fn(() => ({ status: 0 }) as never),
            removeImage,
            registerExitHandler,
          },
        ).ok,
      ).toBe(true);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to remove temporary rebuild finalization image"),
      );
      expect(registerExitHandler).toHaveBeenCalledWith(expect.any(Function));
      expect(removeImage).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  });
});
