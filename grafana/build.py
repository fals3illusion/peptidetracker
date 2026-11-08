# Generates peptidetracker-dashboard.json (Grafana import format).
import json
DS = {"type": "grafana-postgresql-datasource", "uid": "${DS_PEPTIDETRACKER}"}
pid = 0
def q(sql, fmt="time_series", ref="A"):
    return {"refId": ref, "datasource": DS, "rawQuery": True, "editorMode": "code", "format": fmt, "rawSql": sql.strip()}
def panel(kind, title, x, y, w, h, targets, **extra):
    global pid; pid += 1
    p = {"id": pid, "type": kind, "title": title, "datasource": DS, "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets}
    p.update(extra); return p
def stat(title, sql, x, unit="none", decimals=1, color="blue", desc=None):
    return panel("stat", title, x, 0, 4, 4, [q(sql, "table")], description=desc or "",
        fieldConfig={"defaults": {"unit": unit, "decimals": decimals, "color": {"mode": "fixed", "fixedColor": color}}, "overrides": []},
        options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "value", "graphMode": "none", "textMode": "value", "justifyMode": "center"})

panels = [
  stat("Current weight", "SELECT weight_lb AS \"lb\" FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at DESC LIMIT 1", 0, unit="none"),
  stat("Total lost (lb)", "SELECT (SELECT weight_lb FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at LIMIT 1) - (SELECT weight_lb FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at DESC LIMIT 1) AS \"lb\"", 4, color="green"),
  stat("Body weight lost", "SELECT 100.0 * ((SELECT weight_lb FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at LIMIT 1) - (SELECT weight_lb FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at DESC LIMIT 1)) / (SELECT weight_lb FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at LIMIT 1) AS \"pct\"", 8, unit="percent", color="green"),
  stat("To goal (lb)", "SELECT (SELECT weight_lb FROM pt_entries WHERE user_id = '$person' ORDER BY taken_at DESC LIMIT 1) - (settings->>'goal')::numeric AS \"lb\" FROM pt_settings WHERE user_id = '$person'", 12, color="purple"),
  stat("Current dose (mg)", "SELECT dose_mg AS \"mg\" FROM (SELECT min(taken_at) AS t, sum(dose_mg) AS dose_mg FROM pt_shots WHERE user_id = '$person' AND lower(name) NOT IN (SELECT lower(pr->>'name') FROM pt_settings ws, jsonb_array_elements(coalesce(ws.settings->'protocols', '[]'::jsonb)) pr WHERE ws.user_id = '$person') GROUP BY coalesce(group_id, to_char(date_trunc('minute', taken_at), 'YYYYMMDDHH24MI'))) d ORDER BY t DESC LIMIT 1", 16, color="orange", desc="Main GLP-1 only (medications with their own schedule are left out)"),
  stat("Spent total", "SELECT coalesce(sum(price), 0) AS \"usd\" FROM pt_supplies WHERE user_id = '$person'", 20, unit="currencyUSD", decimals=0, color="text"),

  panel("timeseries", "Weight", 0, 4, 24, 10, [q("""
SELECT taken_at AS "time",
       weight_lb AS "Daily weigh-in",
       round(avg(weight_lb) OVER (ORDER BY taken_at RANGE BETWEEN interval '7 days' - interval '1 second' PRECEDING AND CURRENT ROW), 2) AS "7-day average",
       (SELECT (settings->>'goal')::numeric FROM pt_settings WHERE user_id = '$person') AS "Goal"
FROM pt_entries WHERE user_id = '$person'
ORDER BY 1""")],
    fieldConfig={"defaults": {"unit": "none", "decimals": 1, "custom": {"lineWidth": 1, "pointSize": 4, "showPoints": "always", "spanNulls": True}}, "overrides": [
      {"matcher": {"id": "byName", "options": "Daily weigh-in"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "#2a78d6"}}, {"id": "custom.lineWidth", "value": 0}, {"id": "custom.fillOpacity", "value": 0}]},
      {"matcher": {"id": "byName", "options": "7-day average"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "#2a78d6"}}, {"id": "custom.lineWidth", "value": 3}, {"id": "custom.showPoints", "value": "never"}]},
      {"matcher": {"id": "byName", "options": "Goal"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "#888888"}}, {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [4, 6]}}, {"id": "custom.showPoints", "value": "never"}]}]},
    options={"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}),

  panel("barchart", "Weekly change (lb, avg of each week vs the week before)", 0, 14, 12, 8, [q("""
SELECT to_char(wk, 'Mon DD') AS "Week of",
       round(avg_lb - lag(avg_lb) OVER (ORDER BY wk), 2) AS "Change"
FROM (SELECT date_trunc('week', taken_at) AS wk, avg(weight_lb) AS avg_lb FROM pt_entries WHERE user_id = '$person' GROUP BY 1) w
ORDER BY wk""", "table")],
    fieldConfig={"defaults": {"unit": "none", "decimals": 1, "color": {"mode": "fixed", "fixedColor": "#1baf7a"}}, "overrides": []},
    options={"xTickLabelRotation": -45, "showValue": "auto", "legend": {"showLegend": False}}),

  panel("timeseries", "Dose (mg)", 12, 14, 12, 8, [q("""
SELECT t AS "time", dose_mg AS "Dose (mg)" FROM (SELECT min(taken_at) AS t, sum(dose_mg) AS dose_mg FROM pt_shots WHERE user_id = '$person' AND lower(name) NOT IN (SELECT lower(pr->>'name') FROM pt_settings ws, jsonb_array_elements(coalesce(ws.settings->'protocols', '[]'::jsonb)) pr WHERE ws.user_id = '$person') GROUP BY coalesce(group_id, to_char(date_trunc('minute', taken_at), 'YYYYMMDDHH24MI'))) d ORDER BY 1""")],
    fieldConfig={"defaults": {"unit": "none", "decimals": 1, "color": {"mode": "fixed", "fixedColor": "#eb6834"}, "min": 0, "custom": {"lineInterpolation": "stepAfter", "lineWidth": 2, "showPoints": "always", "pointSize": 6, "fillOpacity": 10}}, "overrides": []},
    options={"legend": {"showLegend": False}, "tooltip": {"mode": "single"}}),

  panel("bargauge", "Open vials: % left", 0, 22, 12, 6, [q("""
SELECT s.name || ' (' || to_char(s.opened_at, 'Mon DD') || '): ' ||
       CASE WHEN s.kind = 'vial' THEN round(s.powder_mg - coalesce(sum(sh.dose_mg), 0), 1) || ' of ' || s.powder_mg || ' mg left'
            ELSE (s.dose_count - count(sh.id)) || ' of ' || s.dose_count || ' doses left' END AS "Vial",
       round(100.0 * CASE WHEN s.kind = 'vial' THEN (s.powder_mg - coalesce(sum(sh.dose_mg), 0)) / nullif(s.powder_mg, 0)
            ELSE (s.dose_count - count(sh.id))::numeric / nullif(s.dose_count, 0) END, 1) AS "% left"
FROM pt_supplies s LEFT JOIN pt_shots sh ON sh.supply_id = s.id
WHERE NOT s.done AND s.user_id = '$person'
GROUP BY s.id ORDER BY s.opened_at""", "table")],
    fieldConfig={"defaults": {"unit": "percent", "min": 0, "max": 100, "decimals": 0, "color": {"mode": "fixed", "fixedColor": "#6250d6"}}, "overrides": []},
    options={"displayMode": "basic", "orientation": "horizontal", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": True}, "showUnfilled": True}),

  panel("table", "Shots", 12, 22, 12, 10, [q("""
SELECT taken_at AS "Date", name AS "Medication", dose_mg AS "mg", units AS "Units", site AS "Site"
FROM pt_shots WHERE user_id = '$person' ORDER BY taken_at DESC""", "table")],
    fieldConfig={"defaults": {}, "overrides": [{"matcher": {"id": "byName", "options": "Date"}, "properties": [{"id": "unit", "value": "time:ddd MMM D"}]}]},
    options={"showHeader": True}),

  panel("table", "Purchases", 0, 28, 12, 4, [q("""
SELECT opened_at AS "Date", name AS "Medication", CASE WHEN kind = 'vial' THEN powder_mg || ' mg vial + ' || water_ml || ' mL' ELSE dose_count || ' doses' END AS "What", price AS "Price"
FROM pt_supplies WHERE user_id = '$person' ORDER BY opened_at DESC""", "table")],
    fieldConfig={"defaults": {}, "overrides": [
      {"matcher": {"id": "byName", "options": "Date"}, "properties": [{"id": "unit", "value": "time:MMM D, YYYY"}]},
      {"matcher": {"id": "byName", "options": "Price"}, "properties": [{"id": "unit", "value": "currencyUSD"}]}]},
    options={"showHeader": True}),
]

dash = {
  "__inputs": [{"name": "DS_PEPTIDETRACKER", "label": "PeptideTracker (PostgreSQL)", "description": "PostgreSQL data source pointing at your PeptideTracker backup database",
                "type": "datasource", "pluginId": "grafana-postgresql-datasource", "pluginName": "PostgreSQL"}],
  "__requires": [{"type": "datasource", "id": "grafana-postgresql-datasource", "name": "PostgreSQL", "version": "1.0.0"}],
  "title": "PeptideTracker", "uid": "peptidetracker", "tags": ["health", "glp-1"],
  "timezone": "browser", "editable": True, "schemaVersion": 39, "version": 5, "refresh": "5m",
  "time": {"from": "now-100d", "to": "now"},
  "panels": panels,
  "templating": {"list": [{
    "name": "person", "label": "Person", "type": "query", "datasource": DS,
    "query": "SELECT coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), username) AS __text, user_id AS __value FROM pt_people ORDER BY username",
    "definition": "SELECT coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), username) AS __text, user_id AS __value FROM pt_people ORDER BY username",
    "refresh": 1, "includeAll": False, "multi": False, "sort": 0, "current": {},
  }]},
}
json.dump(dash, open("peptidetracker-dashboard.json", "w"), indent=2)
# Also dump plain SQL for testing
print(len(panels), "panels")
