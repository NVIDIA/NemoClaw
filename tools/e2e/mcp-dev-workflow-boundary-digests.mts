// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "052c49d5e8688266dbf38fa911733132d33e4470a29a61deb6e7a11067737559";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "6b37ff9bfe69b299c76d517c0f165dd22d25fe2520c80bc9edc2af4fe4f65c43";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "504821ad93c57971d0281ef1130ed6008fadd331bd56acb1a6b5e6a3358f3e49";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "ee28f7ecc4ab0aed53c83793e8c6f57045a49d0cca38ed80786a83eeb5c0b2fc";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "5b517388f3f47f92452e038a591cdea00501e76bec22144f1b8264e5c21b963f";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}
