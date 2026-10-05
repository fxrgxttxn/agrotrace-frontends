FROM nginx:1.27-alpine

RUN apk add --no-cache curl

ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx
ENV GATEWAY_PORT=80
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template

COPY placeholder/ /srv/react/
COPY placeholder/ /srv/angular/
COPY placeholder/ /srv/svelte/

COPY start/ /srv/start/

RUN mkdir -p /srv/ds

RUN mkdir -p /srv/react-mock /srv/angular-mock /srv/svelte-mock

RUN GATEWAY_PORT=80 envsubst '${GATEWAY_PORT}' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf.check \
  && nginx -t -c /etc/nginx/nginx.conf.check \
  && rm /etc/nginx/nginx.conf.check

EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD curl -fsS -H 'Host: localhost' http://127.0.0.1/ -o /dev/null

CMD ["nginx", "-g", "daemon off;"]
