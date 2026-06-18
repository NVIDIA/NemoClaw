# Platform-Specific Notes

## Lepton (`from tao_sdk.platforms.lepton import LeptonSDK`)
- Jobs run as containers on DGX Cloud.
- NFS/Lustre mounts auto-detected from the node group; the SDK builds the appropriate `Mount` objects.
- `gpu_count` resolves to a Lepton resource shape; or pass `dedicated_node_group="<name>"` for guaranteed allocation.
- `num_nodes=N` (N>1) enables distributed training.

## Brev (`from tao_sdk.platforms.brev import BrevSDK`)
- Jobs run on GPU instances via `brev exec`.
- No shared storage — S3 only.
- Pass `instance_id="<id>"` in kwargs to reuse an existing instance (skip 2–5 min boot).
- Pass `gpu_type="L40S"` to control instance class for ephemeral instances.
- Pass `cloud_cred_id="<id>"` and `workspace_group_id="<id>"` on multi-credential
  or multi-workspace accounts. Without them, `brev create` rejects with a
  placement error. Discover via `brev orgs --json` (cloud cred) and
  `brev ls --json` (workspace group). See `skills/platform/tao-run-on-brev/SKILL.md` →
  *Creating an instance — placement info* for the full lookup recipe.
- The handler waits for both `status=RUNNING` and `brev exec ... -- true`
  before returning, so a `create_job` → `get_job_logs` sequence won't race
  sshd bring-up. The first remote exec uses a 600s timeout to absorb the
  container-pull window; reused instances use 30s.
- Use `sdk.delete_instance(instance_id)` when done with an ephemeral one.

## SLURM
- Jobs submit over SSH to a login node with `sbatch` and run containers through
  Pyxis/Enroot `srun --container-image`.
- Use the platform helper output to ask only for SLURM credentials and storage
  settings. Do not ask for Lepton, Brev, or Kubernetes credentials.
- Dataset paths must be visible from the cluster job, usually absolute Lustre or
  shared filesystem paths; do not pass agent-host local paths to SLURM jobs.
- Use the packaged SLURM runtime defaults unless the user gives a validated
  override. For the common `polar,polar3,polar4,grizzly` queues, prefer the
  four-hour default rather than generating 12-hour wrappers.

## Kubernetes
- Jobs run as Kubernetes Jobs on a configured GPU cluster.
- Auth uses kubeconfig (`KUBECONFIG` or `~/.kube/config`) or an in-cluster
  service account.
- Requires NVIDIA GPU Operator or equivalent `nvidia.com/gpu` device plugin.
- Do not ask for Lepton, Brev, or SLURM credentials for Kubernetes runs.
- A local path on the agent host is not proof that the path is mounted inside
  the job pod.

## Local Docker
- Jobs run on the local Docker daemon host.
- Multi-node is not supported; multi-GPU on the local host is supported.
- Verify local dataset paths, Docker daemon access, and NVIDIA runtime before
  generating or launching runner artifacts.
