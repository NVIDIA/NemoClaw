<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Outside v1 Scope

v1 deliberately leaves some responsibilities to other components and teams.
These are product decisions, not unfinished features, so no work is planned to add them to NemoClaw.
For features that v1 does not have yet or has not tested, refer to [Current Limits](limits.md).
For Classic features planned for v1, refer to [Roadmap: Bring agreed Classic features to v1](https://github.com/NVIDIA/NemoClaw/milestone/14).

The following table explains why each responsibility is outside v1 scope and what to use instead:

| What Is Out of Scope | Why It Is Out of Scope |
|---|---|
| Backing up, restoring, taking snapshots of, or moving agent files | Agent files live on storage that your platform operator provides, and backing up and moving that storage is already the platform's job. NemoClaw has no backup or transfer command. To keep files when a sandbox is replaced, [store them on mounted volumes](../build-deploy/state.md#keep-agent-files-on-mounted-volumes). |
| One NemoClaw command set for actions specific to each agent, such as restarting an agent's own gateway process | Each agent and its supporting components define those actions and provide the controls for them. NemoClaw relies on those components instead of reimplementing them, and manages the deployment as a whole: it previews, applies, exports, and removes the deployment. [Ecosystem](../about/ecosystem.md) helps you find the component responsible for each action. |
| Classic's step-by-step commands and its TypeScript API | v1 is a new design. You describe the deployment you want in a YAML file, and the CLI, Rust SDK, or OpenTofu provider creates, updates, or removes resources to match it. v1 does not keep compatibility with Classic's commands, API, configuration format, or state. The [migration guide](../get-started/migration.md#map-the-user-task) maps each Classic task to its v1 equivalent. |
| Approving a blocked network request while the agent runs, or explaining the network policy to an agent | NVIDIA OpenShell enforces each sandbox's network policy and provides both through its policy advisor. If you approve access through OpenShell, also add it to the deployment YAML as a [named grant](../security/sandbox-network.md#choose-a-policy), so export and the next apply keep it. Decision: [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651). |
| Named network policy presets | Named grants cover what presets were for. They add specific destinations to the default isolated policy without rewriting the whole policy. Refer to [choose a policy](../security/sandbox-network.md#choose-a-policy). Decision: [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651). |
| Shields, Classic's option to lock agent configuration and state after setup | Locking agent state after setup is an optional capability for other products, not a core NemoClaw responsibility. Keeping it in NemoClaw would add security, recovery, and testing work for every supported agent. NVIDIA OpenShell still enforces sandbox isolation and network policy. Decision: [#10696](https://github.com/NVIDIA/NemoClaw/issues/10696). |
| Automatic conversion of a Classic deployment and its data to v1 | v1 uses a new state format and does not take over resources that it did not create. Each agent owns its data format, and the platform owns the storage. Instead, run v1 as a [separate deployment](../get-started/migration.md#keep-deployment-identities-separate) beside Classic. [#14580](https://github.com/NVIDIA/NemoClaw/issues/14580) tracks a documented path from a Classic configuration export to a v1 deployment. |
