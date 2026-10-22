#!/bin/sh
# Tạo/cập nhật các role ít quyền:
#   hotel_app     - ứng dụng web (không phải superuser, không có quyền DDL)
#   hotel_monitor - postgres-exporter (chỉ quyền đọc thống kê pg_monitor)
# Mật khẩu được truyền qua biến psql (:'x') và format(%L) để escape an toàn.
set -eu

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v mon_pw="$MONITOR_DB_PASSWORD" -v db="$POSTGRES_DB" <<'EOSQL'
SELECT format('CREATE ROLE hotel_app LOGIN PASSWORD %L', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_app') \gexec
SELECT format('ALTER ROLE hotel_app LOGIN PASSWORD %L', :'app_pw') \gexec

SELECT format('CREATE ROLE hotel_monitor LOGIN PASSWORD %L', :'mon_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_monitor') \gexec
SELECT format('ALTER ROLE hotel_monitor LOGIN PASSWORD %L', :'mon_pw') \gexec
GRANT pg_monitor TO hotel_monitor;

SELECT format('GRANT CONNECT ON DATABASE %I TO hotel_app, hotel_monitor', :'db') \gexec
-- CURRENT_DATE/now() trong mọi phiên tính theo giờ Việt Nam, khớp với "hôm nay" của ứng dụng
SELECT format('ALTER DATABASE %I SET timezone TO %L', :'db', 'Asia/Ho_Chi_Minh') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hotel_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON rooms TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON bookings TO hotel_app;
GRANT USAGE, SELECT ON SEQUENCE rooms_id_seq, bookings_id_seq TO hotel_app;
EOSQL
