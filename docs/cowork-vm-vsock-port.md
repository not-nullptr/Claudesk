# Cowork VM: a fixed vsock port makes it one VM per host

A problem statement for someone who wants to take a run at it. Everything below
is either a measurement taken on the box or a fact read out of the binaries, with
the command or file noted. Inferences are labelled as such.

> **The clean fix is known, and it is a kernel, not a patch.** Kernels carrying
> the AF_VSOCK network-namespace feature (`/proc/sys/net/vsock/{ns_mode,child_ns_mode}`,
> mainline 7.0 or a verified backport) partition the listener table per namespace,
> so Docker's per-container namespace is enough and nothing here needs touching.
> See `cowork-vsock-netns-solution.md`. This host runs 6.8 and has no such
> feature, which is why everything below looks host-global — that is the
> pre-feature behaviour, not a permanent property.

## The deployment

- One Linux host (Docker + KVM). One Docker **container per tenant account**;
  each runs its own Claude Desktop (Electron) instance, plus a bridge container
  sharing its network namespace.
- Claude Desktop's **Cowork** feature runs an agent in an isolated Linux guest:
  the app starts `qemu-system-x86_64` with `/dev/kvm` and `/dev/vhost-vsock`,
  booting a Linux image from a per-account disk bundle
  (`…/vm_bundles/claudevm.bundle/rootfs.img`).
- The guest talks back to the host over **AF_VSOCK**. That pipe is what breaks
  when more than one tenant on the host uses Cowork at the same time.

## Symptom

The second (and later) instance's VM fails to start:

```
Workspace unavailable. The isolated Linux environment failed to start
(vsock listen on port 51234: listen vsock vm(4294967295):51234: bind: address already in use).
```

`vm(4294967295)` is `VMADDR_CID_ANY`. The first instance's VM runs fine; every
other one on the same host fails until that one's VM stops.

## The two ends of the connection

**Host side** — `/usr/lib/claude-desktop/resources/cowork-linux-helper`, a Go
binary the app spawns as `cowork-linux-helper -socket /tmp/run/user/app/claude-cowork-vm.sock`.
It listens on vsock for the guest to connect and then serves the guest RPC.

- Only one flag exists (`-h`):
  ```
  Usage of …/cowork-linux-helper:
    -socket string
        unix socket path to listen on (default "/tmp/run/user/app/claude-cowork-vm.sock")
  ```
- It logs `vsock listen on port %d: %w` — the failure above.
- It is single-guest by construction: its binary contains `guest connection
  superseded by new boot` and `[guestrpc] rejecting connection from %s (expected
  CID %d)`.
- It writes its own qemu command line; the vsock device argument is
  `vhost-vsock-pci,guest-cid=%d`, with a per-boot guest CID (observed:
  `cid=294865509`).
- The port is a compile-time constant. At file offset **1,347,708** there is a
  single `mov $51234,%ebx` (`bb 22 c8 00 00`), confirmed by `objdump` and by
  rewriting it on a copy and diffing the bytes.

**Guest side** — `coworkd`, running inside the guest VM. From its console log:

```
[rpc] connecting to host CID=2 port=51234
[rpc] connected successfully
```

So the guest dials host CID 2 (= host) on the same fixed port. The dial happens
at guest boot, before it has exchanged anything with the host — the connection it
is making *is* the first exchange.

## Measurements

### 1. The vsock listener table is not partitioned by network namespace

**On this host, whose kernel is 6.8.0-142-generic and has no
`/proc/sys/net/vsock/`.** This is version-dependent, and the version is the whole
story: kernels that carry the AF_VSOCK network-namespace feature — documented at
`/proc/sys/net/vsock/{ns_mode,child_ns_mode}`, mainline 7.0 and later, or a
distribution backport — *do* partition it, and a namespace created with
`ns_mode=local` gets its own vsock listener table. On such a kernel a
container-per-tenant layout can run one VM per tenant with no binary changes at
all. See `cowork-vsock-netns-solution.md` for that path. The measurement below is
what a pre-feature kernel does, and is why the failure reproduces here.

Run inside the container, then again in a fresh network namespace:

```
this container's netns :   51234 -> EADDRINUSE | 51236 -> OK
fresh netns (unshare -n):  51234 -> EADDRINUSE | 51236 -> OK
```

The net ids differ (`4026532684` vs `4026537080`), so the namespace really
changed. An unused port binds in the fresh namespace; 51234 does not. A netns —
which is precisely what Docker gives each container for the IP stack — does not
partition this.

Probe used:

```python
import socket, errno
s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
s.bind((0xFFFFFFFF, 51234))   # VMADDR_CID_ANY
```

### 2. The listener cannot be scoped to a guest CID instead

Binding to any specific CID returns `EADDRNOTAVAIL` — guest CIDs are not local to
the host:

```
bind cid=2     port=51234 -> EADDRINUSE   (an existing ANY listener covers it)
bind cid=100   port=51235 -> EADDRNOTAVAIL
bind ANY       port=51235 -> OK
```

So "one listener per guest CID" is not an available shape.

### 3. No configuration surface for the port

- The helper's only flag is `-socket` (above).
- The app's `startVM` path in `app.asar` passes no port; the helper's JSON
  parameter tags are `bundlePath, certificates, code, data, enabled, fatal,
  httpProxy, httpsProxy, id, installed, message, method, noProxy, resultJson,
  running, status, success, type` — no port.
- The app exposes only `COWORK_VM_DEBUG`, `COWORK_VM_IDLE_MINUTES`,
  `COWORK_VM_MEMORY_GB`, `COWORK_VM_SCHEDULE_GUARD_MINUTES`; the helper reads
  only `COWORK_VM_ACCEL` and `COWORK_VM_FORCE_EFI`.
- The guest image exposes no port flag or env either (no `COWORKD_*` port
  setting; its port appears only as `port=51234` in log lines).

### 4. The guest image is not content-hash pinned

The bundle carries `.rootfs.img.origin`, `.vmlinuz.origin`, `.initrd.origin`,
`.cowork-adopted` — all the **same 40-hex value**
(`882518393ed4ce89020bd48d99d5daf114999773`), i.e. a bundle revision id, not a
per-file digest. The helper's own check is phrased as "bundled kernel/initrd
origin does not match rootfs.img" (all three must agree on the revision).

Separately, the VM attaches a *second*, read-only disk
(`virtio-blk-pci,drive=smolbindisk,…,readonly=on,id=smolbindisk`) which the guest
references as `smolBinPath`; the guest logs an `[updater] smol-bin image …`
verification against it. That is a different artifact from `rootfs.img`.

### 5. A naive scan does not locate the guest's port

Scanning the raw `rootfs.img` (10 GiB) for the *instruction* form
`bb <port:u32le>` turns up hits, but they are not distinguishable from noise:

| port searched | hits | offsets |
|---|---|---|
| 51234 | 3 | 6844997049, 6845234529, 6845564385 |
| 51233 | 3 | 6845418849, 6845454957, 6845646093 |
| 51235 | 4 | 6844988337, 6845364177, 6845516421, 6845547717 |

Unrelated, meaningless port values return the same counts in the same ~600 KB
region around 6.845 GB. That region contains no `coworkd`, no `vsock`, and no Go
runtime strings within ±32 MB, and no ELF section covers it. Whatever it is, it
is not `coworkd`'s code. **The guest's port constant has not been located.**

## The constraints, restated

Any solution has to satisfy all of:

1. The host side needs a vsock listener to reach the guest; the guest dials
   `(host CID 2, <port>)` unilaterally at boot.
2. The host listener table observed above is shared across network namespaces on
   this kernel (6.8), and the underlying device (`/dev/vhost-vsock`) is a single
   host device passed into each container with `devices:`. On a kernel with the
   AF_VSOCK namespace feature this constraint dissolves — a `local`-mode
   namespace partitions the table, and Docker already creates one per container.
3. A listener cannot be bound to a specific guest CID.
4. Neither end exposes a port, and the guest's dial happens before it can be told
   anything by the host.

Point 4 is an argument, not a measurement: because the dial is the guest's first
contact, the port cannot come from the host at runtime. It could still come from
something the host supplies *at boot* (kernel command line, an attached disk, a
shared filesystem) — see below. The helper's kernel command line is a literal
without a port (`root=/dev/vda1 ro console=hvc0 console=hvc1 fsck.repair=yes`).

## Directions that were looked at

- **Network namespace / "just bind it inside the container."** Measured: does not
  partition the table. (Section 1.)
- **CID-scoped listener.** Measured: unavailable. (Section 2.)
- **Config/flag/env for the port.** None exists on either side. (Section 3.)
- **Moving both constants (a per-instance port).** The host constant is located
  and rewritable; the guest constant is not located (Section 5). A host-only move
  would leave the guest dialling 51234 and landing on whichever other instance
  still holds it, so the pair is only useful together.
- **A proxy on 51234 that demuxes by guest CID.** The guest's connection carries
  its CID, but the helper checks the peer CID against an expected value, so a
  proxy would have to preserve it end to end.

## Directions not yet explored — the interesting ones

- **A kernel with the AF_VSOCK network-namespace feature.** The clean answer, and
  the one that needs no binary or image changes: on such a kernel a namespace
  created with `ns_mode=local` has its own vsock listener table, so each tenant
  container — which Docker already gives its own namespace — binds 51234
  privately. `cowork-vsock-netns-solution.md` lays out the prerequisites, the
  write-once `child_ns_mode` trap, and the acceptance test. What is left is a
  host kernel with the feature (mainline 7.0+, or a verified backport) and a
  boot-time policy so tenant namespaces are created in `local` mode.
- **A kernel boundary below the container.** If the host kernel cannot be moved,
  two VMs have two kernels
  and therefore two vsock tables; each could bind 51234 without knowing the other
  exists. Running each tenant's Desktop inside its own microVM (Kata,
  Firecracker, …) rather than a container is the obvious instance of this. The
  gate is nested virtualization: the Cowork VM inside the tenant VM needs
  `/dev/kvm` of its own (`/sys/module/kvm_intel/parameters/nested`, or `kvm_amd`).
- **A userspace vsock transport.** qemu supports `vhost-user-vsock` with a
  userspace backend (`vhost-device-vsock` and friends) instead of the kernel
  `vhost-vsock-pci` device. Worth investigating whether that changes where the
  host-side listener lives. The helper's qemu arguments are compiled in, so this
  would need something at the qemu invocation boundary.
- **Finding the guest's dial site.** Mounting `rootfs.img` read-only on a host
  with loop devices available (`losetup -o <partition offset>` — the image is
  GPT-partitioned; an ext4 superblock candidate sits at offset 116392960), then
  disassembling the actual `coworkd` binary. Section 5's failure is about scanning
  a raw image, not about the binary being unreadable once mounted.
- **Where the guest's port comes from after all.** Since the dial is the guest's
  first act, the value is fixed before any host exchange. Candidates worth
  ruling in or out: the kernel command line, the read-only `smol-bin` disk, or
  anything in the host `/config` directory that the guest mounts over virtiofs.
- **Upstream.** Whether a newer Desktop build makes the port dynamic, or supports
  more than one guest, is unknown from here.

## Environment

- Host kernel: `6.8.0-142-generic`, `CONFIG_VSOCKETS` present, `vhost_vsock`
  loaded. `/dev/vhost-vsock` and `/dev/kvm` passed into each container.
- Containers: Docker, `userns_mode: host`, `cap_add: SYS_ADMIN`, seccomp profile
  that unlocks `mount`/`pivot_root` (the container re-roots into an overlay whose
  upper layer is a per-tenant host directory).
- Claude Desktop: `2.31226.1` (Linux `.deb`), launched as the `app` user.
- Guest: direct kernel boot (`vmlinuz` + `initrd`), root `/dev/vda1`, systemd,
  `coworkd` as a systemd unit.

## Reproducing

On any host running two such containers:

```sh
# fresh namespace, unused port vs the busy one
sudo unshare -n python3 - <<'PY'
import socket, errno
def b(p):
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try: s.bind((0xFFFFFFFF, p)); s.listen(1); return "OK"
    except OSError as e: return errno.errorcode.get(e.errno)
    finally: s.close()
print("51234 ->", b(51234), "| 51236 ->", b(51236))
PY
```

Start Cowork in two containers at once; the second's Desktop logs the
`address already in use` line above and the UI shows "Workspace unavailable".
