# Isolated firmware compiler pack

The first profile is `firmware-avr-gcc-v1`: AVR GCC 5.4.0, baremetal C11,
explicit `atmega328p` compiler ABI, linux/amd64. This ABI is a declaration;
it does not identify a populated MCU or establish hardware compatibility.
PlatformIO, ESP-IDF, Arduino CLI, Zephyr, other ABIs and multiple source bundles
remain explicit unsupported profiles until separately pinned and qualified.
The shared firmware request/reference shape permits further reviewed packs.

The image definition pins the Debian amd64 base manifest and compiler, binutils,
avr-libc and Python packages. Package installation occurs at image build time.
No package download, network, user build script, generated executable or flash
utility runs during a compile job. An image build alone does not approve execution.
The operator records the actual image digest, package inventory, versions,
licenses and fixture evidence before approving the generated recipe.

The recipe uses a fixed trusted Python adapter and fixed GCC/objcopy/size argument
vectors. Known integer configuration becomes C macros. Unknown configuration,
secret references, source scripts/configuration, non-C translation units and mixed
rights fail explicitly. Every mounted file must match the firmware source pin.
Read-only inputs, network none, nonroot, no capabilities, no new privileges,
1 GiB memory, 2 CPUs, 128 PIDs, 180 seconds and 16 MiB total output apply through
the shared runner. There is no application DB or device mount in the tool image.

Successful outputs are `firmware.elf`, `firmware.hex`, `compile.log`,
`compile.json` and a separate `handoff.json`. The handoff pins the frozen firmware,
source files/rights, configuration, toolchain, population/native target/pins and,
when supplied, one exact frozen assembly occurrence. The application checks the
successful registered receipt and hashes, ELF AVR identity and Intel HEX checksums.
These checks do not qualify hardware, flashing, device operation or manufacturing.
Failures remain failed build evidence and cannot yield an accepted handoff.

The Debian packages retain their installed copyright notices in `/usr/share/doc`.
GCC/binutils are GPL tools; runtime library exceptions and avr-libc's BSD-style
terms remain applicable to generated outputs. Consult the exact installed notices
and the firmware source rights before redistribution. This pack copies no
predecessor code or hardware examples.
