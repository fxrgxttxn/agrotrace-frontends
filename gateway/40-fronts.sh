#!/bin/sh
# /srv/<front> is a symlink (ruling PL2): to the front's build inside its bind-mounted checkout directory when the build
# exists, otherwise to the placeholder. Angular and SvelteKit delete their output directory on every build, so a bind
# mount of the output directory itself would point at a removed inode; a symlink is resolved on every request. Run by
# the image entrypoint at start and by `./at fe:build <front>` after a build (idempotent).
set -eu
for pair in react:dist angular:dist svelte:build; do
  f="${pair%%:*}"; out="${pair#*:}"
  if [ -f "/srv/src/$f/$out/index.html" ]; then
    ln -sfn "/srv/src/$f/$out" "/srv/$f"
  else
    ln -sfn /srv/placeholder "/srv/$f"
  fi
done
