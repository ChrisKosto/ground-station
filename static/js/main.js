(() => {
    const state = {
        nextPassIso: window.APP_DATA.nextPassIso,
        satelliteMapData: window.APP_DATA.satelliteMapData,
        mapRefreshSeconds: window.APP_DATA.mapRefreshSeconds,
        dashboardData: window.APP_DATA.initialDashboardData,
        groundStation: window.APP_DATA.groundStation,
        satelliteColors: window.APP_DATA.satelliteColors,
        currentView: "flat",
        clearGlobePin: null
    };

    window.FlatMapModule.setStateRef(state);
    window.GlobeModule.setStateRef(state);

    state.clearGlobePin = () => {
        window.GlobeModule.clearPin();
    };

    function updateCountdown() {
        const countdownEl = document.getElementById("countdown");

        if (!state.nextPassIso) {
            countdownEl.textContent = "--:--:--";
            return;
        }

        const target = new Date(state.nextPassIso);
        const now = new Date();
        const diff = target - now;

        countdownEl.textContent = window.AppUtils.formatCountdown(diff);
    }

    function renderPassesTable(passes) {
        const tbody = document.getElementById("passes-table-body");
        tbody.innerHTML = "";

        if (!passes || passes.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">Δεν βρέθηκαν upcoming passes.</td>
                </tr>
            `;
            return;
        }

        for (const p of passes) {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${p.sat}</td>
                <td>${p.rise_time}</td>
                <td>${p.culmination_time}</td>
                <td>${p.set_time}</td>
                <td>${p.max_elevation}°</td>
                <td>${p.duration_min}</td>
            `;
            tbody.appendChild(row);
        }
    }

    function updateDashboard(data) {
        document.getElementById("last-pass-satellite").textContent = data.last_pass.satellite;
        document.getElementById("last-pass-time").textContent = data.last_pass.time;
        document.getElementById("last-pass-image").src = data.last_pass.image;

        document.getElementById("next-pass-sat").textContent = data.next_pass.sat;
        document.getElementById("next-pass-time").textContent = data.next_pass.time;
        document.getElementById("next-pass-elev").textContent = data.next_pass.elev;
        document.getElementById("next-pass-duration").textContent = data.next_pass.duration;

        state.nextPassIso = data.next_pass.time_iso;
        renderPassesTable(data.upcoming_passes);
        updateCountdown();
    }

    function switchView(viewName) {
        state.currentView = viewName;

        const flatWrapper = document.getElementById("flat-map-wrapper");
        const globeWrapper = document.getElementById("globe-map-wrapper");
        const flatBtn = document.getElementById("flat-view-btn");
        const globeBtn = document.getElementById("globe-view-btn");

        if (viewName === "flat") {
            flatWrapper.classList.remove("hidden-view");
            globeWrapper.classList.add("hidden-view");
            flatBtn.classList.add("active");
            globeBtn.classList.remove("active");
            setTimeout(() => window.FlatMapModule.invalidateSize(), 100);
        } else {
            globeWrapper.classList.remove("hidden-view");
            flatWrapper.classList.add("hidden-view");
            globeBtn.classList.add("active");
            flatBtn.classList.remove("active");
            window.GlobeModule.show();
        }
    }

    async function fetchPasses() {
        try {
            const response = await fetch("/api/passes");
            const data = await response.json();
            state.dashboardData = data;
            updateDashboard(data);
        } catch (error) {
            console.error("Error fetching pass data:", error);
        }
    }

    async function fetchMapOnly() {
        try {
            const response = await fetch("/api/map");
            const data = await response.json();

            if (typeof data.map_refresh_seconds === "number") {
                state.mapRefreshSeconds = data.map_refresh_seconds;
                document.getElementById("map-refresh-note").textContent =
                    `Ο χάρτης ανανεώνεται κάθε ${state.mapRefreshSeconds} δευτερόλεπτα`;
            }

            state.satelliteMapData = data.satellite_map || [];
            window.FlatMapModule.onMapDataUpdated();
            window.GlobeModule.updateData();
        } catch (error) {
            console.error("Error fetching map data:", error);
        }
    }

    function startInfoRefreshLoop() {
        setInterval(() => {
            window.FlatMapModule.refreshOpenInfoContent();
            window.GlobeModule.renderGlobeOverlay();
        }, 1000);
    }

    function init() {
        window.FlatMapModule.init("satellite-map");
        updateCountdown();
        startInfoRefreshLoop();

        document.getElementById("flat-view-btn").addEventListener("click", () => switchView("flat"));
        document.getElementById("globe-view-btn").addEventListener("click", () => switchView("globe"));

        window.addEventListener("resize", () => {
            if (state.currentView === "flat") {
                window.FlatMapModule.invalidateSize();
            } else if (window.GlobeModule.isInitialized()) {
                window.GlobeModule.onResize();
            }
        });

        setInterval(updateCountdown, 1000);
        setInterval(fetchMapOnly, state.mapRefreshSeconds * 1000);
        setInterval(fetchPasses, 60000);
    }

    init();
})();