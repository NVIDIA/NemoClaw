// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "d1415509251931c82ad6c48960cc7801078c8f523d977e0eadf27296338bc6e0";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "b9546e0e69db329495934c8d05bd7951dd0176a6dad659095a60cbcd0c7721e1";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "69ce3f37667cc6b5301fbb76074d3575da1cd45eb90b164dc407a17137a2d273";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "a99862977077321de6f23184485a71e8dbbc2a40afb6d69aa39c82c38410646d";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "be192ff3c94b205d6d4b70030bf7ea97702d38c5c7cceec402503892b2c0920e";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

export const MCP_DEV_JOB_LOCAL_DOCKERFILE_EXECUTION_CONTEXT_SHA256 =
  "f1a3da59c7c0f7958b953cd18d283f07969bde74a810318e1f1972537567a082";
