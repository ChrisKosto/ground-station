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
    let globalClickHandlerInstalled = false;

    let stateRef = null;

    function setStateRef(ref) {
        stateRef = ref;
    }

    function getSatelliteColors() {
        return stateRef?.satelliteColors || {};
    }

    function getGroundStation() {
        return stateRef?.groundStation || { lat: 0, lon: 0, name: "Ground Station" };
    }

    function getSatelliteNamesFromState() {
        return new Set((stateRef?.satelliteMapData || []).map(s => s.name));
    }

    function init(containerId) {
        if (map) return;

        map = L.map(containerId, {
            worldCopyJump: true,
            preferCanvas: true
        }).setView([20, 0], 2);

        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: "&copy; OpenStreetMap &copy; CARTO"
        }).addTo(map);

        addGroundStationMarker();
        initializeSatelliteLayers(stateRef?.satelliteMapData || []);
        installGlobalClickToClose();
        startMapAnimationLoop();
    }

    function addGroundStationMarker() {
        const station = getGroundStation();

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

        groundStationMarker = L.marker([station.lat, station.lon], {
            icon: icon,
            zIndexOffset: 1000
        }).addTo(map);

        groundStationMarker.bindPopup(buildGroundStationHtml(station), {
            autoClose: false,
            closeOnClick: false
        });

        groundStationHalo = L.circleMarker([station.lat, station.lon], {
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
        if (!sat || !map || !sat.current) return;

        const radiusMeters = Math.max(0, (sat.footprint_radius_km || 0) * 1000);
        const color = getSatelliteColors()[sat.name] || "#00d4ff";

        if (!activeFootprintCircle) {
            activeFootprintCircle = L.circle([sat.current.lat, sat.current.lon], {
                radius: radiusMeters,
                color: color,
                weight: 1.2,
                opacity: 0.22,
                fillColor: color,
                fillOpacity: 0.035,
                interactive: false
            }).addTo(map);
            return;
        }

        activeFootprintCircle.setLatLng([sat.current.lat, sat.current.lon]);
        activeFootprintCircle.setRadius(radiusMeters);
        activeFootprintCircle.setStyle({
            color: color,
            fillColor: color
        });
    }

    function hideSatelliteFootprint() {
        if (activeFootprintCircle && map) {
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
            applyMarkerStyle(obj, false);
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
        syncInfoContentForObject(obj);
        obj.marker.openPopup();
        showSatelliteFootprint(obj.tooltipData);
    }

    function installGlobalClickToClose() {
        if (globalClickHandlerInstalled) return;

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

            if (stateRef && typeof stateRef.clearGlobePin === "function") {
                stateRef.clearGlobePin();
            }
        });

        globalClickHandlerInstalled = true;
    }

    function applyMarkerStyle(obj, isHovering) {
        if (!obj || !obj.marker) return;

        obj.marker.setStyle({
            radius: isHovering ? obj.hoverRadius : obj.baseRadius,
            weight: isHovering ? obj.hoverWeight : obj.baseWeight
        });
    }

    function handleSatelliteMouseOver(satName) {
        const obj = satelliteObjects[satName];
        if (!obj) return;

        obj.isHovering = true;
        applyMarkerStyle(obj, true);

        if (!obj.isPinned) {
            syncInfoContentForObject(obj);
            obj.marker.openTooltip();
            showSatelliteFootprint(obj.tooltipData);
        }
    }

    function handleSatelliteMouseOut(satName) {
        const obj = satelliteObjects[satName];
        if (!obj) return;

        obj.isHovering = false;
        applyMarkerStyle(obj, false);

        if (!obj.isPinned) {
            obj.marker.closeTooltip();
            hideSatelliteFootprint();
        }
    }

    function buildMarkerOptions(color, isIss, baseRadius, baseWeight) {
        return {
            radius: baseRadius,
            color: color,
            fillColor: color,
            fillOpacity: isIss ? 1 : 0.95,
            weight: baseWeight,
            bubblingMouseEvents: false
        };
    }

    function buildTrackPolyline(segment, color, isIss) {
        return L.polyline(segment, {
            color: color,
            weight: isIss ? 3.5 : 3,
            opacity: isIss ? 0.95 : 0.82,
            interactive: false
        }).addTo(map);
    }

    function createSatelliteLayer(sat) {
        const color = getSatelliteColors()[sat.name] || "#00d4ff";
        const isIss = sat.name === "ISS (ZARYA)";

        const baseRadius = isIss ? 10 : 9;
        const hoverRadius = isIss ? 12 : 11;
        const baseWeight = 2;
        const hoverWeight = 2.8;

        const marker = L.circleMarker(
            [sat.current.lat, sat.current.lon],
            buildMarkerOptions(color, isIss, baseRadius, baseWeight)
        ).addTo(map);

        const initialInfoHtml = buildInfoHtml(sat);

        marker.bindTooltip(initialInfoHtml, {
            direction: "top",
            offset: [0, -12],
            sticky: false,
            permanent: false,
            className: "satellite-tooltip",
            opacity: 1
        });

        marker.bindPopup(initialInfoHtml, {
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
        const polylines = trackSegments.map(segment => buildTrackPolyline(segment, color, isIss));

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
            isIss,
            baseRadius,
            hoverRadius,
            baseWeight,
            hoverWeight,
            lastInfoHtml: initialInfoHtml
        };
    }

    function removeSatelliteLayer(satName) {
        const obj = satelliteObjects[satName];
        if (!obj || !map) return;

        if (pinnedSatelliteName === satName) {
            pinnedSatelliteName = null;
            hideSatelliteFootprint();
        }

        if (obj.marker) {
            map.removeLayer(obj.marker);
        }

        if (obj.polylines && obj.polylines.length) {
            obj.polylines.forEach(polyline => map.removeLayer(polyline));
        }

        delete satelliteObjects[satName];
    }

    function pruneRemovedSatellites() {
        const currentNames = getSatelliteNamesFromState();

        for (const satName in satelliteObjects) {
            if (!currentNames.has(satName)) {
                removeSatelliteLayer(satName);
            }
        }
    }

    function initializeSatelliteLayers(satellites) {
        for (const sat of satellites) {
            if (!satelliteObjects[sat.name]) {
                createSatelliteLayer(sat);
            }
        }
    }

    function ensurePolylineCount(obj, requiredCount, color, isIss) {
        while (obj.polylines.length < requiredCount) {
            obj.polylines.push(buildTrackPolyline([], color, isIss));
        }

        while (obj.polylines.length > requiredCount) {
            const polyline = obj.polylines.pop();
            map.removeLayer(polyline);
        }
    }

    function updateSatelliteTracks(sat) {
        const obj = satelliteObjects[sat.name];
        if (!obj) return;

        const color = getSatelliteColors()[sat.name] || "#00d4ff";
        const trackSegments = splitTrackAtDateline(sat.track || []);

        ensurePolylineCount(obj, trackSegments.length, color, obj.isIss);

        for (let i = 0; i < trackSegments.length; i++) {
            obj.polylines[i].setLatLngs(trackSegments[i]);
        }
    }

    function syncInfoContentForObject(obj) {
        if (!obj || !obj.tooltipData) return;

        const nextHtml = buildInfoHtml(obj.tooltipData);

        if (nextHtml === obj.lastInfoHtml) return;

        obj.lastInfoHtml = nextHtml;
        obj.marker.setTooltipContent(nextHtml);
        obj.marker.setPopupContent(nextHtml);
    }

    function updateSatelliteTarget(sat) {
        const obj = satelliteObjects[sat.name];
        if (!obj) return;

        obj.fromLat = obj.displayLat;
        obj.fromLon = obj.displayLon;
        obj.targetLat = sat.current.lat;
        obj.targetLon = sat.current.lon;
        obj.tooltipData = sat;

        syncInfoContentForObject(obj);
        updateSatelliteTracks(sat);

        if (obj.isPinned) {
            obj.marker.openPopup();
            showSatelliteFootprint(obj.tooltipData);
        }
    }

    function syncSatelliteLayers(satellites) {
        pruneRemovedSatellites();
        initializeSatelliteLayers(satellites);

        for (const sat of satellites) {
            updateSatelliteTarget(sat);
        }
    }

    function animateMarkers(t) {
        for (const satName in satelliteObjects) {
            const obj = satelliteObjects[satName];

            const lat = obj.fromLat + (obj.targetLat - obj.fromLat) * t;
            const lon = interpolateLon(obj.fromLon, obj.targetLon, t);

            obj.displayLat = lat;
            obj.displayLon = lon;

            obj.marker.setLatLng([lat, lon]);
        }

        if (activeFootprintCircle && pinnedSatelliteName) {
            const pinnedObj = satelliteObjects[pinnedSatelliteName];
            if (pinnedObj && pinnedObj.tooltipData) {
                activeFootprintCircle.setLatLng([
                    pinnedObj.displayLat,
                    pinnedObj.displayLon
                ]);
            }
        }
    }

    function startMapAnimationLoop() {
        function animate() {
            const now = performance.now();
            const durationMs = Math.max(250, (stateRef?.mapRefreshSeconds || 5) * 1000);
            const t = Math.min((now - lastMapPayloadTime) / durationMs, 1);

            animateMarkers(t);
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

            const nextHtml = buildInfoHtml(obj.tooltipData);

            if (nextHtml !== obj.lastInfoHtml) {
                obj.lastInfoHtml = nextHtml;
                obj.marker.setTooltipContent(nextHtml);
                obj.marker.setPopupContent(nextHtml);
            }

            if (obj.isPinned) {
                obj.marker.openPopup();
                showSatelliteFootprint(obj.tooltipData);
            }
        }
    }

    function onMapDataUpdated() {
        lastMapPayloadTime = performance.now();
        syncSatelliteLayers(stateRef?.satelliteMapData || []);
    }

    function invalidateSize() {
        if (map) {
            map.invalidateSize();
        }
    }

    function destroy() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        closePinnedPopup();

        for (const satName in satelliteObjects) {
            removeSatelliteLayer(satName);
        }

        if (groundStationHalo && map) {
            map.removeLayer(groundStationHalo);
            groundStationHalo = null;
        }

        if (groundStationMarker && map) {
            map.removeLayer(groundStationMarker);
            groundStationMarker = null;
        }

        if (map) {
            map.remove();
            map = null;
        }
    }

    return {
        setStateRef,
        init,
        refreshOpenInfoContent,
        onMapDataUpdated,
        invalidateSize,
        closePinnedPopup,
        destroy
    };
})();