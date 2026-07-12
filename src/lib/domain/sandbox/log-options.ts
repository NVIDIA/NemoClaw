// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_SANDBOX_LOG_LINES = "200";

export type SandboxLogsOptions = {
  follow: boolean;
  lines: string;
  since: string | null;
};
