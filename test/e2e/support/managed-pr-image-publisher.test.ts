// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  managedPrImageContract,
  type ManagedPrImageExpectedIdentity,
  validateManagedPrImageBundle,
} from "../../../tools/e2e/managed-pr-image-publisher.mts";
import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

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

  it("keeps package authority out of PR-controlled jobs and binds it to the trusted publisher", () => {
    const source = readWorkflow("managed-images.yaml");
    expect(source.permissions).toEqual({ contents: "read" });
    expect(
      required(source.jobs?.["pr-reviewed-npm-audit"], "missing PR audit").permissions,
    ).not.toHaveProperty("packages");
    expect(
      required(source.jobs?.["pr-staging-qa-deep-code"], "missing PR staging QA").permissions,
    ).not.toHaveProperty("packages");
    expect(
      required(source.jobs?.["pr-build-and-entrypoint"], "missing PR builder").permissions,
    ).not.toHaveProperty("packages");
    expect(
      required(source.jobs?.["pi-candidate"], "missing Pi candidate").permissions,
    ).not.toHaveProperty("packages");
    const prBuilder = required(source.jobs?.["pr-build-and-entrypoint"], "missing PR builder");
    expect(JSON.stringify(prBuilder)).not.toContain("secrets.GITHUB_TOKEN");
    expect(
      step(prBuilder, "Upload the credential-free candidate image bundle").with?.name,
    ).toContain("managed-pr-image-");

    const controller = readWorkflow("managed-runtime-base-qualification.yaml");
    const publisher = required(
      controller.jobs?.["publish-candidate-images"],
      "missing trusted candidate publisher",
    );
    expect(publisher).toMatchObject({
      needs: "authenticate-source",
      permissions: { actions: "read", contents: "read", packages: "write" },
    });
    expect(step(publisher, "Check out the trusted image publisher").with?.ref).toBe(
      "${{ github.workflow_sha }}",
    );
    expect(
      step(publisher, "Download the exact authenticated candidate image bundle").with,
    ).toMatchObject({
      "run-id": "${{ needs.authenticate-source.outputs.source_run_id }}",
      name: expect.stringContaining("managed-pr-image-"),
    });
    const steps = publisher.steps ?? [];
    expect(
      steps.indexOf(
        step(publisher, "Validate the authenticated OCI artifact without executing it"),
      ),
    ).toBeLessThan(steps.indexOf(step(publisher, "Log in only inside the trusted publisher")));
    expect(step(publisher, "Publish the validated OCI artifact by digest").with).toMatchObject({
      context: "trusted",
      file: "trusted/tools/e2e/managed-pr-image-publisher.Dockerfile",
      "build-contexts": "candidate=oci-layout://${{ steps.bundle.outputs.oci_reference }}",
      outputs:
        "type=image,name=${{ matrix.repository }},push-by-digest=true,name-canonical=true,push=true",
    });
  });
});
