# Contributing

## Updating pinned asset checksums

Any PR that bumps the version of an external binary downloaded by `install.sh`
(nvm, Ollama, etc.) **must** update the corresponding `URL_*` and `CHECKSUM_*`
variables in `scripts/verify-checksums.sh` in the same commit.

The easiest way is to let the script regenerate the digests automatically:

```bash
# 1. Update the URL_* variable in scripts/verify-checksums.sh to the new version URL
# 2. Re-pin all digests in one command:
bash scripts/verify-checksums.sh --regenerate

# 3. Review and commit both the URL and checksum change together:
git diff scripts/verify-checksums.sh
git add scripts/verify-checksums.sh
```

Checksums are computed with `sha3sum -a 256` (install: `brew install sha3sum`).
If `sha3sum` is not available the script falls back to `shasum -a 256` (built into macOS)
or `sha256sum` (Linux) — note these are different algorithms, so always regenerate
with the same tool that is present on your machine.

PRs that change a download URL without updating the matching `CHECKSUM_*` variable
will be rejected.

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
