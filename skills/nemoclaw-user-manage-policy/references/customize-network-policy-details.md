# Customize the Sandbox Network Policy: Details

## Remove a Custom Preset

Custom presets applied with `--from-file` or `--from-dir` are recorded in the NemoClaw sandbox registry alongside their full YAML content, so they can be removed by name — the original file does not need to be kept on disk:

```console
$ nemoclaw my-assistant policy-remove my-internal-api --yes
```

`policy-remove` accepts both built-in and custom preset names. Run `nemoclaw <name> policy-list` to see every preset currently applied to the sandbox.
