window.GlobeModule = (() => {
    const { buildInfoHtml, buildGroundStationHtml } = window.AppUtils;

    let globe = null;
    let globeHoverSatellite = null;
    let globePinnedSatellite = null;
    let globeResizeTimeout = null;
    let stateRef = null;

    function setStateRef(ref) {
        stateRef = ref;
    }

    function getSatelliteColors() {
        return stateRef.satelliteColors;
    }

    function getGroundStation() {
        return stateRef.groundStation;
    }

    function getInfoPanel() {
        return document.getElementById("globe-info-panel");
    }

    function getSatelliteByName(name) {
        return stateRef.satelliteMapData.find(s => s.name === name) || null;
    }

    function getGlobePointObjects() {
        const points = stateRef.satelliteMapData.map(sat => ({
            ...sat,
            lat: sat.current.lat,
            lng: sat.current.lon,
            size: sat.name === "ISS (ZARYA)" ? 1.0 : 0.82,
            color: getSatelliteColors()[sat.name] || "#00d4ff",
            isGroundStation: false
        }));

        points.push({
            name: getGroundStation().name,
            lat: getGroundStation().lat,
            lng: getGroundStation().lon,
            size: 0.9,
            color: "#00d4ff",
            isGroundStation: true
        });

        return points;
    }

    function getSmoothOrbitPathData() {
        return stateRef.satelliteMapData
            .map(sat => {
                const track = sat.track || [];
                if (track.length < 2) return null;

                const altitude = sat.name === "ISS (ZARYA)" ? 0.03 : 0.022;

                return {
                    satName: sat.name,
                    color: getSatelliteColors()[sat.name] || "#00d4ff",
                    stroke: sat.name === "ISS (ZARYA)" ? 0.55 : 0.42,
                    points: track.map(p => ({
                        lat: p.lat,
                        lng: p.lon,
                        alt: altitude
                    }))
                };
            })
            .filter(Boolean);
    }

    function getFootprintPolygonPoints(sat) {
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

    function getPolygonData() {
        const sat = globePinnedSatellite || globeHoverSatellite;
        if (!sat) return [];

        const polygon = getFootprintPolygonPoints(sat);
        if (!polygon.length) return [];

        const color = getSatelliteColors()[sat.name] || "#00d4ff";

        return [{
            satName: sat.name,
            color: color,
            coords: [polygon],
            capColor: color,
            sideColor: color,
            strokeColor: color
        }];
    }

    function renderGlobeOverlay() {
        const panel = getInfoPanel();
        const sat = globePinnedSatellite || globeHoverSatellite;

        if (!sat) {
            panel.classList.add("hidden");
        } else {
            panel.innerHTML = buildInfoHtml(sat);
            panel.classList.remove("hidden");
        }

        if (globe) {
            globe.polygonsData(getPolygonData());
        }
    }

    function sizeGlobeRenderer() {
        if (!globe) return;

        const wrapper = document.getElementById("globe-map-wrapper");
        const width = wrapper.clientWidth;
        const height = wrapper.clientHeight;

        if (width > 0 && height > 0) {
            globe.width(width);
            globe.height(height);
        }
    }

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

    function init(containerId) {
        const container = document.getElementById(containerId);

        globe = Globe()(container)
            .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-night.jpg")
            .bumpImageUrl("https://unpkg.com/three-globe/example/img/earth-topology.png")
            .backgroundColor("rgba(0,0,0,0)")
            .showAtmosphere(true)
            .atmosphereColor("#4cc9ff")
            .atmosphereAltitude(0.16)

            .pointsData(getGlobePointObjects())
            .pointLat(d => d.lat)
            .pointLng(d => d.lng)
            .pointAltitude(d => d.isGroundStation ? 0.01 : 0.03)
            .pointRadius(d => d.size)
            .pointColor(d => d.color)
            .pointsMerge(false)

            .pathsData(getSmoothOrbitPathData())
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

            .polygonsData(getPolygonData())
            .polygonGeoJsonGeometry(d => ({
                type: "Polygon",
                coordinates: [d.coords[0].map(([lat, lng]) => [lng, lat])]
            }))
            .polygonCapColor(d => `${d.capColor}22`)
            .polygonSideColor(() => "rgba(0,0,0,0)")
            .polygonStrokeColor(d => d.strokeColor)
            .polygonAltitude(0.0025)

            .htmlElementsData(getGlobePointObjects().filter(p => p.isGroundStation))
            .htmlLat(point => point.lat)
            .htmlLng(point => point.lng)
            .htmlElement(() => {
                const el = document.createElement("div");
                el.innerHTML = "📡";
                el.style.color = "#00d4ff";
                el.style.fontSize = "16px";
                el.style.textShadow = "0 0 10px rgba(0,212,255,0.8)";
                el.style.pointerEvents = "none";
                return el;
            })

            .onPointHover(point => {
                if (globePinnedSatellite) return;

                if (point && !point.isGroundStation) {
                    globeHoverSatellite = getSatelliteByName(point.name);
                } else {
                    globeHoverSatellite = null;
                }

                renderGlobeOverlay();
            })

            .onPointClick(point => {
                if (!point) return;

                if (point.isGroundStation) {
                    globePinnedSatellite = null;
                    globeHoverSatellite = null;
                    getInfoPanel().innerHTML = buildGroundStationHtml(getGroundStation());
                    getInfoPanel().classList.remove("hidden");

                    if (globe) {
                        globe.polygonsData([]);
                    }
                    return;
                }

                globePinnedSatellite = getSatelliteByName(point.name);
                globeHoverSatellite = null;
                renderGlobeOverlay();
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
        controls.panSpeed = 0.8;

        sizeGlobeRenderer();
        globe.pointOfView({ lat: 20, lng: 10, altitude: 2.2 }, 0);
    }

    function updateData() {
        if (!globe) return;

        if (globePinnedSatellite) {
            const refreshedPinned = getSatelliteByName(globePinnedSatellite.name);
            globePinnedSatellite = refreshedPinned || null;
        }

        if (globeHoverSatellite) {
            const refreshedHover = getSatelliteByName(globeHoverSatellite.name);
            globeHoverSatellite = refreshedHover || null;
        }

        globe.pointsData(getGlobePointObjects());
        globe.pathsData(getSmoothOrbitPathData());

        sizeGlobeRenderer();
        renderGlobeOverlay();
    }

    function show() {
        setTimeout(() => {
            if (!globe) {
                init("globe-view");
            } else {
                sizeGlobeRenderer();
                updateData();
            }

            clearTimeout(globeResizeTimeout);
            globeResizeTimeout = setTimeout(() => {
                sizeGlobeRenderer();
                updateData();
            }, 250);
        }, 80);
    }

    function clearPin() {
        globePinnedSatellite = null;
        globeHoverSatellite = null;
        renderGlobeOverlay();
    }

    function onResize() {
        if (!globe) return;
        sizeGlobeRenderer();
        updateData();
    }

    function isInitialized() {
        return !!globe;
    }

    return {
        setStateRef,
        show,
        updateData,
        clearPin,
        onResize,
        isInitialized,
        renderGlobeOverlay
    };
})();