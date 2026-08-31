// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "052c49d5e8688266dbf38fa911733132d33e4470a29a61deb6e7a11067737559";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "63fdbb0b1d775e0f06cb31adc36d992b79bf75866a51038e3faa87849f2545e4";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "504821ad93c57971d0281ef1130ed6008fadd331bd56acb1a6b5e6a3358f3e49";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "4c03445d26a30aabef34ab12879c95c01d5bc48ee1d192f588d47782935104cf";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "5b517388f3f47f92452e038a591cdea00501e76bec22144f1b8264e5c21b963f";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}
