#!/usr/bin/env python3
"""Sinh các dashboard Grafana (JSON) cho Hotel Booking.

    python3 scripts/gen-dashboards.py

Kết quả ghi vào grafana/dashboards/*.json và được Grafana provisioning tự nạp.
Sửa dashboard bằng cách sửa file này rồi chạy lại (dashboard provisioned không lưu được từ UI).
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "grafana" / "dashboards"
PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}


class Board:
    def __init__(self):
        self.panels, self.y, self.x, self.row_h, self.next_id = [], 0, 0, 0, 1

    def _place(self, w, h):
        if self.x + w > 24:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        pos = {"x": self.x, "y": self.y, "w": w, "h": h}
        self.x += w
        self.row_h = max(self.row_h, h)
        return pos

    def row(self, title):
        if self.x:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        self.panels.append({"id": self.next_id, "type": "row", "title": title, "collapsed": False,
                            "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1}, "panels": []})
        self.next_id += 1
        self.y += 1

    def add(self, ptype, title, targets, w=8, h=8, ds=PROM, unit=None, desc="", options=None,
            field=None, overrides=None):
        defaults = {"unit": unit} if unit else {}
        defaults.update(field or {})
        p = {
            "id": self.next_id, "type": ptype, "title": title, "description": desc,
            "datasource": ds, "gridPos": self._place(w, h),
            "targets": [dict(t, refId=chr(65 + i), datasource=ds) for i, t in enumerate(targets)],
            "fieldConfig": {"defaults": defaults, "overrides": overrides or []},
            "options": options or {},
        }
        self.next_id += 1
        self.panels.append(p)
        return p


def prom(expr, legend="", instant=False):
    return {"expr": expr, "legendFormat": legend, "range": not instant, "instant": instant}


def loki(expr, legend="", qtype="range"):
    return {"expr": expr, "legendFormat": legend, "queryType": qtype}


def thresholds(*steps):
    return {"thresholds": {"mode": "absolute",
                           "steps": [{"color": c, "value": v} for v, c in steps]}}


def ts_opts(stack=False):
    return {"legend": {"displayMode": "table", "placement": "bottom", "calcs": ["lastNotNull", "max"]},
            "tooltip": {"mode": "multi", "sort": "desc"}}


def ts_field(stack=False, fill=10):
    return {"custom": {"lineWidth": 2, "fillOpacity": fill, "showPoints": "never",
                       "stacking": {"mode": "normal" if stack else "none"}}}


def dashboard(uid, title, board, tags, templating=None, refresh="30s", time_from="now-1h"):
    return {
        "uid": uid, "title": title, "tags": tags, "timezone": "browser", "schemaVersion": 39,
        "version": 1, "editable": False, "refresh": refresh, "graphTooltip": 1,
        "time": {"from": time_from, "to": "now"},
        "templating": {"list": templating or []},
        "annotations": {"list": []},
        "panels": board.panels,
    }


# ===================================================================== Overview
def overview():
    b = Board()
    b.row("Tổng quan hệ thống")
    b.add("stat", "Trạng thái target Prometheus", [prom("up", "{{job}}", instant=True)], w=10, h=5,
          desc="1 = UP, 0 = DOWN (Status > Targets trong Prometheus)",
          options={"colorMode": "background", "graphMode": "none", "textMode": "value_and_name",
                   "reduceOptions": {"calcs": ["lastNotNull"]}},
          field={"mappings": [{"type": "value", "options": {
              "0": {"text": "DOWN", "color": "red"}, "1": {"text": "UP", "color": "green"}}}],
              **thresholds((None, "red"), (1, "green"))})
    stat = {"colorMode": "value", "graphMode": "area", "reduceOptions": {"calcs": ["lastNotNull"]}}
    b.add("stat", "Phòng có khách hôm nay", [prom("hotel_rooms_occupied")], w=3, h=5, options=stat,
          field=thresholds((None, "blue")))
    b.add("stat", "Chờ xác nhận", [prom('hotel_bookings{status="pending"}')], w=3, h=5, options=stat,
          field=thresholds((None, "green"), (5, "orange"), (10, "red")))
    b.add("stat", "Đặt phòng mới (24h)", [prom("sum(increase(hotel_bookings_created_total[24h]))")],
          w=4, h=5, options=stat, field={"decimals": 0, **thresholds((None, "green"))})
    b.add("stat", "Đặt trùng bị chặn (24h)", [prom("sum(increase(hotel_booking_conflicts_total[24h]))")],
          w=4, h=5, options=stat, field={"decimals": 0, **thresholds((None, "green"), (1, "orange"))},
          desc="Yêu cầu bị PostgreSQL từ chối bởi ràng buộc EXCLUDE chống đặt trùng")

    b.row("Ứng dụng (Node.js)")
    b.add("timeseries", "Request/s theo route",
          [prom('sum by (route) (rate(http_request_duration_seconds_count{job="hotel-app"}[$__rate_interval]))',
                "{{route}}")], w=12, unit="reqps", options=ts_opts(), field=ts_field(stack=True))
    b.add("timeseries", "Request/s theo mã trạng thái HTTP",
          [prom('sum by (status_code) (rate(http_request_duration_seconds_count{job="hotel-app"}[$__rate_interval]))',
                "{{status_code}}")], w=12, unit="reqps", options=ts_opts(), field=ts_field(stack=True),
          overrides=[{"matcher": {"id": "byRegexp", "options": "5.."},
                      "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]},
                     {"matcher": {"id": "byRegexp", "options": "4.."},
                      "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]}])
    q = 'histogram_quantile({q}, sum by (le) (rate(http_request_duration_seconds_bucket{{job="hotel-app"}}[$__rate_interval])))'
    b.add("timeseries", "Thời gian phản hồi (p50 / p95 / p99)",
          [prom(q.format(q=0.5), "p50"), prom(q.format(q=0.95), "p95"), prom(q.format(q=0.99), "p99")],
          w=8, unit="s", options=ts_opts(), field=ts_field())
    b.add("piechart", "Đặt phòng theo trạng thái", [prom("hotel_bookings", "{{status}}", instant=True)],
          w=8, options={"pieType": "donut", "legend": {"displayMode": "table", "placement": "right",
                                                       "values": ["value"]},
                        "reduceOptions": {"calcs": ["lastNotNull"]}})
    b.add("timeseries", "Node.js: bộ nhớ (heap / RSS)",
          [prom('nodejs_heap_size_used_bytes{job="hotel-app"}', "heap used"),
           prom('process_resident_memory_bytes{job="hotel-app"}', "RSS")],
          w=8, unit="bytes", options=ts_opts(), field=ts_field())

    b.row("Nginx")
    b.add("timeseries", "Nginx request/s", [prom("rate(nginx_http_requests_total[$__rate_interval])", "requests")],
          w=12, unit="reqps", options=ts_opts(), field=ts_field())
    b.add("timeseries", "Kết nối Nginx",
          [prom("nginx_connections_active", "active"), prom("nginx_connections_reading", "reading"),
           prom("nginx_connections_writing", "writing"), prom("nginx_connections_waiting", "waiting")],
          w=12, options=ts_opts(), field=ts_field())

    b.row("PostgreSQL")
    b.add("stat", "PostgreSQL", [prom("pg_up", instant=True)], w=4, h=8,
          options={"colorMode": "background", "graphMode": "none", "reduceOptions": {"calcs": ["lastNotNull"]}},
          field={"mappings": [{"type": "value", "options": {
              "0": {"text": "DOWN", "color": "red"}, "1": {"text": "UP", "color": "green"}}}]})
    b.add("stat", "Kích thước database", [prom('pg_database_size_bytes{datname!~"template.*|postgres"}', "{{datname}}",
                                                 instant=True)],
          w=4, h=8, unit="bytes", options={"graphMode": "none", "reduceOptions": {"calcs": ["lastNotNull"]}})
    b.add("timeseries", "Kết nối PostgreSQL theo trạng thái",
          [prom('sum by (state) (pg_stat_activity_count{datname!~"template.*"})', "{{state}}")],
          w=8, options=ts_opts(), field=ts_field(stack=True))
    b.add("timeseries", "Transactions/s",
          [prom('sum(rate(pg_stat_database_xact_commit{datname!~"template.*"}[$__rate_interval]))', "commit"),
           prom('sum(rate(pg_stat_database_xact_rollback{datname!~"template.*"}[$__rate_interval]))', "rollback")],
          w=8, unit="ops", options=ts_opts(), field=ts_field())
    b.add("timeseries", "Connection pool của ứng dụng", [prom("hotel_db_pool_connections", "{{state}}")],
          w=8, options=ts_opts(), field=ts_field())
    b.add("timeseries", "Cache hit ratio",
          [prom('sum(rate(pg_stat_database_blks_hit[$__rate_interval])) / '
                '(sum(rate(pg_stat_database_blks_hit[$__rate_interval])) + '
                'sum(rate(pg_stat_database_blks_read[$__rate_interval])) > 0)', "hit ratio")],
          w=8, unit="percentunit", options=ts_opts(), field={**ts_field(), "min": 0, "max": 1})
    b.add("timeseries", "Tuples/s (đọc/ghi)",
          [prom('sum(rate(pg_stat_database_tup_fetched{datname!~"template.*"}[$__rate_interval]))', "fetched"),
           prom('sum(rate(pg_stat_database_tup_inserted{datname!~"template.*"}[$__rate_interval]))', "inserted"),
           prom('sum(rate(pg_stat_database_tup_updated{datname!~"template.*"}[$__rate_interval]))', "updated")],
          w=8, unit="ops", options=ts_opts(), field=ts_field())

    b.row("Container (cAdvisor)")
    b.add("timeseries", "CPU theo container",
          [prom('sum by (name) (rate(container_cpu_usage_seconds_total{name=~"hotel_.+"}[$__rate_interval])) * 100',
                "{{name}}")], w=12, unit="percent", options=ts_opts(), field=ts_field())
    b.add("timeseries", "RAM theo container",
          [prom('container_memory_working_set_bytes{name=~"hotel_.+"}', "{{name}}")],
          w=12, unit="bytes", options=ts_opts(), field=ts_field())
    b.add("timeseries", "Network nhận theo container",
          [prom('sum by (name) (rate(container_network_receive_bytes_total{name=~"hotel_.+"}[$__rate_interval]))',
                "{{name}}")], w=12, unit="Bps", options=ts_opts(), field=ts_field())
    b.add("bargauge", "RAM so với giới hạn (mem_limit)",
          [prom('container_memory_working_set_bytes{name=~"hotel_.+"} / '
                '(container_spec_memory_limit_bytes{name=~"hotel_.+"} > 0)', "{{name}}", instant=True)],
          w=12, unit="percentunit",
          options={"orientation": "horizontal", "displayMode": "gradient",
                   "reduceOptions": {"calcs": ["lastNotNull"]}},
          field={"min": 0, "max": 1, **thresholds((None, "green"), (0.7, "orange"), (0.9, "red"))})
    return dashboard("hotel-overview", "Hotel Booking - Tổng quan", b, ["hotel-booking", "prometheus"])


# ========================================================================= Logs
def logs():
    b = Board()
    svc = {"type": "custom", "name": "service", "label": "Service", "query": "nginx,app,db,pgadmin,grafana,prometheus,loki,promtail",
           "current": {"text": "All", "value": "$__all"}, "includeAll": True, "allValue": ".+", "multi": False,
           "options": []}
    b.row("Tổng quan log (Loki)")
    b.add("timeseries", "Số dòng log theo service",
          [loki('sum by (service) (count_over_time({project="hotel-booking"}[$__auto]))', "{{service}}")],
          w=12, ds=LOKI, options=ts_opts(), field=ts_field(stack=True))
    b.add("timeseries", "Nginx: request theo mã trạng thái (từ access log)",
          [loki('sum by (status) (count_over_time({service="nginx", stream="stdout"} | json | __error__="" [$__auto]))',
                "{{status}}")],
          w=12, ds=LOKI, options=ts_opts(), field=ts_field(stack=True))
    b.add("bargauge", "Top URI lỗi 4xx/5xx (1 giờ)",
          [loki('topk(10, sum by (uri, status) (count_over_time({service="nginx", stream="stdout"} | json | status >= 400 [1h])))',
                "{{status}} {{uri}}", qtype="instant")],
          w=12, h=9, ds=LOKI, options={"orientation": "horizontal", "displayMode": "basic",
                                       "reduceOptions": {"calcs": ["lastNotNull"]}})
    b.add("timeseries", "Ứng dụng: log theo level",
          [loki('sum by (level) (count_over_time({service="app"} | json | __error__="" [$__auto]))', "{{level}}")],
          w=12, h=9, ds=LOKI, options=ts_opts(), field=ts_field(stack=True))

    b.row("Truy vấn LogQL mẫu")
    logopt = {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending", "enableLogDetails": True}
    b.add("logs", "(a) Access log Nginx", [loki('{service="nginx", stream="stdout"} | json')],
          w=24, h=9, ds=LOKI, options=logopt, desc='{service="nginx", stream="stdout"} | json')
    b.add("logs", "(b) HTTP 4xx & 5xx",
          [loki('{service="nginx", stream="stdout"} | json | status >= 400')],
          w=12, h=9, ds=LOKI, options=logopt, desc='{service="nginx", stream="stdout"} | json | status >= 400')
    b.add("logs", "(c) Log lỗi/cảnh báo của ứng dụng",
          [loki('{service="app"} | json | level=~"error|warn"')],
          w=12, h=9, ds=LOKI, options=logopt, desc='{service="app"} | json | level=~"error|warn"')
    b.add("logs", "(d) Đặt phòng bị chặn do trùng lịch",
          [loki('{service="app"} |= "booking conflict" | json')],
          w=12, h=8, ds=LOKI, options=logopt)
    b.add("logs", "(e) Đăng nhập quản trị", [loki('{service="app"} |~ "admin login" | json')],
          w=12, h=8, ds=LOKI, options=logopt)
    b.add("logs", "Log theo service: $service", [loki('{project="hotel-booking", service=~"$service"}')],
          w=24, h=10, ds=LOKI, options=logopt)
    return dashboard("hotel-logs", "Hotel Booking - Logs", b, ["hotel-booking", "loki"],
                     templating=[svc], refresh="30s", time_from="now-1h")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, d in (("hotel-overview.json", overview()), ("hotel-logs.json", logs())):
        (OUT / name).write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {OUT / name} ({len(d['panels'])} panels)")
