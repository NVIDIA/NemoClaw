---
name: nemoclaw-contributor-onboard
description: Prepare a NemoClaw source checkout for compliant contribution through the repository's one-command setup and readiness doctor. Use when a new contributor asks to set up a development machine, prepare a checkout for a first PR, repair local contributor tooling, verify contributor readiness, launch the pinned coding agent, or decide whether optional runtime onboarding is needed. Trigger keywords - contributor setup, developer onboarding, first PR, dev setup, dev doctor, repair checkout, prepare development machine.
---

# Onboard a NemoClaw Contributor

Use the repository setup script as the executable source of truth.
Do not duplicate its dependency, build, hook, CLI-link, or readiness logic in agent commands.

## Prepare the Checkout

1. Read the root `AGENTS.md` and `CONTRIBUTING.md` completely.
2. Inspect the worktree and current branch without discarding or overwriting existing changes.
3. Run `./scripts/dev-setup.sh` from the repository root.
4. If repository-local setup needs to be retried, run `./scripts/dev-setup.sh --repair`.
5. Run `./scripts/dev-setup.sh --doctor` and report every remaining failure with its remediation.
   Use `./scripts/dev-setup.sh --doctor --json` when a machine-readable report helps.

The default and repair modes may update repository dependencies, builds, hooks, the root Python environment, and local CLI exposure.
They must not create a gateway or sandbox.

## Handle User-Controlled Changes

Pause and obtain explicit approval before installing or changing host packages, starting or replacing a container runtime, accepting a license, generating or registering a signing key, changing GitHub state, or changing global Git configuration.

- Ask for contributor name and email only when the doctor reports that identity is missing.
- Prefer repository-local Git identity changes when the user approves them.
- Use `gh auth login -h github.com` for missing GitHub authentication and pause for browser or device authentication.
- Let the user choose and register a Git-supported commit-signing key.
- Follow `../_shared/git-github-hard-stop.md` for authentication, authorization, SSH, remote-access, or push failures.
- Never print tokens, credential values, private keys, or command output that may contain them.
- Never place secrets in command arguments, generated reports, or tracked files.

After an approved remediation, rerun the doctor instead of assuming readiness.

## Decide on Runtime Onboarding

Ask whether the intended issue requires a live gateway or sandbox after source setup is ready.
Documentation work and isolated unit tests normally do not require runtime onboarding.

If runtime validation is required and the user approves it, run:

```bash
./scripts/dev-setup.sh --with-runtime
```

This delegates to interactive `nemoclaw onboard`.
Do not preselect third-party software acceptance, inference provider or model, credentials, sandbox name or resources, messaging integrations, or network policy unless the user already supplied those decisions.

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

Summarize repository-local setup performed, doctor status, user-controlled remediations still needed, whether runtime onboarding ran, and the next safe contributor action.
