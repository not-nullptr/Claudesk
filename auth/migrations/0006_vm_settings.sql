-- Per-account Cowork VM sizing and the instance address for admin actions.
--
-- `vm_memory_gb` / `vm_cpu_count` are what the admin asked for; NULL means the
-- account inherits the deployment's `.env`. The `vm_applied_*` columns are what
-- the host reconciler actually wrote into the account's compose project, so the
-- dashboard can show the difference until an Apply lands. `internal_upstream`
-- is the instance's gateway_net alias (`<slug>-desktop:8080`), written back by
-- scripts/provision-user.sh; the admin's VM restart uses it instead of the
-- loopback port Caddy uses, which authd cannot reach from its own network.
ALTER TABLE users ADD COLUMN vm_memory_gb INTEGER;
ALTER TABLE users ADD COLUMN vm_cpu_count INTEGER;
ALTER TABLE users ADD COLUMN vm_applied_memory_gb INTEGER;
ALTER TABLE users ADD COLUMN vm_applied_cpu_count INTEGER;
ALTER TABLE users ADD COLUMN vm_applied_at INTEGER;
ALTER TABLE users ADD COLUMN internal_upstream TEXT;
