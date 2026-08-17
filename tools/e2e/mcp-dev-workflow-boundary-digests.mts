// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "39a72a2c05f7ed71e34d1df54fbee4db15ce3a3aa62ca382bd283d4345a85358";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "9f9983804a29816d7e1b35e9e791f453f4e9e83f4ec41b906953e976d372353e";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "504821ad93c57971d0281ef1130ed6008fadd331bd56acb1a6b5e6a3358f3e49";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "97bbb42df2f236a572f229e51f787ef9011c34a08eddd09f92f52fd052239c9b";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "62cf2ee01ac7192f41fc7b2b071de729da8bacec1e4f693da1ec6f0b1f4723c0";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}
