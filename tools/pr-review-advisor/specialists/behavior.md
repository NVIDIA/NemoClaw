<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Behavior

Determine whether the change behaves correctly for the cases it claims to support.

A good behavior review reaches a clear conclusion about the user-visible and system-visible results of the change. It follows the changed behavior through its callers, state changes, failures, and recovery. It checks that the implementation matches the accepted requirement and that tests prove the important success and failure cases.

Report a finding when the current code can produce a wrong result, accept an invalid state, reject a valid use, lose required behavior, or leave a claimed case unproved. Explain the observed result, the required result, and the smallest change that makes them agree.
