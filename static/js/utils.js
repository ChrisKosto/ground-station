window.AppUtils = (() => {
    function formatCountdown(diffMs) {
        if (diffMs <= 0) return "00:00:00";

        const totalSeconds = Math.floor(diffMs / 1000);
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
        const seconds = String(totalSeconds % 60).padStart(2, "0");

        return `${hours}:${minutes}:${seconds}`;
    }

    function formatEtaFromIso(isoString) {
        if (!isoString) return "N/A";

        const target = new Date(isoString);
        const now = new Date();
        const diffMs = target - now;

        if (diffMs <= 0) return "N/A";

        const totalSeconds = Math.floor(diffMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function getVisibilityClass(level) {
        if (level === "high") return "vis-high";
        if (level === "medium") return "vis-medium";
        return "vis-low";
    }

    function buildInfoHtml(sat) {
        const vis = sat.visibility || { status: "N/A", level: "low", elevation: "N/A" };
        const liveEta = formatEtaFromIso(sat.next_pass_iso);

        return `
            <div class="sat-tooltip-title">${sat.name}</div>
            <div class="vis-pill ${getVisibilityClass(vis.level)}">${vis.status}</div>
            <div class="sat-tooltip-line">Elevation: ${vis.elevation}°</div>
            <div class="sat-tooltip-line">Altitude: ${sat.altitude_km} km</div>
            <div class="sat-tooltip-line">Estimated time: ${liveEta}</div>
            <div class="sat-tooltip-line sat-tooltip-muted">Next pass: ${sat.next_pass_time}</div>
            <div class="sat-tooltip-line sat-tooltip-muted">Footprint: ${sat.footprint_radius_km} km</div>
            <div class="sat-tooltip-line sat-tooltip-muted">Lat: ${sat.current.lat}</div>
            <div class="sat-tooltip-line sat-tooltip-muted">Lon: ${sat.current.lon}</div>
        `;
    }

    function buildGroundStationHtml(groundStation) {
        return `
            <div class="sat-tooltip-title">${groundStation.name}</div>
            <div class="sat-tooltip-line">Lat: ${groundStation.lat}</div>
            <div class="sat-tooltip-line">Lon: ${groundStation.lon}</div>
            <div class="sat-tooltip-line sat-tooltip-muted">Primary observer location</div>
        `;
    }

    function splitTrackAtDateline(trackPoints) {
        const segments = [];
        let currentSegment = [];

        for (let i = 0; i < trackPoints.length; i++) {
            const current = trackPoints[i];
            const latLng = [current.lat, current.lon];

            if (currentSegment.length === 0) {
                currentSegment.push(latLng);
                continue;
            }

            const previous = trackPoints[i - 1];
            const lonDiff = Math.abs(current.lon - previous.lon);

            if (lonDiff > 180) {
                if (currentSegment.length > 1) {
                    segments.push(currentSegment);
                }
                currentSegment = [latLng];
            } else {
                currentSegment.push(latLng);
            }
        }

        if (currentSegment.length > 1) {
            segments.push(currentSegment);
        }

        return segments;
    }

    function interpolateLon(fromLon, toLon, t) {
        let delta = toLon - fromLon;

        if (Math.abs(delta) > 180) {
            if (delta > 0) delta -= 360;
            else delta += 360;
        }

        let interpolated = fromLon + delta * t;

        while (interpolated > 180) interpolated -= 360;
        while (interpolated < -180) interpolated += 360;

        return interpolated;
    }

    return {
        formatCountdown,
        formatEtaFromIso,
        getVisibilityClass,
        buildInfoHtml,
        buildGroundStationHtml,
        splitTrackAtDateline,
        interpolateLon
    };
})();