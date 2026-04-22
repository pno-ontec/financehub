# ─────────────────────────────────────────────────────────────────────────────
# FinanceHub — Dockerfile (multi-stage build)
# Stage 1: instala dependências
# Stage 2: imagem final mínima (apenas produção)
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Copia apenas manifesto primeiro (cache de camadas)
COPY server/package.json ./

# Instala somente dependências de produção
RUN npm install --omit=dev --ignore-scripts

# ── Stage 2: Runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Metadados
LABEL maintainer="FinanceHub"
LABEL description="FinanceHub - Gestão financeira segura"

# Variáveis de ambiente padrão (sobrescritas pelo .env ou docker-compose)
ENV NODE_ENV=production \
    PORT=3000

# Cria usuário sem privilégios (princípio do menor privilégio)
RUN addgroup -g 1001 -S financehub && \
    adduser  -u 1001 -S financehub -G financehub

WORKDIR /app

# Copia node_modules do builder
COPY --from=builder /build/node_modules ./node_modules

# Copia código do servidor
COPY server/ ./server/

# Copia frontend
COPY client/ ./client/

# Cria diretórios de dados com permissão correta
RUN mkdir -p server/data server/uploads logs && \
    chown -R financehub:financehub /app && \
    chmod 700 server/data server/uploads

# Troca para usuário sem privilégios
USER financehub

# Expõe a porta (não publica — o Nginx faz o proxy)
EXPOSE 3000

# Health check interno
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Inicia a aplicação
CMD ["node", "server/index.js"]
