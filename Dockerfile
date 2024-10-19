ARG NODE_TAG=node:21-bullseye

FROM --platform=$BUILDPLATFORM $NODE_TAG AS base

ADD . /app
WORKDIR /app

# Enable yarn and install system packages
RUN corepack enable && apt install -y libssl1.1

FROM base AS builder

# Resolve packages
RUN --mount=type=cache,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn yarn install

# Build sources
RUN yarn docker:build

FROM base AS prod

# Resolve packages, without devDependencies
RUN --mount=type=cache,target=/root.yarn YARN_CACHE_FOLDER=/root.yarn yarn install --production

COPY --from=builder /app/dist /app/dist
ENV VERSION "docker"

CMD [ "yarn", "docker:start" ]

