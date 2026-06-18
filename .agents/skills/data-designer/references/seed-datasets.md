# Seed Datasets Reference

Seed datasets bootstrap synthetic data generation from existing data. Every column from the seed becomes a Jinja2 variable you can reference in prompts and expressions — the seed provides realism and domain specificity, and Data Designer adds volume and variation on top.

## Before configuring a seed source

1. **Read the source code.** Read `seed_source.py` under the config root directory printed by `data-designer agent context`. This file contains all seed source classes and their parameters. Do not guess types or parameters.

2. **Verify the dataset is readable and fetch column names.** Before wiring the seed into the config, confirm the file can be read and extract its column names. This catches bad paths and corrupt files, and gives you the exact column names available for downstream prompts.

## Notes

- The most common seed source is `LocalFileSeedSource` (local file on disk). Supported formats: `.parquet`, `.csv`, `.json`, `.jsonl`.
- Seed columns are automatically registered as `SeedDatasetColumnConfig` entries — you do **not** add them manually. Just reference them by name in downstream prompts and expressions.
