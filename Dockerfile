# Build outside Railpack/Mise+Aqua — those layers sometimes fail to resolve pnpm majors.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install pnpm via npm registry (never depends on Aqua index).
RUN npm install -g pnpm@9.15.9

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build \
	&& pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["node", "dist/server.js"]
