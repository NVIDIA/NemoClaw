# SLURM Failure Modes and Troubleshooting

**SSH auth failure**: The passwordless-login setup is incomplete. Check
`SLURM_USER`, `SLURM_HOSTNAME`, `SSH_KEY_PATH`, key permissions (`chmod 600`),
`known_hosts` entries for every login host, and whether the key is mounted into
the service container. Re-run the `ssh -o BatchMode=yes ...` verification step
from `references/ssh-setup.md` to confirm the fix before resubmitting.

**Local dataset path rejected**: Convert the data path to `lustre:///...` or
copy the dataset onto the cluster's shared filesystem.

**SQSH conversion timeout**: Increase `sqsh_conversion_timeout_minutes`, use a
smaller image, or pre-stage the SQSH image in the cache directory.

**Pyxis or Enroot unavailable**: The generated sbatch script depends on
`srun --container-image`. Ask the cluster admin to enable Pyxis/Enroot or use a
different platform.

**Bad node or transient GPU failure**: The handler retries infrastructure-like
failures such as CUDA driver errors, missing GPUs, NCCL/RDMA failures, Xid
errors, and node failures up to the configured retry limit.
