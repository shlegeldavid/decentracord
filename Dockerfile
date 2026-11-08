FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --cache /tmp/decentracord-npm-cache \
  && rm -rf /tmp/decentracord-npm-cache

COPY tsconfig.base.json ./
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
COPY apps/web apps/web
RUN npm run build

FROM build AS test-helper
WORKDIR /workspace
COPY tests/helpers tests/helpers
ENTRYPOINT ["node", "--import", "tsx", "tests/helpers/identity-cli.ts"]

FROM build AS test-runner
WORKDIR /workspace
COPY tests/integration tests/integration
COPY vitest.config.ts vitest.config.ts
ENTRYPOINT ["npm", "run", "test:integration", "--", "tests/integration/login-api.test.ts"]

FROM build AS e2e-runner
WORKDIR /workspace
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
  && ./node_modules/.bin/playwright install --with-deps chromium \
  && chown -R node:node /ms-playwright
COPY tests/helpers tests/helpers
COPY tests/e2e tests/e2e
COPY playwright.config.ts playwright.config.ts
USER node
ENTRYPOINT ["npm", "run", "test:e2e:playwright", "--"]

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --omit=dev --workspace @decentracord/server --include-workspace-root=false --cache /tmp/decentracord-npm-cache \
  && rm -rf /tmp/decentracord-npm-cache
COPY --from=build --chown=node:node /workspace/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /workspace/apps/server/dist/public ./public
COPY --chown=node:node migrations ./migrations

USER node
ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["server"]
