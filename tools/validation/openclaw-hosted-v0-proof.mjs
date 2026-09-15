// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const captureDir = fs.realpathSync(process.argv[2]);
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.join(captureDir, "artifacts", "ubuntu-repo-cloud-openclaw");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const command = (file, args) => execFileSync(file, args, { encoding: "utf8" }).trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exportBytes = fs.readFileSync(path.join(captureDir, "v0-export.yaml"));
const capture = readJson(path.join(captureDir, "v0-capture.json"));
const cleanup = readJson(path.join(artifactDir, "cleanup.json"));
const target = readJson(path.join(artifactDir, "target-result.json"));

if (cleanup.failures?.length !== 0 || target.status !== "passed") {
  throw new Error("v0 target or cleanup did not pass");
}
const exportText = exportBytes.toString("utf8");
const secret = process.env.NVIDIA_INFERENCE_API_KEY ?? "";
if (exportText.includes("nvapi-") || (secret && exportText.includes(secret))) {
  throw new Error("v0 export contains the NVIDIA credential");
}
const release = Object.fromEntries(
  fs
    .readFileSync("/etc/os-release", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
    }),
);
const docker = (format) => command("docker", ["version", "--format", format]);
const proof = {
  scenario: "openclaw-nvidia-hosted-linux-docker",
  revision: "f47724f29838fe08898993fad1c8c6b7fcb3e080",
  manifestSha256: "35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b",
  validationOverlaySha256: sha256(
    fs.readFileSync(path.join(toolsDir, "openclaw-hosted-v0-capture.patch")),
  ),
  target: "ubuntu-repo-cloud-openclaw",
  passed: true,
  realAgentResponse: capture.realAgentResponse === true,
  exported: true,
  exportSha256: sha256(exportBytes),
  destroyed: true,
  ownedResourcesOnly: true,
  redacted: true,
  input: { credentialRefs: ["NVIDIA_INFERENCE_API_KEY"] },
  platform: {
    os: "linux",
    architecture: command("uname", ["-m"]),
    kernel: command("uname", ["-sr"]),
    linuxRelease: `${release.ID}:${release.VERSION_ID}`,
  },
  runtime: {
    containerEngine: "docker",
    dockerClientVersion: docker("{{.Client.Version}}"),
    dockerServerVersion: docker("{{.Server.Version}}"),
    dockerServerOs: docker("{{.Server.Os}}"),
    dockerServerArchitecture: docker("{{.Server.Arch}}"),
    dockerDaemonId: command("docker", ["info", "--format", "{{.ID}}"]),
  },
  images: capture.images,
  model: { id: capture.model },
  commands: [
    "npm run test:live-e2e -- test/e2e/live/registry-targets.test.ts -t ^ubuntu-repo-cloud-openclaw: --silent=false --reporter=default",
    ...capture.commands,
    "v0 fixture cleanup (verified by cleanup.json)",
  ],
  artifacts: {
    cleanup: {
      path: "artifacts/ubuntu-repo-cloud-openclaw/cleanup.json",
      sha256: sha256(fs.readFileSync(path.join(artifactDir, "cleanup.json"))),
    },
    targetResult: {
      path: "artifacts/ubuntu-repo-cloud-openclaw/target-result.json",
      sha256: sha256(fs.readFileSync(path.join(artifactDir, "target-result.json"))),
    },
  },
};
const serialized = `${JSON.stringify(proof, null, 2)}\n`;
if (serialized.includes("nvapi-") || (secret && serialized.includes(secret))) {
  throw new Error("v0 proof contains the NVIDIA credential");
}
fs.writeFileSync(path.join(captureDir, "v0-proof.json"), serialized, { flag: "wx" });
