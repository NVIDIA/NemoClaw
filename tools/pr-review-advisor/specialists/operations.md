<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Operations

Determine whether maintainers can operate, diagnose, and recover the changed system.

A good operations review follows the change through deployment, startup, normal use, failure, retry, cancellation, cleanup, upgrade, and rollback where those states apply. It checks that maintainers can tell what happened, identify the affected resource, take the documented recovery action, and avoid duplicate or abandoned work.

Report a finding when the changed system can become stuck, leak resources, hide the cause of failure, repeat an unsafe action, resist cleanup, or leave no reliable recovery path. Explain the operational state, its effect, and the smallest change that makes operation or recovery reliable.
