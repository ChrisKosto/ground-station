window.GlobeModule = (() => {
    const { buildInfoHtml, buildGroundStationHtml } = window.AppUtils;

    let globe = null;
    let stateRef = null;

    let globeHoverSatellite = null;
    let globePinnedSatellite = null;

    let resizeObserver = null;
    let isInitialized = false;

    // Cached data (optimization)
    let cachedPoints = [];
    let cachedPaths = [];
    let cachedPolygons = [];

    function setStateRef(ref) {
        stateRef = ref;
    }

    function getSatelliteColors() {
        return stateRef?.satelliteColors || {};
    }

    function getGroundStation() {
        return stateRef?.groundStation || { lat: 0, lon: 0, name: "GS" };
    }

    function getInfoPanel() {
        return document.getElementById("globe-info-panel");
    }

    function getSatelliteByName(name) {
        return stateRef?.satelliteMapData.find(s => s.name === name) || null;
    }

    // =========================
    // DATA BUILDERS (CACHED)
    // =========================

    function buildPointData() {
        const sats = stateRef?.satelliteMapData || [];

        cachedPoints = sats.map(sat => ({
            name: sat.name,
            lat: sat.current.lat,
            lng: sat.current.lon,
            size: sat.name === "ISS (ZARYA)" ? 1.0 : 0.82,
            color: getSatelliteColors()[sat.name] || "#00d4ff",
            isGroundStation: false
        }));

        cachedPoints.push({
            name: getGroundStation().name,
            lat: getGroundStation().lat,
            lng: getGroundStation().lon,
            size: 0.9,
            color: "#00d4ff",
            isGroundStation: true
        });

        return cachedPoints;
    }

    function buildPathData() {
        const sats = stateRef?.satelliteMapData || [];

        cachedPaths = sats
            .map(sat => {
                if (!sat.track || sat.track.length < 2) return null;

                return {
                    satName: sat.name,
                    color: getSatelliteColors()[sat.name] || "#00d4ff",
                    stroke: sat.name === "ISS (ZARYA)" ? 0.55 : 0.42,
                    points: sat.track.map(p => ({
                        lat: p.lat,
                        lng: p.lon,
                        alt: sat.name === "ISS (ZARYA)" ? 0.03 : 0.022
                    }))
                };
            })
            .filter(Boolean);

        return cachedPaths;
    }

    function buildFootprintPolygon(sat) {
        if (!sat || !sat.current || !sat.footprint_radius_km) return [];

        const lat0 = sat.current.lat * Math.PI / 180;
        const lon0 = sat.current.lon * Math.PI / 180;
        const angularDistance = sat.footprint_radius_km / 6371.0;

        const points = [];
        const stepDeg = 3;

        for (let bearingDeg = 0; bearingDeg <= 360; bearingDeg += stepDeg) {
            const bearing = bearingDeg * Math.PI / 180;

            const lat = Math.asin(
                Math.sin(lat0) * Math.cos(angularDistance) +
                Math.cos(lat0) * Math.sin(angularDistance) * Math.cos(bearing)
            );

            const lon = lon0 + Math.atan2(
                Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat0),
                Math.cos(angularDistance) - Math.sin(lat0) * Math.sin(lat)
            );

            let lonDeg = lon * 180 / Math.PI;
            while (lonDeg > 180) lonDeg -= 360;
            while (lonDeg < -180) lonDeg += 360;

            points.push([lat * 180 / Math.PI, lonDeg]);
        }

        return points;
    }

    function buildPolygonData() {
        const sat = globePinnedSatellite || globeHoverSatellite;
        if (!sat) return [];

        const polygon = buildFootprintPolygon(sat);
        if (!polygon.length) return [];

        const color = getSatelliteColors()[sat.name] || "#00d4ff";

        cachedPolygons = [{
            satName: sat.name,
            color: color,
            coords: [polygon],
            capColor: color,
            strokeColor: color
        }];

        return cachedPolygons;
    }

    // =========================
    // UI OVERLAY
    // =========================

    function renderOverlay() {
        const panel = getInfoPanel();
        const sat = globePinnedSatellite || globeHoverSatellite;

        if (!panel) return;

        if (!sat) {
            panel.classList.add("hidden");
        } else {
            panel.innerHTML = buildInfoHtml(sat);
            panel.classList.remove("hidden");
        }

        if (globe) {
            globe.polygonsData(buildPolygonData());
        }
    }

    // =========================
    // SIZE HANDLING
    // =========================

    function resizeGlobe() {
        if (!globe) return;

        const wrapper = document.getElementById("globe-map-wrapper");
        if (!wrapper) return;

        const width = wrapper.clientWidth;
        const height = wrapper.clientHeight;

        if (width > 0 && height > 0) {
            globe.width(width);
            globe.height(height);
        }
    }

    function setupResizeObserver() {
        const wrapper = document.getElementById("globe-map-wrapper");
        if (!wrapper) return;

        resizeObserver = new ResizeObserver(() => {
            resizeGlobe();
        });

        resizeObserver.observe(wrapper);
    }

    // =========================
    // CAMERA
    // =========================

    function focusOnSatellite(sat, ms = 800) {
        if (!globe || !sat) return;

        globe.pointOfView(
            {
                lat: sat.current.lat,
                lng: sat.current.lon,
                altitude: 1.8
            },
            ms
        );
    }

    // =========================
    // INIT
    // =========================

    function init(containerId) {
        if (isInitialized) return;

        const container = document.getElementById(containerId);

        globe = Globe()(container)
            .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-night.jpg")
            .bumpImageUrl("https://unpkg.com/three-globe/example/img/earth-topology.png")
            .backgroundColor("rgba(0,0,0,0)")
            .showAtmosphere(true)
            .atmosphereColor("#4cc9ff")
            .atmosphereAltitude(0.16)

            // POINTS
            .pointsData(buildPointData())
            .pointLat(d => d.lat)
            .pointLng(d => d.lng)
            .pointAltitude(d => d.isGroundStation ? 0.01 : 0.03)
            .pointRadius(d => d.size)
            .pointColor(d => d.color)
            .pointsMerge(false)

            // PATHS
            .pathsData(buildPathData())
            .pathPoints(d => d.points)
            .pathPointLat(p => p.lat)
            .pathPointLng(p => p.lng)
            .pathPointAlt(p => p.alt)
            .pathColor(d => d.color)
            .pathStroke(d => d.stroke)
            .pathResolution(1)
            .pathDashLength(0.55)
            .pathDashGap(0.18)
            .pathDashInitialGap(() => Math.random())
            .pathDashAnimateTime(5000)
            .pathTransitionDuration(0)

            // POLYGONS
            .polygonsData(buildPolygonData())
            .polygonGeoJsonGeometry(d => ({
                type: "Polygon",
                coordinates: [d.coords[0].map(([lat, lng]) => [lng, lat])]
            }))
            .polygonCapColor(d => `${d.capColor}22`)
            .polygonSideColor(() => "rgba(0,0,0,0)")
            .polygonStrokeColor(d => d.strokeColor)
            .polygonAltitude(0.0025)

            // GROUND STATION ICON
            .htmlElementsData(buildPointData().filter(p => p.isGroundStation))
            .htmlLat(d => d.lat)
            .htmlLng(d => d.lng)
            .htmlElement(() => {
                const el = document.createElement("div");
                el.innerHTML = "📡";
                el.style.color = "#00d4ff";
                el.style.fontSize = "16px";
                el.style.textShadow = "0 0 10px rgba(0,212,255,0.8)";
                el.style.pointerEvents = "none";
                return el;
            })

            // EVENTS
            .onPointHover(point => {
                if (globePinnedSatellite) return;

                if (point && !point.isGroundStation) {
                    globeHoverSatellite = getSatelliteByName(point.name);
                } else {
                    globeHoverSatellite = null;
                }

                renderOverlay();
            })

            .onPointClick(point => {
                if (!point) return;

                if (point.isGroundStation) {
                    globePinnedSatellite = null;
                    globeHoverSatellite = null;

                    const panel = getInfoPanel();
                    panel.innerHTML = buildGroundStationHtml(getGroundStation());
                    panel.classList.remove("hidden");

                    globe.polygonsData([]);
                    return;
                }

                globePinnedSatellite = getSatelliteByName(point.name);
                globeHoverSatellite = null;

                renderOverlay();
                focusOnSatellite(globePinnedSatellite, 900);
            });

        const controls = globe.controls();
        controls.autoRotate = false;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.7;
        controls.minDistance = 180;
        controls.maxDistance = 350;
        controls.zoomSpeed = 0.8;

        resizeGlobe();
        setupResizeObserver();

        globe.pointOfView({ lat: 20, lng: 10, altitude: 2.2 }, 0);

        isInitialized = true;
    }

    // =========================
    // UPDATE
    // =========================

    function updateData() {
        if (!globe) return;

        if (globePinnedSatellite) {
            globePinnedSatellite = getSatelliteByName(globePinnedSatellite.name);
        }

        if (globeHoverSatellite) {
            globeHoverSatellite = getSatelliteByName(globeHoverSatellite.name);
        }

        globe.pointsData(buildPointData());
        globe.pathsData(buildPathData());

        resizeGlobe();
        renderOverlay();
    }

    function show() {
        setTimeout(() => {
            resizeGlobe();
        }, 100);
    }

    function clearPin() {
        globePinnedSatellite = null;
        globeHoverSatellite = null;

        const panel = getInfoPanel();
        if (panel) panel.classList.add("hidden");

        if (globe) {
            globe.polygonsData([]);
        }
    }

    function isGlobeInitialized() {
        return isInitialized;
    }

    function onResize() {
        resizeGlobe();
    }

    return {
        setStateRef,
        init,
        updateData,
        show,
        clearPin,
        isInitialized: isGlobeInitialized,
        onResize
    };
})();