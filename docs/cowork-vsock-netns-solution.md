# Running Multiple Cowork VMs on One Linux Host Without Binary Patching

**Solution:** isolate each tenant's AF_VSOCK transport with Linux `local`-mode network namespaces.  
**Prepared:** 13 October 2026  
**Status:** upstream Linux implementation verified against documentation and source; **not yet validated on the specific Cowork installation**.  
**Original case:** `cowork-vm-vsock-port.md` (user-supplied measurements and binary inspection).

> **Executive decision:** On a Linux kernel with the AF_VSOCK network-namespace feature introduced in **mainline Linux 7.0** (or a verified backport), give each tenant a **distinct network namespace whose vsock `ns_mode` is `local`**. Keep that tenant's `cowork-linux-helper` **and its QEMU process** in the same namespace. Each helper can then bind the unchanged `VMADDR_CID_ANY:51234` listener and each Cowork guest can still dial host **CID 2, port 51234**. This avoids editing either binary, separate physical hosts, and extra tenant microVMs.
>
> This is a proposed deployment fix supported by upstream code, **not a claim that the real Cowork two-tenant test has passed**. Complete the smoke tests and acceptance criteria below before production rollout.

## 1. Problem and scope

### 1.1 Existing deployment

The reported setup is:

- One Linux host with **Docker** and **KVM**.
- One tenant container per account, each running a separate Claude Desktop (Electron) instance. A bridge container shares that tenant container's network namespace.
- Cowork launches a Linux guest through `qemu-system-x86_64`, accessing `/dev/kvm` and `/dev/vhost-vsock`; the guest boots from a per-account VM bundle.
- A native `cowork-linux-helper` exposes the guest RPC endpoint through `AF_VSOCK`.
- Measured baseline host kernel: **`6.8.0-142-generic`**. Measured Desktop build: **`2.31226.1`**.

When the first Cowork VM is running, starting a second tenant's Cowork VM fails with:

```text
Workspace unavailable. The isolated Linux environment failed to start
(vsock listen on port 51234: listen vsock vm(4294967295):51234: bind: address already in use).
```

The original investigation established the following for that build and host:

1. The host helper binds `VMADDR_CID_ANY` (`0xFFFFFFFF`), port **51234**.
2. The guest daemon `coworkd` unilaterally connects to host **CID 2**, port **51234** at boot.
3. On the existing **6.8** kernel, binding the same vsock port in a fresh Docker or `unshare --net` namespace still returns `EADDRINUSE`.
4. The helper and guest have no exposed port setting. Changing only the helper's binary constant would not update the guest.
5. The helper checks an **expected guest CID**. Reconnecting the stream through an ordinary relay may change the peer identity observed by the helper.
6. The helper launches QEMU with a `vhost-vsock-pci,guest-cid=...` device, using a guest CID chosen for that boot.

These observations come from the original case report; they should not be mistaken for new experiments performed for this document.

### 1.2 Requirements

The deployment fix must:

- Allow **two or more tenants simultaneously**, all using port `51234`.
- Keep the guest's dial target at `(CID 2, port 51234)` and preserve the actual guest peer CID for the helper.
- Avoid binary modification of `cowork-linux-helper` or `coworkd`.
- Stay on **one Linux host** and retain Docker/KVM, without putting each tenant in an additional microVM.
- Preserve each tenant's network connectivity and the bridge-container arrangement.

## 2. Why new vsock namespace support solves this

### 2.1 The version-dependent fact that changes the answer

**Before Linux 7.0**, AF_VSOCK sockets were not isolated by ordinary Linux network namespaces. Separate Docker network namespaces did *not* give separate vsock listener tables; the measured `EADDRINUSE` behavior on 6.8 is consistent with the old kernel design.

**Linux 7.0 added network namespace awareness** for the `vhost-vsock` host transport and the `vsock-loopback` transport. It has two modes:

| `ns_mode` | AF_VSOCK behavior | Suitable for these tenants? |
|---|---|---|
| `global` | Shared CID allocation and socket reachability with other `global` namespaces; backwards-compatible default | **No** — the original port collision can persist |
| `local` | Private CID allocation; sockets/VMs communicate only within that specific namespace | **Yes** — one listener on port `51234` per distinct local namespace |

The initial host network namespace (`init_net`) itself always stays `global`. What must become `local` is **each newly created tenant network namespace**, not the initial host namespace.

Both **the host-side listener lookup** and **vhost-vsock VM-device routing** are namespace aware in the new kernel. The kernel stores a pointer to the process's network namespace when `/dev/vhost-vsock` is opened. As a result, the same *device node* can be provided to distinct tenant containers without merging their vsock transport namespaces.

**Important qualification:** This works only if QEMU opens `/dev/vhost-vsock` **while already running in the correct tenant namespace**. Moving a process after the device has been opened, or inheriting an already-open device descriptor from another namespace, is not equivalent.

### 2.2 The resulting traffic paths

```text
ONE HOST, ONE HOST KERNEL, MULTIPLE DOCKER TENANTS

Tenant A network namespace: ns_mode=local
  Claude Desktop A
    -> cowork-linux-helper A: AF_VSOCK bind(ANY, 51234)
    -> QEMU A: opens /dev/vhost-vsock inside namespace A
         -> Cowork guest A: connects to host CID=2, port=51234
         -> accepted by helper A with guest A's real peer CID

Tenant B network namespace: ns_mode=local
  Claude Desktop B
    -> cowork-linux-helper B: AF_VSOCK bind(ANY, 51234)
    -> QEMU B: opens /dev/vhost-vsock inside namespace B
         -> Cowork guest B: connects to host CID=2, port=51234
         -> accepted by helper B with guest B's real peer CID

The two namespaces may reuse port 51234 and, if necessary, guest CIDs.
The tenants do not see each other's local-mode vsock endpoints.
```

There is **no port translation** and **no userspace connection proxy**. CID `2` remains the guest-visible host CID. The expected-CID logic in the helper should therefore continue to see the guest endpoint normally. This last sentence is an **inference from the upstream transport implementation and reported helper behavior**; prove it with the real Cowork test.

### 2.3 What does *not* need to change

- No QEMU command-line rewrite or `vhost-user-vsock` substitution.
- No guest image changes, guest `coworkd` disassembly, or guest port-constant search.
- No helper executable patch or per-account binary copy.
- No additional host or nested virtualization layer.
- No guest network-namespace changes: the relevant isolation is on the **host side** around helper and QEMU.

## 3. Kernel prerequisites and compatibility

### 3.1 Minimum implementation

Use **Linux mainline 7.0 or later**, or a distro-maintained kernel that verifiably backports **AF_VSOCK local/global namespace modes** and the matching **`vhost-vsock` changes**. Do not infer support from a version number alone if using vendor backports. Prefer a currently maintained, tested distribution kernel rather than selecting an old mainline release only for this feature.

Verify the actual booted kernel and API:

```bash
uname -r
sudo modprobe vhost_vsock
ls -l /dev/vhost-vsock /dev/kvm
cat /proc/sys/net/vsock/ns_mode
cat /proc/sys/net/vsock/child_ns_mode
```

On a supporting host's **initial** namespace, typical output is:

```text
/proc/sys/net/vsock/ns_mode        -> global
/proc/sys/net/vsock/child_ns_mode  -> global  # default, unless changed
```

If the sysctl files do not exist, check the running kernel, module availability, and packaging. **Do not proceed assuming Docker alone provides this feature.** The original `6.8.0-142-generic` system did not have the required implementation.

### 3.2 Two different sysctls — and the write-once trap

| Path | Meaning | Writable? |
|---|---|---|
| `/proc/sys/net/vsock/ns_mode` | **Current** network namespace's mode; fixed at namespace creation | No |
| `/proc/sys/net/vsock/child_ns_mode` | Mode that **future child** namespaces will inherit | Yes, but **write-once** |

Rules documented upstream:

- The namespace's `ns_mode` is inherited from its creator/parent's `child_ns_mode` **at creation time**.
- Existing namespaces do **not** change when the parent's `child_ns_mode` is changed.
- `child_ns_mode` is **write-once**: the first write locks its value; later attempts to write a different value fail with `EBUSY`. Rewriting the same value succeeds.
- A `local` namespace cannot select `global` for its children (`EPERM`).
- The initial host namespace is always `global`; its **future children** can nevertheless be `local`.

**Operational consequence:** Do **not** immediately execute `sysctl -w net.vsock.child_ns_mode=local` in the initial host namespace during exploration. It locks the parent policy for the remainder of that namespace's lifetime (normally until reboot) and affects **all subsequently created child namespaces**, including unrelated workloads. Test in temporary nested namespaces first.

Also, putting `net.vsock.child_ns_mode=local` *inside an already-created tenant* changes only that tenant namespace's **future children**. It does **not** turn the tenant itself into a local-mode namespace. `ns_mode` cannot be set directly.

## 4. Safe preflight: two isolated listeners without touching host policy

The following is a **mechanism test**, not yet the actual Cowork application test. It creates a fresh, temporary *parent* namespace, writes `child_ns_mode=local` **inside that parent**, and creates a second, local-mode namespace to hold the listener. It avoids changing the host's initial namespace settings.

Prerequisites: a supporting kernel, permission to create network namespaces (`root`/appropriate capabilities), Python 3 with `AF_VSOCK`, and working vsock kernel support.

### 4.1 Execute in terminal A

```bash
sudo modprobe vhost_vsock

sudo unshare --net sh -eu -c '
    echo local > /proc/sys/net/vsock/child_ns_mode
    exec unshare --net python3 -
' <<'PY'
import os
import socket
import time
from pathlib import Path

mode = Path('/proc/sys/net/vsock/ns_mode').read_text().strip()
assert mode == 'local', f'vsock ns_mode must be local, got {mode!r}'

listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
listener.bind((0xFFFFFFFF, 51234))  # VMADDR_CID_ANY
listener.listen(1)
print('LISTEN OK:', os.readlink('/proc/self/ns/net'),
      'ns_mode=' + mode, 'port=51234', flush=True)
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
finally:
    listener.close()
PY
```

Leave this listener running; stop it later with **Ctrl-C**.

### 4.2 Execute the **same command** in terminal B

Use another terminal while A is still listening. Both should print `LISTEN OK` with `ns_mode=local`, **different** network namespace inode identifiers, and port `51234`.

**Success:** two simultaneous local-mode AF_VSOCK listeners on `VMADDR_CID_ANY:51234`, in distinct namespaces. This proves the specific bind-collision mechanism has been removed on the tested kernel.

**Failure:** if B returns `EADDRINUSE`, inspect each namespace's `ns_mode` and `readlink /proc/self/ns/net`, and confirm you are running the feature-enabled kernel. If the mode is `global`, the listener collision is expected. If creating namespaces fails, address privilege/security restrictions before diagnosing vsock.

This test does not prove that QEMU's transport is opened in the right namespace or that Cowork's RPC handshake succeeds. That is the next stage.

## 5. Production integration with Docker

### 5.1 The required layout

For each tenant:

1. Create a **distinct `local` network namespace**.
2. Start that tenant's Desktop, helper, and QEMU inside it.
3. Retain the bridge container's **sharing of that tenant's network namespace** (it must not accidentally point to another tenant or a global-mode namespace).
4. Continue passing `/dev/kvm` and `/dev/vhost-vsock` into the tenant with its existing appropriate device and security permissions.
5. Keep ordinary IP networking intact (Docker interfaces, routes, DNS and bridge connectivity). `local` refers here to **vsock mode**, not the IP loopback-only network.

**Do not rely on different Docker container names or different `/dev/vhost-vsock` mounts for isolation.** The namespace mode, not the path to the shared device node, determines the new routing boundary.

### 5.2 Simple host-wide creation policy

For a dedicated host whose newly created namespaces can all use local vsock isolation, configure the **namespace that Docker uses to create tenant network namespaces** before those namespaces are created. In a typical rootful Docker deployment that parent is the initial host network namespace.

After testing the feature with section 4, in a controlled maintenance window:

```bash
# Examine the parent namespace policy first.
cat /proc/sys/net/vsock/ns_mode
cat /proc/sys/net/vsock/child_ns_mode

# One-time host policy for future namespaces, if approved:
sudo sysctl -w net.vsock.child_ns_mode=local
```

**CAUTION:** This is a host-wide, write-once policy change in that namespace. It is not the right choice if other applications need new **global-mode** vsock namespaces. Review all consumers, stage the change and plan for a reboot if the policy must be reset. A dedicated tenant host is the clearest fit.

Then **recreate**, rather than merely restart, the tenant containers and their network namespaces; existing namespaces retain their old mode. Arrange for the setting to be applied on each boot **before** Docker (or the relevant namespace-creating service) creates tenant namespaces. Use service ordering appropriate to your actual init/container stack. Do not assume an arbitrary late-started sysctl config will retrofit existing containers.

> A selective alternative is to create tenant namespaces under a **dedicated parent namespace** configured with `child_ns_mode=local` instead of changing the initial host namespace. The nested `unshare` example proves that model. Integrating such a parent with standard Docker/Compose namespace creation and maintaining the right IP networking needs a deliberate launcher/network design; no untested Compose option is presented here as a turnkey implementation.

### 5.3 Verify each tenant *after recreation*

Substitute real container names:

```bash
# Both tenant containers must report local.
docker exec tenant_a cat /proc/sys/net/vsock/ns_mode
docker exec tenant_b cat /proc/sys/net/vsock/ns_mode

# They must be in DIFFERENT network namespaces.
docker exec tenant_a readlink /proc/self/ns/net
docker exec tenant_b readlink /proc/self/ns/net

# Its bridge should share the SAME namespace as its tenant.
docker exec tenant_a_bridge readlink /proc/self/ns/net
docker exec tenant_b_bridge readlink /proc/self/ns/net
```

Expected:

- Tenant A and tenant B both report **`local`**.
- Tenant A and tenant B have **different** namespace inode values.
- Tenant A's bridge reports **the same namespace** as A; B's bridge matches B.
- The Desktop helper and QEMU must not launch through a host-side/global-namespace daemon or wrapper that moves their device-opening step outside the tenant namespace.

If two containers are using `network_mode: service:...`, both share the same namespace by design. This is correct **within a tenant**, but **not between different tenants**.

### 5.4 Confirm the vsock device-open boundary

Upstream `vhost_vsock_dev_open()` records:

```c
net = current->nsproxy->net_ns;
vsock->net = get_net_track(net, &vsock->ns_tracker, GFP_KERNEL);
```

This is why QEMU must **open** `/dev/vhost-vsock` from the tenant's namespace. To inspect namespace membership on a running system, find the actual helper and QEMU PIDs and inspect their host `/proc` entries. For example, from the host:

```bash
# Identify relevant PIDs carefully on a multi-tenant host.
ps -eo pid,cmd | grep -E '[c]owork-linux-helper|[q]emu-system-x86_64'

# For each PID found:
readlink /proc/<PID>/ns/net
```

The helper PID and its QEMU PID should match the correct tenant's namespace inode. This PID check establishes process membership, **not** with certainty where a previously inherited/opened FD originated; review unusual launchers or descriptor passing if present.

## 6. Real two-tenant acceptance test

Do not mark the fix deployed based only on section 4's listener test.

1. Record a known-good backup and the existing host/container configuration; schedule downtime appropriate to a kernel upgrade.
2. Boot the feature-enabled kernel, load `vhost_vsock`, and run the two-listener test.
3. Configure namespace creation, recreate tenants, and verify **`ns_mode=local`** plus distinct namespace IDs.
4. Start tenant A's Claude Desktop and Cowork; confirm the VM boots and guest RPC connects.
5. **While A stays running**, start tenant B's Cowork; confirm it also boots, without `EADDRINUSE`.
6. Verify both guest logs still connect to **host CID 2, port 51234** and both host helpers accept their **own** guest's CID (no `expected CID` rejection).
7. Exercise meaningful agent/RPC operations in A and B **concurrently**, not just a successful listen. Stop/restart A while B stays up, and then reverse; ensure sessions do not cross or terminate each other.
8. Verify both tenant bridge containers still have working intended IP networking and that tenants do not share data or sockets.
9. Run a third tenant or repeated cycles if required by expected scale; monitor QEMU/vhost-vsock errors and kernel logs.

**Acceptance matrix**

| Check | Expected | Result |
|---|---|---|
| Kernel supports `ns_mode` and `child_ns_mode` | Both sysctls present | Not run |
| A vsock mode | `local` | Not run |
| B vsock mode | `local` | Not run |
| Tenant netns identifiers | Different | Not run |
| Simultaneous bind on 51234 | Both succeed | Not run |
| QEMU and helper membership | Correct tenant namespace | Not run |
| Guest connection target | CID `2`, port `51234` | Not run |
| Helper peer CID check | Correct guest accepted | Not run |
| Concurrent full Cowork operation | Works for A and B | Not run |
| Isolation and independent restarts | No cross-tenant connection | Not run |
| Tenant IP/bridge networking | No regression | Not run |

Fill the result column from actual observations. This document does **not** claim that those tests have already passed.

## 7. Troubleshooting decision tree

| Symptom | Likely explanation | Action |
|---|---|---|
| `.../net/vsock/ns_mode` missing | Kernel lacks API, feature not built or not available | Confirm kernel and modules; use supported kernel/backport |
| `ns_mode=global` in tenant | Tenant netns created before policy applied, or created from a `global` parent policy | Trace actual namespace creator; apply policy to the parent; **recreate** tenant netns |
| Writing `child_ns_mode=local` returns `EBUSY` | That parent's write-once value was locked differently | Do not assume changed; use a fresh temporary parent or plan a reboot for initial host policy |
| Writing `child_ns_mode=global` inside `local` returns `EPERM` | Local namespaces cannot spawn global-mode children | Redesign namespace parentage if global mode is truly needed |
| Two listeners still conflict | One or both listeners are in compatible `global` namespaces, or not actually distinct | Check both `ns_mode` values and netns inode IDs before looking elsewhere |
| QEMU/guest fails although both listeners bind | Device opened in wrong namespace, permission issue, transport issue or unrelated Cowork startup error | Check actual helper/QEMU PIDs and launch path; inspect QEMU and kernel logs |
| Guest connects but helper says `expected CID` | Peer routing, guest-CID assignment, or app protocol mismatch | Check namespaces, guest CID logs, and whether any wrapper/proxy was introduced |
| Bridge loses connectivity after recreation | IP networking setup changed with namespace recreation | Repair intended Docker network configuration; local vsock mode alone does not configure IP networking |
| Host had an existing listener, but local tenant still binds | **Expected**: a global listener does not occupy a local tenant's namespace | Continue with real guest routing/handshake verification |

Useful diagnostics:

```bash
uname -a
lsmod | grep -E '(^vhost_vsock|^vsock|^vmw_vsock)' || true
cat /proc/sys/net/vsock/ns_mode
cat /proc/sys/net/vsock/child_ns_mode
sudo dmesg | tail -100
```

Diagnostics such as `ss` may be namespace-dependent; perform socket inspections from the specific tenant namespace when evaluating listener ownership.

## 8. Rollback and change-management cautions

- **Before changing host policy:** the temporary nested-namespace smoke test can be stopped by exiting its processes. It does not modify the host initial namespace's `child_ns_mode`.
- **After changing initial host `child_ns_mode`:** there is no in-place command to change it back to `global` after locking it to `local`. A **host reboot** resets the kernel/initial namespace state, provided the persistent policy is also removed or changed before Docker creates the new namespaces.
- **After upgrading the kernel:** use your ordinary tested kernel rollback procedure if necessary. Rebooting into an old 6.8-style kernel restores the old behavior, **including the original vsock collision**.
- **Existing containers:** do not expect a container restart alone to replace an already-existing network namespace. Verify the inode and `ns_mode` after recreation; pay attention to containers that deliberately share an existing namespace.
- **Shared single host kernel:** this provides kernel-enforced vsock isolation between namespaces, **not** the same complete isolation boundary as independent host kernels. It does not replace normal tenant hardening, device-access controls, resource quotas, and threat-model review.
- **Kernel support matrix:** current upstream support is specifically relevant to **host-side `vhost-vsock`**. Not every AF_VSOCK guest transport supports local namespaces; do not generalize the result to guest-internal `virtio-vsock`, Hyper-V, or VMCI namespace isolation.

## 9. Alternatives, if kernel upgrade is not available

### 9.1 Ordinary byte-stream vsock proxy: not sufficient as stated

One listener on 51234 could accept incoming guest connections and route them by CID, but simply opening a **new** socket to each helper does not automatically preserve the **original accepted peer CID**. The original helper's expected-CID check makes such an approach unreliable without proving the identity semantics.

### 9.2 Advanced broker using the original accepted socket: conceptual only

On the old kernel, a technically plausible design is a single broker owning `51234` and transferring the **original accepted AF_VSOCK socket descriptor** to the correct helper, instead of proxying the stream. A syscall-interception wrapper could potentially use Linux seccomp user notification and `SECCOMP_IOCTL_NOTIF_ADDFD` to substitute the accepted file descriptor for a helper's intercepted `accept` call.

That approach would require implementation and verification of listener virtualization, helper syscall behavior, readiness and nonblocking flags, returned peer addresses, CID-to-tenant registration, process lifetimes, security isolation, and error handling. It has **not** been demonstrated to work with Cowork, and is **not** a ready-made alternative to upgrading the host kernel. `SECCOMP_IOCTL_NOTIF_ADDFD` is a real kernel interface; that alone does not validate the proposed integration.

### 9.3 Other options deliberately avoided here

- Changing both binaries' hard-coded ports: explicitly outside the requested constraints; the original guest dial constant was not located.
- Running tenant environments on separate physical hosts: explicitly outside scope.
- Putting each tenant into an additional microVM: introduces a separate kernel, but explicitly outside scope and has nested virtualization implications.
- Switching to a userspace `vhost-user-vsock` transport: would require QEMU invocation changes and a different transport design, neither demonstrated for this unmodified helper.

## 10. Summary and go/no-go criteria

**GO**, subject to full end-to-end validation, if:

- The booted kernel implements `local`-mode AF_VSOCK namespaces and host `vhost-vsock` support.
- Each tenant gets a **distinct local-mode network namespace**, with helper and QEMU in it before opening sockets/devices.
- The two-listener test and concurrent Cowork test both pass.
- No unrelated workload requires global-mode vsock children from the same locked namespace parent.
- Container networking and tenant isolation remain intact.

**NO-GO** if:

- The host must remain on the original 6.8 kernel without a suitable backport **and** an unmodified deployment is the only accepted option.
- Both tenant applications are required to run in one shared network namespace.
- A third-party launcher opens `/dev/vhost-vsock` in a global namespace and cannot be adjusted.
- The real Cowork peer-CID/RPC test fails, even though the standalone listener test passes.

**Bottom line:** This is no longer inherently a "one Cowork VM per physical host" problem. On kernels with the upstream vsock namespace feature, it becomes a **per-network-namespace deployment configuration** problem. The fixed port `51234` and guest host CID `2` can remain untouched.

## 11. Source trail and evidence classification

**Case-specific facts (user-supplied):** `cowork-vm-vsock-port.md`, describing the measured 6.8 behavior, desktop/helper/guest binaries, log excerpts, Docker setup, and the absence of a port option. These observations apply to that case; they were **not** reproduced on the author's machine for this guide.

**Upstream-confirmed feature and API:**

1. Stefano Garzarella, [“AF_VSOCK: network namespace support is here”](https://stefano-garzarella.github.io/posts/2026-02-11-vsock-netns/) (11 February 2026; updated 17 April 2026) — design, `global`/`local` modes, `vhost-vsock` support, and nested-namespace testing.
2. Linux kernel, [sysctl documentation: `/proc/sys/net/vsock`](https://docs.kernel.org/admin-guide/sysctl/net.html) — immutable `ns_mode`, write-once `child_ns_mode`, inheritance and mode semantics.
3. Linux `v7.0`, [`drivers/vhost/vsock.c`](https://raw.githubusercontent.com/torvalds/linux/v7.0/drivers/vhost/vsock.c) — `vhost_vsock_dev_open()` captures `current->nsproxy->net_ns` and stores it; transport looks up the device with its namespace.
4. Linux `v7.0`, [`net/vmw_vsock/af_vsock.c`](https://raw.githubusercontent.com/torvalds/linux/v7.0/net/vmw_vsock/af_vsock.c) — namespace-aware socket matching and explicit kernel comments on CID modes/compatibility.
5. [Linux 7.x release files](https://www.kernel.org/pub/linux/kernel/v7.x/) — independent confirmation of the release series.

**Conceptual, not validated fallback:** Linux [`seccomp_unotify(2)`](https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html), which documents `SECCOMP_IOCTL_NOTIF_ADDFD`. No Cowork integration has been performed.

**Confidence boundary:** The kernel capability is an upstream implementation, not a speculative patch; its application to the fixed-port Cowork topology follows from the documented behavior and source code. Actual operation with the user's exact containers and app build remains to be demonstrated by the acceptance test.
