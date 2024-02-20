ARG NODE_TAG=node:21-alpine

FROM --platform=$BUILDPLATFORM $NODE_TAG AS base

ADD . /app
WORKDIR /app

# Enable yarn and install system packages
RUN corepack enable && apk add openssl1.1-compat-dev

# Resolve packages
RUN --mount=type=cache,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn yarn install

# Build sources
RUN yarn docker:build

CMD [ "yarn", "docker:start" ]

