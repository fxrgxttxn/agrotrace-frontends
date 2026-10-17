#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
base="${SITE_BASE:-/agrotrace-frontends/}"
out="${1:-_site}"
ds=packages/design-system

for dir in frontend-react/dist-mock frontend-angular/dist-mock frontend-svelte/build-mock; do
  [ -f "$dir/index.html" ] || { echo "site: no $dir/index.html — build the mock fronts first" >&2; exit 1; }
done

rm -rf "$out"
mkdir -p "$out/ds/components"
for page in index.html 404.html; do sed "s#%BASE%#$base#g" "site/$page" > "$out/$page"; done
touch "$out/.nojekyll"
cp "$ds/fonts.css" "$ds/tokens.css" "$ds/base.css" "$out/ds/"
cp "$ds/components/button.css" "$ds/components/card.css" "$out/ds/components/"
cp -r "$ds/fonts" "$out/ds/fonts"
cp -r frontend-react/dist-mock "$out/react"
cp -r frontend-angular/dist-mock "$out/angular"
cp -r frontend-svelte/build-mock "$out/svelte"
echo "site: $out (base $base)"
