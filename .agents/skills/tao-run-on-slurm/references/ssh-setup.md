# SSH and Enroot Credential Setup

Before any SLURM job can be submitted or any runner script is generated, the
host running the TAO service or SDK must be able to log in to at least one host
from `SLURM_HOSTNAME` over SSH **without an interactive password prompt**. The
handler runs `sbatch`, `squeue`, `sacct`, `scancel`, and log tails
non-interactively, so password or 2FA prompts will fail the job at submit or
status time.

## Passwordless SSH setup

Set this up once per (host, login node, user) tuple:

1. Ensure an SSH keypair exists for the service user (e.g. `~/.ssh/id_ed25519`).
   Create one with `ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519` if it is
   missing. The handler defaults to the same locations described under
   `SSH_KEY_PATH` in Credentials.
2. Install the public key on each login node:

   ```bash
   ssh-copy-id -i ~/.ssh/id_ed25519.pub <SLURM_USER>@<login-host>
   ```

   This is the only step that requires the user's password; run it interactively
   once per login host listed in `SLURM_HOSTNAME`. If `ssh-copy-id` is not
   available, append the public key manually:

   ```bash
   cat ~/.ssh/id_ed25519.pub | ssh <SLURM_USER>@<login-host> \
     'mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
      cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
   ```
3. Trust the host key so SSH does not stall on the "authenticity of host" prompt
   inside the handler. Either log in once interactively to accept the prompt,
   or pre-populate `~/.ssh/known_hosts` with `ssh-keyscan -H <login-host> >> ~/.ssh/known_hosts`.
4. Verify the result is fully non-interactive for at least one listed login
   host:

   ```bash
   ssh -o BatchMode=yes -o PreferredAuthentications=publickey \
     <SLURM_USER>@<login-host> 'hostname && squeue -u $USER -h | head -n 1'
   ```

   `BatchMode=yes` forces failure if SSH would otherwise prompt; this command
   must succeed before the SLURM platform is usable.
5. When the service runs in a container (microservices deployment), mount the
   private key into the container at the path referenced by `SSH_KEY_PATH`, with
   `chmod 600` and matching ownership for the in-container user. The handler
   refuses keys with world-readable permissions.

For convenience, a per-host alias in `~/.ssh/config` lets you reference a short
name everywhere:

```text
Host slurm-login
    HostName <login-host>
    User <SLURM_USER>
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
```

If a site enforces 2FA on every SSH connection, passwordless key auth alone is
not enough; coordinate with the cluster admin to allow key-only auth from the
service host or use an SSH agent with cached credentials and expose it to the
handler via `SSH_AUTH_SOCK`.

## SSH failure remediation prompt

When passwordless SSH fails, use this concise prompt:

```text
SLURM is blocked on passwordless SSH. Please provide:

SSH_KEY_PATH=/path/to/private_key

If you have not set up passwordless access yet:
1. Create a key if needed:
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
2. Install the public key on one login host:
   ssh-copy-id -i ~/.ssh/id_ed25519.pub <SLURM_USER>@<login-host>
3. Trust the host key:
   ssh-keyscan -H <login-host> >> ~/.ssh/known_hosts
4. Lock private-key permissions:
   chmod 600 ~/.ssh/id_ed25519
5. Verify it works without prompts:
   ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 <SLURM_USER>@<login-host> 'hostname'

After that, rerun with SSH_KEY_PATH=~/.ssh/id_ed25519.
```

## Enroot credentials for private nvcr.io images

Pyxis on the compute nodes invokes enroot to import the Docker image. Enroot
does NOT read `NGC_KEY` from the SLURM job env — it requires persistent
credentials in `~/.config/enroot/.credentials` on the login/compute nodes.
Without this, anonymous pulls of `nvcr.io/nvstaging/*` (or any auth-gated
repo) fail with "Could not process JSON input" at job startup. Skip if the
image is from a public repo.

The enroot-credentials step only needs to run **once per (cluster, user)** —
subsequent SLURM sessions inherit the file. Use the `printf | ssh` heredoc
pattern below so the `NGC_KEY` value never lands in shell history, intermediate
files, or chat output. Do not `cat` or `echo` the value at any step. After the
file is in place, both the SDK's SQSH pre-conversion job (which runs on
`sqsh_conversion_partition`) and the actual training job's Pyxis pull will
authenticate as `$oauthtoken` against `nvcr.io`.

```bash
if [ -n "$NGC_KEY" ]; then
  REMOTE_CRED_OK=$(ssh -o BatchMode=yes "${SLURM_USER}@${SLURM_HOST}" \
    'test -s ~/.config/enroot/.credentials && echo OK || echo MISSING' 2>/dev/null)
  if [ "$REMOTE_CRED_OK" != "OK" ]; then
    echo "MISSING: ~/.config/enroot/.credentials not set on ${SLURM_HOST}."
    echo "After user approval, install it from NGC_KEY (no value echoed):"
    echo "  printf 'machine nvcr.io login \$oauthtoken password %s\\nmachine authn.nvidia.com login \$oauthtoken password %s\\n' \"\$NGC_KEY\" \"\$NGC_KEY\" \\"
    echo "    | ssh -o BatchMode=yes \"\${SLURM_USER}@\${SLURM_HOST}\" '"
    echo "        mkdir -p ~/.config/enroot && umask 077 && cat > ~/.config/enroot/.credentials && chmod 600 ~/.config/enroot/.credentials"
    echo "      '"
    exit 1
  fi
fi
```
