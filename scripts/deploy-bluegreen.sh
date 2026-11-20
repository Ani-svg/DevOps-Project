#!/bin/bash

set -Eeuo pipefail

# -----------------------------------------
# Granthalaya Production Blue-Green Deployment
# -----------------------------------------

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_DIR="${APP_DIR:?Production application directory is required}"
RUNTIME_FRONTEND_DIR="${RUNTIME_FRONTEND_DIR:?Runtime frontend directory is required}"

COMPOSE_FILE="$PROJECT_DIR/docker-compose.bluegreen.yml"
ENV_FILE="${ENV_FILE_PATH:-/home/aniket/DevOps-Project/.env}"
ACTIVE_CONFIG="${ACTIVE_CONFIG_PATH:-/home/aniket/DevOps-Project/nginx/active-backend.conf}"

NGINX_CONTAINER="granthalaya-nginx-bluegreen"
DOCKER_NETWORK="devops-project_default"
COMPOSE_PROJECT="devops-project"

SWITCH_ATTEMPTED=false
FRONTEND_UPDATE_ATTEMPTED=false

BACKUP_FILE=""
FRONTEND_BACKUP=""

# -----------------------------------------
# Validate deployment inputs
# -----------------------------------------

if [[ ! -f "$APP_DIR/backend/Dockerfile" ]]; then
    echo "ERROR: Production backend Dockerfile not found."
    exit 1
fi

if [[ ! -f "$APP_DIR/backend/tests/api.test.js" ]]; then
    echo "ERROR: Production API tests not found."
    exit 1
fi

if [[ ! -f "$APP_DIR/frontend/index.html" ]]; then
    echo "ERROR: Production frontend not found."
    exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "ERROR: Blue-Green Compose file not found."
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: Runtime environment file not found."
    exit 1
fi

if [[ ! -f "$ACTIVE_CONFIG" ]]; then
    echo "ERROR: Active Nginx configuration not found."
    exit 1
fi

if [[ ! -d "$RUNTIME_FRONTEND_DIR" ]]; then
    echo "ERROR: Runtime frontend directory not found."
    exit 1
fi

# -----------------------------------------
# Docker Compose configuration
# -----------------------------------------

COMPOSE_ARGS=(
    -p "$COMPOSE_PROJECT"
    --project-directory "$PROJECT_DIR"
    --env-file "$ENV_FILE"
    -f "$COMPOSE_FILE"
)

export APP_DIR
export RUNTIME_FRONTEND_DIR

# -----------------------------------------
# Rollback function
# -----------------------------------------

rollback() {

    EXIT_CODE=$?

    trap - ERR
    set +e

    echo ""
    echo "======================================"
    echo "DEPLOYMENT FAILED"
    echo "======================================"

    # Restore previous frontend

    if [[ "$FRONTEND_UPDATE_ATTEMPTED" == true ]]; then

        echo "Restoring previous frontend..."

        find "$RUNTIME_FRONTEND_DIR" \
            -mindepth 1 -maxdepth 1 \
            -exec rm -rf -- {} +

        cp -a "$FRONTEND_BACKUP/." "$RUNTIME_FRONTEND_DIR/"

        echo "Previous frontend restored."

    fi

    # Restore previous Nginx backend

    if [[ "$SWITCH_ATTEMPTED" == true ]]; then

        echo "Restoring previous Nginx configuration..."

        cp "$BACKUP_FILE" "$ACTIVE_CONFIG"

        if docker exec "$NGINX_CONTAINER" nginx -t &&
           docker exec "$NGINX_CONTAINER" nginx -s reload; then

            echo "Rollback successful."
            echo "Previous backend is active."

        else

            echo "CRITICAL: Automatic Nginx rollback failed."
            echo "Manual intervention is required."

        fi

    fi

    [[ -n "$BACKUP_FILE" ]] && rm -f "$BACKUP_FILE"
    [[ -n "$FRONTEND_BACKUP" ]] && rm -rf "$FRONTEND_BACKUP"

    exit "$EXIT_CODE"
}

trap rollback ERR

# -----------------------------------------
# Step 1: Identify active backend
# -----------------------------------------

echo ""
echo "======================================"
echo "GRANTHALAYA BLUE-GREEN DEPLOYMENT"
echo "======================================"

echo "Production source: $APP_DIR"
echo "Infrastructure: $PROJECT_DIR"

echo ""
echo "Identifying active backend..."

if grep -q "granthalaya-backend-blue:3000" "$ACTIVE_CONFIG"; then

    ACTIVE="blue"
    TARGET="green"

elif grep -q "granthalaya-backend-green:3000" "$ACTIVE_CONFIG"; then

    ACTIVE="green"
    TARGET="blue"

else

    echo "Unable to identify active backend."
    exit 1

fi

echo "Currently active: $ACTIVE"
echo "New deployment target: $TARGET"

# -----------------------------------------
# Step 2: Back up existing configuration
# -----------------------------------------

BACKUP_FILE="$(mktemp)"

cp "$ACTIVE_CONFIG" "$BACKUP_FILE"

FRONTEND_BACKUP="$(mktemp -d)"

cp -a "$RUNTIME_FRONTEND_DIR/." "$FRONTEND_BACKUP/"

# -----------------------------------------
# Step 3: Build inactive backend
# -----------------------------------------

echo ""
echo "Building production backend: $TARGET"

docker compose "${COMPOSE_ARGS[@]}" \
    build "backend-$TARGET"

docker compose "${COMPOSE_ARGS[@]}" \
    up -d --no-deps --wait --wait-timeout 120 "backend-$TARGET"

echo "$TARGET backend is healthy."

# -----------------------------------------
# Step 4: Run automated API tests
# -----------------------------------------

echo ""
echo "Running four automated API tests..."

docker run --rm \
    --network "$DOCKER_NETWORK" \
    -v "$APP_DIR/backend/tests:/tests:ro" \
    -w /tests \
    -e "API_BASE_URL=http://granthalaya-backend-$TARGET:3000" \
    node:20-alpine node --test

echo ""
echo "All four automated API tests passed."

# -----------------------------------------
# Step 5: Update production frontend
# -----------------------------------------

echo ""
echo "Updating production frontend..."

FRONTEND_UPDATE_ATTEMPTED=true

find "$RUNTIME_FRONTEND_DIR" \
    -mindepth 1 -maxdepth 1 \
    -exec rm -rf -- {} +

cp -a "$APP_DIR/frontend/." "$RUNTIME_FRONTEND_DIR/"

echo "Production frontend updated."

# -----------------------------------------
# Step 6: Switch Nginx traffic
# -----------------------------------------

echo ""
echo "Switching Nginx traffic to $TARGET..."

SWITCH_ATTEMPTED=true

cat > "$ACTIVE_CONFIG" <<CONFIG
upstream active_backend {
    server granthalaya-backend-$TARGET:3000;
}
CONFIG

docker exec "$NGINX_CONTAINER" nginx -t

docker exec "$NGINX_CONTAINER" nginx -s reload

echo "Nginx traffic switched."

# -----------------------------------------
# Step 7: Verify deployment
# -----------------------------------------

echo ""
echo "Verifying production application..."

curl --fail --silent --show-error \
    --retry 10 \
    --retry-connrefused \
    --retry-delay 2 \
    http://localhost:8082/api/public/stats
echo ""
echo "Verifying production frontend..."

curl --fail --silent --show-error \
    --retry 10 \
    --retry-connrefused \
    --retry-delay 2 \
    http://localhost:8082/

echo ""
echo "Production frontend verification passed."
echo ""
echo "Production deployment successful!"

echo "Previous backend: $ACTIVE"
echo "Currently active backend: $TARGET"

# -----------------------------------------
# Cleanup
# -----------------------------------------

rm -f "$BACKUP_FILE"
rm -rf "$FRONTEND_BACKUP"

trap - ERR

echo ""
echo "======================================"
echo "BLUE-GREEN DEPLOYMENT COMPLETED"
echo "======================================"
