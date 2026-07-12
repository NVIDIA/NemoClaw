// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

interface OverlayfsAutofixCleanupOptions {
  cleanup: CleanupRegistry;
  cleanupEnv: NodeJS.ProcessEnv;
  gatewayContainer: string;
  host: Pick<HostCliClient, "cleanupGatewayRegistration" | "cleanupSandbox" | "command">;
  preserveSandbox: boolean;
  redactionValues: string[];
  sandbox: Pick<SandboxClient, "cleanupSandbox">;
  sandboxName: string;
}

async function removeOverlayGatewayContainer({
  cleanupEnv,
  gatewayContainer,
  host,
  redactionValues,
}: Pick<
  OverlayfsAutofixCleanupOptions,
  "cleanupEnv" | "gatewayContainer" | "host" | "redactionValues"
>): Promise<void> {
  const removeContainer = await host.command("docker", ["rm", "-f", gatewayContainer], {
    artifactName: "cleanup-overlayfs-gateway-container",
    env: cleanupEnv,
    redactionValues,
    timeoutMs: 5 * 60_000,
  });
  assertCleanupSucceededOrAbsent(
    removeContainer,
    /No such container/i,
    "remove overlayfs gateway container",
  );
}

async function removeOverlayPatchedImages({
  cleanupEnv,
  host,
  redactionValues,
}: Pick<OverlayfsAutofixCleanupOptions, "cleanupEnv" | "host" | "redactionValues">): Promise<void> {
  const imageList = await host.command(
    "docker",
    ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
    {
      artifactName: "cleanup-overlayfs-patched-image-list",
      env: cleanupEnv,
      redactionValues,
      timeoutMs: 5 * 60_000,
    },
  );
  assertExitZero(imageList, "list overlayfs patched images during cleanup");
  const patchedImages = imageList.stdout
    .split(/\r?\n/)
    .map((image) => image.trim())
    .filter((image) => image.startsWith("nemoclaw-cluster:"));
  if (patchedImages.length > 0) {
    const removeImages = await host.command("docker", ["rmi", "-f", ...patchedImages], {
      artifactName: "cleanup-overlayfs-patched-images",
      env: cleanupEnv,
      redactionValues,
      timeoutMs: 5 * 60_000,
    });
    assertExitZero(removeImages, "remove overlayfs patched images");
  }
}

export function trackOverlayfsAutofixCleanup(options: OverlayfsAutofixCleanupOptions): void {
  if (options.preserveSandbox) return;

  const { cleanup, cleanupEnv, gatewayContainer, host, redactionValues, sandbox, sandboxName } =
    options;
  cleanup.trackDisposable("remove overlayfs onboard lock", () => {
    fs.rmSync(path.join(os.homedir(), ".nemoclaw", "onboard.lock"), { force: true });
  });
  cleanup.trackDisposable("remove overlayfs patched images", () =>
    removeOverlayPatchedImages({ cleanupEnv, host, redactionValues }),
  );
  cleanup.trackDisposable("remove overlayfs gateway container", () =>
    removeOverlayGatewayContainer({ cleanupEnv, gatewayContainer, host, redactionValues }),
  );
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-overlayfs-openshell-gateway",
    env: cleanupEnv,
    redactionValues,
    timeoutMs: 5 * 60_000,
  });
  cleanup.trackDisposable(`delete overlayfs OpenShell sandbox ${sandboxName}`, () =>
    sandbox.cleanupSandbox(sandboxName, {
      artifactName: "cleanup-overlayfs-openshell-sandbox-delete",
      env: cleanupEnv,
      redactionValues,
      timeoutMs: 5 * 60_000,
    }),
  );
  cleanup.trackSandbox(host, sandboxName, {
    artifactName: "cleanup-overlayfs-sandbox",
    env: cleanupEnv,
    redactionValues,
    timeoutMs: 5 * 60_000,
  });
}
