FROM hasura/graphql-engine:v2.10.2

LABEL org.opencontainers.image.title="MINT Hasura GraphQL engine" \
      org.opencontainers.image.source="https://github.com/mintproject/mint" \
      org.opencontainers.image.licenses="MIT"

RUN rm -f /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y \
    curl \
    postgresql-client-common \
    && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/hasura/graphql-engine/raw/stable/cli/get.sh | INSTALL_PATH=/usr/local/bin bash
RUN mkdir /hasura
COPY . hasura/
