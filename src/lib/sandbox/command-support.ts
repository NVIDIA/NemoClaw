// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

export const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});
