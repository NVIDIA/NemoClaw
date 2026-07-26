// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const CLOUDLFARED_STEP_NAME = "Install and verify cloudflared prerequisite";

interface CloudflaredPin {
  version: string;
  debSha256: string;
}

function requirePin(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`inference-routing ${label} is missing or invalid`);
  }
  return value;
}

export function readInferenceRoutingCloudflaredPin(
  workflowPath = path.join(REPO_ROOT, ".github", "workflows", "e2e.yaml"),
): CloudflaredPin {
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; env?: Record<string, unknown> }> }>;
  };
  const step = workflow.jobs?.["inference-routing"]?.steps?.find(
    (candidate) => candidate.name === CLOUDLFARED_STEP_NAME,
  );
  return {
    version: requirePin(
      step?.env?.CLOUDFLARED_VERSION,
      "cloudflared version pin",
      /^\d+\.\d+\.\d+$/,
    ),
    debSha256: requirePin(
      step?.env?.CLOUDFLARED_DEB_SHA256,
      "cloudflared SHA256 pin",
      /^[0-9a-f]{64}$/,
    ),
  };
}

async function commandOutput(
  host: HostCliClient,
  command: string,
  args: string[],
  artifactName: string,
): Promise<string> {
  const result = await host.command(command, args, {
    artifactName: `inference-routing-cloudflared-${artifactName}`,
    captureLimitBytes: 4 * 1024 * 1024,
    cwd: REPO_ROOT,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} failed while preparing cloudflared: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export async function resolveVerifiedCloudflaredBinary(
  cleanup: Pick<CleanupRegistry, "add">,
  host: HostCliClient,
  runtime: Pick<NodeJS.Process, "platform" | "arch"> = process,
): Promise<string> {
  if (runtime.platform !== "linux" || runtime.arch !== "x64") {
    throw new Error("cloudflared is required for the DNS-backed HTTPS routing proof");
  }

  const pin = readInferenceRoutingCloudflaredPin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-"));
  cleanup.add(`remove verified cloudflared prerequisite ${root}`, () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deb = path.join(root, `cloudflared-${pin.version}-linux-amd64.deb`);
  const url =
    `https://github.com/cloudflare/cloudflared/releases/download/${pin.version}/` +
    "cloudflared-linux-amd64.deb";
  await commandOutput(
    host,
    "curl",
    ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https", url, "--output", deb],
    "download",
  );

  const actualSha256 = createHash("sha256").update(fs.readFileSync(deb)).digest("hex");
  if (actualSha256 !== pin.debSha256) {
    throw new Error(`cloudflared package SHA256 mismatch: expected ${pin.debSha256}`);
  }
  const packageName = (
    await commandOutput(host, "dpkg-deb", ["-f", deb, "Package"], "package-name")
  ).trim();
  const version = (
    await commandOutput(host, "dpkg-deb", ["-f", deb, "Version"], "package-version")
  ).trim();
  const architecture = (
    await commandOutput(host, "dpkg-deb", ["-f", deb, "Architecture"], "package-architecture")
  ).trim();
  if (packageName !== "cloudflared" || version !== pin.version || architecture !== "amd64") {
    throw new Error(
      `unexpected cloudflared package metadata: package=${packageName} version=${version} architecture=${architecture}`,
    );
  }

  const extracted = path.join(root, "extracted");
  await commandOutput(host, "dpkg-deb", ["-x", deb, extracted], "extract");
  const binary = path.join(extracted, "usr", "bin", "cloudflared");
  fs.accessSync(binary, fs.constants.X_OK);
  const reportedVersion = await commandOutput(host, binary, ["--version"], "verify-version");
  if (!reportedVersion.includes(`cloudflared version ${pin.version}`)) {
    throw new Error(`unexpected cloudflared version output: ${reportedVersion.trim()}`);
  }
  return binary;
}
