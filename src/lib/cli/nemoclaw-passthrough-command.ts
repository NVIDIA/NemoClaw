// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "./nemoclaw-oclif-command";

/** Shared lifecycle-aware base for commands that forward raw agent arguments. */
export abstract class NemoClawPassthroughCommand extends NemoClawCommand {}
