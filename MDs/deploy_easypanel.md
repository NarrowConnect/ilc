# 🏛️ Guia de Deploy — Login do Cidadão (ILC) no Easypanel (VPS)

> Guia completo para subir o sistema ILC em uma VPS utilizando o **Easypanel**.
> O banco de dados é **SQLite embutido no próprio app**: não existe Supabase nem serviço Postgres. No Easypanel há **um único serviço** (o app ILC) com um **volume** para guardar o arquivo do banco.

---

## Pré-requisitos

| Item | Requisito mínimo |
|------|-----------------|
| VPS | 1 vCPU / 1 GB RAM (Ubuntu 22.04 LTS recomendado) |
| Domínio | Um domínio ou subdomínio apontando para o IP da VPS |
| Easypanel | Instalado e acessível via browser |
| Conta Google Cloud | Credenciais OAuth 2.0 configuradas (para login com Google) |

---

## Passo 1 — Configurar as Credenciais OAuth do Google

1. Acesse o [Google Cloud Console](https://console.cloud.google.com).
2. Crie um novo projeto (ou use um existente).
3. Vá em **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client IDs**.
4. Tipo de aplicação: **Web application**.
5. Em **Authorized JavaScript origins**, adicione `https://SEU_DOMINIO.com`.
6. Em **Authorized redirect URIs**, adicione `https://SEU_DOMINIO.com/api/auth/google/callback`.
7. Salve e copie o **Client ID** e o **Client Secret**.

---

## Passo 2 — Instalar o Easypanel na VPS

```bash
curl -sSL https://easypanel.io/install.sh | sh
```

O Easypanel estará disponível em `http://SEU_IP:3000`.

---

## Passo 3 — Criar o Projeto e o Serviço do App

1. No Easypanel, clique em **Create Project** (ex.: `ilc`).
2. Dentro do projeto, **Create Service → App**.
3. Fonte **GitHub**: selecione o repositório do ILC, branch `main`. O Easypanel usa o `Dockerfile` da raiz (deixe Build/Start Command em branco).

---

## Passo 4 — Volume do Banco de Dados (obrigatório)

Sem este passo, **o banco é apagado a cada novo deploy**.

1. No serviço do app, abra **Mounts → Add Volume**.
2. **Name**: `ilc-data` · **Mount Path**: `/usr/src/app/data`
3. Salve.

> Use o tipo **Volume** (não *Bind*). O volume do Docker herda as permissões da imagem, que roda como usuário `app`.

Dentro desse volume ficam:
- `ilc.db` (mais `ilc.db-wal` e `ilc.db-shm`): o banco;
- `backups/ilc-AAAA-MM-DD.db`: backups automáticos diários (os últimos 7 por padrão).

**Mantenha o serviço com 1 réplica.** O SQLite não é compartilhado entre vários containers.

---

## Passo 5 — Variáveis de Ambiente

Em **Environment** do serviço:

| Variável | Valor | Observação |
|----------|-------|------------|
| `JWT_SECRET` | string aleatória longa (64+ chars) | obrigatório |
| `SESSION_SECRET` | outra string aleatória (32+ chars) | obrigatório |
| `GOOGLE_CLIENT_ID` | `XXX.apps.googleusercontent.com` | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-...` | Google Cloud Console |
| `GOOGLE_CALLBACK_URL` | `https://SEU_DOMINIO.com/api/auth/google/callback` | |
| `WAHA_BASE_URL` / `WAHA_API_KEY` / `WAHA_SESSION` / `WAHA_DEFAULT_CHAT_ID` | dados do WAHA | envio de eventos no grupo do WhatsApp |
| `SEED_DEMO` | `false` | não cria cidadãos de demonstração no 1º boot |
| `BACKUP_KEEP` | `7` | opcional: quantos backups diários manter |
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | |

`DATA_DIR` já vem definido na imagem (`/usr/src/app/data`). **Não existe mais `DATABASE_URL`.**

---

## Passo 6 — Domínio e HTTPS

1. No serviço, vá em **Domains → Add Domain** e informe o domínio (ex.: `ilc.seudominio.com`), porta `3000`.
2. O Easypanel emite o certificado **Let's Encrypt** automaticamente.
3. No DNS, crie um registro `A` apontando para o IP da VPS.

---

## Passo 7 — Deploy e Verificação

1. Clique em **Deploy** e acompanhe a aba **Logs**.
2. Quando aparecerem `🏛️ Banco SQLite embutido pronto em /usr/src/app/data/ilc.db` e `📡 Portal ILC rodando na porta ...`, o sistema está no ar.
3. Acesse `https://SEU_DOMINIO.com`.

Em um banco novo, o servidor cria automaticamente o administrador:

| Usuário | Senha padrão |
|---------|-------------|
| `comissario_otavio` | `admin123` |

> **⚠️ IMPORTANTE**: troque essa senha logo após o primeiro login.

---

## Migração única dos dados do Supabase (apenas para quem vinha da versão antiga)

Faça uma vez, na troca para esta versão:

1. Faça o deploy desta versão com o **volume já montado** (Passos 4 e 5). O banco nasce com o admin padrão, que será substituído.
2. Avise os usuários e evite uso durante a cópia (alguns minutos).
3. Adicione temporariamente a variável `SUPABASE_DATABASE_URL` com a connection string do Supabase (*Project Settings → Database → Connection string → URI*) e faça **Deploy** para aplicar.
4. Abra o **Console** do serviço no Easypanel e rode:
   ```bash
   node scripts/migrate-from-supabase.js --confirm
   ```
   O script:
   - salva um backup do SQLite atual em `data/backups/pre-migracao-*.db`;
   - copia todas as tabelas, mantendo IDs, hashes de senha, scores, certificados, eventos e auditoria;
   - imprime a conferência de linhas por tabela. Todas devem estar com ✅.
5. Clique em **Restart** no serviço.
6. Teste: login com senha e com Google, painel do cidadão, painel admin, eventos e envio no grupo.
7. Mantenha o projeto Supabase intacto por 1–2 semanas como plano de volta. Depois, remova `SUPABASE_DATABASE_URL` e encerre o projeto no Supabase.

---

## Backups

- **Automático:** 1 cópia por dia em `/usr/src/app/data/backups/`, dentro do volume.
- **Download manual (admin):** `GET /api/admin/backup`, com o token de um administrador, baixa uma cópia consistente do banco (`.db`).
- **Cópia para fora da VPS:** recomendado. Configure o backup de volumes do Easypanel, ou baixe periodicamente pelo endpoint acima.
- **Restaurar:** pare o serviço, substitua `ilc.db` no volume pelo arquivo de backup (apague `ilc.db-wal` e `ilc.db-shm`) e inicie de novo.

O arquivo `.db` pode ser aberto em qualquer visualizador SQLite, como o [DB Browser for SQLite](https://sqlitebrowser.org/).

---

## Atualização da Aplicação

- Faça `git push` na `main` e clique em **Deploy** (ou use o webhook automático).
- O volume preserva o banco entre deploys. Novas colunas e tabelas são criadas automaticamente na inicialização.

---

## Solução de Problemas Comuns

### ❌ "Falha ao preparar o banco SQLite" / `SQLITE_CANTOPEN` / permissão negada
- Confirme que o mount é do tipo **Volume** em `/usr/src/app/data`.
- Se usar *Bind mount*, a pasta no host precisa pertencer ao usuário do container. Prefira Volume.

### ❌ Os dados sumiram depois de um deploy
- O volume não estava montado em `/usr/src/app/data`. Monte-o. Se houver backup em outro lugar, restaure.

### ❌ `database is locked`
- Verifique se o serviço tem **apenas 1 réplica**.

### ❌ Login com Google não funciona
- `GOOGLE_CALLBACK_URL` deve ser idêntico à URI cadastrada no Google Cloud Console.

---

## Arquitetura do Sistema em Produção

```
┌─────────────────────────────────────────────────┐
│          USUÁRIO (Browser / APK / iOS)          │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS (Let's Encrypt via Easypanel)
┌──────────────────▼──────────────────────────────┐
│              VPS (Easypanel)                    │
│  ┌─────────────────────────────────────────┐    │
│  │  Serviço único: app ILC (Docker)        │    │
│  │  ┌─────────────┐  ┌──────────────────┐  │    │
│  │  │  Express.js │  │  React (dist/)   │  │    │
│  │  │  :3000 API  │  │  Estáticos       │  │    │
│  │  └──────┬──────┘  └──────────────────┘  │    │
│  │         │ node:sqlite                    │    │
│  │  ┌──────▼──────────────────────────┐    │    │
│  │  │ Volume /usr/src/app/data        │    │    │
│  │  │  ilc.db  +  backups/            │    │    │
│  │  └─────────────────────────────────┘    │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

---

*Documento gerado para o sistema Login do Cidadão — Índice de Lealdade Cívica (ILC)*
