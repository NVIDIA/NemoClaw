<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local E2E Runs

Choose the source to test. Use the current checkout for working-tree source. Use a
detached worktree for one commit.

Follow [Run Live E2E Locally](../../../../test/e2e/docs/README.md#run-live-e2e-locally)
for commands, host requirements, and cleanup. Review the selected test's environment
and cleanup contracts before execution.

A local run does not reproduce GitHub full E2E. Host requirements, credentials,
target opt-ins, or unavailable services can cause tests to skip or fail.

## Report the Result

Return:

- whether the run used working-tree content or a commit;
- the test file, or state that the aggregate local command ran;
- the resolved commit when applicable;
- the command result; and
- any retained resources or required cleanup.

Do not describe a local aggregate run as GitHub full E2E or release qualification.
