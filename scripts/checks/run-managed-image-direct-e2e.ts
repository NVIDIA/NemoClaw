#!/usr/bin/env -S node --no-warnings

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../src/lib/onboard/managed-image/contract.ts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile.ts";
import {
  MANAGED_STARTUP_CA_ENV,
  MANAGED_STARTUP_PROFILE_ENV,
} from "../../src/lib/onboard/managed-startup/transport.ts";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "./generate-managed-startup-profile-fixture.mts";
import type { ProtectedManagedImagePlatform } from "./protected-managed-image-contract.ts";

const CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE_RE = /^sha256:[a-f0-9]{64}$/u;
const IMMUTABLE_REFERENCE_RE = /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/u;

export interface ManagedImageDirectE2eInputs {
  readonly agent: ShippedManagedImageAgent;
  readonly image: string;
  readonly platform: ProtectedManagedImagePlatform;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function requiredArgument(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
}

export function parseManagedImageDirectE2eInputs(
  argv: readonly string[],
): ManagedImageDirectE2eInputs {
  const agent = requiredArgument(argv, "--agent");
  const image = requiredArgument(argv, "--image");
  const platform = requiredArgument(argv, "--platform");
  const knownFlags = new Set(["--agent", "--image", "--platform"]);
  if (argv.length !== 6 || argv.some((value, index) => index % 2 === 0 && !knownFlags.has(value))) {
    throw new Error(
      "usage: --agent <agent> --image <immutable> --platform <linux/amd64|linux/arm64>",
    );
  }
  if (!(SHIPPED_MANAGED_IMAGE_AGENTS as readonly string[]).includes(agent)) {
    throw new Error("--agent must identify a shipped managed-image agent");
  }
  if (!IMMUTABLE_REFERENCE_RE.test(image)) {
    throw new Error("--image must be an immutable image ID or digest reference");
  }
  if (platform !== "linux/amd64" && platform !== "linux/arm64") {
    throw new Error("--platform must be linux/amd64 or linux/arm64");
  }
  return { agent: agent as ShippedManagedImageAgent, image, platform };
}

function docker(args: readonly string[], ignoreError = false): CommandResult {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  const normalized = {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
  if (normalized.status !== 0 && !ignoreError) {
    throw new Error(
      `docker ${args[0] ?? "command"} failed: ${normalized.stderr.trim().slice(-2000)}`,
    );
  }
  return normalized;
}

function managedConfig(agent: ShippedManagedImageAgent): string {
  switch (agent) {
    case "openclaw":
      return "/sandbox/.openclaw/openclaw.json";
    case "hermes":
      return "/sandbox/.hermes/config.yaml";
    case "langchain-deepagents-code":
      return "/sandbox/.deepagents/config.toml";
  }
}

function waitForNativeStartup(containerId: string): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = docker(
      ["exec", "--user", "sandbox", containerId, "test", "-s", "/tmp/nemoclaw-native-startup-uid"],
      true,
    );
    if (probe.status === 0) return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error("native managed-image startup did not reach its command boundary");
}

export function runManagedImageDirectE2e(input: ManagedImageDirectE2eInputs): void {
  const expectedImageId = docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    input.image,
  ]).stdout.trim();
  if (!IMMUTABLE_IMAGE_RE.test(expectedImageId)) {
    throw new Error("managed image reference did not resolve to one immutable local image ID");
  }
  const encodedProfile = encodeManagedStartupProfile(
    managedStartupE2eProfile(input.agent, false, true, true),
  );
  const corporateCa = Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64");
  const finalCommand = [
    "id -u > /tmp/nemoclaw-native-startup-uid",
    "exec /usr/bin/tail -f /dev/null",
  ].join("\n");
  let containerId = "";
  try {
    containerId = docker([
      "run",
      "-d",
      "--platform",
      input.platform,
      "--network",
      "none",
      "--entrypoint",
      "/usr/bin/env",
      "--env",
      `${MANAGED_STARTUP_PROFILE_ENV}=${encodedProfile}`,
      "--env",
      `${MANAGED_STARTUP_CA_ENV}=${corporateCa}`,
      input.image,
      "/usr/local/bin/nemoclaw-start",
      "/bin/sh",
      "-c",
      finalCommand,
    ]).stdout.trim();
    if (!CONTAINER_ID_RE.test(containerId)) {
      throw new Error("docker run did not return one exact container identity");
    }
    waitForNativeStartup(containerId);
    const inspected = JSON.parse(docker(["inspect", "--type", "container", containerId]).stdout) as
      | Array<{ Id?: string; Image?: string; State?: { Running?: boolean } }>
      | undefined;
    const container = inspected?.[0];
    if (
      inspected?.length !== 1 ||
      container?.Id !== containerId ||
      container.Image !== expectedImageId ||
      container.State?.Running !== true
    ) {
      throw new Error("native startup did not retain one running exact-image container");
    }
    const uid = docker([
      "exec",
      "--user",
      "sandbox",
      containerId,
      "cat",
      "/tmp/nemoclaw-native-startup-uid",
    ]).stdout.trim();
    if (!/^[0-9]+$/u.test(uid) || uid === "0") {
      throw new Error("native startup command did not run as the sandbox user");
    }
    const config = docker([
      "exec",
      "--user",
      "sandbox",
      containerId,
      "cat",
      managedConfig(input.agent),
    ]).stdout;
    if (!config.includes("nvidia/nemotron-3-ultra-550b-a55b")) {
      throw new Error("managed agent configuration does not contain the requested model");
    }
    process.stdout.write(
      `Direct exact-image native startup passed for ${input.agent} on ${input.platform}.\n`,
    );
  } finally {
    if (CONTAINER_ID_RE.test(containerId)) docker(["rm", "-f", containerId], true);
  }
}

function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry!)).href === importMetaUrl;
}

if (isMain(import.meta.url)) {
  runManagedImageDirectE2e(parseManagedImageDirectE2eInputs(process.argv.slice(2)));
}
