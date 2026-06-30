#!/usr/bin/env bash
# =============================================================================
#  Svatantra — CT Dashboard  |  Linux Deployment Script
#  Supports : Ubuntu 20.04+ / Debian 11+  and  RHEL/CentOS/Amazon Linux 2+
#  Run as   : sudo bash deploy.sh          (first time)
#             sudo bash deploy.sh          (update / redeploy)
# =============================================================================
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}▶  $*${NC}"; }

# ── Configuration (override via environment variables) ────────────────────────
APP_NAME="${APP_NAME:-ct-dashboard}"
APP_PORT="${PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_USER="${SERVICE_USER:-ct-dashboard}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${APP_DIR}/logs"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

# ── Must run as root ──────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Please run as root:  sudo bash deploy.sh"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Svatantra CT Dashboard — Deployment Script           ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
info "App directory : $APP_DIR"
info "Port          : $APP_PORT"
info "Service name  : $APP_NAME"
info "Service user  : $SERVICE_USER"
echo ""

# ── Detect package manager ────────────────────────────────────────────────────
detect_distro() {
  if command -v apt-get &>/dev/null; then
    echo "debian"
  elif command -v yum &>/dev/null || command -v dnf &>/dev/null; then
    echo "rhel"
  else
    error "Unsupported distro — neither apt-get nor yum/dnf found."
  fi
}
DISTRO=$(detect_distro)
info "Detected distro family: $DISTRO"

# ── Step 1: Install Node.js ───────────────────────────────────────────────────
header "Step 1 — Node.js ${NODE_MAJOR}.x"

install_node_debian() {
  info "Installing Node.js ${NODE_MAJOR}.x via NodeSource…"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
}

install_node_rhel() {
  info "Installing Node.js ${NODE_MAJOR}.x via NodeSource…"
  PKG_MGR="yum"
  command -v dnf &>/dev/null && PKG_MGR="dnf"
  $PKG_MGR install -y -q curl
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  $PKG_MGR install -y -q nodejs
}

NODE_OK=false
if command -v node &>/dev/null; then
  CURRENT_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [[ $CURRENT_MAJOR -ge 18 ]]; then
    success "Node.js $(node -v) already installed — skipping."
    NODE_OK=true
  else
    warn "Node.js $(node -v) is too old (need ≥18). Upgrading…"
  fi
fi

if [[ $NODE_OK == false ]]; then
  [[ $DISTRO == "debian" ]] && install_node_debian || install_node_rhel
  success "Node.js $(node -v) installed."
fi

# ── Step 2: Create service user ───────────────────────────────────────────────
header "Step 2 — Service user"

if id "$SERVICE_USER" &>/dev/null; then
  success "User '$SERVICE_USER' already exists — skipping."
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  success "Created system user '$SERVICE_USER'."
fi

# ── Step 3: Set directory ownership & permissions ─────────────────────────────
header "Step 3 — Permissions"

mkdir -p "$LOG_DIR" "${APP_DIR}/data"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"
chmod -R 750 "$APP_DIR"
success "Ownership → $SERVICE_USER:$SERVICE_USER"

# ── Step 4: Install npm dependencies ─────────────────────────────────────────
header "Step 4 — npm install"

cd "$APP_DIR"
# Run npm install as the service user so node_modules are owned correctly
sudo -u "$SERVICE_USER" npm install --omit=dev --no-audit --no-fund 2>&1 \
  | grep -v "^npm warn" || true
success "npm dependencies installed."

# ── Step 5: Stop existing service (if running) ────────────────────────────────
header "Step 5 — Stop existing service (if any)"

if systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then
  systemctl stop "$APP_NAME"
  success "Stopped existing service."
else
  info "Service not currently running — nothing to stop."
fi

# ── Step 6: Create / update systemd unit ─────────────────────────────────────
header "Step 6 — systemd service"

NODE_BIN=$(command -v node)

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Svatantra Center Quality CT Dashboard
Documentation=https://github.com/svatantra/ct-dashboard
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

# Environment
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$APP_NAME"
success "systemd unit created/updated at $SERVICE_FILE"

# ── Step 7: Start service ─────────────────────────────────────────────────────
header "Step 7 — Start service"

systemctl start "$APP_NAME"
sleep 3

if systemctl is-active --quiet "$APP_NAME"; then
  success "Service is running."
else
  error "Service failed to start. Check logs with:  journalctl -u ${APP_NAME} -n 50 --no-pager"
fi

# ── Step 8: Firewall ──────────────────────────────────────────────────────────
header "Step 8 — Firewall"

open_ufw() {
  if ufw status | grep -q "Status: active"; then
    ufw allow "$APP_PORT"/tcp &>/dev/null
    success "ufw: allowed TCP port $APP_PORT"
  else
    warn "ufw is installed but not active — skipping firewall rule."
  fi
}

open_firewalld() {
  if firewall-cmd --state &>/dev/null; then
    firewall-cmd --permanent --add-port="${APP_PORT}/tcp" &>/dev/null || true
    firewall-cmd --reload &>/dev/null || true
    success "firewalld: allowed TCP port $APP_PORT"
  else
    warn "firewalld not running — skipping firewall rule."
  fi
}

if command -v ufw &>/dev/null; then
  open_ufw
elif command -v firewall-cmd &>/dev/null; then
  open_firewalld
else
  warn "No firewall tool detected (ufw/firewalld) — ensure port $APP_PORT is open manually."
fi

# ── Step 9: Health check ──────────────────────────────────────────────────────
header "Step 9 — Health check"

sleep 2
if curl -sf "http://localhost:${APP_PORT}/api/health" &>/dev/null; then
  success "Health check passed — app is responding."
else
  warn "Health check failed. Service may still be starting. Check:  journalctl -u ${APP_NAME} -n 30"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<server-ip>")

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║  Deployment complete!                                    ║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  Dashboard URL   :  http://${SERVER_IP}:${APP_PORT}         "
echo -e "${BOLD}${GREEN}║${NC}  Default login   :  admin  /  admin@123               "
echo -e "${BOLD}${GREEN}║${NC}  Change password :  node scripts/add-user.js --password admin"
echo -e "${BOLD}${GREEN}║${NC}                                                       "
echo -e "${BOLD}${GREEN}║${NC}  Useful commands:"
echo -e "${BOLD}${GREEN}║${NC}    Status  →  systemctl status ${APP_NAME}"
echo -e "${BOLD}${GREEN}║${NC}    Logs    →  journalctl -u ${APP_NAME} -f"
echo -e "${BOLD}${GREEN}║${NC}    Restart →  systemctl restart ${APP_NAME}"
echo -e "${BOLD}${GREEN}║${NC}    Stop    →  systemctl stop ${APP_NAME}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
