# FinanceHub — Deploy na VPS Ubuntu 24 com PostgreSQL

> Docker 29 já instalado. Guia completo sem GitHub Actions.

---

## VISÃO GERAL

```
VPS Ubuntu 24
└── Docker Compose
    ├── postgres  (porta 5432 - apenas interno)
    ├── app       (porta 3000 - apenas interno)
    └── nginx     (porta 80 + 443 - público)
```

---

## PASSO 1 — Preparar a VPS

```bash
# Conecte via SSH
ssh root@SEU_IP_VPS

# Atualizar sistema
apt update && apt upgrade -y

# Instalar ferramentas
apt install -y curl nano unzip ufw

# Verificar Docker
docker --version          # 29.x.x ✓
docker compose version    # v2.x.x ✓

# Firewall
ufw allow ssh
ufw allow 80
ufw allow 443
ufw --force enable
ufw status
```

---

## PASSO 2 — Enviar o projeto para a VPS

### Opção A — WinSCP (recomendado, mais fácil)
1. Baixe e abra o **WinSCP** (https://winscp.net)
2. Conecte: `SFTP · SEU_IP_VPS · porta 22 · root · senha`
3. Navegue em `C:\Users\PaulinhoNOliveira\Automacoes\financehub`
4. Arraste a pasta para `/opt/` na VPS

### Opção B — SCP pelo PowerShell
```powershell
scp -r C:\Users\PaulinhoNOliveira\Automacoes\financehub root@SEU_IP:/opt/
```

### Opção C — ZIP pelo WinSCP
```powershell
# No Windows: comprime sem node_modules
# Aqui já tem o ZIP pronto (financehub-pg.zip)
# Envie o ZIP pelo WinSCP e extraia na VPS:
```
```bash
# Na VPS:
cd /opt
unzip financehub-pg.zip
mv fh5-pg financehub
cd financehub
ls    # client/ server/ docker-compose.yml Dockerfile nginx/ .env.example
```

---

## PASSO 3 — Criar o arquivo .env

```bash
cd /opt/financehub

# Gera chaves seguras
JWT_SECRET=$(openssl rand -hex 64)
SECRET_KEY=$(openssl rand -hex 32)
KEY_SALT=$(openssl rand -hex 32)
PGPASSWORD=$(openssl rand -hex 24)

# Cria o .env
cat > .env << EOF
# PostgreSQL
PGDATABASE=financehub
PGUSER=financehub
PGPASSWORD=${PGPASSWORD}

# JWT / Segurança
JWT_SECRET=${JWT_SECRET}
SECRET_KEY=${SECRET_KEY}
KEY_SALT=${KEY_SALT}

# App
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=https://SEU_DOMINIO.COM.BR

# Admin
ADMIN_EMAIL=paulinho.n.oliveira@gmail.com

# PIX
PIX_KEY=SEU_CPF_OU_EMAIL
PIX_NAME=SEU NOME
PIX_CITY=SAO PAULO

ANTHROPIC_API_KEY=
EOF

chmod 600 .env
echo "Senha do banco: ${PGPASSWORD}"   # anote isso!
```

---

## PASSO 4 — Configurar o domínio no Nginx

```bash
cd /opt/financehub

# Substitui o placeholder pelo seu domínio REAL
sed -i 's/SEU_DOMINIO.COM.BR/financehub.paulinho.com.br/g' \
    nginx/financehub-docker.conf

cat nginx/financehub-docker.conf | grep server_name   # confere
```

---

## PASSO 5 — Primeiro teste SEM SSL

```bash
cd /opt/financehub

# Sobe só postgres + app (sem nginx ainda)
docker compose up -d postgres app

# Aguarda (~20 segundos para PG iniciar)
docker compose logs -f app

# Quando aparecer "✅  FinanceHub v7 em http://localhost:3000":
curl http://localhost:3000/api/health
# {"status":"ok","ts":...}  ← sucesso!

# Testa no navegador: http://SEU_IP:3000
# (abra a porta temporariamente no firewall)
ufw allow 3000
# ... testa no browser ...
ufw delete allow 3000   # fecha depois do teste
```

---

## PASSO 6 — Apontar DNS do domínio

No painel do seu provedor de domínio:
```
Tipo:   A
Nome:   @   (ou subdomínio, ex: financehub)
Valor:  SEU_IP_VPS
TTL:    300
```

Aguarde 5-30 minutos. Confirme:
```bash
nslookup SEU_DOMINIO.COM.BR
# Deve mostrar SEU_IP_VPS
```

---

## PASSO 7 — SSL com Certbot (Let's Encrypt)

```bash
# Sobe nginx temporário na porta 80 para o certbot validar
docker compose up -d nginx

# Instala certbot na VPS (fora do Docker, mais simples)
apt install -y certbot

# Para nginx do Docker temporariamente
docker compose stop nginx

# Gera o certificado
certbot certonly --standalone \
  -d SEU_DOMINIO.COM.BR \
  -d www.SEU_DOMINIO.COM.BR \
  --email paulinho.n.oliveira@gmail.com \
  --agree-tos \
  --no-eff-email

# Verifica que os certs foram gerados
ls /etc/letsencrypt/live/SEU_DOMINIO.COM.BR/
# fullchain.pem  privkey.pem  ← precisa ter esses dois

# Cria o dhparam (pode demorar 1-2 min)
openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048

# Copia options-ssl-nginx.conf do certbot
curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
  > /etc/letsencrypt/options-ssl-nginx.conf
```

---

## PASSO 8 — Montar volumes SSL no docker-compose

```bash
# Edita docker-compose.yml para montar os certs do host no nginx
nano /opt/financehub/docker-compose.yml
```

Adicione nos volumes do nginx:
```yaml
    volumes:
      - ./nginx/financehub-docker.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro      # <- adicione estas duas linhas
      - /var/www/certbot:/var/www/certbot:ro       # <- 
```

---

## PASSO 9 — Subida final completa

```bash
cd /opt/financehub

# Sobe tudo
docker compose up -d

# Acompanha logs
docker compose logs -f

# Verifica que tudo está rodando
docker compose ps
# NAME                    STATUS
# financehub_postgres     Up (healthy)
# financehub_app          Up (healthy)
# financehub_nginx        Up

# Testa HTTPS
curl https://SEU_DOMINIO.COM.BR/api/health
```

Acesse: **https://SEU_DOMINIO.COM.BR** 🎉

---

## PASSO 10 — Renovação automática SSL

```bash
# Adiciona ao crontab do root
crontab -e

# Adiciona esta linha (renova às 3h da manhã, 2x por semana)
0 3 * * 1,4 certbot renew --quiet && docker compose -f /opt/financehub/docker-compose.yml restart nginx
```

---

## COMANDOS ÚTEIS DO DIA A DIA

```bash
cd /opt/financehub

# Ver status
docker compose ps

# Ver logs da app
docker compose logs -f app --tail=50

# Ver logs do nginx
docker compose logs -f nginx --tail=50

# Reiniciar só a app (após atualizar código)
docker compose up -d --build app

# Reiniciar tudo
docker compose restart

# Parar tudo (mantém dados)
docker compose down

# Backup do banco PostgreSQL
docker exec financehub_postgres pg_dump \
  -U financehub financehub > backup_$(date +%Y%m%d).sql

# Restaurar backup
cat backup_20260422.sql | docker exec -i financehub_postgres \
  psql -U financehub financehub

# Acessar banco diretamente
docker exec -it financehub_postgres psql -U financehub financehub
```

---

## ATUALIZAR O CÓDIGO (quando tiver nova versão)

```bash
cd /opt/financehub

# 1. Envie os novos arquivos pelo WinSCP (só client/ e server/)
# 2. Rebuild e restart da app (banco continua rodando)
docker compose up -d --build app --no-deps

# O migrate() roda automaticamente no startup
# e cria colunas novas sem apagar os dados
```

---

## TROUBLESHOOTING

**App não conecta ao PostgreSQL:**
```bash
docker compose logs postgres    # vê se PG iniciou
docker compose logs app         # vê o erro exato
# Confirme que PGPASSWORD no .env é o mesmo do postgres
```

**Nginx 502 Bad Gateway:**
```bash
docker compose ps app          # está healthy?
docker compose logs app        # erro de startup?
```

**Certificado SSL não encontrado:**
```bash
ls /etc/letsencrypt/live/      # domínio está lá?
# Refaça o passo 7 com o domínio correto
```

**Portas 80/443 ocupadas:**
```bash
ss -tlnp | grep -E ':80|:443'  # quem está usando
systemctl stop apache2         # para apache se estiver rodando
systemctl disable apache2
```
