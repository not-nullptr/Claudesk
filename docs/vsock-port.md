# One Cowork VM per host — and the per-instance port that fixes it

> **Superseded.** The per-instance port move described here was only ever
> half-proven — the host constant is locatable and rewritable, but the guest's
> dial site was never found, and without both halves it is not usable. The clean
> path is a kernel with the AF_VSOCK namespace feature, where each container's
> namespace partitions the listener table and no binary needs touching. See
> `cowork-vsock-netns-solution.md` and `cowork-vm-vsock-port.md`. This file is
> kept for the mechanism and the measurements, not as a recommendation.

## The problem

The Cowork VM talks back to the host over vsock. The host side,
`cowork-linux-helper` (the Desktop app's own Go binary), listens on **port
51234**; the guest side, `coworkd`, dials `(host CID 2, port 51234)`. Both values
are compile-time constants:

- the helper's only flag is `-socket` (`cowork-linux-helper -h`), the app passes
  no port, and no environment variable reaches either side;
- the app's `startVM` path sends no port to the helper;
- the helper listens with **VMADDR_CID_ANY**, so the listener belongs to the
  host's single `/dev/vhost-vsock` device.

Two consequences make this a deployment ceiling:

1. **Host-side vsock binds are host-global, not per namespace.** In a fresh
   network namespace (`unshare -n`, verified to be a different net id) binding
   51234 still returns `EADDRINUSE`, while 51235 there binds fine.
2. **A listener cannot be scoped to a guest CID.** Binding `(cid, 51234)` for any
   specific CID returns `EADDRNOTAVAIL` — that CID is not local to the host.

So on one host only **one** Cowork VM can run at a time. The second instance's VM
fails with:

```
vsock listen on port 51234: bind: address already in use
```

which the UI reports as *"Workspace unavailable. The isolated Linux environment
failed to start…"*. With one container per account (Eva mode), this bites as soon
as two accounts use Cowork at once.

## The fix: a port per instance

`patch-vsock-port.mjs` finds a port loaded as a 32-bit immediate
(`mov $imm32,%e?x`) and rewrites it. Go compiles these constants straight into
the instruction, so there is no string to match — the encoding is the target.
`22 c8 00 00` is `51234`; the helper's site is a single `mov $imm32,%ebx`.

The boot script `rootfs/etc/cont-init.d/22-cowork-vsock-port.sh` runs when
`CLAUDESK_VM_VSOCK_PORT` is set:

- copies the image's helper into the instance's persistent root, patches the
  copy, and **bind-mounts it over the original path** — the overlay's upper layer
  is never written, so a later app update brings a pristine helper back and the
  patch is re-derived instead of a stale binary shadowing a newer one;
- patches `rootfs.img` in the instance's own VM bundle when
  `CLAUDESK_VM_VSOCK_GUEST_SITES` is non-zero (the guest image is not
  content-hashed — the `.origin` files are a bundle revision id shared by
  rootfs/kernel/initrd — so this survives, and it is per instance because each
  account's bundle is its own reflink);
- refuses anything that does not match the expected site count, so a changed
  layout stops the container instead of patching half the pair.

Ports are assigned in `provision-user.sh`: each account gets
`CLAUDESK_VM_VSOCK_PORT_BASE + <authd id>`, and the deployment's own instance uses
`CLAUDESK_VM_VSOCK_PORT`. **Both are unset by default** — nothing moves until an
operator turns it on, because a host moved without its guest is worse than
neither.

## Enabling it — do this in order

Patching **only** the host is worse than not patching: the guest would still dial
51234 and land on whichever helper still holds it — another tenant's. So the
guest side has to be settled first.

### 1. Does the guest follow the host?

Everything points to the guest hardcoding 51234, but it is cheap to be sure, and
it decides whether `CLAUDESK_VM_VSOCK_GUEST_SITES` must be set:

1. Make sure the host is otherwise quiet — **no other instance may be running a
   VM** — or a misdirected guest could reach the wrong helper.
2. On one instance, set `CLAUDESK_VM_VSOCK_PORT` to a free port and
   `CLAUDESK_VM_VSOCK_GUEST_SITES=0`, recreate that instance, and open Cowork.
3. In the guest console log, look for `[rpc] connecting to host CID=2 port=…`. If
   it names the port you set, the guest follows the host and
   `GUEST_SITES=0` is correct for every instance. If it still says 51234 (and the
   VM fails), the guest hardcodes it — go to step 2.

### 2. Locate the guest's site

The guest image is not readable without privileges, so run this on the box:

```bash
node /opt/claude-cowork-bridge/patch-vsock-port.mjs scan \
  --file /config/.config/Claude-3p/vm_bundles/claudevm.bundle/rootfs.img \
  --encoding all
```

The correct site is the one that sits inside `coworkd`'s `.text` — confirm which
file the offset lands in by mounting the image read-only (`debugfs` after
`losetup -o <partition offset>`). Set `CLAUDESK_VM_VSOCK_GUEST_SITES` to that
count and `CLAUDESK_VM_VSOCK_GUEST_ENCODING` to its encoding.

## Tools

```
patch-vsock-port.mjs scan  --file F [--port P] [--encoding all]
patch-vsock-port.mjs check --file F --port P [--default 51234] [--expect N]
patch-vsock-port.mjs patch --file F --port P [--default 51234] [--expect N]
```

`scripts/vsock-port-smoke.mjs` pins the tool and the boot script's orchestration
(including that the installed helper is never modified in place).
