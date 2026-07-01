// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertOpenshellResolvable,
  buildPolicyGetCommand,
  parseCurrentPolicy,
} from "../../policy/index";
import { runCapture } from "../../runner";

export interface PolicyGetResult {
  raw: string;
  yaml: string;
}

export function getSandboxPolicy(sandboxName: string): PolicyGetResult {
  assertOpenshellResolvable();
  const raw = runCapture(buildPolicyGetCommand(sandboxName));
  return { raw, yaml: raw ? parseCurrentPolicy(raw) : "" };
}
