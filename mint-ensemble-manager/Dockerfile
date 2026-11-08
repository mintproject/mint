FROM node:24-alpine

LABEL org.opencontainers.image.title="MINT Ensemble Manager" \
      org.opencontainers.image.source="https://github.com/mintproject/mint" \
      org.opencontainers.image.licenses="MIT"

# # Install cwltool
# RUN apk add --update \
#   libc-dev \
#   gcc \
#   python3-dev \
#   py3-pip \
#   build-base \
#   linux-headers
# RUN pip install cwltool

# # Install docker client
# ARG DOCKER_CLI_VERSION="20.10.21"
# ENV DOWNLOAD_URL="https://download.docker.com/linux/static/stable/x86_64/docker-$DOCKER_CLI_VERSION.tgz"
# RUN apk --no-cache add curl \
#     && curl -L $DOWNLOAD_URL | tar -xz docker \
#     && mv docker/docker /usr/local/bin/docker

# Install ensemble manager
RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app
WORKDIR /home/node/app
COPY package*.json ./
RUN npm install --maxsockets=5 || npm install --maxsockets=5 || npm install --maxsockets=5
COPY --chown=node:node . .

RUN mkdir -p /data && chown -R node:node /data

RUN apk add --no-cache tini
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/mint-ensemble-entrypoint.sh
RUN chmod +x /usr/local/bin/mint-ensemble-entrypoint.sh
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/mint-ensemble-entrypoint.sh"]
# Build ensemble manager
USER node
RUN NODE_OPTIONS=--openssl-legacy-provider npm run build


# Start ensemble manager
EXPOSE 3000
CMD [ "npm", "start" ]
