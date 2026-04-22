# FinanceHub — Deploy Completo: Docker Local → GitHub → VPS
## Guia passo a passo para Ubuntu/macOS/Windows (WSL2)

```
Fluxo completo:
  Seu PC (Docker local) → GitHub (repositório + CI/CD) → VPS (produção)
```

---

## PRÉ-REQUISITOS NA SUA MÁQUINA LOCAL

| Ferramenta | Instalação | Verificar |
|---|---|---|
| Docker Desktop | docker.com/products/docker-desktop | `docker --version` |
| Git | git-scm.com | `git --version` |
| Conta GitHub | github.com | — |

---

## PARTE 1 — DOCKER LOCAL (desenvolvimento)

### 1.1 — Gerar as chaves de segurança

```bash
# Entre na pasta do projeto
cd financehub

# Instale as dependências temporariamente para rodar o setup
cd server && npm install && node scripts/setup.js
# Responda as perguntas:
#   Porta: 3000
#   Domínio: http://localhost:3000
# O arquivo server/.env será criado com as chaves geradas

cd ..
```

### 1.2 — Subir o ambiente de desenvolvimento com Docker

```bash
# Build e inicia em modo dev (com hot reload)
docker compose -f docker-compose.dev.yml up --build

# Em outro terminal, verifique se está rodando:
curl http://localhost:3000/api/health
# Resposta esperada: {"status":"ok","ts":...}

# Acesse no navegador:
# http://localhost:3000
```

**O que acontece:**
- Código da pasta `server/` é montado como volume → edite e veja as mudanças em tempo real
- Dados ficam em volumes Docker nomeados (persistem entre restarts)
- Porta 3000 exposta diretamente (sem Nginx em dev)

### 1.3 — Comandos úteis em desenvolvimento

```bash
# Ver logs em tempo real
docker compose -f docker-compose.dev.yml logs -f app

# Reiniciar apenas o app
docker compose -f docker-compose.dev.yml restart app

# Parar tudo
docker compose -f docker-compose.dev.yml down

# Parar E remover volumes (limpa dados)
docker compose -f docker-compose.dev.yml down -v

# Entrar no container para debug
docker exec -it financehub_dev sh
```

### 1.4 — Testar o build de produção localmente

```bash
# Build da imagem de produção
docker build -t financehub:local .

# Testar com docker run simples
docker run --rm -p 3000:3000 \
  --env-file server/.env \
  -v $(pwd)/server/data:/app/server/data \
  financehub:local

# Ou com compose de produção (sem subir nginx ainda)
GITHUB_USER=local docker compose up --build app
```

---

## PARTE 2 — GITHUB (repositório + CI/CD)

### 2.1 — Criar repositório no GitHub

```bash
# No site github.com:
# 1. Clique em "New repository"
# 2. Nome: financehub
# 3. Visibilidade: Private (recomendado — dados financeiros!)
# 4. NÃO inicialize com README (já temos código)
# 5. Clique "Create repository"
```

### 2.2 — Conectar seu projeto local ao GitHub

```bash
# Na pasta do projeto:
cd financehub

# Inicializa o git (se ainda não fez)
git init

# Configura identidade (se for a primeira vez)
git config user.name  "Seu Nome"
git config user.email "seu@email.com"

# Adiciona o remote (substitua SEU_USUARIO pelo seu usuário GitHub)
git remote add origin https://github.com/SEU_USUARIO/financehub.git

# Verifica o .gitignore (certifique que .env e /data estão listados!)
cat .gitignore

# Adiciona todos os arquivos (EXCETO os do .gitignore)
git add .

# Primeiro commit
git commit -m "feat: FinanceHub inicial com autenticação e criptografia"

# Envia para o GitHub
git push -u origin main
```

### 2.3 — Configurar Secrets no GitHub (para o CI/CD)

No GitHub, acesse: **Settings → Secrets and variables → Actions → New repository secret**

Crie os seguintes secrets:

| Secret | Valor | Como obter |
|---|---|---|
| `VPS_HOST` | IP ou domínio da VPS | Painel do seu provedor (ex: 192.168.1.1) |
| `VPS_USER` | `financehub` | Usuário criado na VPS |
| `VPS_SSH_KEY` | Chave SSH privada | Ver passo 2.4 |
| `VPS_PORT` | `22` | Porta SSH (padrão 22) |

> **GITHUB_TOKEN** já é criado automaticamente pelo GitHub — não precisa criar.

### 2.4 — Gerar e registrar a chave SSH para CI/CD

```bash
# Na sua máquina local — gera par de chaves dedicado para deploy
ssh-keygen -t ed25519 -C "financehub-deploy" -f ~/.ssh/financehub_deploy

# Isso cria dois arquivos:
#   ~/.ssh/financehub_deploy      ← CHAVE PRIVADA (vai no secret VPS_SSH_KEY)
#   ~/.ssh/financehub_deploy.pub  ← chave pública (vai na VPS)

# Ver a chave privada (copie o conteúdo COMPLETO, incluindo BEGIN/END)
cat ~/.ssh/financehub_deploy

# Ver a chave pública
cat ~/.ssh/financehub_deploy.pub
```

```bash
# Na VPS — adiciona a chave pública do GitHub Actions
# (execute como usuário financehub na VPS)
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# Cole o conteúdo de financehub_deploy.pub abaixo:
echo "COLE_AQUI_O_CONTEUDO_DA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

```
No GitHub:
  Settings → Secrets → VPS_SSH_KEY
  Cole o conteúdo COMPLETO de ~/.ssh/financehub_deploy (chave PRIVADA)
  incluindo as linhas "-----BEGIN OPENSSH PRIVATE KEY-----"
```

### 2.5 — Configurar GitHub Environment (aprovação manual)

No GitHub: **Settings → Environments → New environment**
- Nome: `production`
- Marque **"Required reviewers"** e adicione seu usuário
- Isso garante que cada deploy precise da sua aprovação

### 2.6 — Habilitar GitHub Container Registry

No GitHub: **Settings → Packages → Package visibility**
- O pacote `financehub` será criado automaticamente no primeiro push

### 2.7 — Fazer o primeiro push e observar o CI/CD

```bash
# Qualquer push para main dispara o workflow
git add .
git commit -m "ci: configura Docker e GitHub Actions"
git push origin main

# Acompanhe em:
# github.com/SEU_USUARIO/financehub/actions
```

**Fluxo que será executado:**
```
Push → Job "test" (verifica sintaxe)
     → Job "build" (builda imagem Docker e publica no GHCR)
     → Job "deploy" (aguarda sua aprovação) → Deploy na VPS
```

---

## PARTE 3 — VPS (produção)

### 3.1 — Preparar a VPS

```bash
# Conecte na VPS
ssh root@SEU_IP

# Cria usuário dedicado
adduser financehub
usermod -aG sudo,docker financehub

# Desativa login root SSH
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd
```

### 3.2 — Instalar Docker na VPS

```bash
# Como root ou com sudo
curl -fsSL https://get.docker.com | sh

# Adiciona usuário ao grupo docker (sem precisar de sudo)
usermod -aG docker financehub

# Habilita Docker para iniciar com o sistema
systemctl enable docker
systemctl start docker

# Verifica
docker --version
docker compose version
```

### 3.3 — Instalar UFW (firewall)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

### 3.4 — Clonar o repositório na VPS

```bash
# Como usuário financehub
su - financehub

# Clona o repositório
git clone https://github.com/SEU_USUARIO/financehub.git ~/financehub
cd ~/financehub

# Cria a pasta de workflows se não existir
mkdir -p .github/workflows
```

### 3.5 — Criar o .env na VPS

```bash
cd ~/financehub/server

# Instalar Node temporariamente para gerar as chaves
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

npm install
node scripts/setup.js
# Responda:
#   Porta: 3000
#   Domínio: https://seudominio.com.br

# IMPORTANTE: Faça backup das chaves geradas em local seguro!
# cat .env  →  copie e guarde em gerenciador de senhas
```

### 3.6 — Configurar o domínio no nginx

```bash
# Edita o arquivo nginx substituindo o domínio
cd ~/financehub
sed -i 's/seudominio.com.br/SEU_DOMINIO_REAL.com.br/g' nginx/financehub-docker.conf

# Verifica a substituição
grep server_name nginx/financehub-docker.conf
```

### 3.7 — Primeiro deploy: subir sem SSL para validar

```bash
cd ~/financehub

# Login no GHCR (use token do GitHub com permissão de packages:read)
# Gere em: github.com → Settings → Developer Settings → Personal Access Tokens → Classic
echo "SEU_GITHUB_TOKEN" | docker login ghcr.io -u SEU_USUARIO --password-stdin

# Edita docker-compose.yml e adiciona seu usuário
sed -i 's/${GITHUB_USER}/SEU_USUARIO/g' docker-compose.yml

# Cria um nginx temporário SEM SSL para validar o certbot
cat > nginx/init.conf << 'EOF'
server {
    listen 80;
    server_name seudominio.com.br www.seudominio.com.br;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'FinanceHub OK'; add_header Content-Type text/plain; }
}
EOF

# Sobe apenas nginx e certbot por enquanto
docker compose up -d nginx certbot

# Verifica se o nginx responde
curl http://seudominio.com.br
```

### 3.8 — Gerar certificado SSL com Certbot

```bash
cd ~/financehub

# Solicita o certificado (substitua o domínio e e-mail)
docker compose run --rm certbot certonly \
  --webroot \
  -w /var/www/certbot \
  -d seudominio.com.br \
  -d www.seudominio.com.br \
  --email seu@email.com \
  --agree-tos \
  --no-eff-email

# Se sucesso, verifica o certificado
docker compose run --rm certbot certificates
```

### 3.9 — Subir tudo em produção

```bash
cd ~/financehub

# Remove o nginx temporário
rm nginx/init.conf

# Sobe todos os serviços (app + nginx com SSL + certbot)
docker compose up -d

# Acompanha os logs
docker compose logs -f

# Verifica saúde
curl https://seudominio.com.br/api/health
```

### 3.10 — Configurar deploy automático via GitHub Actions

```bash
# A partir daqui, todo push na main do GitHub
# dispara automaticamente o CI/CD que:
#   1. Testa o código
#   2. Builda e publica a nova imagem no GHCR
#   3. Faz deploy na VPS (pull da imagem + restart do container)

# Para acompanhar: github.com/SEU_USUARIO/financehub/actions
```

---

## PARTE 4 — FLUXO DO DIA A DIA

### Fazer uma alteração e publicar

```bash
# 1. Edita o código na sua máquina
nano server/routes/data.js

# 2. Testa localmente
docker compose -f docker-compose.dev.yml up

# 3. Commit e push → CI/CD cuida do resto
git add .
git commit -m "feat: adiciona filtro por data"
git push origin main

# 4. Acompanha o deploy em:
#    github.com/SEU_USUARIO/financehub/actions
#    (aprove no environment "production" quando solicitado)
```

### Comandos úteis na VPS

```bash
# Status dos containers
docker compose ps

# Logs em tempo real
docker compose logs -f app
docker compose logs -f nginx

# Reiniciar apenas o app
docker compose restart app

# Ver uso de recursos
docker stats

# Backup manual dos dados (já cifrados com AES-256)
tar -czf ~/backup-$(date +%Y%m%d).tar.gz ~/financehub/server/data/
# Mova o backup para fora da VPS (S3, Google Drive, etc.)

# Atualizar manualmente sem CI/CD
docker compose pull && docker compose up -d --remove-orphans

# Entrar no container para debug
docker exec -it financehub_app sh

# Ver logs do nginx
docker exec financehub_nginx cat /var/log/nginx/financehub_error.log
```

---

## DIAGRAMA DO FLUXO COMPLETO

```
┌─────────────────────────────────────────────────────────────────┐
│                      SEU COMPUTADOR                             │
│                                                                 │
│  Edita código → docker compose dev → testa em localhost:3000    │
│                          ↓                                      │
│              git commit + git push → GitHub                     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         GITHUB                                  │
│                                                                 │
│  Actions: test → build → push imagem → ghcr.io/user/financehub  │
│                                    ↓                            │
│                          (aguarda aprovação)                    │
│                                    ↓                            │
│                       SSH na VPS → docker pull + up             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                           VPS                                   │
│                                                                 │
│  Nginx (443 SSL) → Container Node.js → server/data/*.enc        │
│  Certbot (renovação automática SSL a cada 12h)                  │
│  UFW Firewall (apenas 22/80/443)                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## CHECKLIST FINAL

### Local
- [ ] `docker compose -f docker-compose.dev.yml up` funciona
- [ ] `curl http://localhost:3000/api/health` retorna `{"status":"ok"}`
- [ ] Login e importação de OFX/CSV funcionam

### GitHub
- [ ] Repositório criado como **Private**
- [ ] `.env` e `server/data/` não aparecem no repositório (`.gitignore`)
- [ ] Secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` configurados
- [ ] Workflow Actions passa (aba Actions no GitHub)
- [ ] Environment `production` criado com aprovação manual

### VPS
- [ ] Docker instalado e rodando
- [ ] UFW ativo (22, 80, 443 apenas)
- [ ] `server/.env` criado com chaves seguras
- [ ] Certificado SSL gerado pelo Certbot
- [ ] `curl https://seudominio.com.br/api/health` retorna OK
- [ ] Backup automático configurado (cron)
