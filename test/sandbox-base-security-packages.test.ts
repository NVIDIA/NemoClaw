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
import { stageFixedParser, useRealPatchedParser } from "./helpers/python-parser-security-fixture";

const ROOT = path.resolve(import.meta.dirname, "..");
const SECURITY_IMAGES = [
  {
    name: "OpenClaw",
    dockerfile: path.join(ROOT, "Dockerfile.base"),
    finalDockerfile: path.join(ROOT, "Dockerfile"),
    startMarker: "# Trixie has not published fixes",
    endMarker: "# gosu for privilege separation",
  },
  {
    name: "Hermes",
    dockerfile: path.join(ROOT, "agents", "hermes", "Dockerfile.base"),
    finalDockerfile: path.join(ROOT, "agents", "hermes", "Dockerfile"),
    startMarker: "# Install the reviewed libexpat, jq, and Vim packages",
    endMarker: "COPY scripts/lib/reviewed-npm-archive.mts",
  },
  {
    name: "Deep Agents Code",
    dockerfile: path.join(ROOT, "agents", "langchain-deepagents-code", "Dockerfile.base"),
    finalDockerfile: path.join(ROOT, "agents", "langchain-deepagents-code", "Dockerfile"),
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
): {
  command: string;
  inventory: string;
  debianSecurityDebs: string;
  nativeSecurityDebs: string;
  pythonShim: string;
} {
  const lists = path.join(tmp, "apt-lists");
  const debianSecurityDebs = path.join(tmp, "debian-security-debs");
  const nativeSecurityDebs = path.join(tmp, "native-security-debs");
  const inventoryDirectory = path.join(tmp, "security-inventory");
  const inventory = path.join(inventoryDirectory, "security-packages.txt");
  const fakePythonLink = path.join(tmp, "usr-local-bin", "python");
  const { fixedParser, pythonShim } = stageFixedParser(tmp);
  fs.mkdirSync(lists);
  fs.mkdirSync(debianSecurityDebs);
  fs.mkdirSync(nativeSecurityDebs);
  fs.mkdirSync(path.dirname(fakePythonLink), { recursive: true });
  fs.writeFileSync(path.join(nativeSecurityDebs, "libssh2-1t64.deb"), "fixed libssh2");
  fs.writeFileSync(
    path.join(nativeSecurityDebs, "nemoclaw-python3.13-htmlparser-fix.deb"),
    "fixed parser package",
  );

  const dockerfile = fs.readFileSync(image.dockerfile, "utf-8");
  const command = dockerRunCommandBetween(dockerfile, image.startMarker, image.endMarker)
    .replaceAll("/var/lib/apt/lists", lists)
    .replaceAll("/tmp/nemoclaw-debian-security", debianSecurityDebs)
    .replaceAll("/tmp/nemoclaw-native-security", nativeSecurityDebs)
    .replaceAll("/usr/local/share/nemoclaw/security-packages.txt", inventory)
    .replaceAll("/usr/local/share/nemoclaw", inventoryDirectory)
    .replaceAll("/usr/local/bin/python", fakePythonLink)
    .replaceAll("/usr/bin/python3", pythonShim)
    .replaceAll("/usr/lib/python3.13/html/parser.py", fixedParser);
  return { command, inventory, debianSecurityDebs, nativeSecurityDebs, pythonShim };
}

function securityInventory(architecture: (typeof ARCHITECTURES)[number]): string {
  return [
    `architecture=${architecture}`,
    "libexpat1=2.8.2-1",
    "libonig5=6.9.9-1+b1",
    "libjq1=1.8.2-1",
    "jq=1.8.2-1",
    "vim-common=2:9.2.0782-1",
    "vim-tiny=2:9.2.0782-1",
    "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw1",
    "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1",
    "",
  ].join("\n");
}

function completedImageSecurityCommand(
  image: (typeof SECURITY_IMAGES)[number],
  tmp: string,
  architecture: (typeof ARCHITECTURES)[number],
): { command: string; inventory: string; pythonShim: string } {
  const inventory = path.join(tmp, "security-packages.txt");
  const { fixedParser, pythonShim } = stageFixedParser(tmp);
  fs.writeFileSync(inventory, securityInventory(architecture), { mode: 0o444 });
  const dockerfile = fs.readFileSync(image.finalDockerfile, "utf-8");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Verify the immutable security package inventory in the completed image.",
    "# End completed-image security package verification.",
  )
    .replaceAll("/usr/local/share/nemoclaw/security-packages.txt", inventory)
    .replaceAll("/usr/lib/python3.13/html/parser.py", fixedParser);
  return { command, inventory, pythonShim };
}

describe("sandbox base security packages", () => {
  it.each(
    SECURITY_CASES,
  )("executes the exact security package contract for %s on %s", (_name, architecture, image) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-security-"));
    const prepared = sandboxSecurityCommand(image, tmp);

    try {
      const result = runLoggedDockerShell(prepared.command, tmp, [
        'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
        'install() { [[ "$#" -eq 8 && "$1" == "-d" && "$2" == "-o" && "$3" == "root" && "$4" == "-g" && "$5" == "root" && "$6" == "-m" && "$7" == "0755" ]] || return 64; mkdir -p "$8"; }',
        'chown() { [[ "$#" -eq 2 && "$1" == "root:root" ]] || return 64; }',
        ...useRealPatchedParser(baseAptSecurityFunctions(architecture), prepared.pythonShim),
      ]);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      const calls = fs.readFileSync(path.join(tmp, "calls.log"), "utf-8");
      expect(calls).toContain("dpkg-install");
      expect(fs.readFileSync(prepared.inventory, "utf-8")).toBe(securityInventory(architecture));
      expect(fs.statSync(prepared.inventory).mode & 0o777).toBe(0o444);
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
      expect(prepared.debianSecurityDebs).not.toBe(prepared.nativeSecurityDebs);
      expect(fs.existsSync(prepared.debianSecurityDebs)).toBe(false);
      expect(fs.existsSync(prepared.nativeSecurityDebs)).toBe(image.name === "OpenClaw");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(
    SECURITY_CASES,
  )("executes the completed-image package contract for %s on %s", (_name, architecture, image) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-final-security-"));
    const prepared = completedImageSecurityCommand(image, tmp, architecture);

    try {
      const result = runLoggedDockerShell(prepared.command, tmp, [
        [
          "stat() {",
          `  [[ "$#" -eq 3 && "$1" == "-c" && "$2" == "%u:%g:%a" && "$3" == ${JSON.stringify(prepared.inventory)} ]] || return 64`,
          '  printf "0:0:444\\n"',
          "}",
        ].join("\n"),
        ...useRealPatchedParser(baseAptSecurityFunctions(architecture), prepared.pythonShim),
      ]);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
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
        ...useRealPatchedParser(baseAptSecurityFunctions(architecture), prepared.pythonShim),
      ]);
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(path.join(tmp, "calls.log"), "utf-8")).not.toContain("dpkg-install");
      expect(fs.existsSync(prepared.debianSecurityDebs)).toBe(true);
      expect(fs.existsSync(prepared.nativeSecurityDebs)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
