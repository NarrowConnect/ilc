# Multi-stage Dockerfile otimizado para deploy em VPS (produção)

# ------------------------
# Stage: builder (build do frontend)
# ------------------------
FROM node:24-alpine AS builder

WORKDIR /usr/src/app

# Instalar dependências necessárias para build (inclui devDependencies)
# Aceitar peer deps legacy quando necessário
ENV NPM_CONFIG_LEGACY_PEER_DEPS=1
COPY package.json package-lock.json* ./
# Use npm ci when package-lock.json exists for reproducible build, fallback to npm install
RUN if [ -f package-lock.json ]; then npm ci --legacy-peer-deps; else npm install --legacy-peer-deps; fi

# Copiar todo o código e gerar build do frontend (Vite)
COPY . .
RUN npm run build


# ------------------------
# Stage: runner (imagem final leve)
# ------------------------
FROM node:24-alpine AS runner

WORKDIR /usr/src/app

# Definir ambiente de produção
ENV NODE_ENV=production

# Instalar apenas dependências de produção
# Copiar package.json e package-lock.json se existir, para instalar de forma reprodutível
COPY package.json package-lock.json* ./
# Instalação reproducível em produção quando possível
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --legacy-peer-deps; else npm install --omit=dev --legacy-peer-deps; fi

# Copiar artefatos do build e arquivos do servidor
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/server.js ./server.js
COPY --from=builder /usr/src/app/db.js ./db.js
COPY --from=builder /usr/src/app/ministerios.js ./ministerios.js
COPY --from=builder /usr/src/app/jogos.js ./jogos.js
COPY --from=builder /usr/src/app/SQL ./SQL
COPY --from=builder /usr/src/app/scripts ./scripts
# APK publicado para a atualização dentro do app (rota /downloads/ILC-Cidadao.apk)
COPY --from=builder /usr/src/app/releases ./releases

# Banco SQLite embutido: monte um VOLUME do EasyPanel em /usr/src/app/data
# para que o arquivo ilc.db (e os backups diários) sobrevivam a novos deploys.
ENV DATA_DIR=/usr/src/app/data

# Criar usuário não-root e ajustar permissões
RUN addgroup -S app && adduser -S app -G app && mkdir -p /usr/src/app/data && chown -R app:app /usr/src/app
USER app
# Sem instrução VOLUME aqui de propósito: um volume anônimo esconderia a falta do volume
# do EasyPanel (e seria perdido no deploy). O servidor avisa no log se a pasta não estiver montada.

# Expor porta e definir variável padrão (pode ser sobrescrita em runtime)
ENV PORT=3000
ENV NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 3000

# Healthcheck simples usando Node (verifica /api/health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "require('http').get('http://localhost:'+ (process.env.PORT||3000) +'/api/health', res=>{if(res.statusCode===200) process.exit(0); else process.exit(1)}).on('error',()=>process.exit(1))"

# Iniciar o servidor Express
CMD ["node", "server.js"]
