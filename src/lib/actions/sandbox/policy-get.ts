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

/** Read the round-trippable OpenShell base policy and strip its metadata header. */
export function getSandboxPolicy(sandboxName: string): PolicyGetResult {
  assertOpenshellResolvable();
  let raw: string;
  try {
    raw = runCapture(buildPolicyGetCommand(sandboxName));
  } catch (cause) {
    const detail = cause instanceof Error ? ` ${cause.message}` : "";
    throw new Error(`Failed to retrieve base policy for sandbox '${sandboxName}'.${detail}`, {
      cause,
    });
  }
  return { raw, yaml: raw ? parseCurrentPolicy(raw) : "" };
}
