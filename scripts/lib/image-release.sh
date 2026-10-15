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

image_release() {
    image="$1"
    path="$2"
    docker run --rm --entrypoint cat "$image" "$path" 2>/dev/null \
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
    for spec in \
        "local/claude-cowork-bridge:latest /app/release.json" \
        "local/claudesk-desktop:official-linux /opt/claude-cowork-bridge/release.json"
    do
        image="${spec%% *}"
        path="${spec##* }"
        actual="$(image_release "$image" "$path")"
        if [ "$actual" != "$expected" ]; then
            printf 'release: %s carries %s, this checkout is %s\n' \
                "$image" "${actual:-nothing readable}" "$expected" >&2
            stale=1
        fi
    done

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
