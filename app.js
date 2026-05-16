// ======================= CONFIG =======================
const API_URL = "https://data.vatsim.net/v3/vatsim-data.json";

const MODES = {
    oceanic: ["planned", "cruise", "exit"]
};

const state = {
    mode: "oceanic",
    positions: JSON.parse(localStorage.getItem("positions_vstrips") || "{}"),
    orders: JSON.parse(localStorage.getItem("orders_vstrips") || "{}"),
    flights: JSON.parse(localStorage.getItem("flights_vstrips") || "{}")
};

const AIRWAY_DB = [
 "RASKI",
 "PARAR",
 "TOTOX",
 "BISET",
 "REXOD",
 "LEGEN",
 "MEPAT",
 "NINOB",
 "OPIRA",
 "OMDEV",
 "OSUPI",
 "LOTAV",
 "LEMAX",
 "MESAN",
 "NITIX",
 "OSIRI",
 "VASTU",
 "IGAMA",
 "KITAL",
 "LADIB",
 "METIP",
 "NIVUD",
 "OTABI",
 "OLNIK",
 "POMAN",
 "BOLUR",
 "DONSA",
 "GOLEM",
 "ESMIT",
 "BIBGO",
 "APUNA",
 "EGOGI",
 "ODOLI",
 "GOKUM",
 "OLINK",
 "BEDIL",
 "ASPUX",
 "MAMIG",
 "RIGLO",
 "ANGAL",
 "GIDAS",
 "UNRIV",
 "MOXET",
 "UGPEG",
 "ENBAD",
 "GOBIG",
 "ELKEL",
 "RULSA",
 "RIBTO",
 "CLAVA",
 "MAGUG",
 "OMLEV",
 "NABIL",
 "ORLID",
 "VUTAS",
 "OTKIR",
 "GOSGU",
 "BUSUX",
 "LEVLU",
 "PERRY",
 "MURUS"
];

const OCEANIC_FIX_SET = new Set(AIRWAY_DB);

// ======================= DATA =======================
let AIRWAY_INDEX = {};
let FIX_DB = {};
let FIX_COORDS = {};

const AIRWAY_FIX_SET = new Set(AIRWAY_DB);

async function loadData() {
    try {
        AIRWAY_INDEX = await fetch("airway_index.json").then(r => r.json());
        FIX_DB = await fetch("fixdb.json").then(r => r.json());
        const rawCoords = await fetch("fixcoord.json").then(r => r.json());
        FIX_COORDS = {};
        Object.keys(rawCoords).forEach(k => {
            FIX_COORDS[k.toUpperCase().trim()] = rawCoords[k];
        });
        Object.values(AIRWAY_INDEX).forEach(edges => {
            edges.forEach(([a, b]) => {
                AIRWAY_FIX_SET.add(a.toUpperCase().trim());
                AIRWAY_FIX_SET.add(b.toUpperCase().trim());
            });
        });
        console.log("✅ Airway graph loaded");
    } catch (err) {
        console.warn("Data files not found");
    }
}
const loadDataPromise = loadData();

// ======================= HELPERS =======================
function cleanToken(token) {
    if (!token) return [];
    return token.split("/").map(t => t.trim()).filter(t => t.length > 0);
}

function isAirway(token) { return /^[A-Z]\d+[A-Z]*$/.test(token); }
function isProcedure(token) { return /\d+[A-Z]$/.test(token); }
function isRouteDatum(token) { return /^N\d+F\d+$/.test(token) || /^F\d+$/.test(token) || /^M\d+$/.test(token); }

function findPath(start, end, airway) {
    const edges = AIRWAY_INDEX[airway];
    if (!edges) return [];
    let graph = {};
    edges.forEach(([a, b]) => {
        if (!graph[a]) graph[a] = [];
        if (!graph[b]) graph[b] = [];
        graph[a].push(b);
        graph[b].push(a);
    });
    let queue = [[start]];
    let visited = new Set([start]);
    while (queue.length) {
        let path = queue.shift();
        let node = path[path.length - 1];
        if (node === end) return path;
        for (let n of (graph[node] || [])) {
            if (!visited.has(n)) {
                visited.add(n);
                queue.push([...path, n]);
            }
        }
    }
    return [];
}

function expandRoute(tokens) {
    const routeElements = [];
    for (let i = 0; i < tokens.length; i++) {
        const cleaned = cleanToken(tokens[i]);
        for (const token of cleaned) {
            if (isProcedure(token) || isRouteDatum(token)) continue;
            routeElements.push(token);
        }
    }

    const expanded = [];
    const seen = new Set();
    let previousFix = null;
    let pendingAirway = null;

    const addFix = (fix) => {
        const normalized = fix.toUpperCase().trim();
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            expanded.push(normalized);
        }
    };

    for (const token of routeElements) {
        if (isAirway(token)) {
            pendingAirway = token;
            continue;
        }

        addFix(token);

        if (previousFix && pendingAirway) {
            const path = findPath(previousFix, token, pendingAirway);
            if (path.length > 0) {
                path.forEach(fix => addFix(fix));
            }
            pendingAirway = null;
        }

        previousFix = token;
    }

    return expanded;
}

function isOceanicFix(fix) { return OCEANIC_FIX_SET.has(fix); }

function extractRegistration(remarks) {
    if (!remarks || typeof remarks !== 'string') return "----";
    const match = remarks.match(/REG\/([A-Z0-9-]+)/i);
    return match ? match[1] : "----";
}

function expandRouteToFixes(route) {
    if (!route) return [];
    const tokens = route.toUpperCase().match(/[A-Z0-9]+/g) || [];
    console.log('route:', route, 'tokens:', tokens);
    const expanded = expandRoute(tokens);
    console.log('expanded:', expanded);
    return expanded;
}

function normalizeFixes(fixes) {
    return fixes
        .map(fix => (typeof fix === 'string' ? fix.toUpperCase().trim() : ""))
        .filter(fix => fix.length > 0);
}

function matchOceanicFixes(fixes) {
    return normalizeFixes(fixes).filter(fix => OCEANIC_FIX_SET.has(fix));
}

function expandRouteFromVatsim(route) {
    const expanded = expandRouteToFixes(route);
    return matchOceanicFixes(expanded);
}

function getDirectionFromFixes(fixes) {
    if (!fixes || fixes.length < 2) return null;
    const lons = fixes.map(fix => FIX_COORDS[fix]?.lon).filter(lon => typeof lon === "number");
    if (lons.length < 2) return null;
    return lons[lons.length - 1] < lons[0] ? "westbound" : "eastbound";
}

// ======================= ADD STRIPS =======================
async function addOceanicStrip() {
    const input = document.getElementById("oceanicCallsign");
    const callsign = (input.value || "").trim().toUpperCase();
    if (!callsign) return alert("Please enter a callsign");

    try {
        await loadDataPromise;
        const data = await (await fetch(API_URL)).json();
        const p = data.pilots.find(p => p.callsign === callsign);
        if (!p) return alert("Callsign not found on VATSIM");

        const fp = p.flight_plan || {};
        const expandedFixes = expandRouteToFixes(fp.route);
        const matchingFixes = matchOceanicFixes(expandedFixes);
        console.log('expandedFixes:', expandedFixes, 'matchingFixes:', matchingFixes);

        state.flights[callsign] = {
            callsign,
            dep: fp.departure || "----",
            arr: fp.arrival || "----",
            aircraft: fp.aircraft_short || "----",
            cruise: fp.altitude || "----",
            registration: extractRegistration(fp.remarks),
            type: "oceanic",
            prefilledFixes: matchingFixes.length > 0 ? matchingFixes : null,
            stripValues: {
                altitude: parseInt(fp.altitude?.toString().replace(/\D/g, ''), 10) || "",
                fixes: matchingFixes.length > 0 ? matchingFixes : normalizeFixes(expandedFixes),
                mach: "",
                est: [],
                act: []
            }
        };

        state.positions[callsign] ||= getCols()[0];
        saveOrders();
        render();
        input.value = "";
    } catch (err) {
        alert("Failed to fetch from VATSIM");
    }
}

function addCustomStrip() {
    const input = document.getElementById("customStripText");
    const text = (input.value || "").trim();
    if (!text) return alert("Please enter some text for the strip");

    const custom = {
        callsign: "CUSTOM-" + Date.now(),
        aircraft: text,
        dep: "", arr: "", cruise: "----", registration: "",
        prefilledFixes: [],
        stripValues: {
            text
        }
    };

    state.flights[custom.callsign] = custom;
    state.positions[custom.callsign] ||= getCols()[0];
    saveOrders();
    render();
    input.value = "";
}

// ======================= BUILD STRIPS =======================
function buildOceanicStrip(f) {
    const div = document.createElement("div");
    div.className = "strip oceanic";
    div.dataset.callsign = f.callsign;

    let flNum = parseInt(f.cruise.toString().replace(/\D/g, ''), 10) || 0;
    if (flNum >= 1000) flNum = Math.floor(flNum / 100);

    const savedFixes = normalizeFixes(
        (Array.isArray(f.stripValues?.fixes) && f.stripValues.fixes.length > 0)
            ? f.stripValues.fixes
            : (f.prefilledFixes || [])
    );
    const displayFixes = matchOceanicFixes(savedFixes);
    f.stripValues = f.stripValues || {};
    f.stripValues.altitude = f.stripValues.altitude ?? flNum;
    f.stripValues.fixes = displayFixes;
    const colCount = Math.max(f.stripValues.fixes.length, 4);
    console.log('displayFixes:', displayFixes, 'colCount:', colCount);
    if (f.stripValues.fixes.length < colCount) {
        f.stripValues.fixes = [...f.stripValues.fixes, ...Array(colCount - f.stripValues.fixes.length).fill("")];
    }
    f.stripValues.mach = f.stripValues.mach || "";
    f.stripValues.est = f.stripValues.est || Array(colCount).fill("");
    f.stripValues.act = f.stripValues.act || Array(colCount).fill("");

    const stripValues = f.stripValues;
    div.fixCoords = stripValues.fixes.map(fix => FIX_COORDS[fix] || {lat:0, lon:0});
    let direction = getDirectionFromFixes(stripValues.fixes.filter(Boolean));

    if (direction === "westbound") div.style.background = "#dbeafe";
    else if (direction === "eastbound") div.style.background = "#fef9c3";
    else div.style.background = (flNum % 20 === 0) ? "#f3f6ff" : "#f3fff3";

    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";

    table.innerHTML = `
        <tr>
            <td class="callsign-cell" style="font-weight:bold; cursor:pointer;">${f.aircraft}</td>
            <td>1</td>
            <td>${f.dep}</td>
            <td rowspan="3" style="font-weight:bold; border:1px solid #2563eb; width:40px;"><input class="alt-box" value="${stripValues.altitude/100}" placeholder="${flNum}"></td>
            ${Array.from({length: colCount}).map((_, i) => {
                const fix = stripValues.fixes[i] || "";
                const highlightClass = isOceanicFix(fix) ? "highlighted-fix" : "";
                return `<td><input class="act-box fix-box ${highlightClass}" value="${fix}" placeholder="FIX"></td>`;
            }).join('')}
        </tr>
        <tr>
            <td colspan="2" style="background:#fde047; font-weight:bold; color:black; border:1px solid black;">${f.callsign}</td>
            <td><input class="act-box mach-box" value="${stripValues.mach}" placeholder="MACH"></td>
            ${Array.from({length: colCount}).map((_, i) => `<td><input class="act-box est-box" value="${stripValues.est[i] || ''}" placeholder="EST"></td>`).join('')}
        </tr>
        <tr>
            <td></td>
            <td>${f.registration}</td>
            <td>${f.arr}</td>
            ${Array.from({length: colCount}).map((_, i) => `<td><input class="act-box act-val-box" value="${stripValues.act[i] || ''}" placeholder="ACT"></td>`).join('')}
        </tr>
    `;

    table.querySelectorAll("td").forEach(td => {
        td.style.border = "1px solid #2563eb";
        td.style.padding = "2px";
        td.style.textAlign = "center";
    });

    table.querySelectorAll("input").forEach(inp => {
        inp.style.width = "100%";
        inp.style.border = "none";
        inp.style.textAlign = "center";
        inp.style.background = "transparent";
        if (inp.classList.contains("est-box")) {
            inp.addEventListener("input", () => {
                const idx = [...table.querySelectorAll(".est-box")].indexOf(inp);
                f.stripValues.est[idx] = inp.value;
                calculateEstimates(div);
                saveOrders();
            });
        }
    });

    const altInput = table.querySelector(".alt-box");
    if (altInput) {
        altInput.addEventListener("input", () => {
            f.stripValues.altitude = altInput.value;
            saveOrders();
        });
    }

    const machInput = table.querySelector(".mach-box");
    if (machInput) {
        machInput.addEventListener("input", () => {
            f.stripValues.mach = machInput.value;
            saveOrders();
        });
    }

    table.querySelectorAll(".fix-box").forEach((inp, i) => {
        inp.addEventListener("input", () => {
            const value = inp.value.toUpperCase().trim();
            f.stripValues.fixes[i] = value;
            div.fixCoords[i] = FIX_COORDS[value] || {lat: 0, lon: 0};
            saveOrders();
        });
    });

    table.querySelectorAll(".act-val-box").forEach((inp, i) => {
        inp.addEventListener("input", () => {
            f.stripValues.act[i] = inp.value;
            saveOrders();
        });
    });

    div.addEventListener("dblclick", (e) => {
        if (e.target.closest("input")) return;
        deleteStrip(div);
    });

    div.appendChild(table);
    enableDrag(div);
    return div;
}

function buildCustomStrip(f) {
    const div = document.createElement("div");
    div.className = "strip custom";
    div.dataset.callsign = f.callsign;
    div.style.background = "#fde2e2";
    div.style.border = "1px solid #f87171";
    div.style.borderRadius = "8px";
    div.style.padding = "15px";
    div.style.textAlign = "center";
    div.style.fontWeight = "bold";
    div.textContent = f.aircraft;

    div.addEventListener("dblclick", () => deleteStrip(div));

    enableDrag(div);
    return div;
}

// ======================= SMOOTH DRAG (Reliable) =======================
function enableDrag(strip) {
    let offsetY, offsetX;
    let placeholder = null;
    let currentLane = null;
    let dragStarted = false;
    let startX = 0;
    let startY = 0;

    const startDrag = (e) => {
        dragStarted = true;
        e.preventDefault();
        document.body.style.userSelect = "none";

        const rect = strip.getBoundingClientRect();
        offsetY = e.clientY - rect.top;
        offsetX = e.clientX - rect.left;

        currentLane = strip.parentNode;

        placeholder = document.createElement("div");
        placeholder.className = "strip-placeholder";
        placeholder.style.height = rect.height + "px";
        placeholder.style.margin = "4px 0";
        placeholder.style.transition = "all 0.15s ease";
        currentLane.insertBefore(placeholder, strip.nextSibling);

        document.body.appendChild(strip);
        strip.style.position = "absolute";
        strip.style.width = rect.width + "px";
        strip.style.zIndex = 1000;
        strip.style.pointerEvents = "none";
        strip.style.transform = "scale(1.05)";
        strip.style.transition = "transform 0.15s ease";
        strip.style.top = (e.clientY - offsetY) + "px";
        strip.style.left = (e.clientX - offsetX) + "px";
    };

    const mouseMove = (ev) => {
        if (!dragStarted) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (Math.hypot(dx, dy) < 6) return;
            startDrag(ev);
        }

        strip.style.top = (ev.clientY - offsetY) + "px";
        strip.style.left = (ev.clientX - offsetX) + "px";

        const lanes = [...document.querySelectorAll(".lane")];
        const lane = lanes.find(l => {
            const r = l.getBoundingClientRect();
            return ev.clientX >= r.left && ev.clientX <= r.right &&
                   ev.clientY >= r.top && ev.clientY <= r.bottom;
        }) || currentLane;

        if (lane !== currentLane) {
            if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
            lane.appendChild(placeholder);
            currentLane = lane;
        }

        const strips = [...currentLane.querySelectorAll(".strip")].filter(s => s !== strip);
        let afterEl = strips.find(s => ev.clientY < s.getBoundingClientRect().top + s.offsetHeight / 2);
        if (afterEl) currentLane.insertBefore(placeholder, afterEl);
        else currentLane.appendChild(placeholder);
    };

    const mouseUp = () => {
        document.removeEventListener("mousemove", mouseMove);
        document.removeEventListener("mouseup", mouseUp);
        document.body.style.userSelect = "";

        if (!dragStarted) return;

        currentLane.insertBefore(strip, placeholder);
        placeholder.remove();

        strip.style.position = "";
        strip.style.left = "";
        strip.style.top = "";
        strip.style.width = "";
        strip.style.zIndex = "";
        strip.style.pointerEvents = "";
        strip.style.transform = "";
        strip.style.transition = "";

        dragStarted = false;
        state.positions[strip.dataset.callsign] = currentLane.id;
        saveOrders();
    };

    strip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest("input")) return;

        e.preventDefault();
        document.body.style.userSelect = "none";

        startX = e.clientX;
        startY = e.clientY;
        dragStarted = false;

        document.addEventListener("mousemove", mouseMove);
        document.addEventListener("mouseup", mouseUp);
    });
}

function getDragAfterElement(lane, y, placeholder = null) {
    const strips = [...lane.querySelectorAll(".strip:not(.dragging)")];
    return strips.reduce((closest, child) => {
        if (child === placeholder) return closest;
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ======================= CALCULATE ESTIMATES =======================
// ======================= CALCULATE ESTIMATES =======================
function calculateEstimates(stripDiv) {
    const callsign = stripDiv.dataset.callsign;
    const flight = state.flights[callsign];
    if (!flight || !flight.stripValues) return;

    const table = stripDiv.querySelector("table");
    const estInputs = table.querySelectorAll(".est-box");
    if (estInputs.length === 0) return;

    const gsInput = table.querySelector("input[placeholder='MACH']");
    let gs = parseInt(gsInput?.value || "480", 10) || 480;

    const coords = stripDiv.fixCoords || [];
    if (coords.length === 0) return;

    let firstEstIndex = -1;

    // SAVE current manual entries FIRST
    estInputs.forEach((inp, i) => {
        flight.stripValues.est[i] = inp.value.trim();
    });

    for (let i = 0; i < estInputs.length; i++) {
        if (estInputs[i].value.trim() !== "") {
            firstEstIndex = i;
            break;
        }
    }

    if (firstEstIndex === -1) return;

    const parseHHMM = str => {
        str = str.replace(/\D/g, "").padStart(4, "0");

        const h = parseInt(str.slice(0, 2), 10) || 0;
        const m = parseInt(str.slice(2, 4), 10) || 0;

        return h * 60 + m;
    };

    const formatHHMM = mins => {
        mins = ((mins % 1440) + 1440) % 1440;

        const h = Math.floor(mins / 60)
            .toString()
            .padStart(2, "0");

        const m = Math.round(mins % 60)
            .toString()
            .padStart(2, "0");

        return h + m;
    };

    let baseMins = parseHHMM(estInputs[firstEstIndex].value);

    for (let i = firstEstIndex + 1; i < estInputs.length; i++) {
        const prev = coords[i - 1];
        const curr = coords[i];

        if (!prev || !curr) continue;

        const R = 3440.065;

        const toRad = deg => deg * Math.PI / 180;

        const dLat = toRad(curr.lat - prev.lat);
        const dLon = toRad(curr.lon - prev.lon);

        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(prev.lat)) *
                Math.cos(toRad(curr.lat)) *
                Math.sin(dLon / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        const dist = R * c;

        baseMins += (dist / gs) * 60;

        const calculated = formatHHMM(baseMins);

        estInputs[i].value = calculated;

        // THIS IS THE FIX
        // Persist calculated estimates into state
        flight.stripValues.est[i] = calculated;
    }

    saveOrders();
}

// ======================= SAVE & RENDER =======================
function getCols() {
    return MODES[state.mode];
}

function saveOrders() {
    const orders = {};
    getCols().forEach(col => {
        const lane = document.getElementById(col);
        if (lane) {
            orders[col] = [...lane.querySelectorAll(".strip")].map(s => s.dataset.callsign);
        }
    });
    localStorage.setItem("orders_vstrips", JSON.stringify(orders));
    localStorage.setItem("positions_vstrips", JSON.stringify(state.positions));
    localStorage.setItem("flights_vstrips", JSON.stringify(state.flights));
}

function render() {
    const board = document.getElementById("board");
    if (!board) return;
    board.innerHTML = "";

    getCols().forEach(col => {
        const lane = document.createElement("div");
        lane.className = "lane";
        lane.id = col;
        lane.innerHTML = `<h2>${col.toUpperCase()}</h2>`;
        board.appendChild(lane);
        /*setupLane(lane);*/
    });

    getCols().forEach(col => {
        const lane = document.getElementById(col);
        Object.values(state.flights)
            .filter(f => state.positions[f.callsign] === col)
            .forEach(f => {
                const strip = f.callsign.startsWith("CUSTOM-") ? buildCustomStrip(f) : buildOceanicStrip(f);
                lane.appendChild(strip);
            });
    });
}

// ======================= DELETE STRIP FUNCTION =======================
function deleteStrip(strip) {
    if (!strip) return;
    const callsign = strip.dataset.callsign;
    if (strip.parentNode) strip.parentNode.removeChild(strip);
    if (callsign && state.flights[callsign]) {
        delete state.flights[callsign];
    }
    saveOrders();
}

// ======================= UTC CLOCK =======================
function updateUTCTime() {
    const now = new Date();
    const h = String(now.getUTCHours()).padStart(2, '0');
    const m = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    const el = document.getElementById('utc-time');
    if (el) el.textContent = `${h}:${m}:${s} Z`;
}
updateUTCTime();
setInterval(updateUTCTime, 1000);

// ======================= INIT =======================
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("addOceanicBtn").onclick = addOceanicStrip;
    document.getElementById("addCustomBtn").onclick = addCustomStrip;
    render();
    window.addEventListener("beforeprint", saveOrders);
});


//python3 -m http.server
