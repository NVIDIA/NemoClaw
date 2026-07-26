// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_APT_SECURITY_HASHES,
  baseAptSecurityFunctions,
  dockerRunCommandBetween,
  runLoggedDockerShell,
} from "./helpers/base-apt-security-functions";

const ROOT = path.resolve(import.meta.dirname, "..");
const SECURITY_IMAGES = [
  {
    name: "OpenClaw",
    dockerfile: path.join(ROOT, "Dockerfile.base"),
    startMarker: "# Trixie has not published fixes",
    endMarker: "# gosu for privilege separation",
  },
  {
    name: "Hermes",
    dockerfile: path.join(ROOT, "agents", "hermes", "Dockerfile.base"),
    startMarker: "# Install the reviewed libexpat, jq, and Vim packages",
    endMarker: "COPY scripts/lib/reviewed-npm-archive.mts",
  },
  {
    name: "Deep Agents Code",
    dockerfile: path.join(ROOT, "agents", "langchain-deepagents-code", "Dockerfile.base"),
    startMarker: "# Install the reviewed libexpat, jq, and Vim packages",
    endMarker: "# Node remains available",
  },
] as const;
const ARCHITECTURES = ["amd64", "arm64"] as const;
const SECURITY_CASES = SECURITY_IMAGES.flatMap((image) =>
  ARCHITECTURES.map((architecture) => [image.name, architecture, image] as const),
);

function sandboxSecurityCommand(
  image: (typeof SECURITY_IMAGES)[number],
  tmp: string,
): { command: string; securityDebs: string } {
  const lists = path.join(tmp, "apt-lists");
  const securityDebs = path.join(tmp, "security-debs");
  const fakePython3 = path.join(tmp, "usr-bin", "python3");
  const fakePythonLink = path.join(tmp, "usr-local-bin", "python");
  fs.mkdirSync(lists);
  fs.mkdirSync(path.dirname(fakePython3), { recursive: true });
  fs.mkdirSync(path.dirname(fakePythonLink), { recursive: true });
  fs.writeFileSync(fakePython3, "#!/bin/sh\n", { mode: 0o755 });

  const dockerfile = fs.readFileSync(image.dockerfile, "utf-8");
  const command = dockerRunCommandBetween(dockerfile, image.startMarker, image.endMarker)
    .replaceAll("/var/lib/apt/lists", lists)
    .replaceAll("/tmp/nemoclaw-debian-security", securityDebs)
    .replaceAll("/usr/local/bin/python", fakePythonLink)
    .replaceAll("/usr/bin/python3", fakePython3);
  return { command, securityDebs };
}

describe("sandbox base security packages", () => {
  it.each(
    SECURITY_CASES,
  )("executes the exact security package contract for %s on %s", (_name, architecture, image) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-security-"));
    const { command, securityDebs } = sandboxSecurityCommand(image, tmp);

    try {
      const result = runLoggedDockerShell(command, tmp, [
        'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
        ...baseAptSecurityFunctions(architecture),
      ]);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      const calls = fs.readFileSync(path.join(tmp, "calls.log"), "utf-8");
      expect(calls).toContain("dpkg-install");
      expect(
        calls
          .split("\n")
          .filter((line) => line.startsWith("download "))
          .map((line) => line.slice(line.lastIndexOf("/") + 1)),
      ).toEqual([
        `libexpat1_2.8.2-1_${architecture}.deb`,
        `libonig5_6.9.9-1+b1_${architecture}.deb`,
        `libjq1_1.8.2-1_${architecture}.deb`,
        `jq_1.8.2-1_${architecture}.deb`,
        "vim-common_9.2.0782-1_all.deb",
        `vim-tiny_9.2.0782-1_${architecture}.deb`,
      ]);
      expect(fs.existsSync(securityDebs)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(
    SECURITY_CASES,
  )("rejects a changed expected checksum before installing packages for %s on %s", (_name, architecture, image) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-checksum-"));
    const prepared = sandboxSecurityCommand(image, tmp);
    const command = prepared.command.replace(
      BASE_APT_SECURITY_HASHES[architecture].libexpat,
      "0".repeat(64),
    );

    try {
      const result = runLoggedDockerShell(command, tmp, [
        'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
        ...baseAptSecurityFunctions(architecture),
      ]);
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(path.join(tmp, "calls.log"), "utf-8")).not.toContain("dpkg-install");
      expect(fs.existsSync(prepared.securityDebs)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
