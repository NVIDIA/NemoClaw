---
name: nemoclaw-contributor-onboard
description: Prepare a NemoClaw source checkout for compliant contribution through the repository's one-command setup and readiness doctor. Use when a new contributor asks to set up a development machine, prepare a checkout for a first PR, repair local contributor tooling, verify contributor readiness, launch the pinned coding agent, or decide whether optional runtime onboarding is needed. Trigger keywords - contributor setup, developer onboarding, first PR, dev setup, dev doctor, repair checkout, prepare development machine.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboard a NemoClaw Contributor

Use the repository setup script as the executable source of truth.
Do not duplicate its dependency, build, hook, CLI-exposure, or readiness logic in agent commands.

## Establish Trust First

1. Read the root `AGENTS.md` and `CONTRIBUTING.md` completely.
2. Inspect the worktree and current branch without discarding or overwriting existing changes.
3. Refresh the trusted `origin/main` reference, then compare the entire checkout/worktree diff against that up-to-date base before executing any checkout-local code.
   Include staged, unstaged, and untracked files; review lockfiles and all transitively executed source, not only the entry script or package manifests.
4. If any execution surface differs from trusted `origin/main`, review the diff and obtain explicit approval before running it.

## Route by Intent

- **Readiness only:** run `./scripts/dev-setup.sh --doctor` and never run setup, repair, CLI exposure, runtime onboarding, or the pinned agent.
  Use `./scripts/dev-setup.sh --doctor --json` when a machine-readable report helps.
- **Initial checkout setup:** run `./scripts/dev-setup.sh` from the repository root.
- **Explicit repository repair:** run `./scripts/dev-setup.sh --repair` only when the user asks to repair or retry repository-local setup.
- **CLI exposure:** after explicit approval, run `./scripts/dev-setup.sh --expose-cli`.
- **Runtime onboarding:** after explicit approval, run `./scripts/dev-setup.sh --with-runtime`.

The default and repair modes may update repository-local dependencies, builds, hooks, and the root Python environment.
They must not create a gateway or sandbox or expose a host-visible `nemoclaw` command.
CLI exposure is an explicit opt-in that may use an npm link or a user-local shim.

## Handle User-Controlled Changes

Pause and obtain explicit approval before installing or changing host packages, starting or replacing a container runtime, accepting a license, generating or registering a signing key, changing GitHub state, or changing global Git configuration.

- Ask for contributor name and email only when the doctor reports that identity is missing.
- Prefer repository-local Git identity changes when the user approves them.
- Use `gh auth login -h github.com` for missing GitHub authentication and pause for browser or device authentication.
- Let the user choose and register a Git-supported commit-signing key.
- Follow `../_shared/git-github-hard-stop.md` for authentication, authorization, SSH, remote-access, or push failures.
- Never print tokens, credential values, private keys, or command output that may contain them.
- Never place secrets in command arguments, generated reports, or tracked files.

After an approved host, account, identity, or signing remediation, rerun `npm run dev:doctor` or `./scripts/dev-setup.sh --doctor` instead of rerunning setup.
Reserve setup and `--repair` for repository-local dependency, build, or hook repair.

## Decide on Runtime Onboarding

Ask whether the intended issue requires a live gateway or sandbox after source setup is ready.
Documentation work and isolated unit tests normally do not require runtime onboarding.

If runtime validation is required and the user approves it, run:

```bash
./scripts/dev-setup.sh --with-runtime
```

This delegates to interactive `nemoclaw onboard` and also opts into development CLI exposure as part of that approved flow.
Do not preselect third-party software acceptance, inference provider or model, credentials, sandbox name or resources, messaging integrations, or network policy unless the user already supplied those decisions.

## Launch the Pinned Agent Only on Request

When the user specifically asks to use the repository-pinned coding agent, run the doctor first.
If readiness fails, report the remediation and obtain authorization for the matching setup or repair mode rather than mutating the checkout automatically.
When readiness passes, run:

```bash
npm run agent
```

Pass user-supplied Pi arguments after `--`.
Do not install or invoke a global Pi binary.

## Prepare for the First PR

Before the contributor starts implementation, explain this workflow:

1. Create a feature branch from current `main`.
2. Use Conventional Commits in `<type>(<scope>): <description>` form.
3. Run tests targeted to the changed behavior and `npm run docs` for documentation changes.
4. Commit with configured signing so every pushed commit appears as `Verified` on GitHub.
5. Include `Signed-off-by: Name <email>` in the PR description for DCO compliance.
6. Follow `.github/PULL_REQUEST_TEMPLATE.md` and monitor required CI and automated review feedback.

Use `nemoclaw-contributor-create-pr` when the user asks to publish the changes.
Do not create a branch, commit, push, or PR unless the user's request includes that action.

## Report the Result

Summarize repository-local setup performed, doctor status, user-controlled remediations still needed, whether CLI exposure or runtime onboarding ran, and the next safe contributor action.
