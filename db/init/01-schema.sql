-- Schema hệ thống đặt phòng khách sạn.
-- Idempotent: chạy được trên database mới (docker-entrypoint-initdb.d)
-- và chạy lại trên database đã có để nâng cấp mà KHÔNG xóa dữ liệu
-- (xem scripts/db-migrate.sh).

-- btree_gist cho phép dùng toán tử "=" trên cột integer trong EXCLUDE USING gist
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- rooms
CREATE TABLE IF NOT EXISTS rooms (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(50) NOT NULL,
  type  VARCHAR(30),
  price INT NOT NULL
);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS capacity    INT          NOT NULL DEFAULT 2;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS beds        VARCHAR(50)  NOT NULL DEFAULT '1 giường đôi';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area_m2     INT          NOT NULL DEFAULT 20;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor       INT          NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS description TEXT         NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS amenities   TEXT[]       NOT NULL DEFAULT '{}';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status      VARCHAR(20)  NOT NULL DEFAULT 'active';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ  NOT NULL DEFAULT now();
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now();
UPDATE rooms SET type = 'Standard' WHERE type IS NULL;
ALTER TABLE rooms ALTER COLUMN type SET NOT NULL;

-- --------------------------------------------------------------- bookings
CREATE TABLE IF NOT EXISTS bookings (
  id         SERIAL PRIMARY KEY,
  room_id    INT REFERENCES rooms(id),
  guest_name VARCHAR(100) NOT NULL,
  check_in   DATE NOT NULL,
  check_out  DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_code VARCHAR(12)
  NOT NULL DEFAULT ('HB' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_email VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(20)  NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests      INT          NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_price BIGINT       NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status      VARCHAR(20)  NOT NULL DEFAULT 'pending';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS note        VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now();
ALTER TABLE bookings ALTER COLUMN room_id SET NOT NULL;

-- Phiên bản đầu dùng TIMESTAMP (không múi giờ) cho created_at, giá trị được ghi theo UTC.
-- Đổi sang TIMESTAMPTZ để hiển thị đúng giờ bất kể múi giờ của client.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'created_at') = 'timestamp without time zone' THEN
    ALTER TABLE bookings ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
  END IF;
END
$$;
ALTER TABLE bookings ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE bookings ALTER COLUMN created_at SET NOT NULL;

-- ----------------------------------------------------------- constraints
-- Thêm ràng buộc chỉ khi chưa tồn tại (ALTER TABLE ADD CONSTRAINT không có IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_name_key') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_name_key UNIQUE (name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_price_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_price_check CHECK (price > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_capacity_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_capacity_check CHECK (capacity BETWEEN 1 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_status_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_status_check
      CHECK (status IN ('active', 'maintenance', 'inactive'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_booking_code_key') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_booking_code_key UNIQUE (booking_code);
  END IF;
  -- Ngày trả phòng phải sau ngày nhận phòng
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_dates_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_dates_check CHECK (check_out > check_in);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_guests_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_guests_check CHECK (guests BETWEEN 1 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_status_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
      CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'));
  END IF;
  -- Chống đặt trùng ở tầng database: hai đặt phòng còn hiệu lực của cùng một
  -- phòng không được có khoảng [check_in, check_out) giao nhau. PostgreSQL
  -- kiểm tra ràng buộc này nguyên tử, nên vẫn đúng khi có nhiều request đồng thời.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
      WHERE (status IN ('pending', 'confirmed', 'checked_in'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS bookings_status_idx   ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_check_in_idx ON bookings (check_in);
