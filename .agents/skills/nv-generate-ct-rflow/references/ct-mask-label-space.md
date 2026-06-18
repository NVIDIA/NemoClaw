# Label Space

Standalone mask generation emits raw MAISI labels after upstream remapping:

- mask autoencoder channels are `0..124`
- upstream remaps through `configs/label_dict_124_to_132.json`
- output masks should use MAISI values from `configs/label_dict.json`
- CT image-from-mask expects `0`, `1..132`, and optionally body envelope `200`

Controllable tumor slots:

| Anatomy | Raw MAISI label |
|---|---:|
| lung tumor | 23 |
| pancreatic tumor | 24 |
| hepatic tumor | 26 |
| colon cancer primaries | 27 |
| bone lesion | 128 |

This differs from `nv-generate-ct-rflow` paired output. The paired pipeline
filters final labels into local output ids `1..N`; use that wrapper's
`output.output_label_mapping` to map paired output labels back to MAISI IDs.
