# Mask Format

The input mask must be a NIfTI label map in the MAISI CT vocabulary:

- one channel
- integer-like voxel values
- `0` for background
- `1..132` for anatomy labels from upstream `configs/label_dict.json`
- `200` for body envelope

The released CT ControlNet expects label `200` on body voxels that are not
assigned to a specific organ. A segmentation from NV-Segment-CT or another
segmenter usually does not include this body envelope and should be converted
before image-from-mask inference.

Masks in autoencoder-channel space `0..124` are not valid input for released
CT ControlNet. Remap them through upstream `configs/label_dict_124_to_132.json`
first.
