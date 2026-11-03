// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A refusal made of operator instructions, such as a command to run, kept as separate lines. */
export class OperatorRefusalError extends Error {
  readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    super(lines.join("\n"));
    this.name = "OperatorRefusalError";
    this.lines = [...lines];
  }
}
