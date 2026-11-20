FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
RUN pnpm install --ignore-scripts && pnpm --filter @icq/api prisma:generate && pnpm --filter @icq/api build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /workspace/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=build /workspace/apps/api/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./dist
COPY --from=build /workspace/apps/api/prisma ./prisma
COPY --from=build /workspace/apps/api/package.json ./package.json
RUN ln -sfn ../.pnpm/@prisma+client@6.0.0_prisma@6.0.0/node_modules/@prisma/client node_modules/@prisma/client
RUN ln -sfn ../.pnpm/bcrypt@6.0.0/node_modules/bcrypt node_modules/bcrypt && \
    ln -sfn ../.pnpm/fastify@5.12.8/node_modules/fastify node_modules/fastify && \
    ln -sfn ../.pnpm/socket.io@4.8.4/node_modules/socket.io node_modules/socket.io && \
    ln -sfn ../.pnpm/zod@3.25.76/node_modules/zod node_modules/zod && \
    mkdir -p node_modules/@fastify && \
    ln -sfn ../../.pnpm/@fastify+cors@10.0.0/node_modules/@fastify/cors node_modules/@fastify/cors && \
    ln -sfn ../../.pnpm/@fastify+jwt@9.1.0/node_modules/@fastify/jwt node_modules/@fastify/jwt
EXPOSE 8000
CMD ["node", "dist/server.js"]
