FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

WORKDIR /workspace
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --cache /tmp/decentracord-npm-cache \
  && rm -rf /tmp/decentracord-npm-cache \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libnss3-tools \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /ms-playwright \
  && ./node_modules/.bin/playwright install --with-deps chromium
RUN mkdir -p /test-ca

COPY apps/server/src apps/server/src
COPY scripts/verify-install.mjs scripts/verify-install.mjs
COPY tests/helpers tests/helpers
COPY tests/e2e tests/e2e
COPY playwright.config.ts playwright.config.ts

ENTRYPOINT ["node", "--import", "tsx", "tests/e2e/fixtures.ts"]
