#!/bin/bash
# ============================================
# Piston VPS Setup Script
# Run this on your Ubuntu 22.04 VPS
# Usage: sudo bash setup-piston.sh [vps1|vps2]
# ============================================

set -e

VPS_TYPE=${1:-"vps1"}

echo "============================================"
echo "Piston Setup Script for $VPS_TYPE"
echo "============================================"

# Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then
    echo "Please run with sudo: sudo bash setup-piston.sh $VPS_TYPE"
    exit 1
fi

# 1. Update system
echo "[1/7] Updating system..."
apt update && apt upgrade -y

# 2. Install Docker
echo "[2/7] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker $SUDO_USER
else
    echo "Docker already installed"
fi

# 3. Install Docker Compose
echo "[3/7] Installing Docker Compose..."

# Method 1: Try installing from Docker's official repo
if ! docker compose version &> /dev/null; then
    # Add Docker's official GPG key and repository
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    apt-get update
    apt-get install -y docker-compose-plugin || {
        # Method 2: Fallback to standalone docker-compose
        echo "Installing standalone docker-compose..."
        curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose
        chmod +x /usr/local/bin/docker-compose
        ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
    }
else
    echo "Docker Compose already installed"
fi

# Verify installation
if docker compose version &> /dev/null; then
    echo "Docker Compose (plugin) installed ✓"
elif docker-compose version &> /dev/null; then
    echo "Docker Compose (standalone) installed ✓"
    # Create alias for compatibility
    echo 'alias docker compose="docker-compose"' >> ~/.bashrc
else
    echo "ERROR: Docker Compose installation failed!"
    exit 1
fi

# 4. Verify cgroup v2
echo "[4/7] Verifying cgroup v2..."
if ! cat /proc/filesystems | grep -q cgroup2; then
    echo "ERROR: cgroup v2 is required but not enabled!"
    echo "Please enable cgroup v2 and disable cgroup v1"
    exit 1
fi
echo "cgroup v2 is enabled ✓"

# 5. Configure system limits
echo "[5/7] Configuring system limits..."
cat >> /etc/sysctl.conf << EOF
# Piston optimizations
fs.file-max = 2097152
vm.max_map_count = 262144
net.core.somaxconn = 65535
EOF
sysctl -p

# Configure PAM limits
cat >> /etc/security/limits.conf << EOF
# Piston limits
* soft nofile 65536
* hard nofile 65536
* soft nproc 65536
* hard nproc 65536
EOF

# 6. Create Piston directory
echo "[6/7] Setting up Piston..."
PISTON_DIR="/opt/piston"
mkdir -p $PISTON_DIR
cd $PISTON_DIR

# Create data directory for packages
mkdir -p data/piston/packages

# Download the correct compose file
if [ "$VPS_TYPE" == "vps1" ]; then
    echo "Configuring for VPS1 (shared server - 8 concurrent jobs)..."
    cat > docker-compose.yaml << 'EOF'
version: '3.8'

services:
    piston_api:
        image: ghcr.io/engineer-man/piston
        container_name: piston_api
        restart: always
        privileged: true
        ports:
            - "8867:2000"
        volumes:
            - ./data/piston/packages:/piston/packages
        tmpfs:
            - /tmp:exec
        environment:
            - PISTON_COMPILE_TIMEOUT=30000
            - PISTON_RUN_TIMEOUT=6000
            - PISTON_COMPILE_CPU_TIME=30000
            - PISTON_RUN_CPU_TIME=6000
            - PISTON_COMPILE_MEMORY_LIMIT=536870912
            - PISTON_RUN_MEMORY_LIMIT=268435456
            - PISTON_MAX_CONCURRENT_JOBS=24
            - PISTON_MAX_PROCESS_COUNT=128
            - PISTON_MAX_OPEN_FILES=4096
            - PISTON_MAX_FILE_SIZE=20000000
            - PISTON_OUTPUT_MAX_SIZE=65536
            - PISTON_DISABLE_NETWORKING=true
            - PISTON_LOG_LEVEL=INFO
        deploy:
            resources:
                limits:
                    memory: 24G
                    cpus: '6'
EOF
else
    echo "Configuring for VPS2 (dedicated server - 16 concurrent jobs)..."
    cat > docker-compose.yaml << 'EOF'
version: '3.8'

services:
    piston_api:
        image: ghcr.io/engineer-man/piston
        container_name: piston_api
        restart: always
        privileged: true
        ports:
            - "8867:2000"
        volumes:
            - ./data/piston/packages:/piston/packages
        tmpfs:
            - /tmp:exec
        environment:
            - PISTON_COMPILE_TIMEOUT=30000
            - PISTON_RUN_TIMEOUT=6000
            - PISTON_COMPILE_CPU_TIME=30000
            - PISTON_RUN_CPU_TIME=6000
            - PISTON_COMPILE_MEMORY_LIMIT=536870912
            - PISTON_RUN_MEMORY_LIMIT=268435456
            - PISTON_MAX_CONCURRENT_JOBS=28
            - PISTON_MAX_PROCESS_COUNT=128
            - PISTON_MAX_OPEN_FILES=4096
            - PISTON_MAX_FILE_SIZE=20000000
            - PISTON_OUTPUT_MAX_SIZE=65536
            - PISTON_DISABLE_NETWORKING=true
            - PISTON_LOG_LEVEL=INFO
        deploy:
            resources:
                limits:
                    memory: 28G
                    cpus: '7'
EOF
fi

# 7. Start Piston
echo "[7/7] Starting Piston..."
docker compose pull
docker compose up -d

# Wait for startup
sleep 5

# Verify
echo ""
echo "============================================"
echo "Piston Setup Complete!"
echo "============================================"
echo ""
echo "Piston API is running at: http://$(hostname -I | awk '{print $1}'):8867"
echo ""
echo "To check status:"
echo "  curl http://localhost:8867/"
echo ""
echo "To install languages, run:"
echo "  docker compose exec piston_api bash"
echo "  # Then inside container:"
echo "  piston ppman install python"
echo "  piston ppman install javascript"
echo "  piston ppman install java"
echo ""
echo "Or from outside using CLI:"
echo "  git clone https://github.com/engineer-man/piston /tmp/piston-cli"
echo "  cd /tmp/piston-cli/cli && npm install"
echo "  node index.js -u http://localhost:8867 ppman install python"
echo ""
echo "View logs:"
echo "  docker compose logs -f"
echo ""
