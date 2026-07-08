// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HostCommandObservation {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class HostCliClient {
  observeVersion(): HostCommandObservation {
    return { command: ["nemoclaw", "--version"], exitCode: null, stdout: "", stderr: "" };
  }
}
