<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Authoring Deployment YAML With Onboarding

Use `nemoclaw onboard` to write YAML for a separate deployment.
Onboarding assigns a fresh `metadata.uid`, even when you start from a template.
It does not plan, apply, pull images, or create deployment state.

## Starting Onboarding

After you [install the CLI and verify its version](install.md), run onboarding in an interactive terminal.
Onboarding requires a terminal on standard input and standard error.
It does not load OpenTofu or need a deployment state directory.

If you plan to use a managed Docker or Podman gateway, start the engine so onboarding can check it.
To deploy a release bundle with local Docker and NVIDIA Endpoints, follow [Deploying Your First OpenClaw Agent](first-deployment.md).
To build from a checkout, follow [Onboarding From Source](from-source.md) on Apple silicon or WSL2.

1. Choose an unused output path in an existing directory.
   The default is `deployment.yaml` in the current directory.
   Onboarding never overwrites an existing file.
2. Start onboarding with one of these commands.
   Without a template, suggestions start with OpenClaw, a managed Docker gateway, and NVIDIA Endpoints inference.

   ```sh
   nemoclaw onboard --output my-deployment.yaml
   ```

   With a template, its values become suggestions for a new deployment.
   The file must describe exactly one sandbox.
   Onboarding does not edit the template or preserve its comments and formatting.

   ```sh
   nemoclaw onboard single-sandbox-template.yaml --output my-deployment.yaml
   ```

3. Answer the questions for your target.
   The harness menu offers OpenClaw and Hermes.
   A template that names another harness adds it to the menu for that run, but this does not qualify the harness for your deployment.

   Each screen lists its keys.
   **Enter** accepts a suggested text answer.
   **Tab** copies it for editing, and **Ctrl+O** omits an optional answer.
   After harness selection, **Ctrl+D** tries to accept the remaining suggestions and open review.
   If onboarding cannot confirm them for that shortcut, it explains why and leaves the remaining questions open.
   **Esc** exits without saving.

## Target Checks

Onboarding checks responding Docker and Podman engines, the selected image and its harness metadata, and the selected route's model catalog.
For a managed gateway, it also checks engine prerequisites.
These reads do not change the target.
If a template uses an external Docker or Podman gateway, specify the image inspection engine in `spec.gateway.target.docker.engine` or `spec.gateway.target.podman.engine`.
Without it, onboarding cannot verify the image on the selected engine.

If review finds that an automatically selected image cannot run the configuration, onboarding explains why and prompts you for another image.
If you chose the image yourself, the conflict stays in review and blocks saving until you resolve it.
An absent image or a read that could not be verified can leave an advisory and allow saving.
Review is not a deployment plan and does not establish that the configuration will run.
Refer to [provider discovery](../references/provider.md#engine-and-fabric-discovery) for the read contracts.

## Reviewing and Saving the YAML

Review shows the agent, model and provider per route, credential variable names and availability, placement, image and target checks, network access, any web search, and the output path.
The file names credential variables, not values.

1. Review the summary for conflicts and unverified checks.
   A confirmed conflict appears first and prevents saving until resolved.
2. Press **Left Arrow** if you need to return to the questions.
3. Correct any answer that caused a conflict.
4. Press **Tab** on the review screen to show the complete YAML under **Configuration file**.
5. Inspect the YAML.
   Onboarding can omit settings that the deployment uses by default, such as the network tier.
   The summary describes the resulting default network access.
6. Press **Enter** on the review screen to save.
   The CLI prints `plan` and `apply` commands for the saved path but does not run either command.
   It repeats missing credential references and names the first operation that needs each one.
   Interactive apply prompts for missing required values with hidden terminal input; non-interactive runs require them in the environment.

## Planning the Saved Configuration

The new file describes a deployment but does not create it.

1. Choose a state directory that no other deployment uses.
2. Provide the [credentials that plan requires](../references/cli.md#credential-resolution) through a protected environment facility.
   Plan can defer missing credentials that only apply requires.
   Keep credential values out of YAML.
3. Follow [planning and applying a deployment](../build-deploy/usage.md#planning-and-applying) with the saved YAML.

For command syntax, refer to the [CLI reference](../references/cli.md).
