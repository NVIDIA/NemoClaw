#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

export NEMOCLAW_SANDBOX_NAME="the-crucible"
export NEMOCLAW_PROVIDER="cloud"
./bin/nemoclaw.js onboard --non-interactive
