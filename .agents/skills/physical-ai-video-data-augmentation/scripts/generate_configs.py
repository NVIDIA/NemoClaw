#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate Augmentation configs for each input video."""

import hashlib
import os
import sys
import yaml
import random
from pathlib import Path
from omegaconf import OmegaConf


def _stable_hash(s: str) -> int:
    """Deterministic hash stable across Python sessions (no PYTHONHASHSEED dependence)."""
    return int(hashlib.sha256(s.encode()).hexdigest(), 16) % (2**31)


def find_videos(input_dir):
    """Find all MP4 videos in input directory."""
    videos = []
    for ext in ['*.mp4', '*.avi', '*.mkv']:
        videos.extend(Path(input_dir).rglob(ext))
    video_list = [{'path': str(v), 'name': v.stem} for v in videos]
    return sorted(video_list, key=lambda x: x['name'])


def generate_configs(config_file, base_config_file, videos, output_dir):
    """Generate cosmos configs for each video and augmentation."""
    with open(config_file, 'r') as f:
        pipeline_config = yaml.safe_load(f)
    
    with open(base_config_file, 'r') as f:
        base_config = OmegaConf.create(yaml.safe_load(f) or {})
    
    n_augmentations = pipeline_config['augmentation']['n_augmentations']
    variables = pipeline_config['augmentation']['variables']
    
    random.seed(42)
    config_count = 0
    manifest = []
    
    for video in videos:
        video_name = video['name']
        video_path = video['path']
        
        for aug_idx in range(n_augmentations):
            # Sample variable values based on distribution
            sampled_vars = {}
            for var_name, distribution in variables.items():
                if isinstance(distribution, dict):
                    values = list(distribution.keys())
                    probs = list(distribution.values())
                    sampled_vars[var_name] = random.choices(values, weights=probs, k=1)[0]
                elif isinstance(distribution, list):
                    sampled_vars[var_name] = random.choice(distribution)
            
            # Create override config
            aug_subdir = f'{output_dir}/{video_name}/aug_{aug_idx}'
            os.makedirs(aug_subdir, exist_ok=True)
            
            # Build variable overrides for both config formats:
            # - template_generation.variables (old format)
            # - captioning.llm.variables (new format)
            # Restrict each variable to a single-element list with the sampled value.
            # Uses the same key names from workflow_config.yaml (e.g. weather, time_of_day).
            sampled_as_lists = {k: [v] for k, v in sampled_vars.items()}
            
            override_config = OmegaConf.create({
                'data': [{
                    'inputs': {
                        'rgb': video_path,
                        'controls': {'edge': None, 'depth': None, 'seg': None, 'vis': None},
                    },
                    'output': {
                        'video': f'{aug_subdir}/output.mp4',
                        'caption': f'{aug_subdir}/output.txt',
                        'metadata': f'{aug_subdir}/metadata.json',
                    },
                }],
                'template_generation': {
                    'variables': sampled_as_lists,
                },
                'prompt_generation': {
                    'seed': _stable_hash(f'{video_name}_{aug_idx}'),
                },
                'cosmos': {
                    'parameters': {
                        'seed': _stable_hash(f'{video_name}_{aug_idx}_cosmos'),
                        'inference_name': f'{video_name}_aug{aug_idx}',
                    },
                },
            })
            
            merged_config = OmegaConf.merge(base_config, override_config)
            
            # Replace captioning.llm.variables entirely with sampled values
            # so the LLM only sees the target attributes, not the full vocabulary.
            # Direct assignment drops the old map; OmegaConf.update merges dicts.
            if OmegaConf.select(merged_config, 'captioning.llm.variables') is not None:
                merged_config.captioning.llm.variables = OmegaConf.create(sampled_as_lists)
            
            config_filename = f'{video_name}_aug{aug_idx}.yaml'
            config_path = f'{output_dir}/{config_filename}'
            
            with open(config_path, 'w') as f:
                yaml.dump(OmegaConf.to_container(merged_config), f, default_flow_style=False)
            
            manifest.append({
                'video': video_path,
                'video_name': video_name,
                'aug_idx': aug_idx,
                'config': config_filename,
                'sampled_vars': sampled_vars,
            })
            config_count += 1
            print(f"Generated: {config_filename} ({sampled_vars})")
    
    # Write manifest
    with open(f'{output_dir}/manifest.yaml', 'w') as f:
        yaml.dump({'configs': manifest, 'total': config_count}, f)
    
    return config_count


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: python generate_configs.py <input_videos_dir> <config_dir> <output_dir>")
        sys.exit(1)
    
    input_videos_dir = sys.argv[1]
    config_dir = sys.argv[2]
    output_dir = sys.argv[3]
    
    videos = find_videos(input_videos_dir)
    print(f"Found {len(videos)} videos")
    
    # Discover config file: try standardized names in order
    for _name in ('workflow_config.yaml', 'input_config.json', 'test_config.yaml'):
        config_file = f'{config_dir}/{_name}'
        if os.path.exists(config_file):
            break
    else:
        print(f"Error: no config file found in {config_dir} (tried workflow_config.yaml, input_config.json, test_config.yaml)")
        sys.exit(1)

    # Read base augmentation YAML name from the config (yaml.safe_load handles both JSON and YAML)
    with open(config_file) as _f:
        _cfg = yaml.safe_load(_f)
    base_config_name = _cfg.get('augmentation', {}).get('config', 'augmentation/augmentation.yaml')
    base_config_file = f'{config_dir}/{base_config_name}'
    
    count = generate_configs(config_file, base_config_file, videos, output_dir)
    print(f"\nGenerated {count} config files")
