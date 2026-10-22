#!/usr/bin/env bash
# Kiểm thử chức năng đầu-cuối qua Nginx (HTTPS tự ký).
#   ./scripts/smoke-test.sh                # mặc định https://localhost:8443
#   BASE=http://localhost:8088 ./scripts/smoke-test.sh      # HTTP localhost
#   BASE=https://192.168.1.10:8443 ./scripts/smoke-test.sh
# Cần: curl, python3. Đọc ADMIN_USER/ADMIN_PASSWORD từ .env (không in ra).
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE:-https://localhost:8443}"
ADMIN_USER="$(grep -E '^ADMIN_USER=' .env | cut -d= -f2-)"
ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/cookies"
PASS=0; FAIL=0

c() { curl -sk -o "$TMP/body" -w '%{http_code}' "$@"; }
json() { python3 -c "import sys,json; d=json.load(open('$TMP/body')); print($1)"; }
check() { # check "mô tả" giá_trị_thực giá_trị_mong_đợi
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  \e[32mPASS\e[0m %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  \e[31mFAIL\e[0m %s (thực tế: %s, mong đợi: %s)\n' "$1" "$2" "$3"; fi
}
day() { date -d "+$1 day" +%F; }

# Dùng khoảng ngày ngẫu nhiên ở tương lai để chạy lại nhiều lần không bị trùng
OFF=$(( 60 + RANDOM % 280 ))
CI=$(day $OFF); CO=$(day $((OFF+2)))
echo "== Trang web & API công khai (ngày test: $CI -> $CO)"
check "GET / trả về 200" "$(c "$BASE/")" 200
check "GET /admin.html trả về 200" "$(c "$BASE/admin.html")" 200
check "GET /api/rooms trả về 200" "$(c "$BASE/api/rooms")" 200
check "Có ít nhất 10 phòng mẫu" "$(json "len(d['rooms'])>=10")" True
check "GET /api/room-types trả về 200" "$(c "$BASE/api/room-types")" 200
check "Tìm phòng theo ngày + 4 khách" "$(c "$BASE/api/rooms?check_in=$CI&check_out=$CO&guests=4")" 200
check "Kết quả chỉ gồm phòng >= 4 khách" "$(json "all(r['capacity']>=4 for r in d['rooms']) and d['nights']==2")" True
ROOM=$(json "d['rooms'][0]['id']")
check "Ngày trả trước ngày nhận -> 400" "$(c "$BASE/api/rooms?check_in=$CO&check_out=$CI")" 400
check "Ngày nhận ở quá khứ -> 400" "$(c "$BASE/api/rooms?check_in=2020-01-01&check_out=2020-01-02")" 400
check "Ngày sai định dạng -> 400" "$(c "$BASE/api/rooms?check_in=2026-02-30&check_out=2026-03-02")" 400
check "Chi tiết phòng -> 200" "$(c "$BASE/api/rooms/$ROOM")" 200
check "Phòng không tồn tại -> 404" "$(c "$BASE/api/rooms/999999")" 404
check "Danh sách đặt phòng không còn công khai" "$(c "$BASE/api/bookings")" 404
check "/metrics bị chặn ở Nginx" "$(c "$BASE/metrics")" 404

echo "== Đặt phòng"
EMAIL="test$RANDOM@example.com"
body() { printf '{"room_id":%s,"guest_name":"Khach Test","guest_email":"%s","guest_phone":"0901234567","guests":%s,"check_in":"%s","check_out":"%s"}' "$1" "$EMAIL" "$2" "$3" "$4"; }
H=(-H 'Content-Type: application/json')
check "Tạo đặt phòng hợp lệ -> 201" "$(c "${H[@]}" -d "$(body "$ROOM" 2 "$CI" "$CO")" "$BASE/api/bookings")" 201
CODE=$(json "d['booking_code']")
check "Trạng thái ban đầu là pending" "$(json "d['status']")" pending
check "Đặt trùng khoảng thời gian -> 409" "$(c "${H[@]}" -d "$(body "$ROOM" 1 "$(day $((OFF+1)))" "$(day $((OFF+3)))")" "$BASE/api/bookings")" 409
check "Nhận phòng đúng ngày khách trước trả -> 201" "$(c "${H[@]}" -d "$(body "$ROOM" 1 "$CO" "$(day $((OFF+3)))")" "$BASE/api/bookings")" 201
CODE2=$(json "d['booking_code']")
check "Ngày trả = ngày nhận -> 400" "$(c "${H[@]}" -d "$(body "$ROOM" 1 "$CI" "$CI")" "$BASE/api/bookings")" 400
check "Vượt sức chứa phòng -> 400" "$(c "${H[@]}" -d "$(body "$ROOM" 10 "$(day $((OFF+5)))" "$(day $((OFF+6)))")" "$BASE/api/bookings")" 400
check "Thiếu email -> 400" "$(c "${H[@]}" -d '{"room_id":1,"guest_name":"A B","guests":1}' "$BASE/api/bookings")" 400
check "JSON hỏng -> 400" "$(c "${H[@]}" -d '{bad' "$BASE/api/bookings")" 400
check "POST từ origin khác -> 403" "$(c "${H[@]}" -H 'Origin: https://evil.example' -d "$(body "$ROOM" 1 "$CI" "$CO")" "$BASE/api/bookings")" 403

echo "== Đặt phòng đồng thời (20 request cùng phòng, cùng ngày)"
CI3=$(day $((OFF+10))); CO3=$(day $((OFF+12)))
for i in $(seq 1 20); do
  curl -sk -o "$TMP/conc.$i" -w '%{http_code}\n' "${H[@]}" -d "$(body "$ROOM" 1 "$CI3" "$CO3")" "$BASE/api/bookings" &
done > "$TMP/conc"; wait
CODE3=$(cat "$TMP"/conc.* | python3 -c "import sys,re; m=re.search(r'\"booking_code\":\"(\w+)\"', sys.stdin.read()); print(m.group(1) if m else '')")
check "Chỉ đúng 1 request thành công (201)" "$(grep -c '^201$' "$TMP/conc")" 1
check "19 request còn lại bị từ chối (409)" "$(grep -c '^409$' "$TMP/conc")" 19

echo "== Tra cứu & hủy"
check "Tra cứu đúng mã + email -> 200" "$(c "$BASE/api/bookings/lookup?code=$CODE&email=$EMAIL")" 200
check "Tra cứu sai email -> 404" "$(c "$BASE/api/bookings/lookup?code=$CODE&email=other@example.com")" 404
check "Khách tự hủy -> 200" "$(c "${H[@]}" -d "{\"email\":\"$EMAIL\"}" "$BASE/api/bookings/$CODE/cancel")" 200
check "Hủy lần 2 -> 409" "$(c "${H[@]}" -d "{\"email\":\"$EMAIL\"}" "$BASE/api/bookings/$CODE/cancel")" 409
check "Đặt lại khoảng vừa hủy -> 201" "$(c "${H[@]}" -d "$(body "$ROOM" 1 "$CI" "$CO")" "$BASE/api/bookings")" 201
ID3=$(json "d['id']")

echo "== Quản trị"
check "API admin khi chưa đăng nhập -> 401" "$(c "$BASE/api/admin/bookings")" 401
check "Đăng nhập sai mật khẩu -> 401" "$(c "${H[@]}" -d '{"username":"admin","password":"wrong-password"}' "$BASE/api/admin/login")" 401
LOGIN=$(python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$ADMIN_USER" "$ADMIN_PASSWORD")
check "Đăng nhập đúng -> 200" "$(c -c "$JAR" "${H[@]}" -d "$LOGIN" "$BASE/api/admin/login")" 200
if [[ "$BASE" == https://* ]]; then
  check "Cookie phiên có HttpOnly + Secure" "$(grep -c '#HttpOnly_.*TRUE.*hb_admin' "$JAR")" 1
else  # HTTP localhost: Nginx bỏ cờ Secure để cookie dùng được qua HTTP
  check "Cookie phiên có HttpOnly" "$(grep -c '#HttpOnly_.*hb_admin' "$JAR")" 1
fi
check "Thống kê -> 200" "$(c -b "$JAR" "$BASE/api/admin/stats")" 200
check "Danh sách đặt phòng -> 200" "$(c -b "$JAR" "$BASE/api/admin/bookings?status=pending")" 200
check "Xác nhận đặt phòng -> 200" "$(c -b "$JAR" -X PATCH "${H[@]}" -d '{"status":"confirmed"}' "$BASE/api/admin/bookings/$ID3")" 200
check "Chuyển trạng thái sai (confirmed -> checked_out) -> 409" "$(c -b "$JAR" -X PATCH "${H[@]}" -d '{"status":"checked_out"}' "$BASE/api/admin/bookings/$ID3")" 409
check "Hủy bởi admin -> 200" "$(c -b "$JAR" -X PATCH "${H[@]}" -d '{"status":"cancelled"}' "$BASE/api/admin/bookings/$ID3")" 200
RNAME="T$RANDOM"
check "Thêm phòng -> 201" "$(c -b "$JAR" "${H[@]}" -d "{\"name\":\"$RNAME\",\"type\":\"Standard\",\"price\":400000,\"capacity\":2,\"beds\":\"1 giường đôi\",\"area_m2\":18,\"floor\":1,\"description\":\"test\",\"amenities\":[\"Wi-Fi\"]}" "$BASE/api/admin/rooms")" 201
RID=$(json "d['id']")
check "Thêm trùng số phòng -> 409" "$(c -b "$JAR" "${H[@]}" -d "{\"name\":\"$RNAME\",\"type\":\"Standard\",\"price\":400000,\"capacity\":2,\"beds\":\"x\",\"area_m2\":18,\"floor\":1}" "$BASE/api/admin/rooms")" 409
check "Sửa phòng (bảo trì) -> 200" "$(c -b "$JAR" -X PUT "${H[@]}" -d "{\"name\":\"$RNAME\",\"type\":\"Deluxe\",\"price\":450000,\"capacity\":2,\"beds\":\"x\",\"area_m2\":18,\"floor\":1,\"status\":\"maintenance\"}" "$BASE/api/admin/rooms/$RID")" 200
check "Không đặt được phòng đang bảo trì -> 409" "$(c "${H[@]}" -d "$(body "$RID" 1 "$CI" "$CO")" "$BASE/api/bookings")" 409
check "Xóa phòng chưa có đặt -> 200" "$(c -b "$JAR" -X DELETE "$BASE/api/admin/rooms/$RID")" 200
check "Xóa phòng đã có lịch sử -> 409" "$(c -b "$JAR" -X DELETE "$BASE/api/admin/rooms/$ROOM")" 409
check "Đăng xuất -> 200" "$(c -b "$JAR" -c "$JAR" -X POST "$BASE/api/admin/logout")" 200

# Dọn dẹp: hủy các đặt phòng test còn hiệu lực để không chiếm lịch
for code in "$CODE2" "$CODE3"; do
  [ -n "$code" ] && c "${H[@]}" -d "{\"email\":\"$EMAIL\"}" "$BASE/api/bookings/$code/cancel" >/dev/null
done

echo
echo "Kết quả: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
