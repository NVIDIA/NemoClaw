// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandGroup } from "./command-display";

export type PublicDisplayLayout = {
  group: CommandGroup;
  order: number;
  usage?: string;
  description?: string;
  flags?: string;
  hidden?: boolean;
  deprecated?: boolean;
};
