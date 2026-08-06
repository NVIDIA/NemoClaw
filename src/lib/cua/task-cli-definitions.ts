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

export const cuaDeferredTaskIdentityFlags = {
  adapter: Flags.string({
    description: "Ignored compatibility path for the unavailable CUA task adapter",
  }),
  "task-id": Flags.string({
    description: "Ignored compatibility task ID for this unavailable command",
  }),
};

export const cuaTaskInputFlag = Flags.string({
  description: "Private UTF-8 task input file, up to 64 KiB",
  required: true,
});

export const cuaDeferredTaskInputFlag = Flags.string({
  description: "Ignored compatibility input path for this unavailable command",
});
