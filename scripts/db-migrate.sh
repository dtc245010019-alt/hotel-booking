#!/bin/sh
# Áp dụng lại schema, dữ liệu mẫu và role lên database ĐANG CHẠY.
# Các script đều idempotent và không xóa dữ liệu, dùng khi nâng cấp
# một volume pgdata đã tạo từ phiên bản cũ (init script chỉ tự chạy khi volume trống).
#
#   ./scripts/db-migrate.sh
set -eu
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker-compose}"

for f in db/init/01-schema.sql db/init/02-seed.sql; do
  echo ">> $f"
  $COMPOSE exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$f"
done
echo ">> db/init/03-roles.sh"
$COMPOSE exec -T db sh < db/init/03-roles.sh
echo "Migration hoàn tất."
