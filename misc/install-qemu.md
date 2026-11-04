# QEMU installer notes

Run the installer from the repository root with an existing parent directory:

```sh
./misc/install-qemu.sh /opt/
```

The script selects the latest stable source archive from
[QEMU's official release directory](https://download.qemu.org/). For version
`11.1.3`, it creates this layout:

```text
/opt/qemu-11.1.3/
├── build/
│   ├── source/    QEMU source files
│   ├── obj/       generated build files and objects
│   └── share/     installed firmware and data
└── bin/
    └── qemu-system-x86_64
```

The build enables VDE, user networking (Slirp), KVM, and TCG. It builds only
the x86_64 system emulator; QEMU utilities, documentation, and the guest agent
are disabled. `make` uses all available CPU cores. QEMU's source archive
provides the Meson version used by its `configure` script.

On Debian/Ubuntu, the installer uses `apt-get` if build dependencies are
missing. It does not install `qemu-img`; use the distribution's `qemu-utils`
package for that command. Running a VDE network also requires `vde_switch`
from the `vde2` package.

After installation, check the binary and its VDE backend:

```sh
/opt/qemu-11.1.3/bin/qemu-system-x86_64 --version
/opt/qemu-11.1.3/bin/qemu-system-x86_64 -netdev help
```

Use the versioned `bin` directory in `PATH` when launching QEMU by command
name. The installer stops if the destination version directory already exists,
so an existing build is never overwritten.
