# FinanceHub — Como usar com Docker

## ▶️ Primeira vez (ou após baixar atualização)

```powershell
cd C:\Users\PaulinhoNOliveira\Automacoes\financehub

docker compose -f docker-compose.dev.yml up --build
```

Aguarde ~2-3 min no primeiro build (compila o `better-sqlite3`).
Quando aparecer `✅  FinanceHub rodando em http://localhost:3000`, acesse no navegador.

---

## 🔄 Como atualizar o projeto

Quando receber um ZIP novo com alterações:

### Opção A — Só mudou código JS ou HTML (sem novas dependências)
```powershell
# 1. Extraia o ZIP sobrescrevendo os arquivos na pasta
# 2. NÃO precisa rebuildar — o nodemon já reinicia sozinho
#    Só dê F5 no navegador para o frontend

# Se o container estiver parado, suba sem --build:
docker compose -f docker-compose.dev.yml up
```

### Opção B — Mudou o package.json (novas dependências)
```powershell
# Para e reconstrói a imagem
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml up --build
```

### Opção C — Reset completo (banco zerado, recomeço do zero)
```powershell
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up --build
```
⚠️ O `-v` apaga todos os volumes — banco de dados e uploads são perdidos!

---

## 📋 Comandos do dia a dia

```powershell
# Subir (já rodando em background)
docker compose -f docker-compose.dev.yml up -d --build

# Ver logs em tempo real
docker logs financehub_dev -f

# Parar (dados são preservados)
docker compose -f docker-compose.dev.yml down

# Ver o .env gerado automaticamente
docker exec financehub_dev cat /app/server/.env

# Abrir terminal dentro do container
docker exec -it financehub_dev sh
```

---

## 💾 Persistência dos dados

| O que            | Onde fica               | Sobrevive ao restart? |
|------------------|-------------------------|-----------------------|
| Banco SQLite     | volume `financehub_data`    | ✅ Sim               |
| Uploads OFX/CSV  | volume `financehub_uploads` | ✅ Sim               |
| node_modules     | volume `financehub_node_modules` | ✅ Sim          |
| Chaves (.env)    | `server/.env` (gerado 1x)   | ✅ Sim               |

---

## 🐛 Troubleshooting

**Porta 3000 em uso:**
```powershell
# Mude no docker-compose.dev.yml:
# ports:
#   - "3001:3000"   ← lado esquerdo = sua máquina
```

**better-sqlite3 / erro de compilação:**
```powershell
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml build --no-cache
docker compose -f docker-compose.dev.yml up
```

**Docker não inicia:**
- Abra o Docker Desktop e aguarde a baleia 🐋 ficar estável na barra de tarefas
