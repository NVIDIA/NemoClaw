// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "3b35d46a2a0ee62af39d1d489909b25c95701628e4383a3b79af4a5a1b92b3bb";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "2b714e0e98d2e04d8d4036d65c90779c33f0a593811231cd0cbe23ca5c607e60";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "69ce3f37667cc6b5301fbb76074d3575da1cd45eb90b164dc407a17137a2d273";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "a99862977077321de6f23184485a71e8dbbc2a40afb6d69aa39c82c38410646d";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "f1cb3f93c2b91fd498c62d2c08d406befe15b2387b00f3511b8d10d6724d0fc5";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

export const MCP_DEV_JOB_LOCAL_DOCKERFILE_EXECUTION_CONTEXT_SHA256 =
  "f1a3da59c7c0f7958b953cd18d283f07969bde74a810318e1f1972537567a082";
