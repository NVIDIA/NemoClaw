# Preview Review Guide

## Mindset

Quality is statistical, not per-record. Fix systemic issues that affect many records; don't chase cosmetic flaws in individual ones. But don't stop early — clear patterns of broken data or ignored instructions are worth fixing.

## Reading Sample Records

Load `dataset.parquet` from the preview results directory (printed as `Results path:` by the preview command, or the most recent `artifacts/preview_results_*/` directory). Use pandas to load the parquet file and print the records in a compact, reviewable format.

## What to Look For

The specifics depend on the dataset and its intended use. The categories below are common starting points — adapt based on what matters for this dataset.

### Diversity
- **Mode collapse**: are records clustering around the same patterns, topics, or phrasings?
- **Sampler effectiveness**: are samplers being used effectively to steer diversity in the dataset?
- **Structural monotony**: do LLM-generated columns follow the same template across records?

### Data Quality
- **Instruction compliance**: does generated content follow prompt constraints (step counts, format requirements, allowed values)?
- **Internal consistency**: does data within a record agree with itself?
- **Encoding integrity**: no garbled encoding, mojibake, or broken unicode.
- **Plausibility**: do examples look like they could come from the real domain, or are they obviously synthetic?
- **Judge calibration** (if applicable): are scores consistent across similar-quality records? Does the judge catch visible problems?

### Design Choices
Are the right Data Designer features being used? For example:
- A text column that consistently produces structured data or code might be better as a specialized column type.
- Values drawn from a fixed set or known distribution could use a sampler instead of an LLM column.
