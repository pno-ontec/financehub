# FinanceHub — Guia Completo de Deploy na VPS
## Ubuntu 22.04 LTS · Node.js · Nginx · SSL · PM2

---

## PRÉ-REQUISITOS

- VPS com Ubuntu 22.04 (mínimo 1 vCPU, 1GB RAM, 20GB SSD)
- Domínio apontando para o IP da VPS (registro A configurado)
- Acesso SSH como root ou usuário com sudo

---

## PASSO 1 — Conectar e Proteger o Servidor

```bash
# Conectar via SSH
ssh root@SEU_IP_VPS

# Atualizar sistema
apt update && apt upgrade -y

# Criar usuário dedicado (NÃO rodar app como root)
adduser financehub
usermod -aG sudo financehub

# Copiar chave SSH para novo usuário
rsync --archive --chown=financehub:financehub ~/.ssh /home/financehub

# Desabilitar login root via SSH
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Reconectar como usuário financehub
exit
ssh financehub@SEU_IP_VPS
```

---

## PASSO 2 — Firewall (UFW)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh       # porta 22
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
sudo ufw status
```

---

## PASSO 3 — Instalar Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # deve mostrar v20.x.x
npm --version
```

---

## PASSO 4 — Instalar Nginx e Certbot (SSL)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Verificar que nginx está rodando
sudo systemctl status nginx
```

---

## PASSO 5 — Instalar PM2 (gerenciador de processos)

```bash
sudo npm install -g pm2

# Configurar PM2 para iniciar com o sistema
pm2 startup systemd -u financehub --hp /home/financehub
# Copie e execute o comando que o PM2 mostrar
```

---

## PASSO 6 — Fazer Upload do Projeto

```bash
# Na SUA máquina local, compacte o projeto:
zip -r financehub.zip financehub/ --exclude "*/node_modules/*" --exclude "*/.git/*" --exclude "*/data/*" --exclude "*/.env"

# Enviar para VPS:
scp financehub.zip financehub@SEU_IP_VPS:/home/financehub/

# De volta na VPS:
cd /home/financehub
unzip financehub.zip
cd financehub
```

---

## PASSO 7 — Configurar e Instalar Dependências

```bash
# Entrar na pasta do servidor
cd /home/financehub/financehub/server

# Instalar dependências de produção
npm install --omit=dev

# Rodar o assistente de configuração (gera .env com chaves seguras)
node scripts/setup.js

# Verifique o .env gerado
cat .env

# IMPORTANTE: Faça backup das chaves em local SEGURO (ex: gerenciador de senhas)
# Se perder SECRET_KEY e KEY_SALT, os dados criptografados NÃO poderão ser recuperados!
```

---

## PASSO 8 — Criar Diretórios com Permissões Corretas

```bash
cd /home/financehub/financehub

# Criar pastas necessárias
mkdir -p server/data server/uploads logs

# Restringir acesso (apenas o dono lê/escreve)
chmod 700 server/data server/uploads
chmod 755 logs

# Verificar estrutura
ls -la server/
```

---

## PASSO 9 — Configurar Nginx

```bash
# Copiar configuração
sudo cp /home/financehub/financehub/nginx/financehub.conf \
        /etc/nginx/sites-available/financehub

# Editar e substituir 'seudominio.com.br' pelo seu domínio real
sudo nano /etc/nginx/sites-available/financehub

# Ativar o site
sudo ln -s /etc/nginx/sites-available/financehub \
           /etc/nginx/sites-enabled/financehub

# Remover site padrão
sudo rm -f /etc/nginx/sites-enabled/default

# Testar configuração
sudo nginx -t

# Recarregar Nginx
sudo systemctl reload nginx
```

---

## PASSO 10 — Certificado SSL Gratuito (Let's Encrypt)

```bash
# Gera e instala o certificado automaticamente
# (o Certbot atualiza o nginx.conf sozinho)
sudo certbot --nginx -d seudominio.com.br -d www.seudominio.com.br

# Testar renovação automática
sudo certbot renew --dry-run

# O certbot instala um cron/timer para renovar a cada 90 dias automaticamente
```

---

## PASSO 11 — Iniciar a Aplicação com PM2

```bash
cd /home/financehub/financehub

# Carregar variáveis de ambiente
export $(cat server/.env | grep -v '#' | xargs)

# Iniciar com PM2
pm2 start ecosystem.config.js --env production

# Salvar lista de processos (para reiniciar após reboot)
pm2 save

# Verificar status
pm2 status
pm2 logs financehub --lines 50
```

---

## PASSO 12 — Verificar e Testar

```bash
# Testar API
curl https://seudominio.com.br/api/health

# Resposta esperada: {"status":"ok","ts":...}

# Ver logs em tempo real
pm2 logs financehub

# Ver logs do Nginx
sudo tail -f /var/log/nginx/financehub_access.log
sudo tail -f /var/log/nginx/financehub_error.log
```

---

## PASSO 13 — Backup Automático dos Dados

```bash
# Criar script de backup
cat > /home/financehub/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/home/financehub/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

# Compacta os dados criptografados (já estão cifrados com AES-256)
tar -czf "$BACKUP_DIR/data_$DATE.tar.gz" \
    /home/financehub/financehub/server/data/

# Mantém apenas os últimos 30 backups
ls -t "$BACKUP_DIR"/data_*.tar.gz | tail -n +31 | xargs -r rm

echo "[$DATE] Backup concluído: data_$DATE.tar.gz"
EOF

chmod +x /home/financehub/backup.sh

# Agendar backup diário às 3h da manhã
(crontab -l 2>/dev/null; echo "0 3 * * * /home/financehub/backup.sh >> /home/financehub/backup.log 2>&1") | crontab -
```

---

## COMANDOS ÚTEIS DO DIA A DIA

```bash
# Status da aplicação
pm2 status

# Reiniciar após atualização
pm2 restart financehub

# Ver logs ao vivo
pm2 logs financehub

# Parar / iniciar
pm2 stop financehub
pm2 start financehub

# Atualizar o app (após subir novo código)
cd /home/financehub/financehub
pm2 reload financehub

# Verificar uso de recursos
pm2 monit

# Status do Nginx
sudo systemctl status nginx
sudo nginx -t           # testar config
sudo systemctl reload nginx

# Ver certificado SSL
sudo certbot certificates

# Renovar manualmente (normalmente automático)
sudo certbot renew
```

---

## CHECKLIST DE SEGURANÇA

- [x] Login root SSH desabilitado
- [x] Autenticação por senha SSH desabilitada (apenas chave)
- [x] Firewall UFW ativo (apenas 22/80/443)
- [x] App roda como usuário sem privilégios (não root)
- [x] HTTPS obrigatório (redirect HTTP → HTTPS)
- [x] TLS 1.2+ apenas, cifras modernas
- [x] Headers de segurança (HSTS, CSP, X-Frame-Options...)
- [x] Rate limiting duplo (Nginx + Express)
- [x] JWT com expiração curta (15 min) + refresh token
- [x] Cookies httpOnly + Secure + SameSite=Strict
- [x] Senhas com bcrypt (12 rounds)
- [x] Dados cifrados em repouso com AES-256-GCM
- [x] Arquivos sensíveis bloqueados no Nginx (.env, .enc, .log)
- [x] Permissões de arquivo restritivas (chmod 600/700)
- [x] Backup diário dos dados cifrados
- [x] PM2 com reinício automático em caso de crash
- [x] .gitignore protegendo .env e dados

---

## ESTRUTURA FINAL NO SERVIDOR

```
/home/financehub/financehub/
├── server/
│   ├── index.js              ← Ponto de entrada
│   ├── .env                  ← Chaves (chmod 600, nunca no git!)
│   ├── data/                 ← Arquivos .enc (criptografados)
│   │   ├── users.enc
│   │   └── <uuid>.enc
│   ├── uploads/              ← Temporário (limpo após parse)
│   ├── routes/
│   ├── middleware/
│   └── utils/
├── client/public/            ← Frontend HTML
├── logs/                     ← Logs PM2
├── backups/                  ← Backups diários
├── ecosystem.config.js       ← Config PM2
└── nginx/financehub.conf     ← Config Nginx
```
