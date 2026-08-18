// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER_PATH = path.join(REPO_ROOT, "scripts/install-openshell.sh");
const TOOL_COMMAND =
  "node --experimental-strip-types --no-warnings tools/e2e/openshell-qualification.mts";

export const OPENSHELL_QUALIFICATION = {
  archiveSha256: {
    "openshell-aarch64-apple-darwin.tar.gz":
      "969493205e3d3462226ff613eaba0b9cde0f582e3026294169d533d41e87c905",
    "openshell-aarch64-unknown-linux-musl.tar.gz":
      "ce981904ae8febd9cd6b3fbceb04e1dcfb48da6042bac08eadf0c2211f83fe55",
    "openshell-gateway-aarch64-apple-darwin.tar.gz":
      "de8f90db9dd0d3b47855b2b6d2542660730917bd1249e53140300990a8690b94",
    "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz":
      "22b7781249e3487085694d0f0f3797a0e549018b81144cd24b2f1118c730d1c7",
    "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz":
      "b7760cb752a4363c2f21d32298dd0c683dc438f6edfd16c2e4242bc0baefbb7c",
    "openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz":
      "5e5d758d53c6abc6d7a936be907dafa9dfce10423289536f39b50abe294dfafd",
    "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz":
      "559b8aaad3a8eeab45c511e7de531d9baa98a311282dcb0c2c5f38cc2d4ca355",
    "openshell-x86_64-unknown-linux-musl.tar.gz":
      "d1a885a91b3e5aaa006c36aca95dc78bed0638c1ba1a79b55f1da93211b8a0a0",
    "openshell.rb": "f0f86519e227b3b326431410058ba690b1a7b83e5af7384014e4b96283d3a642",
  },
  binarySha256: {
    cli: "98ecf95113fea999e94a928043e57b04cf58a45a1b66ae8bffc73d1bc8bb1d59",
    gateway: "e6cde8a54568aa1926ff6584ffd6984314c68dad64d2722509618a74094c622c",
    standaloneSandbox: "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8",
  },
  releaseTag: "v0.0.106",
  supportedProductVersion: "0.0.101",
  sourceRepository: "NVIDIA/OpenShell",
  sourceSha: "c4b500a7de64d0b66e3ee8098f58d14299092162",
  supervisor: {
    image: "ghcr.io/nvidia/openshell/supervisor",
    manifestDigest: "sha256:722f44669722961b7f432b0b81de25b91a58f34a61d6403bef967acaf2b3af01",
  },
  version: "0.0.106",
} as const;

export const OPENSHELL_QUALIFICATION_SELECT_STEP = Object.freeze({
  id: "openshell_qualification",
  name: "Select OpenShell qualification release",
  run: `${TOOL_COMMAND} select "$GITHUB_OUTPUT"`,
});

export const OPENSHELL_QUALIFICATION_INSTALL_ENV = Object.freeze({
  NEMOCLAW_OPENSHELL_FORCE_INSTALL: "1",
  NEMOCLAW_OPENSHELL_MAX_VERSION: "${{ steps.openshell_qualification.outputs.version }}",
  NEMOCLAW_OPENSHELL_MIN_VERSION: "${{ steps.openshell_qualification.outputs.version }}",
  NEMOCLAW_OPENSHELL_PIN_VERSION: "${{ steps.openshell_qualification.outputs.version }}",
});

export const OPENSHELL_QUALIFICATION_INSTALL_RUN =
  "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN -u NVIDIA_API_KEY -u NVIDIA_INFERENCE_API_KEY -u GITHUB_TOKEN bash scripts/install-openshell.sh";

export const OPENSHELL_QUALIFICATION_SUPERVISOR_OUTPUT =
  "${{ steps.openshell_qualification.outputs.supervisor_image }}";

export function openShellQualificationProvenanceCommand(outputPath: string): string {
  return `${TOOL_COMMAND} provenance "${outputPath}"`;
}

export function validateOpenShellQualificationInstaller(
  installerPath: string = INSTALLER_PATH,
): string[] {
  const source = fs.readFileSync(installerPath, "utf8");
  const failures: string[] = [];
  for (const [asset, sha256] of Object.entries(OPENSHELL_QUALIFICATION.archiveSha256)) {
    const pin =
      `${OPENSHELL_QUALIFICATION.releaseTag}:${asset})\n` + `      printf '%s\\n' "${sha256}"`;
    if (!source.includes(pin)) failures.push(`installer pin is missing for ${asset}`);
  }
  if (!source.includes(OPENSHELL_QUALIFICATION.binarySha256.standaloneSandbox)) {
    failures.push("installer identity is missing for the Linux x64 sandbox binary");
  }
  return failures;
}

export function writeOpenShellQualificationOutputs(outputPath: string): void {
  const failures = validateOpenShellQualificationInstaller();
  if (failures.length > 0) throw new Error(failures.join("; "));
  const supervisorImage =
    `${OPENSHELL_QUALIFICATION.supervisor.image}@` +
    OPENSHELL_QUALIFICATION.supervisor.manifestDigest;
  fs.appendFileSync(
    outputPath,
    `version=${OPENSHELL_QUALIFICATION.version}\nsupervisor_image=${supervisorImage}\n`,
    "utf8",
  );
}

export function writeOpenShellQualificationProvenance(outputPath: string): void {
  const provenance = {
    schemaVersion: 1,
    sourceRepository: OPENSHELL_QUALIFICATION.sourceRepository,
    releaseTag: OPENSHELL_QUALIFICATION.releaseTag,
    sourceSha: OPENSHELL_QUALIFICATION.sourceSha,
    artifacts: {
      cli: { binarySha256: OPENSHELL_QUALIFICATION.binarySha256.cli },
      gateway: { binarySha256: OPENSHELL_QUALIFICATION.binarySha256.gateway },
      standaloneSandbox: {
        binarySha256: OPENSHELL_QUALIFICATION.binarySha256.standaloneSandbox,
      },
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function runCli(): void {
  const [command, outputPath, ...extra] = process.argv.slice(2);
  if (!outputPath || extra.length > 0 || (command !== "select" && command !== "provenance")) {
    throw new Error("usage: openshell-qualification.mts select OUTPUT | provenance OUTPUT");
  }
  if (command === "select") writeOpenShellQualificationOutputs(outputPath);
  else writeOpenShellQualificationProvenance(outputPath);
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
