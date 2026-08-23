// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "d1415509251931c82ad6c48960cc7801078c8f523d977e0eadf27296338bc6e0";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "c0d58e681f2c419f3ec9dc4bd457e244a193e17ab82fa208ad2fa83b35cc1718";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "504821ad93c57971d0281ef1130ed6008fadd331bd56acb1a6b5e6a3358f3e49";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "ee28f7ecc4ab0aed53c83793e8c6f57045a49d0cca38ed80786a83eeb5c0b2fc";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "62cf2ee01ac7192f41fc7b2b071de729da8bacec1e4f693da1ec6f0b1f4723c0";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}
