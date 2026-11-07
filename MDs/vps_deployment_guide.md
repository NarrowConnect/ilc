# 🏛️ Guia de Deploy em VPS — Sistema ILC via Easypanel

Este guia descreve como subir o **Índice de Lealdade Cívica (ILC)** em uma VPS com o **Easypanel**. O banco de dados é **SQLite embutido no próprio app**, então não é preciso nenhum serviço de banco separado (nem Supabase, nem Postgres).

> Para o passo a passo detalhado (variáveis, backups, migração dos dados antigos do Supabase), veja [deploy_easypanel.md](deploy_easypanel.md).

---

## 💾 1. Banco de Dados (embutido)

- O servidor cria e mantém sozinho o arquivo `ilc.db` (schema em `SQL/sqlite_schema.sql`) na pasta `DATA_DIR`, que no container é `/usr/src/app/data`.
- Na primeira inicialização, ele aplica as sementes (papéis, faixas de lealdade, tipos de evento e certificados) e cria o administrador padrão.
- Backups diários automáticos ficam em `data/backups/`.

O único requisito é montar um **volume** do Easypanel em `/usr/src/app/data`, para o banco sobreviver a novos deploys.

---

## 🐧 2. Instalando o Easypanel na VPS

1. Contrate uma VPS com **Ubuntu (20.04/22.04 LTS)**, com no mínimo 1 vCPU e 1 GB de RAM.
2. Acesse via SSH:
   ```bash
   ssh root@<IP_DA_SUA_VPS>
   ```
3. Instale o Easypanel:
   ```bash
   curl -sSL https://easypanel.io/install.sh | bash
   ```
4. Acesse `http://<IP_DA_SUA_VPS>:3000` e crie a conta do administrador do painel.

---

## 🐳 3. Deploiando o Portal no Easypanel

1. **Create Project** (ex.: `ilc-dashboard`), depois **Add Service → App**.
2. **Source**: o repositório GitHub do ILC, branch `main`, diretório base `/`. O build usa o `Dockerfile` da raiz.
3. **Mounts → Add Volume**: nome `ilc-data`, caminho `/usr/src/app/data`.
4. **Environment**:

   | Chave | Valor Exemplo | Descrição |
   |---|---|---|
   | `JWT_SECRET` | `uma-chave-longa-e-muito-segura` | Assina os tokens JWT. |
   | `SESSION_SECRET` | `outra-chave-longa` | Sessão do fluxo OAuth. |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | Google Cloud | Login com Google. |
   | `WAHA_BASE_URL` / `WAHA_API_KEY` / `WAHA_SESSION` / `WAHA_DEFAULT_CHAT_ID` | WAHA | Envio no grupo do WhatsApp. |
   | `SEED_DEMO` | `false` | Não cria cidadãos de demonstração. |
   | `PORT` | `3000` | Porta do Express. |
   | `NODE_ENV` | `production` | Ambiente de produção. |

5. **Domains**: use o subdomínio `.easypanel.host` ou o seu domínio (registro `A` para o IP da VPS), porta `3000`.
6. **Deploy**. Mantenha o serviço com **1 réplica**.

---

## 🧪 4. Validação da Stack

1. Abra o link do Easypanel. A tela de **Login do Cidadão** deve carregar.
2. Nos logs, confirme `🏛️ Banco SQLite embutido pronto em /usr/src/app/data/ilc.db`.
3. Faça login com:
   - **Identificador**: `comissario_otavio`
   - **Senha**: `admin123` (troque depois do primeiro acesso)
4. Lance um evento no painel administrativo e confira se o score e a auditoria são atualizados.
5. Reinicie o serviço e confirme que os dados continuam lá, o que mostra que o volume está montado corretamente.
