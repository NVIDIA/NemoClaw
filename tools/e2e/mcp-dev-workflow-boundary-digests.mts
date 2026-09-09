// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "d1415509251931c82ad6c48960cc7801078c8f523d977e0eadf27296338bc6e0";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "9b70d22accbd7b413932e73b7e865097291af95eb3bacd4f862ff3f574325ab4";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "d4a46db674c65bf14c80de6a9faa1702a0b6ff48781537871504e768cf222cf7";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "31674eafe2ce79207c50cb2fb23f75ba0b2cdd572254f831754ca25beba82ac4";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "9fae24e2a586143abeb36916b556e924d268300d03375bfe6936c5ad97aab9d5";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

export const MCP_DEV_JOB_LOCAL_DOCKERFILE_EXECUTION_CONTEXT_SHA256 =
  "f1a3da59c7c0f7958b953cd18d283f07969bde74a810318e1f1972537567a082";
