#!/usr/bin/env bash
# Chuẩn bị môi trường trước khi chạy docker-compose lần đầu (an toàn khi chạy lại):
#   1. Tạo .env từ .env.example, thay "change_me..." bằng mật khẩu ngẫu nhiên.
#      Nếu .env đã có: giữ nguyên giá trị cũ, chỉ bổ sung khóa còn thiếu.
#   2. Tạo chứng chỉ HTTPS tự ký (có SAN localhost + IP của máy) nếu chưa có.
#      Tạo lại: FORCE_CERT=1 ./scripts/setup.sh
#   3. Sinh nginx/htpasswd cho Prometheus UI từ PROMETHEUS_USER/PASSWORD.
# Script không in mật khẩu ra màn hình.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null || { echo "Thiếu lệnh: $1"; exit 1; }; }
need openssl

rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }

# ---------------------------------------------------------------- 1. .env
touch .env
chmod 600 .env
added=0
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
  grep -q "^${key}=" .env && continue
  case "$key" in
    SESSION_SECRET) val="$(openssl rand -hex 32)" ;;
    *) [[ "$val" == change_me* ]] && val="$(rand 24)" ;;
  esac
  echo "${key}=${val}" >> .env
  echo "  + .env: thêm ${key}"
  added=$((added + 1))
done < .env.example
if grep -q '=change_me' .env; then
  echo "CẢNH BÁO: .env còn giá trị 'change_me', hãy thay bằng mật khẩu mạnh."
fi
echo "[1/3] .env sẵn sàng (thêm ${added} khóa). Xem tài khoản: grep -E 'USER|EMAIL|PASSWORD' .env"

# ------------------------------------------------------- 2. htpasswd Prometheus
pu="$(grep -E '^PROMETHEUS_USER=' .env | cut -d= -f2-)"
pp="$(grep -E '^PROMETHEUS_PASSWORD=' .env | cut -d= -f2-)"
printf '%s:%s\n' "$pu" "$(printf '%s' "$pp" | openssl passwd -apr1 -stdin)" > nginx/htpasswd
chmod 644 nginx/htpasswd
echo "[2/3] Đã sinh nginx/htpasswd cho user Prometheus '${pu}'"

# ------------------------------------------------------------ 3. Chứng chỉ
# SAN gồm: localhost, 127.0.0.1, hostname, IPv4 của các card mạng thật (bỏ qua
# docker0/br-*/veth* của Docker), PUBLIC_HOST và EXTRA_SAN (vd "DNS:hotel.lab,IP:10.0.0.5").
# Chứng chỉ mới được tạo trong thư mục tạm, kiểm tra xong mới thay thế; cặp cũ được
# sao lưu vào nginx/certs/backup-<thời gian>/ (thư mục nginx/certs/ đã được Git ignore).
build_san() {
  local san="DNS:localhost,IP:127.0.0.1" ip host
  add() { [[ ",${san}," == *",$1,"* ]] || san="${san},$1"; }
  host="$(hostname 2>/dev/null || true)"
  [[ -n "$host" && "$host" != localhost ]] && add "DNS:${host}"
  for ip in $(ip -4 -o addr show 2>/dev/null \
               | awk '$2 != "lo" && $2 !~ /^(docker|br-|veth|virbr)/ {sub(/\/.*/, "", $4); print $4}'); do
    add "IP:${ip}"
  done
  host="$(grep -E '^PUBLIC_HOST=' .env | cut -d= -f2-)"
  if [[ -n "$host" ]]; then
    if [[ "$host" =~ ^[0-9.]+$ ]]; then add "IP:${host}"; else add "DNS:${host}"; fi
  fi
  if [[ -n "${EXTRA_SAN:-}" ]]; then
    IFS=',' read -ra extra <<< "$EXTRA_SAN"
    for e in "${extra[@]}"; do add "$e"; done
  fi
  echo "$san"
}

CERTS=nginx/certs
mkdir -p "$CERTS"
if [[ ! -f $CERTS/server.crt || ! -f $CERTS/server.key || "${FORCE_CERT:-0}" == 1 ]]; then
  san="$(build_san)"
  stage="$(mktemp -d "$CERTS/.staging.XXXXXX")"
  chmod 755 "$stage"   # Nginx (uid 101) trong container kiểm tra cần đọc được
  trap 'rm -rf "$stage"' EXIT
  if ! openssl req -x509 -nodes -newkey rsa:2048 -days 365 -sha256 \
      -keyout "$stage/server.key" -out "$stage/server.crt" \
      -subj "/C=VN/O=Hotel Booking Demo/CN=localhost" \
      -addext "subjectAltName=${san}" 2>"$stage/openssl.log"; then
    cat "$stage/openssl.log"; echo "LỖI: không tạo được chứng chỉ, giữ nguyên chứng chỉ cũ."; exit 1
  fi
  # Kiểm tra: cert đọc được, khóa khớp cert, có SAN
  openssl x509 -in "$stage/server.crt" -noout -ext subjectAltName >/dev/null
  [[ "$(openssl x509 -in "$stage/server.crt" -noout -pubkey)" == "$(openssl pkey -in "$stage/server.key" -pubout)" ]] \
    || { echo "LỖI: khóa không khớp chứng chỉ, giữ nguyên chứng chỉ cũ."; exit 1; }
  # Nginx chạy bằng uid 101 trong container nên cần quyền đọc file key được mount vào
  chmod 644 "$stage/server.key" "$stage/server.crt"
  # Kiểm tra cú pháp Nginx với chứng chỉ mới (nếu có Docker và image nginx)
  image="$(grep -oE 'nginxinc/nginx-unprivileged:[^ ]+' docker-compose.yml | head -1)"
  if command -v docker >/dev/null && docker image inspect "$image" >/dev/null 2>&1; then
    if ! docker run --rm --network none \
        -v "$PWD/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" \
        -v "$PWD/nginx/snippets:/etc/nginx/snippets:ro" \
        -v "$PWD/nginx/htpasswd:/etc/nginx/htpasswd:ro" \
        -v "$PWD/$stage:/etc/nginx/certs:ro" \
        "$image" nginx -t >"$stage/nginx-t.log" 2>&1; then
      tail -5 "$stage/nginx-t.log"; echo "LỖI: nginx -t thất bại với chứng chỉ mới, giữ nguyên chứng chỉ cũ."; exit 1
    fi
    echo "      nginx -t với chứng chỉ mới: OK"
  fi
  if [[ -f $CERTS/server.crt || -f $CERTS/server.key ]]; then
    backup="$CERTS/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
    cp -p $CERTS/server.crt $CERTS/server.key "$backup"/ 2>/dev/null || true
    chmod 700 "$backup"; chmod 600 "$backup"/server.key 2>/dev/null || true
    echo "      Đã sao lưu chứng chỉ cũ vào $backup/"
  fi
  mv -f "$stage/server.key" $CERTS/server.key
  mv -f "$stage/server.crt" $CERTS/server.crt
  echo "[3/3] Đã tạo chứng chỉ tự ký, SAN: ${san}"
  echo "      Áp dụng: docker-compose restart nginx"
else
  echo "[3/3] Đã có chứng chỉ $CERTS/server.crt (tạo lại: FORCE_CERT=1 $0)"
fi
echo "Xong. Chạy: docker-compose up -d --build"
