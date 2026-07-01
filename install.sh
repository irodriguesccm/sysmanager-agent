#!/bin/bash
# SysManager Agent - Script de instalação
# Uso: curl -sSL http://console:7878/agent/install.sh | bash -s -- --token TOKEN --server ws://console:7877/ws/agent --name Agent-001

set -e

AGENT_DIR="/opt/sysmanager-agent"
SERVICE_FILE="/etc/systemd/system/sysmanager-agent.service"
CONFIG_DIR="/etc/sysmanager-agent"
CONFIG_FILE="$CONFIG_DIR/config.json"

TOKEN=""
SERVER_URL=""
AGENT_NAME="Agent-$(hostname)"
INTERVAL=5000
LOCAL_API_BASE_URL="http://127.0.0.1:3001"
SOURCE_BASE_URL=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --token)   TOKEN="$2";      shift 2 ;;
    --server)  SERVER_URL="$2"; shift 2 ;;
    --name)    AGENT_NAME="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --api) LOCAL_API_BASE_URL="$2"; shift 2 ;;
    --source) SOURCE_BASE_URL="$2"; shift 2 ;;
    *) echo "Argumento desconhecido: $1"; exit 1 ;;
  esac
done

if [ -z "$TOKEN" ] || [ -z "$SERVER_URL" ]; then
  echo "Uso: $0 --token TOKEN --server ws://console:7877/ws/agent [--name Agent-001] [--interval 5000] [--api http://127.0.0.1:3001]"
  exit 1
fi

echo "=== SysManager Agent Installer ==="
echo "Servidor: $SERVER_URL"
echo "Nome:     $AGENT_NAME"
echo "API local: $LOCAL_API_BASE_URL"

if [ -z "$SOURCE_BASE_URL" ]; then
  SERVER_HOST=$(echo "$SERVER_URL" | sed -E 's#^[a-zA-Z]+://([^:/]+).*#\1#')
  SOURCE_BASE_URL="http://${SERVER_HOST}:7878/agent/runtime"
fi

SOURCE_BASE_URL="${SOURCE_BASE_URL%/}"
echo "Origem dos arquivos: $SOURCE_BASE_URL"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "[!] Node.js não encontrado. Instalando..."
  if command -v dnf &>/dev/null; then
    dnf install -y nodejs npm
  elif command -v apt-get &>/dev/null; then
    apt-get install -y nodejs npm
  elif command -v yum &>/dev/null; then
    yum install -y nodejs npm
  else
    echo "[ERRO] Gerenciador de pacotes não suportado. Instale o Node.js manualmente."
    exit 1
  fi
fi

NODE_VERSION=$(node --version | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "[ERRO] Node.js 18+ é necessário. Versão atual: $(node --version)"
  exit 1
fi

echo "[✓] Node.js $(node --version)"

# Create directories
mkdir -p "$AGENT_DIR" "$CONFIG_DIR"

# Download agent runtime files
curl -fsSL "$SOURCE_BASE_URL/index.js" -o "$AGENT_DIR/index.js"
curl -fsSL "$SOURCE_BASE_URL/local-api-fallback.js" -o "$AGENT_DIR/local-api-fallback.js"
curl -fsSL "$SOURCE_BASE_URL/package.json" -o "$AGENT_DIR/package.json"

# Install dependencies
cd "$AGENT_DIR"
npm install --omit=dev --quiet

# Write config
cat > "$CONFIG_FILE" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "token": "$TOKEN",
  "agentName": "$AGENT_NAME",
  "reportInterval": $INTERVAL,
  "localApiBaseUrl": "$LOCAL_API_BASE_URL"
}
EOF

chmod 600 "$CONFIG_FILE"
echo "[✓] Configuração salva em $CONFIG_FILE"

# Create systemd service
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=SysManager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$AGENT_DIR
ExecStart=/usr/bin/node $AGENT_DIR/index.js --config $CONFIG_FILE
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sysmanager-agent

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sysmanager-agent
systemctl restart sysmanager-agent

echo ""
echo "=== Instalação concluída ==="
echo "Status: $(systemctl is-active sysmanager-agent)"
echo ""
echo "Comandos úteis:"
echo "  systemctl status sysmanager-agent"
echo "  journalctl -u sysmanager-agent -f"
echo "  systemctl restart sysmanager-agent"
