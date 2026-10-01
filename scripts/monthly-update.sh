#!/bin/sh
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
state_dir="${CLAUDESK_UPDATE_STATE_DIR:-/vol2/1000/Docker/ClaudeDesktop/update-state}"
stable_image="local/claude-desktop-nas:official-linux"
bridge_image="local/claude-cowork-bridge:latest"
mkdir -p "$state_dir"

exec 9>"$state_dir/update.lock"
if ! flock -n 9; then
  printf '%s\n' '[monthly-update] another update is running'
  exit 0
fi

log_file="$state_dir/monthly-update.log"
exec >>"$log_file" 2>&1
printf '\n[%s] monthly update started\n' "$(date -Iseconds)"

write_state() {
  outcome="$1"
  detail="$2"
  candidate="${3:-}"
  installed="${4:-}"
  tmp="$state_dir/state.json.tmp"
  jq -n \
    --arg checkedAt "$(date -Iseconds)" \
    --arg outcome "$outcome" \
    --arg detail "$detail" \
    --arg candidate "$candidate" \
    --arg installed "$installed" \
    '{checkedAt:$checkedAt,outcome:$outcome,detail:$detail,candidateVersion:$candidate,installedVersion:$installed}' \
    > "$tmp"
  mv -f "$tmp" "$state_dir/state.json"
}

record_event() {
  stage="$1"
  outcome="$2"
  version="${3:-}"
  detail="${4:-}"
  jq -nc \
    --arg at "$(date -Iseconds)" \
    --arg stage "$stage" \
    --arg outcome "$outcome" \
    --arg version "$version" \
    --arg detail "$detail" \
    '{at:$at,stage:$stage,outcome:$outcome,version:$version,detail:$detail}' \
    >> "$state_dir/events.jsonl"
}

set_env_version() {
  version="$1"
  env_file="$project_dir/.env"
  tmp="$state_dir/env.tmp"
  awk -v value="$version" '
    BEGIN { updated = 0 }
    /^CLAUDE_DESKTOP_VERSION=/ { print "CLAUDE_DESKTOP_VERSION=" value; updated = 1; next }
    { print }
    END { if (!updated) print "CLAUDE_DESKTOP_VERSION=" value }
  ' "$env_file" > "$tmp"
  chmod --reference="$env_file" "$tmp"
  chown --reference="$env_file" "$tmp"
  mv -f "$tmp" "$env_file"
}

wait_healthy() {
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    health="$(docker inspect claude-desktop --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    bridge_health="$(docker inspect cowork-bridge --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    if [ "$health" = "healthy" ] && [ "$bridge_health" = "healthy" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  return 1
}

current_version="$(docker exec claude-desktop dpkg-query -W -f='${Version}' claude-desktop)"
current_image="$(docker inspect claude-desktop --format '{{.Image}}')"
current_bridge_image="$(docker inspect cowork-bridge --format '{{.Image}}')"
host_bash="$(awk -F= '$1 == "CLAUDE_COWORK_HOST_BASH" { print $2; exit }' "$project_dir/.env")"
gateway_settings="$(awk -F= '$1 == "CLAUDE_REMOTE_GATEWAY_SETTINGS" { print $2; exit }' "$project_dir/.env")"
case "$gateway_settings" in
  1) ;;
  *) gateway_settings=0 ;;
esac
case "$host_bash" in
  0|1) ;;
  *) host_bash=0 ;;
esac
candidate="$(docker run --rm --entrypoint /bin/sh "$stable_image" -c '
  apt-get update -o Acquire::Retries=3 >/dev/null
  apt-cache policy claude-desktop | awk "/Candidate:/ { print \$2; exit }"
')"

if [ -z "$candidate" ] || [ "$candidate" = "(none)" ]; then
  record_event "candidate-discovery" "failed" "" "signed APT repository returned no candidate"
  write_state "candidate-check-failed" "signed APT repository returned no candidate" "" "$current_version"
  exit 1
fi
record_event "candidate-discovery" "found" "$candidate" "installed=$current_version"
if [ "$candidate" = "$current_version" ]; then
  record_event "candidate-discovery" "unchanged" "$candidate" "already installed"
  write_state "unchanged" "already on signed repository candidate" "$candidate" "$current_version"
  printf '[monthly-update] already current: %s\n' "$current_version"
  exit 0
fi

supported_version="$(jq -er '.desktopVersion' "$project_dir/config/release.json")"
if [ "$candidate" != "$supported_version" ]; then
  record_event "compatibility-profile" "deferred" "$candidate" "reviewed=$supported_version"
  write_state "awaiting-compatibility-profile" "new upstream release needs a reviewed project compatibility profile; production unchanged" "$candidate" "$current_version"
  printf '[monthly-update] leaving %s running; %s has no reviewed compatibility profile\n' "$current_version" "$candidate"
  exit 0
fi

candidate_tag="local/claude-desktop-nas:candidate-$candidate"
rollback_tag="local/claude-desktop-nas:rollback-$current_version"
bridge_candidate_tag="local/claude-cowork-bridge:candidate-$candidate"
bridge_rollback_tag="local/claude-cowork-bridge:rollback-$current_version"
printf '[monthly-update] building candidate %s\n' "$candidate"
record_event "candidate-build" "started" "$candidate" "$candidate_tag"
if ! docker build \
  --build-arg "CLAUDE_DESKTOP_VERSION=$candidate" \
  --tag "$candidate_tag" \
  "$project_dir"; then
  record_event "candidate-build" "failed" "$candidate" "image build failed"
  write_state "candidate-build-failed" "candidate image did not build" "$candidate" "$current_version"
  exit 1
fi
record_event "candidate-build" "passed" "$candidate" "$candidate_tag"

if ! docker run --rm \
  --entrypoint /bin/sh \
  -e COWORK_BRIDGE_ENABLED=1 \
  -e CLAUDE_COWORK_HOST_BASH="$host_bash" \
  -e CLAUDE_REMOTE_GATEWAY_SETTINGS="$gateway_settings" \
  -e CLAUDE_DESKTOP_VERSION="$candidate" \
  "$candidate_tag" \
  -c '/etc/cont-init.d/25-cowork-bridge-wrapper.sh >/tmp/candidate.log && test -s /var/lib/claude-cowork-bridge/renderer/current.json'; then
  docker image rm "$candidate_tag" >/dev/null 2>&1 || true
  record_event "renderer-patch-validation" "failed" "$candidate" "strict anchors or manifest failed"
  write_state "candidate-compatibility-failed" "single-version renderer preparation failed" "$candidate" "$current_version"
  exit 1
fi
record_event "renderer-patch-validation" "passed" "$candidate" "strict renderer manifest generated"

if ! docker build --file "$project_dir/bridge/Dockerfile" \
  --tag "$bridge_candidate_tag" "$project_dir"; then
  write_state "candidate-build-failed" "matching bridge image did not build" "$candidate" "$current_version"
  exit 1
fi

docker run --rm \
  --entrypoint /bin/sh \
  -v "$state_dir:/state" \
  "$stable_image" -c "
    apt-get update -o Acquire::Retries=3 >/dev/null
    cd /state
    apt-get download 'claude-desktop=$candidate' >/dev/null
    deb=claude-desktop_*'${candidate}'*_amd64.deb
    test -f \"\$deb\"
    sha256sum \"\$deb\" > candidate-$candidate.sha256
  "

docker tag "$current_image" "$rollback_tag"
docker tag "$current_bridge_image" "$bridge_rollback_tag"
rollback_pending=1
rollback_on_exit() {
  exit_status=$?
  trap - 0 HUP INT TERM
  if [ "$rollback_pending" -eq 1 ]; then
    printf '[monthly-update] restoring Desktop and bridge images for %s\n' "$current_version"
    cd "$project_dir"
    if docker tag "$rollback_tag" "$stable_image" \
      && docker tag "$bridge_rollback_tag" "$bridge_image" \
      && set_env_version "$current_version" \
      && docker compose up -d --no-build --force-recreate claude-desktop cowork-bridge \
      && wait_healthy; then
      record_event "rollback" "completed" "$current_version" "both original images restored; persistent data not reverted"
      write_state "rolled-back" "candidate failed; original images restored; persistent data not reverted" "$candidate" "$current_version"
    else
      record_event "rollback" "failed" "$current_version" "manual recovery required"
      write_state "rollback-failed" "original image recovery failed; manual intervention required" "$candidate" "$current_version"
    fi
    exit_status=1
  fi
  exit "$exit_status"
}
trap rollback_on_exit 0
trap 'exit 1' HUP INT TERM
docker tag "$candidate_tag" "$stable_image"
docker tag "$bridge_candidate_tag" "$bridge_image"
set_env_version "$candidate"
record_event "production-switch" "started" "$candidate" "rollback=$rollback_tag"

cd "$project_dir"
if ! docker compose up -d --no-build --force-recreate claude-desktop cowork-bridge \
  || ! wait_healthy \
  || ! "$project_dir/scripts/chat-bridge-smoke.sh"; then
  printf '[monthly-update] production verification failed; rolling back to %s\n' "$current_version"
  record_event "production-health" "failed" "$candidate" "health or smoke failed"
  exit 1
fi

rollback_pending=0
trap - 0 HUP INT TERM
record_event "production-health" "passed" "$candidate" "health and basic smoke passed"
record_event "production-switch" "completed" "$candidate" "$stable_image"
write_state "updated" "candidate promoted after production smoke" "$candidate" "$candidate"
printf '[monthly-update] promoted %s\n' "$candidate"
docker image rm "$candidate_tag" >/dev/null 2>&1 || true
docker image rm "$bridge_candidate_tag" >/dev/null 2>&1 || true

docker image ls --format '{{.Repository}}:{{.Tag}}' \
  | awk '/^local\/claude-desktop-nas:(candidate|rollback)-/ { print }' \
  | while IFS= read -r image; do
      [ "$image" = "$rollback_tag" ] || docker image rm "$image" || true
    done
find "$state_dir" -maxdepth 1 -type f -name 'claude-desktop_*_amd64.deb' -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 2 { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r old_deb; do rm -f -- "$old_deb"; done
