#!/bin/sh
#
# Guard against the silent failure this file exists for. Sourced, not executed.
#
#   assert_images_current PROJECT_DIR
#
# The per-account stacks are recreated with `up -d --force-recreate` and no
# `--build` (scripts/provision-user.sh) — deliberately, because every account
# reuses the deployment's image tags and building the same image once per
# account in parallel would be wasteful. The cost is that nothing about an
# account's recreation proves the images are current: if the build did not
# happen, or did not take, every account comes back as fresh containers around
# old code, with new names, new timestamps and no error anywhere. The only
# symptom is that the fix appears not to have worked in the browser, which is a
# genuinely expensive thing to debug from the wrong end.
#
# So check the tags before anything is recreated. Reading the file out of the
# image with `docker run --entrypoint cat` does not start the image's real
# command, so neither the desktop's pivot_root entrypoint nor the bridge's
# server runs.

# Reach Docker the way the caller's privileges allow. deploy.sh runs as the
# deploy user and touches Docker only through sudo, while the reconciler scripts
# are run as root — a bare `docker` in the first case fails, and an unreadable
# image is indistinguishable from a stale one, which is how this check first
# reported every image as carrying nothing.
docker_cli() {
    if [ "$(id -u)" -eq 0 ]; then
        docker "$@"
    else
        sudo docker "$@"
    fi
}

image_release() {
    image="$1"
    path="$2"
    docker_cli run --rm --entrypoint cat "$image" "$path" 2>/dev/null \
        | sed -n 's/.*"patchRelease"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1
}

assert_images_current() {
    project_dir="$1"
    expected="$(sed -n 's/.*"patchRelease"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$project_dir/config/release.json" | head -n 1)"
    if [ -z "$expected" ]; then
        printf 'release: cannot read patchRelease from %s/config/release.json\n' \
            "$project_dir" >&2
        return 1
    fi

    stale=0
    unreadable=0
    for spec in \
        "local/claude-cowork-bridge:latest /app/release.json" \
        "local/claudesk-desktop:official-linux /opt/claude-cowork-bridge/release.json"
    do
        image="${spec%% *}"
        path="${spec##* }"
        actual="$(image_release "$image" "$path")"
        if [ -z "$actual" ]; then
            printf 'release: cannot read %s out of %s\n' "$path" "$image" >&2
            unreadable=1
        elif [ "$actual" != "$expected" ]; then
            printf 'release: %s carries %s, this checkout is %s\n' \
                "$image" "$actual" "$expected" >&2
            stale=1
        fi
    done

    if [ "$unreadable" -ne 0 ]; then
        printf '%s\n' \
            'release: an unreadable image usually means Docker is not reachable as' \
            'release: this user, or the image is not built yet. Rebuild, then retry:' \
            'release:   sudo docker compose -f compose.yaml build claude-desktop cowork-bridge' >&2
        return 1
    fi
    if [ "$stale" -ne 0 ]; then
        printf '%s\n' \
            'release: the images do not carry this checkout; refusing to recreate accounts' \
            'release: on stale code. Rebuild them first:' \
            'release:   sudo docker compose -f compose.yaml build claude-desktop cowork-bridge' >&2
        return 1
    fi
    printf 'release: images carry %s\n' "$expected"
    return 0
}
