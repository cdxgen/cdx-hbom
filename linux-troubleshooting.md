# Linux troubleshooting

`cdx-hbom` can return a useful HBOM in a default OS install. Installing some packages improves the amount of command-based enrichment that can be collected for storage, firmware, display, power, Thunderbolt, modem, and CPU frequency data.

## Ubuntu

These are the exact `apt` commands used on the Ubuntu test hosts during validation.

### Ubuntu amd64 hosts

This set improved enrichment on the NUC-style amd64 test machines:

```bash
sudo apt-get update
sudo apt-get install -y lshw fwupd bolt modemmanager edid-decode
```

This installs the commands behind:

- `lshw`
- `fwupdmgr`
- `boltctl`
- `mmcli`
- `edid-decode`

### Ubuntu arm64 hosts such as Raspberry Pi

This set improved enrichment on the Pi 5 arm64 test machine:

```bash
sudo apt-get update
sudo apt-get install -y upower edid-decode linux-tools-common linux-tools-$(uname -r)
```

Notes:

- `upower` provides the `upower` command.
- `linux-tools-$(uname -r)` is the package that provides `cpupower` on current Ubuntu kernels.
- `linux-tools-common` is installed alongside it because Ubuntu splits the tooling across packages.

### One combined Ubuntu command

If you want a single Ubuntu command that covers the packages we needed across both host types, use:

```bash
sudo apt-get update
sudo apt-get install -y lshw fwupd bolt modemmanager edid-decode upower linux-tools-common linux-tools-$(uname -r)
```

## Fedora

The Fedora package names below were checked against the public Fedora 42 Everything repository metadata.

```bash
sudo dnf install -y lshw fwupd bolt ModemManager edid-decode upower kernel-tools
```

Notes:

- `ModemManager` provides `mmcli`.
- `kernel-tools` provides `cpupower`.
- `bolt` provides `boltctl`.
- `fwupd` provides `fwupdmgr`.

## RHEL 9 and compatible distributions

The RHEL-family package names below were checked against the public CentOS Stream 9 BaseOS and AppStream metadata, which is the closest public match for the RHEL 9 package naming model.

```bash
sudo dnf install -y lshw fwupd bolt ModemManager upower kernel-tools
```

Notes:

- `ModemManager` provides `mmcli`.
- `kernel-tools` provides `cpupower`.
- `bolt` provides `boltctl`.
- `fwupd` provides `fwupdmgr`.

### Important RHEL note about `edid-decode`

During verification, `edid-decode` was **not** present in the public CentOS Stream 9 BaseOS or AppStream metadata. It was also not present in the public EPEL 9 Everything metadata that was checked at the same time.

That means the standard RHEL 9 style command above improves most optional HBOM enrichment, but it may still leave `edid-decode` unavailable unless you add another repository or ship the tool separately.

## openSUSE and SUSE Linux

The package names below were checked against the public openSUSE Tumbleweed OSS repository metadata. Additional spot checks were also made against SUSE Package Hub package pages for packages such as `lshw`, `fwupd`, `bolt`, and `cpupower`.

```bash
sudo zypper --non-interactive install lshw fwupd bolt ModemManager edid-decode upower cpupower
```

Notes:

- `ModemManager` provides `mmcli`.
- `cpupower` is a standalone package in the SUSE ecosystem, unlike Fedora and RHEL where it comes from `kernel-tools`.
- On SUSE Linux Enterprise, package availability can depend on enabled modules or Package Hub. The package names themselves stay the same.

## When to use `--privileged`

Missing packages and missing privilege are different issues.

Use `--privileged` when the diagnostic is about permissions or when you want privileged Linux enrichment such as `dmidecode` or the explicit `sudo -n` retry path for supported commands.

Installing packages helps with diagnostics such as:

- `missing-command`
- reduced optional enrichment coverage

Using `--privileged` helps with diagnostics such as:

- `permission-denied`
- optional privileged enrichment that needs root or passwordless sudo

## When you want a quieter run without extra packages

If you do not want command-based enrichment at all, disable it:

```bash
node ./bin/cdx-hbom.js --no-command-enrichment
```

That avoids optional command lookups and their related command diagnostics, but it also removes the additional enrichment those commands provide.
