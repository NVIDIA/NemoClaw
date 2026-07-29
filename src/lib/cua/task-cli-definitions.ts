// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

export const cuaSandboxArgs = {
  sandboxName: Args.string({
    name: "sandbox",
    description: "Sandbox name",
    required: true,
  }),
};

export const cuaTaskIdentityFlags = {
  adapter: Flags.string({
    description: "Absolute path to the operator-owned CUA task adapter",
    required: true,
  }),
  "task-id": Flags.string({
    description: "Explicit stable task ID",
    required: true,
  }),
};

export const cuaTaskInputFlag = Flags.string({
  description: "Private UTF-8 task input file, up to 64 KiB",
  required: true,
});
