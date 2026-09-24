// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REVIEWED_GATEWAY_UPGRADE_FIXTURE = Object.freeze({
  additionalStoppedSandboxes: 0,
  expectedAdvisoryAuditCount: 1,
  installerSha256: "00f24959e5ca68104fe91221c0a015dab6a4154618497fa36b969b661f418cc2",
  nemoclawCommit: "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
  nemoclawRef: "v0.0.89",
  openclawVersion: "2026.6.10",
  openClawArchive: Object.freeze({
    expectedIntegrity:
      "sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==",
    label: "historical fixture OpenClaw 2026.6.10",
    packageSpec: "openclaw@2026.6.10",
    tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.6.10.tgz",
  }),
  openShellVersion: "0.0.85",
  sandboxBaseImageRef:
    "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
} as const);

export const REVIEWED_GATEWAY_REGISTRATION_UPGRADE_FIXTURE = Object.freeze({
  additionalStoppedSandboxes: 2,
  expectedAdvisoryAuditCount: 0,
  installerSha256: "d6d8b3f4fe9298efae4a0ddce3d1f256f75e5c5ea33c91b41dfb274ef350c335",
  nemoclawCommit: "f75f722bb4a1ec9642c8df36c8924e24500d78f0",
  nemoclawRef: "v0.0.123",
  openclawVersion: "2026.7.1",
  openClawArchive: Object.freeze({
    expectedIntegrity:
      "sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==",
    label: "historical fixture OpenClaw 2026.7.1",
    packageSpec: "openclaw@2026.7.1",
    tarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz",
  }),
  openShellVersion: "0.0.106",
  // The reported v0.0.123 install used its reviewed managed image. Supplying
  // the legacy Dockerfile base override would select a different setup path.
  sandboxBaseImageRef: "",
} as const);

export const REVIEWED_GATEWAY_UPGRADE_FIXTURES = Object.freeze([
  REVIEWED_GATEWAY_UPGRADE_FIXTURE,
  REVIEWED_GATEWAY_REGISTRATION_UPGRADE_FIXTURE,
] as const);

export type ReviewedGatewayUpgradeFixture = (typeof REVIEWED_GATEWAY_UPGRADE_FIXTURES)[number];
