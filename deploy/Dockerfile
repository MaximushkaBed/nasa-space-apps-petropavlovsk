FROM nginx@sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY web/ /srv/web/
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
