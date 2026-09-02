// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  managedPrImageContract,
  type ManagedPrImageExpectedIdentity,
  publishManagedPrImageBundle,
  validateManagedPrImageBundle,
} from "../../../tools/e2e/managed-pr-image-publisher.mts";

let fixtureRoot: string | undefined;

function digest(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeJson(file: string, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  fs.writeFileSync(file, body);
  return body;
}

function imageBundle(
  platform: "linux/amd64" | "linux/arm64",
  options: { onBuild?: string[]; receiptRevision?: string } = {},
): { expected: ManagedPrImageExpectedIdentity; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-pr-image-"));
  fixtureRoot = root;
  const layout = path.join(root, "layout");
  const blobs = path.join(layout, "blobs", "sha256");
  fs.mkdirSync(blobs, { recursive: true });
  const expected: ManagedPrImageExpectedIdentity = {
    agent: "openclaw",
    candidateSha: "a".repeat(40),
    image: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
    platform,
    runAttempt: "2",
    runId: "12345",
  };
  const architecture = platform.slice("linux/".length);
  const cohort = `ghrun-${expected.runId}-${expected.runAttempt}`;
  const layer = Buffer.from("bounded candidate layer");
  const layerDigest = digest(layer);
  fs.writeFileSync(path.join(blobs, layerDigest.slice(7)), layer);
  const config = {
    architecture,
    os: "linux",
    config: {
      User: "root",
      ...(options.onBuild ? { OnBuild: options.onBuild } : {}),
      Labels: {
        "io.nvidia.nemoclaw.agent": expected.agent,
        "io.nvidia.nemoclaw.managed-image.contract": "1",
        "io.nvidia.nemoclaw.managed-image.platform": platform,
        "io.nvidia.nemoclaw.managed-image.startup-profile": "1",
        "io.nvidia.nemoclaw.managed-image.capabilities": "1",
        "io.nvidia.nemoclaw.managed-image.cohort": cohort,
        "org.opencontainers.image.revision": expected.candidateSha,
        "org.opencontainers.image.version": "v1.2.3",
      },
    },
    rootfs: { type: "layers", diff_ids: [layerDigest] },
  };
  const configBody = Buffer.from(JSON.stringify(config));
  const configDigest = digest(configBody);
  fs.writeFileSync(path.join(blobs, configDigest.slice(7)), configBody);
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configBody.length,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layerDigest,
        size: layer.length,
      },
    ],
  };
  const manifestBody = Buffer.from(JSON.stringify(manifest));
  const manifestDigest = digest(manifestBody);
  fs.writeFileSync(path.join(blobs, manifestDigest.slice(7)), manifestBody);
  writeJson(path.join(layout, "oci-layout"), { imageLayoutVersion: "1.0.0" });
  writeJson(path.join(layout, "index.json"), {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: manifestBody.length,
        platform: { architecture, os: "linux" },
      },
    ],
  });
  writeJson(path.join(root, "receipt.json"), {
    bundleVersion: 1,
    agent: expected.agent,
    platform,
    image: expected.image,
    manifestDigest,
    source: {
      repository: "NVIDIA/NemoClaw",
      revision: options.receiptRevision ?? expected.candidateSha,
      release: "v1.2.3",
      cohort,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
    },
  });
  return { expected, root };
}

afterEach(() => {
  fs.rmSync(fixtureRoot ?? path.join(os.tmpdir(), "nemoclaw-no-managed-pr-image-fixture"), {
    force: true,
    recursive: true,
  });
  fixtureRoot = undefined;
});

describe("trusted managed PR image publisher", () => {
  it.each(["linux/amd64", "linux/arm64"] as const)(
    "accepts one exact authenticated %s OCI artifact",
    async (platform) => {
      const fixture = imageBundle(platform);
      await expect(validateManagedPrImageBundle(fixture.root, fixture.expected)).resolves.toEqual({
        cohort: "ghrun-12345-2",
        layoutReference: expect.stringMatching(/\/layout@sha256:[0-9a-f]{64}$/u),
        manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        release: "v1.2.3",
      });
    },
  );

  it("publishes only after validation and then removes registry credentials", async () => {
    const fixture = imageBundle("linux/amd64");
    const calls: string[] = [];
    const registry = {
      login: vi.fn(() => {
        calls.push("login");
      }),
      logout: vi.fn(() => {
        calls.push("logout");
      }),
      publish: vi.fn(() => {
        calls.push("publish");
        return `sha256:${"c".repeat(64)}`;
      }),
    };

    await expect(
      publishManagedPrImageBundle(fixture.root, fixture.expected, registry),
    ).resolves.toEqual({ digest: `sha256:${"c".repeat(64)}`, release: "v1.2.3" });
    expect(calls).toEqual(["login", "publish", "logout"]);
  });

  it("removes registry credentials when publication fails", async () => {
    const fixture = imageBundle("linux/amd64");
    const registry = {
      login: vi.fn(),
      logout: vi.fn(),
      publish: vi.fn(() => {
        throw new Error("registry rejected publication");
      }),
    };

    await expect(
      publishManagedPrImageBundle(fixture.root, fixture.expected, registry),
    ).rejects.toThrow("registry rejected publication");
    expect(registry.login).toHaveBeenCalledOnce();
    expect(registry.publish).toHaveBeenCalledOnce();
    expect(registry.logout).toHaveBeenCalledOnce();
  });

  it("fails closed when the artifact receipt names another candidate", async () => {
    const fixture = imageBundle("linux/amd64", { receiptRevision: "b".repeat(40) });
    await expect(validateManagedPrImageBundle(fixture.root, fixture.expected)).rejects.toThrow(
      "candidate source revision",
    );
  });

  it("rejects candidate ONBUILD execution before the publisher logs in", async () => {
    const fixture = imageBundle("linux/amd64", { onBuild: ["RUN id"] });
    await expect(validateManagedPrImageBundle(fixture.root, fixture.expected)).rejects.toThrow(
      "must not execute ONBUILD commands",
    );
  });

  it("rejects unreferenced artifact content", async () => {
    const fixture = imageBundle("linux/amd64");
    fs.writeFileSync(path.join(fixture.root, "layout", "blobs", "sha256", "f".repeat(64)), "x");
    await expect(validateManagedPrImageBundle(fixture.root, fixture.expected)).rejects.toThrow(
      "unreferenced or missing file",
    );
  });

  it("blocks registry authentication and publication for an invalid artifact", async () => {
    const fixture = imageBundle("linux/amd64");
    fs.writeFileSync(path.join(fixture.root, "layout", "blobs", "sha256", "f".repeat(64)), "x");
    const registry = {
      login: vi.fn(),
      logout: vi.fn(),
      publish: vi.fn(() => `sha256:${"c".repeat(64)}`),
    };

    await expect(
      publishManagedPrImageBundle(fixture.root, fixture.expected, registry),
    ).rejects.toThrow("unreferenced or missing file");
    expect(registry.login).not.toHaveBeenCalled();
    expect(registry.publish).not.toHaveBeenCalled();
    expect(registry.logout).not.toHaveBeenCalled();
  });

  it("writes an immutable contract for only the authenticated source identity", () => {
    const fixture = imageBundle("linux/arm64");
    expect(
      managedPrImageContract(fixture.expected, `sha256:${"c".repeat(64)}`, "v1.2.3"),
    ).toMatchObject({
      agent: "openclaw",
      platform: "linux/arm64",
      reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"c".repeat(64)}`,
      source: {
        cohort: "ghrun-12345-2",
        repository: "NVIDIA/NemoClaw",
        revision: "a".repeat(40),
      },
    });
  });
});
