# Contributing

Thank you for your interest in NemoClaw! This guide helps you get started.

## Development Setup

```bash
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw
npm install                    # host CLI dependencies
cd nemoclaw && npm install     # TypeScript plugin dependencies
npm run build                  # compile TypeScript
cd ..
```

## Running Tests

```bash
node --test test/*.test.js
```

All tests use the Node.js built-in test runner (Node.js 20+). No additional test framework is needed.

## Project Layout

| Directory | Contents |
|-----------|----------|
| `bin/` | Host CLI entry point and modules (JavaScript) |
| `nemoclaw/src/` | OpenClaw plugin commands (TypeScript) |
| `nemoclaw-blueprint/` | Python blueprint for sandbox orchestration |
| `scripts/` | Shell scripts for setup, services, and testing |
| `test/` | Unit and integration tests |
| `docs/` | Sphinx documentation source |

## Pull Request Guidelines

1. **One fix per PR.** Keep changes focused and reviewable.
2. **Reference the issue** in the PR description (e.g., `Fixes #42`).
3. **Run tests** before opening the PR.
4. **Follow existing code style** — SPDX headers on all new files, 2-space indentation for JS/TS, `set -euo pipefail` in shell scripts.
5. **Use conventional commit prefixes** in the PR title: `fix:`, `feat:`, `docs:`, `test:`, `chore:`, `ci:`, `security:`.

## Signing Your Work

* We require that all contributors "sign-off" on their commits. This certifies
  that the contribution is your original work, or you have rights to submit it
  under the same license, or a compatible license.

  * Any contribution which contains commits that are not Signed-Off will not be
    accepted.

* To sign off on a commit you simply use the `--signoff` (or `-s`) option when
  committing your changes:

  ```bash
  git commit -s -m "Add cool feature."
  ```

  This will append the following to your commit message:

  ```text
  Signed-off-by: Your Name <your@email.com>
  ```

* Full text of the DCO:

  ```text
    Developer Certificate of Origin
    Version 1.1

    Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
    1 Letterman Drive
    Suite D4700
    San Francisco, CA, 94129

    Everyone is permitted to copy and distribute verbatim copies of this
    license document, but changing it is not allowed.
  ```

  ```text
    Developer's Certificate of Origin 1.1

    By making a contribution to this project, I certify that:

    (a) The contribution was created in whole or in part by me and I have the
    right to submit it under the open source license indicated in the file; or

    (b) The contribution is based upon previous work that, to the best of my
    knowledge, is covered under an appropriate open source license and I have
    the right under that license to submit that work with modifications,
    whether created in whole or in part by me, under the same open source
    license (unless I am permitted to submit under a different license), as
    indicated in the file; or

    (c) The contribution was provided directly to me by some other person who
    certified (a), (b) or (c) and I have not modified it.

    (d) I understand and agree that this project and the contribution are
    public and that a record of the contribution (including all personal
    information I submit with it, including my sign-off) is maintained
    indefinitely and may be redistributed consistent with this project or the
    open source license(s) involved.
  ```
