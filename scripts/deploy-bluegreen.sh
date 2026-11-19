#!/bin/bash

set -Eeuo pipefail

# -----------------------------------------
# Granthalaya Blue-Green Deployment Script
# -----------------------------------------

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_DIR"

COMPOSE_FILE="docker-compose.bluegreen.yml"
ACTIVE_CONFIG="nginx/active-backend.conf"

NGINX_CONTAINER="granthalaya-nginx-bluegreen"

SWITCH_ATTEMPTED=false
BACKUP_FILE=""

# -----------------------------------------
# Rollback function
# -----------------------------------------

rollback() {

    EXIT_CODE=$?

    trap - ERR

    echo ""
    echo "Deployment failed!"

    if [[ "$SWITCH_ATTEMPTED" == true ]]; then

        echo "Restoring previous Nginx configuration..."

        cp "$BACKUP_FILE" "$ACTIVE_CONFIG"

        if docker exec "$NGINX_CONTAINER" nginx -t &&
           docker exec "$NGINX_CONTAINER" nginx -s reload; then

            echo "Rollback successful."
            echo "Previous backend is active."

        else

            echo "CRITICAL: Automatic rollback failed."
            echo "Manual intervention is required."

        fi

    fi

    if [[ -n "$BACKUP_FILE" ]]; then
        rm -f "$BACKUP_FILE"
    fi

    exit "$EXIT_CODE"
}

trap rollback ERR

# -----------------------------------------
# Step 1: Identify active backend
# -----------------------------------------

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
# Step 2: Backup current configuration
# -----------------------------------------

BACKUP_FILE="$(mktemp)"

cp "$ACTIVE_CONFIG" "$BACKUP_FILE"

# -----------------------------------------
# Step 3: Build inactive backend
# -----------------------------------------

echo ""
echo "Building $TARGET backend..."

docker compose -f "$COMPOSE_FILE" \
    up -d --build --wait --wait-timeout 120 "backend-$TARGET"

echo "$TARGET backend started."

# -----------------------------------------
# Step 4: Run automated API tests
# -----------------------------------------

echo ""
echo "Running automated API tests..."

docker run --rm \
    --network devops-project_default \
    -v "$PROJECT_DIR/backend:/tests:ro" \
    -w /tests \
    -e "API_BASE_URL=http://granthalaya-backend-$TARGET:3000" \
    node:20-alpine node --test

echo "All automated tests passed."

# -----------------------------------------
# Step 5: Switch Nginx traffic
# -----------------------------------------

echo ""
echo "Switching traffic to $TARGET..."

SWITCH_ATTEMPTED=true

cat > "$ACTIVE_CONFIG" <<EOF
upstream active_backend {
    server granthalaya-backend-$TARGET:3000;
}
EOF

# Validate Nginx configuration

docker exec "$NGINX_CONTAINER" nginx -t

# Reload Nginx

docker exec "$NGINX_CONTAINER" nginx -s reload

echo "Nginx traffic switched."

# -----------------------------------------
# Step 6: Verify deployment
# -----------------------------------------

echo ""
echo "Verifying application..."

curl --fail --silent --show-error \
    --retry 10 \
    --retry-connrefused \
    --retry-delay 2 \
    http://localhost:8082/api/public/stats

echo ""
echo "Deployment successful!"

echo "Previous backend: $ACTIVE"
echo "Currently active backend: $TARGET"

# -----------------------------------------
# Cleanup
# -----------------------------------------

rm -f "$BACKUP_FILE"

trap - ERR

echo ""
echo "Blue-Green deployment completed successfully."
