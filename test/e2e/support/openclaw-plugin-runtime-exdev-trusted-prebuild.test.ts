// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE,
} from "../../../src/lib/onboard/openshell-feature-gate.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  acceptTrustedPluginFixturePrebuild,
  createOpenShellTrustedImageWrapper,
  registerTrustedPluginFixtureImageCleanup,
  trustedExdevImageRef,
} from "../live/openclaw-plugin-runtime-exdev-trusted-prebuild.ts";
import {
  resolveOpenShellSiblingComponents,
  withOpenShellDriverConfigWrapperEnv,
} from "../live/openshell-driver-config-test-wrapper.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const DRIVER_CONFIG_JSON = JSON.stringify({
  docker: { mounts: [{ options: ["noexec"], target: "/tmp/exdev", type: "tmpfs" }] },
  podman: { mounts: [{ options: ["noexec"], target: "/tmp/exdev", type: "tmpfs" }] },
});

afterEach(() => vi.unstubAllEnvs());

function createWrapperFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exdev-wrapper-test-"));
  const delegate = path.join(directory, "real-openshell");
  const gateway = path.join(directory, "openshell-gateway");
  const sandbox = path.join(directory, "openshell-sandbox");
  const executableSource =
    '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo \'openshell 0.0.106\'; exit 0; fi\nprintf \'%s\\n\' "$@"\n';
  for (const executable of [delegate, gateway]) {
    fs.writeFileSync(executable, executableSource, { encoding: "utf8", mode: 0o700 });
  }
  fs.writeFileSync(sandbox, `${executableSource}# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  const components = resolveOpenShellSiblingComponents(delegate);
  const wrapper = createOpenShellTrustedImageWrapper({
    driverConfigJson: DRIVER_CONFIG_JSON,
    realOpenshellPath: components.cli,
  });
  return {
    components,
    directory,
    remove: () => {
      wrapper.remove();
      fs.rmSync(directory, { force: true, recursive: true });
    },
    wrapper,
  };
}

describe("trusted EXDEV OpenShell wrapper", () => {
  it("rewrites sandbox creation to the selected local image and injects driver config", () => {
    const fixture = createWrapperFixture();
    try {
      const imageRef = trustedExdevImageRef("wrapper-contract-v1");
      fixture.wrapper.selectImage(imageRef);
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
      expect(valuesFor("--from")).toEqual([imageRef]);
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
      expect(() => fixture.wrapper.selectImage("docker.io/untrusted:latest")).toThrow();
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
      fixture.wrapper.selectImage(trustedExdevImageRef("wrapper-contract-v1"));
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
      fixture.wrapper.selectImage(trustedExdevImageRef("wrapper-contract-v1"));
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

  it("passes the OpenShell feature gate and exposes sibling component paths", () => {
    const fixture = createWrapperFixture();
    try {
      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: fixture.wrapper.executable,
          gatewayBin: fixture.components.gateway,
          sandboxBin: fixture.components.sandbox,
          allowExternalGatewayBin: true,
          allowExternalSandboxBin: true,
        }),
      ).toBe(true);
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
