# Satellite Ground Station Dashboard
# Author: Christos Kostogiannis

from flask import Flask, render_template, jsonify
from skyfield.api import load, wgs84
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import os
import math
import requests

app = Flask(__name__)

# =========================
# Ρυθμίσεις
# =========================
NOAA_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=noaa&FORMAT=tle"
NOAA_TLE_FILE = "data/noaa.tle"

TARGET_NOAA_SATELLITES = {"NOAA 15", "NOAA 18", "NOAA 19"}

ISS_TLE_URL = "https://celestrak.org/NORAD/elements/stations.txt"
ISS_TLE_FILE = "data/iss.tle"
ISS_NAME = "ISS (ZARYA)"

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

# Αν το τελευταίο fetch ήταν επιτυχές από internet, κράτα cache για 30 λεπτά
TLE_CACHE_MINUTES = 30

# Αν το τελευταίο fetch απέτυχε και έπεσε σε fallback, ξαναδοκίμασε πιο γρήγορα
TLE_RETRY_MINUTES_ON_FAILURE = 5

EARTH_RADIUS_KM = 6371.0

try:
    LOCAL_TIMEZONE = ZoneInfo("Europe/Athens")
except Exception:
    LOCAL_TIMEZONE = timezone(timedelta(hours=2))

ts = load.timescale()

_noaa_cache = {
    "satellites": None,
    "loaded_at": None,
    "source": None,          # "internet" | "local fallback"
    "file_updated_at": None,
    "last_attempt_at": None,
    "last_error": None
}

_iss_cache = {
    "satellite": None,
    "loaded_at": None,
    "source": None,          # "internet" | "local fallback"
    "file_updated_at": None,
    "last_attempt_at": None,
    "last_error": None
}


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
    return wgs84.latlon(OBSERVER_LAT, OBSERVER_LON, elevation_m=OBSERVER_ELEV_M)


def format_relative_age(dt):
    if dt is None:
        return "unknown"

    now_utc = datetime.now(timezone.utc)
    seconds = int((now_utc - dt).total_seconds())

    if seconds < 60:
        return "just now"

    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min ago"

    hours = minutes // 60
    if hours < 24:
        return f"{hours}h ago"

    days = hours // 24
    return f"{days}d ago"


def get_file_updated_at(file_path):
    if not os.path.exists(file_path):
        return None
    return datetime.fromtimestamp(os.path.getmtime(file_path), tz=timezone.utc)


def build_tle_status(label, cache_obj):
    file_updated_at = cache_obj.get("file_updated_at")
    source = cache_obj.get("source") or "unknown"

    age_text = format_relative_age(file_updated_at)

    stale = False
    if file_updated_at is not None:
        stale = (datetime.now(timezone.utc) - file_updated_at) > timedelta(hours=12)

    return {
        "label": label,
        "source": source,
        "updated_at_iso": file_updated_at.isoformat() if file_updated_at else None,
        "updated_age": age_text,
        "stale": stale,
        "last_error": cache_obj.get("last_error")
    }


def should_use_cached_data(cache_obj, now_utc, is_list=False):
    cached_value = cache_obj["satellites"] if is_list else cache_obj["satellite"]
    loaded_at = cache_obj.get("loaded_at")
    source = cache_obj.get("source")

    if cached_value is None or loaded_at is None:
        return False

    cache_age = now_utc - loaded_at

    if source == "internet":
        return cache_age < timedelta(minutes=TLE_CACHE_MINUTES)

    # Αν είμαστε σε local fallback, μην περιμένεις 30 λεπτά.
    # Ξαναπροσπάθησε πιο γρήγορα να πιάσεις internet.
    return cache_age < timedelta(minutes=TLE_RETRY_MINUTES_ON_FAILURE)


def download_tle_file(url, file_path):
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    print(f"⬇️ Downloading TLE from: {url}")

    headers = {
        "User-Agent": "Mozilla/5.0 GroundStation/1.0"
    }

    response = requests.get(url, headers=headers, timeout=15)
    response.raise_for_status()

    text = response.text.strip()

    if not text:
        raise RuntimeError("Downloaded TLE file is empty.")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(text + "\n")

    print(f"✅ TLE saved: {file_path}")


def load_iss_satellite():
    now_utc = datetime.now(timezone.utc)

    if should_use_cached_data(_iss_cache, now_utc, is_list=False):
        return _iss_cache["satellite"]

    _iss_cache["last_attempt_at"] = now_utc
    downloaded_ok = False

    try:
        download_tle_file(ISS_TLE_URL, ISS_TLE_FILE)
        downloaded_ok = True
        _iss_cache["last_error"] = None
        print("✅ ISS TLE updated from internet")
    except Exception as e:
        _iss_cache["last_error"] = str(e)
        print(f"⚠️ Failed to download ISS TLE, using local file: {e}")

    if not os.path.exists(ISS_TLE_FILE) or os.path.getsize(ISS_TLE_FILE) == 0:
        raise RuntimeError("No valid ISS TLE available: internet download failed and local file is missing/empty.")

    satellites = load.tle_file(ISS_TLE_FILE)

    iss_satellite = None
    for sat in satellites:
        if sat.name == ISS_NAME or "ISS" in sat.name:
            iss_satellite = sat
            break

    if iss_satellite is None:
        raise RuntimeError("ISS not found in TLE data.")

    if not downloaded_ok:
        print("✅ ISS TLE loaded from local fallback")

    _iss_cache["satellite"] = iss_satellite
    _iss_cache["loaded_at"] = now_utc
    _iss_cache["source"] = "internet" if downloaded_ok else "local fallback"
    _iss_cache["file_updated_at"] = get_file_updated_at(ISS_TLE_FILE)

    return iss_satellite


def load_noaa_satellites():
    now_utc = datetime.now(timezone.utc)

    if should_use_cached_data(_noaa_cache, now_utc, is_list=True):
        return _noaa_cache["satellites"]

    _noaa_cache["last_attempt_at"] = now_utc
    downloaded_ok = False

    try:
        download_tle_file(NOAA_TLE_URL, NOAA_TLE_FILE)
        downloaded_ok = True
        _noaa_cache["last_error"] = None
        print("✅ NOAA TLE updated from internet")
    except Exception as e:
        _noaa_cache["last_error"] = str(e)
        print(f"⚠️ Failed to download NOAA TLE, using local file: {e}")

    if not os.path.exists(NOAA_TLE_FILE) or os.path.getsize(NOAA_TLE_FILE) == 0:
        raise RuntimeError("No valid NOAA TLE available: internet download failed and local file is missing/empty.")

    satellites = load.tle_file(NOAA_TLE_FILE)
    satellites = [sat for sat in satellites if sat.name in TARGET_NOAA_SATELLITES]

    if not satellites:
        raise RuntimeError("No target NOAA satellites found in TLE data.")

    if not downloaded_ok:
        print("✅ NOAA TLE loaded from local fallback")

    _noaa_cache["satellites"] = satellites
    _noaa_cache["loaded_at"] = now_utc
    _noaa_cache["source"] = "internet" if downloaded_ok else "local fallback"
    _noaa_cache["file_updated_at"] = get_file_updated_at(NOAA_TLE_FILE)

    return satellites


def calculate_passes(start_utc, end_utc, satellites):
    observer = get_observer()

    t0 = ts.from_datetime(start_utc)
    t1 = ts.from_datetime(end_utc)

    all_passes = []

    for sat in satellites:
        times, events = sat.find_events(
            observer,
            t0,
            t1,
            altitude_degrees=MIN_ALTITUDE_DEGREES
        )

        current_pass = None

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
                difference = sat - observer
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


def build_track_points_for_satellite(satellite, now_utc):
    points = []
    total_seconds_before = TRACK_MINUTES_BEFORE * 60
    total_seconds_after = TRACK_MINUTES_AFTER * 60

    for offset_seconds in range(-total_seconds_before, total_seconds_after + 1, TRACK_STEP_SECONDS):
        point_dt = now_utc + timedelta(seconds=offset_seconds)
        point_t = ts.from_datetime(point_dt)

        geocentric = satellite.at(point_t)
        subpoint = wgs84.subpoint(geocentric)

        points.append({
            "lat": round(subpoint.latitude.degrees, 5),
            "lon": round(subpoint.longitude.degrees, 5),
            "offset_sec": offset_seconds
        })

    return points


def get_visibility_info(satellite, now_utc):
    observer = get_observer()
    t_now = ts.from_datetime(now_utc)

    difference = satellite - observer
    topocentric = difference.at(t_now)
    alt, az, distance = topocentric.altaz()

    elevation = round(alt.degrees, 1)

    if elevation > 10:
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
        now_utc = datetime.now(timezone.utc)

    next_pass_lookup = get_next_pass_lookup(upcoming_passes)
    result = []

    for sat in tracked_satellites:
        t_now = ts.from_datetime(now_utc)
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

        visibility = get_visibility_info(sat, now_utc)

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


def get_dashboard_data():
    now_utc = datetime.now(timezone.utc)

    noaa_satellites = load_noaa_satellites()
    iss_satellite = load_iss_satellite()

    tracked_satellites = noaa_satellites + [iss_satellite]

    past_start_utc = now_utc - timedelta(hours=PAST_SEARCH_HOURS)
    future_end_utc = now_utc + timedelta(hours=FUTURE_SEARCH_HOURS)

    noaa_passes = calculate_passes(past_start_utc, future_end_utc, noaa_satellites)
    tracked_upcoming_passes = calculate_passes(now_utc, future_end_utc, tracked_satellites)

    past_passes = []
    upcoming_noaa_passes = []
    now_local = now_utc.astimezone(LOCAL_TIMEZONE)

    for p in noaa_passes:
        set_dt = datetime.fromisoformat(p["set_time_iso"])
        rise_dt = datetime.fromisoformat(p["rise_time_iso"])

        if set_dt <= now_local:
            past_passes.append(p)
        elif rise_dt >= now_local:
            upcoming_noaa_passes.append(p)

    upcoming_noaa_passes = upcoming_noaa_passes[:MAX_UPCOMING_PASSES]

    return {
        "last_pass": get_last_pass_data(past_passes),
        "next_pass": get_next_pass_data(upcoming_noaa_passes),
        "upcoming_passes": upcoming_noaa_passes,
        "satellite_map": get_satellite_map_data(tracked_satellites, tracked_upcoming_passes, now_utc=now_utc),
        "map_refresh_seconds": MAP_REFRESH_SECONDS,
        "tle_status": {
            "noaa": build_tle_status("NOAA", _noaa_cache),
            "iss": build_tle_status("ISS", _iss_cache)
        }
    }


@app.route("/")
def index():
    data = get_dashboard_data()
    return render_template("index.html", data=data)


@app.route("/api/passes")
def api_passes():
    data = get_dashboard_data()
    return jsonify(data)


@app.route("/api/map")
def api_map():
    now_utc = datetime.now(timezone.utc)

    noaa_satellites = load_noaa_satellites()
    iss_satellite = load_iss_satellite()
    tracked_satellites = noaa_satellites + [iss_satellite]

    future_end_utc = now_utc + timedelta(hours=FUTURE_SEARCH_HOURS)
    tracked_upcoming_passes = calculate_passes(now_utc, future_end_utc, tracked_satellites)

    return jsonify({
        "server_time_iso": now_utc.isoformat(),
        "map_refresh_seconds": MAP_REFRESH_SECONDS,
        "satellite_map": get_satellite_map_data(tracked_satellites, tracked_upcoming_passes, now_utc=now_utc)
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)