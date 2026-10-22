#!/bin/sh
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY, name VARCHAR(50) NOT NULL,
  type VARCHAR(30), price INT NOT NULL);
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY, room_id INT REFERENCES rooms(id),
  guest_name VARCHAR(100) NOT NULL,
  check_in DATE NOT NULL, check_out DATE NOT NULL,
  created_at TIMESTAMP DEFAULT now());
INSERT INTO rooms(name,type,price) VALUES
 ('101','Standard',500000),('102','Standard',500000),
 ('201','Deluxe',800000),('301','Suite',1500000);
CREATE ROLE hotel_app LOGIN PASSWORD '$APP_DB_PASSWORD';
GRANT SELECT ON rooms TO hotel_app;
GRANT SELECT, INSERT ON bookings TO hotel_app;
GRANT USAGE, SELECT ON SEQUENCE bookings_id_seq TO hotel_app;
EOSQL
