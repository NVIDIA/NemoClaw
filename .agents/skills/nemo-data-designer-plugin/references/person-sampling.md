# Person Sampling Reference

## Sampler types

Prefer `"person"` when the locale is downloaded — it provides census-grounded demographics and optional personality traits. Fall back to `"person_from_faker"` when the locale isn't available.


| `sampler_type`        | Params class                   | When to use                                                                                         |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `"person"`            | `PersonSamplerParams`          | **Preferred.** Locale downloaded to `~/.data-designer/managed-assets/datasets/` by default.         |
| `"person_from_faker"` | `PersonFromFakerSamplerParams` | Fallback when locale not downloaded. Basic names/addresses via Faker, not demographically accurate. |


## Usage

The sampled person column is a nested dict. You can keep it as-is in the final dataset, or set `drop=True` to remove it and extract only the fields you need via `ExpressionColumnConfig`:

```python
# Keep the full person dict in the output
config_builder.add_column(dd.SamplerColumnConfig(
    name="person", sampler_type="person",
    params=dd.PersonSamplerParams(locale="en_US"),
))

# Or drop it and extract specific fields
config_builder.add_column(dd.SamplerColumnConfig(
    name="person", sampler_type="person",
    params=dd.PersonSamplerParams(locale="en_US"), drop=True,
))
config_builder.add_column(dd.ExpressionColumnConfig(
    name="full_name",
    expr="{{ person.first_name }} {{ person.last_name }}", dtype="str",
))
```

Set `with_synthetic_personas=True` when the dataset benefits from personality traits, interests, cultural background, or detailed persona descriptions (e.g., for realistic user simulation or persona-driven prompting). This option is only available with `"person"` — `"person_from_faker"` does not support it.

## Person Object Schema

Fields vary by locale. Always run the following script to get the exact schema for the locale you are using (script path is relative to this skill's directory):

```bash
python scripts/get_person_object_schema.py <locale>
```

This prints the PII fields (always included) and synthetic persona fields (only included when `with_synthetic_personas=True`) available for that locale.
