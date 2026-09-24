# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

# curl: used only by the HEALTHCHECK below (nginx:alpine has no shell HTTP client otherwise).
RUN apk add --no-cache curl

COPY nginx.conf /etc/nginx/nginx.conf

# R6: the placeholder is baked into the image at /srv/{react,angular,svelte}. Later frontend plans
# bind-mount their built dist/ over each of these directories, replacing the placeholder.
COPY placeholder/index.html /srv/react/index.html
COPY placeholder/index.html /srv/angular/index.html
COPY placeholder/index.html /srv/svelte/index.html

COPY start/ /srv/start/

# /srv/ds is a bind-mount point for packages/design-system (read-only, wired in docker-compose.yml);
# the empty directory just needs to exist so nginx has somewhere to alias to before the mount lands.
RUN mkdir -p /srv/ds

RUN nginx -t

EXPOSE 80

# The default_server always serves the start page regardless of backends, so it doubles as a
# liveness probe for the gateway container itself.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD curl -fsS -H 'Host: localhost' http://127.0.0.1/ -o /dev/null

CMD ["nginx", "-g", "daemon off;"]
