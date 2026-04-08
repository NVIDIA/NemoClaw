# Credential Storage

NemoClaw stores operator-provided host-side credentials under `~/.nemoclaw/`.
These credentials are used during onboarding and host-side lifecycle operations.
They are not encrypted at rest by NemoClaw.
Instead, NemoClaw relies on local filesystem ownership and Unix permissions to limit access.

## Location and Permissions

By default, NemoClaw stores credentials in:

```text
~/.nemoclaw/credentials.json
```

When NemoClaw creates this state directory, it uses owner-only permissions:

- `~/.nemoclaw/` is created with mode `0700`
- `~/.nemoclaw/credentials.json` is written with mode `0600`

That means only the local account that owns the files should be able to read or modify them.

NemoClaw also refuses to use obviously unsafe `HOME` paths such as `/tmp`, `/var/tmp`, `/dev/shm`, or `/` for credential storage.
If `HOME` points to one of those locations, onboarding exits with an error instead of writing secrets there.

## Plaintext Storage Warning

The credential file is plaintext JSON.
NemoClaw does **not** currently encrypt the file or integrate with the host operating system keychain.

A typical file looks like this:

```json
{
  "NVIDIA_API_KEY": "nvapi-...",
  "GITHUB_TOKEN": "ghp_...",
  "OPENAI_API_KEY": "sk-..."
}
```

Treat this file like any other local secret material.
Anyone who can read it can reuse those credentials with the upstream provider.

## Precedence and Scope

When NemoClaw looks up a credential, it checks environment variables first.
If the corresponding environment variable is set, NemoClaw uses that value instead of the stored file.

This behavior is useful for:

- CI or automation where you do not want to persist secrets to disk
- temporary overrides during testing
- short-lived or rotated credentials

For interactive local use, `nemoclaw onboard` can save credentials into `~/.nemoclaw/credentials.json` so future runs do not prompt again.

## Security Recommendations

Use the following practices to reduce the risk of credential exposure.

1. Keep your home directory private and owned by your user account.
2. Exclude `~/.nemoclaw/` from cloud-sync folders, shared folders, and broad backup exports unless those systems are already approved for secret storage.
3. Prefer short-lived or low-scope provider credentials where the upstream service supports them.
4. Rotate keys after suspected exposure, machine transfer, or account changes.
5. Prefer environment variables for ephemeral automation instead of persisting long-lived secrets locally.
6. Do not copy `credentials.json` into container images, Git repositories, bug reports, or support bundles.

## Inspect and Repair Permissions

To inspect the current permissions:

```console
$ ls -ld ~/.nemoclaw ~/.nemoclaw/credentials.json
```

Expected output should show a private directory and file, for example:

```text
drwx------  ... ~/.nemoclaw
-rw-------  ... ~/.nemoclaw/credentials.json
```

If the permissions are broader than expected, tighten them:

```console
$ chmod 700 ~/.nemoclaw
$ chmod 600 ~/.nemoclaw/credentials.json
```

## Rotate or Remove Stored Credentials

The simplest way to replace a stored provider key is to rerun onboarding and provide the new value when prompted:

```console
$ nemoclaw onboard
```

To remove the stored file entirely:

```console
$ rm -f ~/.nemoclaw/credentials.json
```

On the next run, NemoClaw prompts again unless the credential is supplied through the environment.

## Related Files

Other NemoClaw host-side state also lives under `~/.nemoclaw/`, such as sandbox registry metadata.
These files are operational state, not provider secrets, but they should still remain in a user-owned home directory.

For the broader sandbox security model and operational trade-offs, see Security Best Practices (see the `nemoclaw-configure-security` skill) and Architecture (see the `nemoclaw-reference` skill).
