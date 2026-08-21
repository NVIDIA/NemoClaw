// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACTION_PATH = path.join(
  ROOT,
  ".github",
  "actions",
  "resolve-reviewed-hermes-platform",
  "action.yaml",
);
const REVIEWED_INDEX = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"9".repeat(64)}`;
const NATIVE_DIGEST = `sha256:${"2".repeat(64)}`;
const ARM64_NATIVE_DIGEST = `sha256:${"4".repeat(64)}`;

type CompositeAction = {
  inputs?: Record<string, { required?: boolean }>;
  outputs?: Record<string, { value?: string }>;
  runs?: { steps?: Array<{ id?: string; run?: string }>; using?: string };
};

function action(): CompositeAction {
  return YAML.parse(readFileSync(ACTION_PATH, "utf8")) as CompositeAction;
}

function runAction(
  options: {
    checksumDigest?: string;
    dockerfile?: string;
    indexJson?: string;
    platform?: string;
  } = {},
) {
  const fixture = mkdtempSync(path.join(tmpdir(), "nemoclaw-hermes-platform-action-"));
  const bin = path.join(fixture, "bin");
  const dockerfile = path.join(fixture, "Dockerfile");
  const dockerLog = path.join(fixture, "docker.log");
  const output = path.join(fixture, "github-output");
  const runnerTemp = path.join(fixture, "runner-temp");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(dockerfile, options.dockerfile ?? `ARG BASE_IMAGE=${REVIEWED_INDEX}\n`);
  writeFileSync(dockerLog, "");
  writeFileSync(output, "");

  const indexJson =
    options.indexJson ??
    JSON.stringify({
      manifests: [
        {
          digest: NATIVE_DIGEST,
          platform: { architecture: "amd64", os: "linux" },
        },
      ],
      mediaType: "application/vnd.oci.image.index.v1+json",
    });
  const docker = path.join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
set -eu
ref="$4"
printf '%s\n' "$ref" >> ${JSON.stringify(dockerLog)}
case "$ref" in
  '${REVIEWED_INDEX}') printf '%s\n' ${JSON.stringify(indexJson)} ;;
  'ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${NATIVE_DIGEST}') printf '%s\n' '{"kind":"native"}' ;;
  'ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${ARM64_NATIVE_DIGEST}') printf '%s\n' '{"kind":"native"}' ;;
  *) exit 97 ;;
esac
`,
  );
  chmodSync(docker, 0o700);
  const sha256sum = path.join(bin, "sha256sum");
  writeFileSync(
    sha256sum,
    `#!/bin/sh
set -eu
printf '%s  %s\n' ${JSON.stringify((options.checksumDigest ?? NATIVE_DIGEST).slice("sha256:".length))} "$1"
`,
  );
  chmodSync(sha256sum, 0o700);

  const script = action().runs?.steps?.find((step) => step.id === "resolve")?.run;
  expect(script).toBeTypeOf("string");
  try {
    const result = spawnSync("bash", ["-c", script ?? ""], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        DOCKERFILE_PATH: dockerfile,
        GITHUB_OUTPUT: output,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PLATFORM: options.platform ?? "linux/amd64",
        RUNNER_TEMP: runnerTemp,
      },
    });
    return {
      dockerCalls: readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean),
      output: readFileSync(output, "utf8"),
      result,
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

describe("reviewed Hermes platform resolver action", () => {
  // source-shape-contract: security -- GitHub must expose the verified digest from the composite resolver step to protected workflow consumers
  it("publishes the verified native manifest digest", () => {
    const value = action();
    expect(value.runs?.using).toBe("composite");
    expect(value.inputs).toMatchObject({
      "dockerfile-path": { required: true },
      platform: { required: true },
    });
    expect(value.outputs?.digest?.value).toBe("${{ steps.resolve.outputs.digest }}");

    const { dockerCalls, output, result } = runAction();
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe(`digest=${NATIVE_DIGEST}\n`);
    expect(dockerCalls).toEqual([
      REVIEWED_INDEX,
      `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${NATIVE_DIGEST}`,
    ]);
  });

  it("selects and verifies the Arm64 descriptor from a multi-platform index", () => {
    const { dockerCalls, output, result } = runAction({
      checksumDigest: ARM64_NATIVE_DIGEST,
      indexJson: JSON.stringify({
        manifests: [
          {
            digest: NATIVE_DIGEST,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            digest: ARM64_NATIVE_DIGEST,
            platform: { architecture: "arm64", os: "linux" },
          },
        ],
        mediaType: "application/vnd.oci.image.index.v1+json",
      }),
      platform: "linux/arm64",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe(`digest=${ARM64_NATIVE_DIGEST}\n`);
    expect(dockerCalls).toEqual([
      REVIEWED_INDEX,
      `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${ARM64_NATIVE_DIGEST}`,
    ]);
  });

  it.each([
    ["missing index", "FROM scratch\n"],
    ["mutable index", "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest\n"],
    ["multiple indexes", `ARG BASE_IMAGE=${REVIEWED_INDEX}\nARG BASE_IMAGE=${REVIEWED_INDEX}\n`],
  ])("fails closed for a %s", (_case, dockerfile) => {
    const { result } = runAction({ dockerfile });
    expect(result.status).not.toBe(0);
  });

  it("rejects an index without one native platform descriptor", () => {
    const { result } = runAction({
      indexJson: JSON.stringify({
        manifests: [],
        mediaType: "application/vnd.oci.image.index.v1+json",
      }),
    });
    expect(result.status).not.toBe(0);
  });

  it.each([
    ["invalid JSON", "not-json"],
    [
      "a single-image manifest",
      JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json" }),
    ],
    [
      "duplicate native descriptors",
      JSON.stringify({
        manifests: [
          {
            digest: NATIVE_DIGEST,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            digest: `sha256:${"4".repeat(64)}`,
            platform: { architecture: "amd64", os: "linux" },
          },
        ],
        mediaType: "application/vnd.oci.image.index.v1+json",
      }),
    ],
  ])("fails closed when the reviewed index contains %s", (_case, indexJson) => {
    const { result } = runAction({ indexJson });
    expect(result.status).not.toBe(0);
  });

  it("rejects duplicate Arm64 descriptors from a multi-platform index", () => {
    const { dockerCalls, result } = runAction({
      indexJson: JSON.stringify({
        manifests: [
          {
            digest: NATIVE_DIGEST,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            digest: ARM64_NATIVE_DIGEST,
            platform: { architecture: "arm64", os: "linux" },
          },
          {
            digest: `sha256:${"6".repeat(64)}`,
            platform: { architecture: "arm64", os: "linux" },
          },
        ],
        mediaType: "application/vnd.oci.image.index.v1+json",
      }),
      platform: "linux/arm64",
    });

    expect(result.status).not.toBe(0);
    expect(dockerCalls).toEqual([REVIEWED_INDEX]);
  });

  it("rejects native manifest bytes that do not match the selected digest", () => {
    const { result } = runAction({ checksumDigest: `sha256:${"3".repeat(64)}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("manifest bytes do not match");
  });

  it("rejects unsupported platforms before image inspection", () => {
    const { dockerCalls, result } = runAction({ platform: "linux/s390x" });
    expect(result.status).not.toBe(0);
    expect(dockerCalls).toEqual([]);
  });
});
