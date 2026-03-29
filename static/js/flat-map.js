window.FlatMapModule = (() => {
    const {
        buildInfoHtml,
        buildGroundStationHtml,
        splitTrackAtDateline,
        interpolateLon
    } = window.AppUtils;

    let map = null;
    let groundStationMarker = null;
    let groundStationHalo = null;
    let activeFootprintCircle = null;

    const satelliteObjects = {};
    let animationFrameId = null;
    let lastMapPayloadTime = performance.now();
    let pinnedSatelliteName = null;

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

    function init(containerId) {
        map = L.map(containerId, {
            worldCopyJump: true
        }).setView([20, 0], 2);

        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: "&copy; OpenStreetMap &copy; CARTO"
        }).addTo(map);

        addGroundStationMarker();
        initializeSatelliteLayers(stateRef.satelliteMapData);
        installGlobalClickToClose();
        startMapAnimationLoop();
    }

    function addGroundStationMarker() {
        const icon = L.divIcon({
            className: "",
            html: `
                <div class="ground-station-icon">
                    <div class="ground-station-pulse"></div>
                    <div class="ground-station-pulse delay"></div>
                    <div class="ground-station-core"></div>
                </div>
            `,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        groundStationMarker = L.marker([getGroundStation().lat, getGroundStation().lon], {
            icon: icon,
            zIndexOffset: 1000
        }).addTo(map);

        groundStationMarker.bindPopup(buildGroundStationHtml(getGroundStation()), {
            autoClose: false,
            closeOnClick: false
        });

        groundStationHalo = L.circleMarker([getGroundStation().lat, getGroundStation().lon], {
            radius: 14,
            color: "#00d4ff",
            weight: 1.5,
            opacity: 0.35,
            fillColor: "#00d4ff",
            fillOpacity: 0.06,
            interactive: false
        }).addTo(map);
    }

    function showSatelliteFootprint(sat) {
        if (!sat || !map) return;

        hideSatelliteFootprint();

        activeFootprintCircle = L.circle([sat.current.lat, sat.current.lon], {
            radius: (sat.footprint_radius_km || 0) * 1000,
            color: getSatelliteColors()[sat.name] || "#00d4ff",
            weight: 1.2,
            opacity: 0.22,
            fillColor: getSatelliteColors()[sat.name] || "#00d4ff",
            fillOpacity: 0.035,
            interactive: false
        }).addTo(map);
    }

    function hideSatelliteFootprint() {
        if (activeFootprintCircle) {
            map.removeLayer(activeFootprintCircle);
            activeFootprintCircle = null;
        }
    }

    function closePinnedPopup() {
        if (!pinnedSatelliteName) return;

        const obj = satelliteObjects[pinnedSatelliteName];
        if (obj) {
            obj.marker.closePopup();
            obj.isPinned = false;
            obj.isHovering = false;
            obj.marker.setStyle({
                radius: obj.baseRadius,
                weight: obj.baseWeight
            });
        }

        pinnedSatelliteName = null;
        hideSatelliteFootprint();
    }

    function pinSatellitePopup(satName) {
        if (pinnedSatelliteName && pinnedSatelliteName !== satName) {
            closePinnedPopup();
        }

        const obj = satelliteObjects[satName];
        if (!obj) return;

        pinnedSatelliteName = satName;
        obj.isPinned = true;
        obj.marker.openPopup();
        showSatelliteFootprint(obj.tooltipData);
    }

    function installGlobalClickToClose() {
        document.addEventListener("click", function (event) {
            const clickedMarker = event.target.closest(".leaflet-interactive");
            const clickedTooltip = event.target.closest(".leaflet-tooltip");
            const clickedPopup = event.target.closest(".leaflet-popup");
            const clickedGroundStation = event.target.closest(".ground-station-icon");
            const clickedViewBtn = event.target.closest(".view-btn");
            const clickedGlobeInfo = event.target.closest("#globe-info-panel");

            if (clickedMarker || clickedTooltip || clickedPopup || clickedGroundStation || clickedViewBtn || clickedGlobeInfo) {
                return;
            }

            closePinnedPopup();

            if (groundStationMarker) {
                groundStationMarker.closePopup();
            }

            if (stateRef && stateRef.clearGlobePin) {
                stateRef.clearGlobePin();
            }
        });
    }

    function handleSatelliteMouseOver(satName) {
        const obj = satelliteObjects[satName];
        if (!obj) return;

        obj.isHovering = true;

        obj.marker.setStyle({
            radius: obj.hoverRadius,
            weight: obj.hoverWeight
        });

        if (!obj.isPinned) {
            obj.marker.openTooltip();
            showSatelliteFootprint(obj.tooltipData);
        }
    }

    function handleSatelliteMouseOut(satName) {
        const obj = satelliteObjects[satName];
        if (!obj) return;

        obj.isHovering = false;

        obj.marker.setStyle({
            radius: obj.baseRadius,
            weight: obj.baseWeight
        });

        if (!obj.isPinned) {
            obj.marker.closeTooltip();
            hideSatelliteFootprint();
        }
    }

    function createSatelliteLayer(sat) {
        const color = getSatelliteColors()[sat.name] || "#00d4ff";
        const isIss = sat.name === "ISS (ZARYA)";

        const baseRadius = isIss ? 10 : 9;
        const hoverRadius = isIss ? 12 : 11;
        const baseWeight = 2;
        const hoverWeight = 2.8;

        const marker = L.circleMarker([sat.current.lat, sat.current.lon], {
            radius: baseRadius,
            color: color,
            fillColor: color,
            fillOpacity: 0.95,
            weight: baseWeight,
            bubblingMouseEvents: false
        }).addTo(map);

        marker.bindTooltip(buildInfoHtml(sat), {
            direction: "top",
            offset: [0, -12],
            sticky: false,
            permanent: false,
            className: "satellite-tooltip",
            opacity: 1
        });

        marker.bindPopup(buildInfoHtml(sat), {
            autoClose: false,
            closeOnClick: false,
            autoPan: true
        });

        marker.on("mouseover", function () {
            handleSatelliteMouseOver(sat.name);
        });

        marker.on("mouseout", function () {
            handleSatelliteMouseOut(sat.name);
        });

        marker.on("click", function (e) {
            L.DomEvent.stopPropagation(e);
            pinSatellitePopup(sat.name);
        });

        const trackSegments = splitTrackAtDateline(sat.track || []);
        const polylines = trackSegments.map(segment =>
            L.polyline(segment, {
                color: color,
                weight: isIss ? 3.5 : 3,
                opacity: isIss ? 0.95 : 0.82,
                interactive: false
            }).addTo(map)
        );

        satelliteObjects[sat.name] = {
            marker,
            polylines,
            displayLat: sat.current.lat,
            displayLon: sat.current.lon,
            fromLat: sat.current.lat,
            fromLon: sat.current.lon,
            targetLat: sat.current.lat,
            targetLon: sat.current.lon,
            tooltipData: sat,
            isPinned: false,
            isHovering: false,
            baseRadius,
            hoverRadius,
            baseWeight,
            hoverWeight
        };
    }

    function initializeSatelliteLayers(satellites) {
        for (const sat of satellites) {
            if (!satelliteObjects[sat.name]) {
                createSatelliteLayer(sat);
            }
        }
    }

    function updateSatelliteTracks(sat) {
        const obj = satelliteObjects[sat.name];
        if (!obj) return;

        const trackSegments = splitTrackAtDateline(sat.track || []);

        while (obj.polylines.length < trackSegments.length) {
            const color = getSatelliteColors()[sat.name] || "#00d4ff";
            const polyline = L.polyline([], {
                color: color,
                weight: sat.name === "ISS (ZARYA)" ? 3.5 : 3,
                opacity: sat.name === "ISS (ZARYA)" ? 0.95 : 0.82,
                interactive: false
            }).addTo(map);
            obj.polylines.push(polyline);
        }

        for (let i = 0; i < obj.polylines.length; i++) {
            if (i < trackSegments.length) {
                obj.polylines[i].setLatLngs(trackSegments[i]);
            } else {
                obj.polylines[i].setLatLngs([]);
            }
        }
    }

    function updateSatelliteTarget(sat) {
        const obj = satelliteObjects[sat.name];
        if (!obj) return;

        obj.fromLat = obj.displayLat;
        obj.fromLon = obj.displayLon;
        obj.targetLat = sat.current.lat;
        obj.targetLon = sat.current.lon;
        obj.tooltipData = sat;

        obj.marker.setTooltipContent(buildInfoHtml(sat));
        obj.marker.setPopupContent(buildInfoHtml(sat));
        updateSatelliteTracks(sat);

        if (obj.isPinned) {
            obj.marker.openPopup();
            showSatelliteFootprint(obj.tooltipData);
        }
    }

    function syncSatelliteLayers(satellites) {
        initializeSatelliteLayers(satellites);

        for (const sat of satellites) {
            updateSatelliteTarget(sat);
        }
    }

    function startMapAnimationLoop() {
        function animate() {
            const now = performance.now();
            const durationMs = stateRef.mapRefreshSeconds * 1000;
            const t = Math.min((now - lastMapPayloadTime) / durationMs, 1);

            for (const satName in satelliteObjects) {
                const obj = satelliteObjects[satName];

                const lat = obj.fromLat + (obj.targetLat - obj.fromLat) * t;
                const lon = interpolateLon(obj.fromLon, obj.targetLon, t);

                obj.displayLat = lat;
                obj.displayLon = lon;

                obj.marker.setLatLng([lat, lon]);
            }

            animationFrameId = requestAnimationFrame(animate);
        }

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }

        animationFrameId = requestAnimationFrame(animate);
    }

    function refreshOpenInfoContent() {
        for (const satName in satelliteObjects) {
            const obj = satelliteObjects[satName];
            if (!obj || !obj.tooltipData) continue;

            obj.marker.setTooltipContent(buildInfoHtml(obj.tooltipData));
            obj.marker.setPopupContent(buildInfoHtml(obj.tooltipData));

            if (obj.isPinned) {
                obj.marker.openPopup();
                showSatelliteFootprint(obj.tooltipData);
            }
        }
    }

    function onMapDataUpdated() {
        lastMapPayloadTime = performance.now();
        syncSatelliteLayers(stateRef.satelliteMapData);
    }

    function invalidateSize() {
        if (map) map.invalidateSize();
    }

    return {
        setStateRef,
        init,
        refreshOpenInfoContent,
        onMapDataUpdated,
        invalidateSize,
        closePinnedPopup
    };
})();