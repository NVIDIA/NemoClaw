# Terraform Modules

These modules are sourced from [microsoft/physical-ai-toolchain](https://github.com/microsoft/physical-ai-toolchain/tree/main/infrastructure/terraform/modules).

To extract all modules into this directory:

```bash
cd /tmp
git clone --depth=1 --filter=blob:none --sparse \
  https://github.com/microsoft/physical-ai-toolchain.git
cd physical-ai-toolchain
git sparse-checkout set infrastructure/terraform/modules
cp -r infrastructure/terraform/modules/* \
  /path/to/physical-ai-skills/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/terraform/modules/
```

Required modules: `platform`, `sil`
Optional modules: `automation`, `dataviewer`, `vpn`
