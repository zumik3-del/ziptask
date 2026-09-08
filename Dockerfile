# ---- build stage ----
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx --bun tsc --noEmit && bunx biome check src/ scripts/

# ---- runtime stage ----
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV ZIPTASK_DB=/var/lib/ziptask/ziptask.db \
    ZIPTASK_PORT=3000 \
    ZIPTASK_HOST=0.0.0.0 \
    ZIPTASK_LEASE_TTL_MIN=15 \
    ZIPTASK_BACKUP_DIR=/backups \
    ZIPTASK_BACKUP_PREFIX=ziptask \
    ZIPTASK_BACKUP_RETAIN=7 \
    CRON_SCHEDULE="0 2 * * *"

RUN apk add --no-cache tar coreutils sqlite cronie && \
    mkdir -p /app/scripts /var/lib/ziptask /backups && \
    chmod 1777 /backups && \
    ln -sf /usr/sbin/crond /etc/init.d/crond

COPY --from=builder /app/package.json /app/bun.lock /app/tsconfig.json ./
COPY --from=builder /app/src/ ./src/
COPY --from=builder /app/scripts/ ./scripts/
COPY --from=builder /app/templates/ ./templates/
RUN bun install --frozen-lockfile --production

EXPOSE 3000

ENTRYPOINT ["/bin/sh", "-c", "echo \"${CRON_SCHEDULE} bun run /app/scripts/backup.ts >> /var/log/ziptask-backup.log 2>&1\" > /etc/crontabs/root && crond -b -l 8 && bun run src/index.ts"]
CMD []
