# Job Submission Examples

## Spec-driven jobs

The skill's action declares a config file (`config_format`, `command: ... {config_path} ...`). Covers TAO models (DINO, BEVFusion, classification-pyt, …) and cosmos-rl — anything whose container reads a spec file and writes outputs to declared spec keys. Use whichever platform SDK fits the target backend; the `build_entrypoint` call is identical across platforms.

```python
import yaml
from tao_sdk.script_runner import build_entrypoint
from tao_sdk.versions import resolve_container_image
# pick the SDK matching your target platform:
from tao_sdk.platforms.lepton     import LeptonSDK     # or
from tao_sdk.platforms.slurm      import SlurmSDK      # or
from tao_sdk.platforms.kubernetes import KubernetesSDK # or
from tao_sdk.platforms.docker     import DockerSDK     # or
from tao_sdk.platforms.brev       import BrevSDK

skill_info = yaml.safe_load(open(f"{bank}/models/tao-train-dino/references/skill_info.yaml"))
action_cfg = skill_info["actions"]["train"]

specs = {
    "dataset": {
        "train_data_sources": [{
            "image_dir":  "s3://my-bucket/coco/train/images",
            "json_file":  "s3://my-bucket/coco/train/annotations.json",
        }],
        "val_data_sources": [{
            "image_dir":  "s3://my-bucket/coco/val/images",
            "json_file":  "s3://my-bucket/coco/val/annotations.json",
        }],
        "num_classes": 80,
    },
    "train": {"num_epochs": 10, "num_gpus": 8},
    # No results_dir — script_runner auto-fills at runtime.
}

ep = build_entrypoint(
    command=action_cfg["command"],                       # e.g. "dino train -e {config_path}"
    specs=specs,                                          # → infers config mode
    inputs=action_cfg["inputs"],                          # spec-keyed dict from skill_info.yaml
    outputs=action_cfg["outputs"],
    config_format=action_cfg["config_format"],            # "yaml" / "toml" / "json"
    upload_excludes=action_cfg.get("upload_excludes", []),
)

sdk = ...   # one of the SDKs above
job = sdk.create_job(
    image=resolve_container_image(skill_info["container_image"]),
    command=ep["command"],
    gpu_count=8,
    # Platform-specific kwargs go here — see each platform's SKILL.md:
    #   Lepton:     dedicated_node_group, resource_shape, num_nodes
    #   SLURM:      partition, account, num_nodes
    #   Kubernetes: namespace, node_selector, tolerations, num_nodes
    #   Docker:     mounts
    #   Brev:       instance_id, gpu_type, cloud_cred_id, workspace_group_id
)
print(f"Job submitted: {job.id}    Results: {job.results_dir}")
```

## Path-keyed jobs (no config file)

The skill's action does not write a spec file — inputs are passed as `{container_path: uri}` and outputs as a list of container paths. Covers HF inference scripts, custom commands, anything that takes its inputs via direct paths rather than a config file.

```python
ep = build_entrypoint(
    command="python infer.py --model /models/cosmos --input /data/in --output /results",
    inputs={                                              # path-keyed → infers passthrough mode
        "/models/cosmos": "hf_model://nvidia/Cosmos-Reason2-8B",   # HF Hub
        "/data/in":       "s3://bucket/test/in",                    # S3
        # also supported: "ngc://..."
    },
    outputs=["/results/"],
)
sdk.create_job(image=img, command=ep["command"], gpu_count=1)
```

In passthrough mode the runtime dispatches each input URI by scheme — `s3://`, `hf_model://`, `ngc://` — to the right downloader. No spec rewriting, no `{config_path}`. After the command, listed output paths are uploaded per the same destination resolution rules (S3 if `S3_BUCKET_NAME`, else mount, else container-ephemeral with warning).
