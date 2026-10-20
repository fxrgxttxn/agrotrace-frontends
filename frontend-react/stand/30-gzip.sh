#!/bin/sh
# gateway-react stand only (docker-compose.react-dev.yml): gzip for scripts, styles, JSON and SVG, so the stand serves
# what a production gateway does and the public-page budget (≤ 60 KB JS gzip) and load time are measured as shipped.
# Runs after the template is rendered (20-envsubst-on-templates.sh); the main gateway is left as it is (Plan 8).
set -eu
conf=/etc/nginx/nginx.conf
grep -q '# stand: gzip' "$conf" && exit 0
sed -i 's|^http {|http {\n  # stand: gzip\n  gzip on;\n  gzip_vary on;\n  gzip_comp_level 6;\n  gzip_min_length 1024;\n  gzip_types text/css application/javascript text/javascript application/json image/svg+xml;|' "$conf"
