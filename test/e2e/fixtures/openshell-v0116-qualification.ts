// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_V0116_QUALIFICATION = Object.freeze({
  supportsRuntimeIdentityRefreshProjection: true,
  sourceRevision: "d1155aa70042d3e2ee49dbfa15346b108b7c1d92",
  supervisorImage:
    "ghcr.io/nvidia/openshell/supervisor@sha256:c8c42aef16c200063e32cbf72e553e4ead027085427b555efafd95063ecead42",
  version: "0.0.116",
});

export function exactGatewayRelease(versionOutput: string): string | null {
  const tokens = versionOutput.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/gu);
  if (tokens?.length !== 1) return null;
  return tokens[0]!.trim().replace(/^v/u, "");
}
