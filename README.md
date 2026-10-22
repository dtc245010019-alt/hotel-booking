# Hotel Booking - Đề 6

Hệ thống đặt phòng khách sạn: Node.js + PostgreSQL + pgAdmin + Nginx reverse proxy (HTTPS tự ký).

## Chạy hệ thống
1. `cp .env.example .env` rồi điền mật khẩu
2. Tạo chứng chỉ tự ký (lệnh bên dưới)
3. `docker-compose up -d --build`

## Truy cập
- Website: https://localhost:8443
- API: https://localhost:8443/api/rooms
- pgAdmin: http://localhost:5050

## Tạo chứng chỉ
mkdir -p nginx/certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout nginx/certs/server.key -out nginx/certs/server.crt -subj "/CN=localhost"
chmod 644 nginx/certs/server.key
