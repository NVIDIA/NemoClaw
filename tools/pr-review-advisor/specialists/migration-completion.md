<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Migration completion

Determine whether the change completes each replacement it introduces.

A good migration completion review follows every affected caller, state path, test, script, workflow, and document to the intended implementation. It identifies old behavior that the change makes obsolete and confirms that one owner remains for each responsibility.

Report a finding when repository evidence shows that an old path, caller, test, or document remains after its replacement and no current compatibility, rollback, client-version, or migration-sequencing requirement still needs it. Name the old path to remove, the current path that replaces it, and the required behavior and trust-boundary guarantees the replacement retains.
