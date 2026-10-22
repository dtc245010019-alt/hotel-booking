-- Dữ liệu mẫu để demo. Idempotent: phòng được upsert theo số phòng,
-- đặt phòng mẫu chỉ được thêm khi bảng bookings còn trống.

INSERT INTO rooms (name, type, price, capacity, beds, area_m2, floor, description, amenities) VALUES
 ('101', 'Standard', 500000, 2, '1 giường đôi', 20, 1,
  'Phòng tiêu chuẩn yên tĩnh, phù hợp cho cặp đôi hoặc khách công tác.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','TV','Nước suối miễn phí']),
 ('102', 'Standard', 500000, 2, '2 giường đơn', 20, 1,
  'Phòng tiêu chuẩn hai giường đơn, gần sảnh và nhà hàng.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','TV']),
 ('103', 'Standard', 550000, 3, '1 giường đôi + 1 giường đơn', 24, 1,
  'Phòng tiêu chuẩn rộng hơn, phù hợp gia đình nhỏ.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','TV','Tủ lạnh mini']),
 ('201', 'Deluxe', 800000, 2, '1 giường King', 28, 2,
  'Phòng Deluxe có ban công nhìn ra thành phố.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','Smart TV','Ban công','Bồn tắm']),
 ('202', 'Deluxe', 850000, 3, '1 giường King + sofa bed', 30, 2,
  'Phòng Deluxe góc với cửa sổ lớn, nhiều ánh sáng tự nhiên.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','Smart TV','Minibar','Bồn tắm']),
 ('203', 'Deluxe', 800000, 2, '2 giường đơn lớn', 28, 2,
  'Phòng Deluxe hai giường, phù hợp bạn bè đi cùng.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','Smart TV','Minibar']),
 ('301', 'Suite', 1500000, 4, '1 giường King + 2 giường đơn', 45, 3,
  'Suite có phòng khách riêng, view toàn cảnh thành phố.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','Smart TV','Phòng khách riêng','Bồn tắm','Bữa sáng']),
 ('302', 'Family', 1200000, 5, '2 giường đôi + 1 giường đơn', 40, 3,
  'Phòng gia đình rộng rãi cho tối đa 5 khách.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','Smart TV','Tủ lạnh','Khu vui chơi trẻ em']),
 ('303', 'Family', 1100000, 4, '2 giường đôi', 36, 3,
  'Phòng gia đình hai giường đôi, có bếp nhỏ.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','TV','Bếp nhỏ']),
 ('401', 'Suite', 2500000, 4, '1 giường King + sofa bed', 60, 4,
  'Presidential Suite tầng cao nhất, có quầy bar và bồn tắm jacuzzi.',
  ARRAY['Wi-Fi miễn phí','Điều hòa','Smart TV','Jacuzzi','Quầy bar','Bữa sáng','Đưa đón sân bay'])
ON CONFLICT (name) DO UPDATE SET
  type = EXCLUDED.type, price = EXCLUDED.price, capacity = EXCLUDED.capacity,
  beds = EXCLUDED.beds, area_m2 = EXCLUDED.area_m2, floor = EXCLUDED.floor,
  description = EXCLUDED.description, amenities = EXCLUDED.amenities, updated_at = now()
-- chỉ cập nhật bản ghi mẫu còn ở dạng cũ, không ghi đè phòng admin đã chỉnh
WHERE rooms.description = '';

-- Đặt phòng mẫu, ngày tính tương đối theo ngày hiện tại để demo luôn có dữ liệu ý nghĩa
INSERT INTO bookings (booking_code, room_id, guest_name, guest_email, guest_phone,
                      guests, check_in, check_out, total_price, status, note)
SELECT v.code, r.id, v.guest, v.email, v.phone, v.guests,
       CURRENT_DATE + v.d_in, CURRENT_DATE + v.d_out,
       r.price * (v.d_out - v.d_in), v.status, v.note
FROM (VALUES
  ('HBDEMO01', '101', 'Nguyễn Văn An',  'an.nguyen@example.com',  '0901000001', 2, -3, -1, 'checked_out', ''),
  ('HBDEMO02', '201', 'Trần Thị Bình',  'binh.tran@example.com',  '0901000002', 2, -1,  2, 'checked_in',  'Cần thêm gối'),
  ('HBDEMO03', '301', 'Lê Hoàng Cường', 'cuong.le@example.com',   '0901000003', 4,  2,  5, 'confirmed',   'Đến muộn sau 22h'),
  ('HBDEMO04', '102', 'Phạm Thu Dung',  'dung.pham@example.com',  '0901000004', 1,  5,  7, 'pending',     ''),
  ('HBDEMO05', '302', 'Hoàng Minh Đức', 'duc.hoang@example.com',  '0901000005', 5,  7, 10, 'confirmed',   'Có trẻ nhỏ'),
  ('HBDEMO06', '202', 'Vũ Ngọc Hà',     'ha.vu@example.com',      '0901000006', 2,  3,  4, 'cancelled',   'Khách đổi lịch')
) AS v(code, room, guest, email, phone, guests, d_in, d_out, status, note)
JOIN rooms r ON r.name = v.room
WHERE NOT EXISTS (SELECT 1 FROM bookings);
