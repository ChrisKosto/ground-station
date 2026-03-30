# Satellite Ground Station Dashboard
# Author: Christos Kostogiannis

from flask import Flask, render_template, jsonify
from skyfield.api import load, wgs84, EarthSatellite
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import math
import os
import threading
import urllib.request

app = Flask(__name__)

# =========================
# Ρυθμίσεις
# =========================
NOAA_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=noaa&FORMAT=tle"
NOAA_TLE_FILE = "data/noaa.tle"

TARGET_NOAA_SATELLITES = {"NOAA 15", "NOAA 18", "NOAA 19"}

ISS_NAME = "ISS (ZARYA)"
ISS_TLE_LINE1 = "1 25544U 98067A   26088.13514873  .00014242  00000-0  25817-3 0  9995"
ISS_TLE_LINE2 = "2 25544  51.6395  14.4011 0003589 233.7545 126.3463 15.50059299510205"

OBSERVER_LAT = 37.9838
OBSERVER_LON = 23.7275
OBSERVER_ELEV_M = 70

MIN_ALTITUDE_DEGREES = 10.0
PAST_SEARCH_HOURS = 12
FUTURE_SEARCH_HOURS = 36
MAX_UPCOMING_PASSES = 5

TRACK_MINUTES_BEFORE = 25
TRACK_MINUTES_AFTER = 25
TRACK_STEP_SECONDS = 30
MAP_REFRESH_SECONDS = 5
TLE_CACHE_MINUTES = 30

# New cache timings for optimization
MAP_DATA_CACHE_SECONDS = 4
DASHBOARD_CACHE_SECONDS = 20

EARTH_RADIUS_KM = 6371.0

try:
    LOCAL_TIMEZONE = ZoneInfo("Europe/Athens")
except Exception:
    LOCAL_TIMEZONE = timezone(timedelta(hours=2))

ts = load.timescale()
observer = wgs84.latlon(OBSERVER_LAT, OBSERVER_LON, elevation_m=OBSERVER_ELEV_M)

_noaa_cache = {
    "satellites": None,
    "loaded_at": None
}

_response_cache = {
    "dashboard": {
        "value": None,
        "created_at": None
    },
    "map": {
        "value": None,
        "created_at": None
    }
}

_cache_lock = threading.Lock()


def utc_now():
    return datetime.now(timezone.utc)


def to_local_datetime(skyfield_time):
    dt_utc = skyfield_time.utc_datetime().replace(tzinfo=timezone.utc)
    return dt_utc.astimezone(LOCAL_TIMEZONE)


def format_local_time(skyfield_time):
    return to_local_datetime(skyfield_time).strftime("%d/%m %H:%M")


def format_duration_minutes(seconds):
    minutes = round(seconds / 60)
    return f"{minutes} min"


def format_eta_from_seconds(seconds):
    if seconds is None or seconds < 0:
        return "N/A"

    total_seconds = int(seconds)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    if minutes > 0:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def get_observer():
    return observer


def get_iss_satellite():
    return EarthSatellite(ISS_TLE_LINE1, ISS_TLE_LINE2, ISS_NAME, ts)


def download_tle_file(url, file_path):
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 GroundStation/1.0"
        }
    )

    with urllib.request.urlopen(request, timeout=15) as response:
        raw_data = response.read()

    text = raw_data.decode("utf-8").strip()

    if not text:
        raise RuntimeError("Downloaded TLE file is empty.")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(text + "\n")


def load_noaa_satellites():
    now_utc = utc_now()

    if (
        _noaa_cache["satellites"] is not None
        and _noaa_cache["loaded_at"] is not None
        and now_utc - _noaa_cache["loaded_at"] < timedelta(minutes=TLE_CACHE_MINUTES)
    ):
        return _noaa_cache["satellites"]

    downloaded_ok = False

    try:
        download_tle_file(NOAA_TLE_URL, NOAA_TLE_FILE)
        downloaded_ok = True
        print("✅ NOAA TLE updated from internet")
    except Exception as e:
        print(f"⚠️ Failed to download NOAA TLE, using local file: {e}")

    if not os.path.exists(NOAA_TLE_FILE) or os.path.getsize(NOAA_TLE_FILE) == 0:
        raise RuntimeError("No valid NOAA TLE available: internet download failed and local file is missing/empty.")

    satellites = load.tle_file(NOAA_TLE_FILE)

    if not downloaded_ok:
        print("✅ NOAA TLE loaded from local cache")

    satellites = [sat for sat in satellites if sat.name in TARGET_NOAA_SATELLITES]

    if not satellites:
        raise RuntimeError("No target NOAA satellites found in TLE data.")

    _noaa_cache["satellites"] = satellites
    _noaa_cache["loaded_at"] = now_utc

    return satellites


def calculate_passes(start_utc, end_utc, satellites):
    obs = get_observer()

    t0 = ts.from_datetime(start_utc)
    t1 = ts.from_datetime(end_utc)

    all_passes = []

    for sat in satellites:
        times, events = sat.find_events(
            obs,
            t0,
            t1,
            altitude_degrees=MIN_ALTITUDE_DEGREES
        )

        current_pass = None
        difference = sat - obs

        for ti, ev in zip(times, events):
            ev = int(ev)

            if ev == 0:
                current_pass = {
                    "sat": sat.name,
                    "rise_time_sf": ti,
                    "culmination_time_sf": None,
                    "set_time_sf": None,
                    "max_elevation": None
                }

            elif ev == 1 and current_pass is not None:
                topocentric = difference.at(ti)
                alt, az, distance = topocentric.altaz()

                current_pass["culmination_time_sf"] = ti
                current_pass["max_elevation"] = round(alt.degrees, 1)

            elif ev == 2 and current_pass is not None:
                current_pass["set_time_sf"] = ti

                rise_dt_utc = current_pass["rise_time_sf"].utc_datetime().replace(tzinfo=timezone.utc)
                set_dt_utc = current_pass["set_time_sf"].utc_datetime().replace(tzinfo=timezone.utc)
                duration_sec = int((set_dt_utc - rise_dt_utc).total_seconds())

                culmination_formatted = (
                    format_local_time(current_pass["culmination_time_sf"])
                    if current_pass["culmination_time_sf"] is not None
                    else "N/A"
                )

                all_passes.append({
                    "sat": current_pass["sat"],
                    "rise_time": format_local_time(current_pass["rise_time_sf"]),
                    "rise_time_iso": to_local_datetime(current_pass["rise_time_sf"]).isoformat(),
                    "culmination_time": culmination_formatted,
                    "set_time": format_local_time(current_pass["set_time_sf"]),
                    "set_time_iso": to_local_datetime(current_pass["set_time_sf"]).isoformat(),
                    "max_elevation": current_pass["max_elevation"] if current_pass["max_elevation"] is not None else 0.0,
                    "duration_sec": duration_sec,
                    "duration_min": format_duration_minutes(duration_sec)
                })

                current_pass = None

    all_passes.sort(key=lambda p: p["rise_time_iso"])
    return all_passes


def get_last_pass_data(past_passes):
    if not past_passes:
        return {
            "satellite": "N/A",
            "time": "No completed pass found",
            "image": "/static/images/sample.jpg"
        }

    last_pass = max(past_passes, key=lambda p: p["set_time_iso"])

    return {
        "satellite": last_pass["sat"],
        "time": f"{last_pass['rise_time']} → {last_pass['set_time']}",
        "image": "/static/images/sample.jpg"
    }


def get_next_pass_data(upcoming_passes):
    if not upcoming_passes:
        return {
            "sat": "N/A",
            "time": "N/A",
            "time_iso": None,
            "elev": "-",
            "duration": "-"
        }

    first = upcoming_passes[0]
    return {
        "sat": first["sat"],
        "time": first["rise_time"],
        "time_iso": first["rise_time_iso"],
        "elev": first["max_elevation"],
        "duration": first["duration_min"]
    }


def get_next_pass_lookup(upcoming_passes):
    lookup = {}
    for p in upcoming_passes:
        if p["sat"] not in lookup:
            lookup[p["sat"]] = p
    return lookup


def get_track_offsets():
    total_seconds_before = TRACK_MINUTES_BEFORE * 60
    total_seconds_after = TRACK_MINUTES_AFTER * 60
    return list(range(-total_seconds_before, total_seconds_after + 1, TRACK_STEP_SECONDS))


TRACK_OFFSETS = get_track_offsets()


def build_track_points_for_satellite(satellite, now_utc):
    point_datetimes = [now_utc + timedelta(seconds=offset) for offset in TRACK_OFFSETS]
    point_times = ts.from_datetimes(point_datetimes)

    geocentric = satellite.at(point_times)
    subpoints = wgs84.subpoint(geocentric)

    latitudes = subpoints.latitude.degrees
    longitudes = subpoints.longitude.degrees

    points = []
    for i, offset_seconds in enumerate(TRACK_OFFSETS):
        points.append({
            "lat": round(float(latitudes[i]), 5),
            "lon": round(float(longitudes[i]), 5),
            "offset_sec": offset_seconds
        })

    return points


def get_visibility_info(satellite, now_time):
    difference = satellite - get_observer()
    topocentric = difference.at(now_time)
    alt, az, distance = topocentric.altaz()

    elevation = round(alt.degrees, 1)

    if elevation > MIN_ALTITUDE_DEGREES:
        return {
            "elevation": elevation,
            "status": "Visible",
            "level": "high"
        }
    elif elevation > 0:
        return {
            "elevation": elevation,
            "status": "Low visibility",
            "level": "medium"
        }
    else:
        return {
            "elevation": elevation,
            "status": "Not visible",
            "level": "low"
        }


def get_footprint_radius_km(altitude_km):
    if altitude_km <= 0:
        return 0.0

    ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitude_km)
    ratio = max(-1.0, min(1.0, ratio))
    central_angle_rad = math.acos(ratio)
    return EARTH_RADIUS_KM * central_angle_rad


def get_satellite_map_data(tracked_satellites, upcoming_passes, now_utc=None):
    if now_utc is None:
        now_utc = utc_now()

    next_pass_lookup = get_next_pass_lookup(upcoming_passes)
    result = []

    t_now = ts.from_datetime(now_utc)

    for sat in tracked_satellites:
        geocentric = sat.at(t_now)
        subpoint = wgs84.subpoint(geocentric)

        altitude_km = round(subpoint.elevation.km, 1)
        footprint_radius_km = round(get_footprint_radius_km(altitude_km), 1)

        next_pass = next_pass_lookup.get(sat.name)

        if next_pass is not None:
            next_pass_dt_local = datetime.fromisoformat(next_pass["rise_time_iso"])
            eta_seconds = int((next_pass_dt_local - now_utc.astimezone(LOCAL_TIMEZONE)).total_seconds())
            eta_text = format_eta_from_seconds(eta_seconds)
            next_pass_time = next_pass["rise_time"]
            next_pass_iso = next_pass["rise_time_iso"]
        else:
            eta_seconds = None
            eta_text = "N/A"
            next_pass_time = "N/A"
            next_pass_iso = None

        visibility = get_visibility_info(sat, t_now)

        result.append({
            "name": sat.name,
            "current": {
                "lat": round(subpoint.latitude.degrees, 5),
                "lon": round(subpoint.longitude.degrees, 5)
            },
            "track": build_track_points_for_satellite(sat, now_utc),
            "estimated_time": eta_text,
            "eta_seconds": eta_seconds,
            "next_pass_time": next_pass_time,
            "next_pass_iso": next_pass_iso,
            "visibility": visibility,
            "altitude_km": altitude_km,
            "footprint_radius_km": footprint_radius_km
        })

    return result


def split_noaa_passes(noaa_passes, now_local):
    past_passes = []
    upcoming_noaa_passes = []

    for p in noaa_passes:
        set_dt = datetime.fromisoformat(p["set_time_iso"])
        rise_dt = datetime.fromisoformat(p["rise_time_iso"])

        if set_dt <= now_local:
            past_passes.append(p)
        elif rise_dt >= now_local:
            upcoming_noaa_passes.append(p)

    return past_passes, upcoming_noaa_passes[:MAX_UPCOMING_PASSES]


def compute_core_data(now_utc=None):
    if now_utc is None:
        now_utc = utc_now()

    noaa_satellites = load_noaa_satellites()
    iss_satellite = get_iss_satellite()
    tracked_satellites = noaa_satellites + [iss_satellite]

    past_start_utc = now_utc - timedelta(hours=PAST_SEARCH_HOURS)
    future_end_utc = now_utc + timedelta(hours=FUTURE_SEARCH_HOURS)

    noaa_passes = calculate_passes(past_start_utc, future_end_utc, noaa_satellites)
    tracked_upcoming_passes = calculate_passes(now_utc, future_end_utc, tracked_satellites)

    now_local = now_utc.astimezone(LOCAL_TIMEZONE)
    past_passes, upcoming_noaa_passes = split_noaa_passes(noaa_passes, now_local)

    map_data = get_satellite_map_data(
        tracked_satellites,
        tracked_upcoming_passes,
        now_utc=now_utc
    )

    return {
        "now_utc": now_utc,
        "past_passes": past_passes,
        "upcoming_noaa_passes": upcoming_noaa_passes,
        "tracked_upcoming_passes": tracked_upcoming_passes,
        "satellite_map": map_data
    }


def build_dashboard_payload(core_data):
    return {
        "last_pass": get_last_pass_data(core_data["past_passes"]),
        "next_pass": get_next_pass_data(core_data["upcoming_noaa_passes"]),
        "upcoming_passes": core_data["upcoming_noaa_passes"],
        "satellite_map": core_data["satellite_map"],
        "map_refresh_seconds": MAP_REFRESH_SECONDS
    }


def build_map_payload(core_data):
    return {
        "server_time_iso": core_data["now_utc"].isoformat(),
        "map_refresh_seconds": MAP_REFRESH_SECONDS,
        "satellite_map": core_data["satellite_map"]
    }


def get_cached_payload(cache_key, ttl_seconds, builder):
    now_utc = utc_now()

    with _cache_lock:
        cache_entry = _response_cache[cache_key]
        if (
            cache_entry["value"] is not None
            and cache_entry["created_at"] is not None
            and (now_utc - cache_entry["created_at"]).total_seconds() < ttl_seconds
        ):
            return cache_entry["value"]

    value = builder(now_utc)

    with _cache_lock:
        _response_cache[cache_key]["value"] = value
        _response_cache[cache_key]["created_at"] = now_utc

    return value


def get_dashboard_data():
    def builder(now_utc):
        core_data = compute_core_data(now_utc)
        return build_dashboard_payload(core_data)

    return get_cached_payload("dashboard", DASHBOARD_CACHE_SECONDS, builder)


def get_map_data():
    def builder(now_utc):
        core_data = compute_core_data(now_utc)
        return build_map_payload(core_data)

    return get_cached_payload("map", MAP_DATA_CACHE_SECONDS, builder)


@app.route("/")
def index():
    data = get_dashboard_data()
    return render_template("index.html", data=data)


@app.route("/api/passes")
def api_passes():
    return jsonify(get_dashboard_data())


@app.route("/api/map")
def api_map():
    return jsonify(get_map_data())


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)