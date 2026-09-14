# Managed runtime fixtures

`reference.json` records the Go `managed.Spec.JSON`, ownership labels, container
configuration, host configuration, and gateway TOML generated from the Spark
configuration fixture at `v1-poc` revision
`b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`.

The four cases cover gateway layouts 0, 1, and 2, and the inference service.
Generation is the synthetic 32-character value `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
The fixture does not authorize access to any existing deployment.

Tests compare exact specification strings and label hashes. Launch comparisons
normalize only omitted versus null optional maps, which differ between the Go
Docker client and Bollard. All non-null selected launch settings remain exact.
