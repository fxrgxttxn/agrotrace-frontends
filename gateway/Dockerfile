# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

# curl: used only by the HEALTHCHECK below (nginx:alpine has no shell HTTP client otherwise).
RUN apk add --no-cache curl

# nginx.conf is a template (R80: X-Forwarded-Port needs the published host port, which
# $server_port can never be — that's always 80, the port nginx listens on *inside* the container).
# The base image's own docker-entrypoint.d/20-envsubst-on-templates.sh runs before nginx starts
# (its ENTRYPOINT is inherited unchanged, only CMD is overridden below) and envsubst's every
# *.template file under NGINX_ENVSUBST_TEMPLATE_DIR into NGINX_ENVSUBST_OUTPUT_DIR, stripping the
# suffix — pointed at /etc/nginx so the output lands at /etc/nginx/nginx.conf itself. GATEWAY_PORT
# defaults to 80 (matching .env.example) so the image still works standalone (`docker run`,
# no compose env); docker-compose.yml overrides it with the host's actual GATEWAY_PORT.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx
ENV GATEWAY_PORT=80
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template

# R6: the placeholder (including a sample /assets/ file, so /assets/* has something real to serve
# in tests) is baked into the image at /srv/{react,angular,svelte}. Later frontend plans bind-mount
# their built dist/ over each of these directories, replacing the placeholder wholesale.
COPY placeholder/ /srv/react/
COPY placeholder/ /srv/angular/
COPY placeholder/ /srv/svelte/

COPY start/ /srv/start/

# /srv/ds is a bind-mount point for packages/design-system (read-only, wired in docker-compose.yml);
# the empty directory just needs to exist so nginx has somewhere to alias to before the mount lands.
RUN mkdir -p /srv/ds

# Mock stands (ruling FM23): each frontend stand bind-mounts its dist-mock build here.
RUN mkdir -p /srv/react-mock /srv/angular-mock /srv/svelte-mock

# Build-time config sanity check: envsubst the template exactly like the real entrypoint would
# (default GATEWAY_PORT), then let nginx validate the result — into a scratch path, never
# /etc/nginx/nginx.conf itself, which must stay absent from the image so the entrypoint always
# generates it fresh from the template at container start.
RUN GATEWAY_PORT=80 envsubst '${GATEWAY_PORT}' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf.check \
  && nginx -t -c /etc/nginx/nginx.conf.check \
  && rm /etc/nginx/nginx.conf.check

EXPOSE 80

# The default_server always serves the start page regardless of backends, so it doubles as a
# liveness probe for the gateway container itself.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD curl -fsS -H 'Host: localhost' http://127.0.0.1/ -o /dev/null

CMD ["nginx", "-g", "daemon off;"]
