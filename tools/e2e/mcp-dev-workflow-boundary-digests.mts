// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "d1415509251931c82ad6c48960cc7801078c8f523d977e0eadf27296338bc6e0";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "9b70d22accbd7b413932e73b7e865097291af95eb3bacd4f862ff3f574325ab4";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "ce61717952372d66af48dbb481889f97eeb53fb65c196ce990b871cfaccb670c";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "9259b3d10f72fdb3c2e0083aceb56327d5d8cf7e998a4691bb5c8113cba1c249";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "2e06fcab9090de7fbb91063a5ad5a008cdc1a162c3dcfd5c17a08607c019d8e8";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

export const MCP_DEV_JOB_LOCAL_DOCKERFILE_EXECUTION_CONTEXT_SHA256 =
  "f1a3da59c7c0f7958b953cd18d283f07969bde74a810318e1f1972537567a082";
