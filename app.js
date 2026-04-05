// ======================= CONFIG =======================
const API_URL = "https://data.vatsim.net/v3/vatsim-data.json";

const MODES = {
  oceanic: ["planned", "cruise", "exit"]
};

const state = {
  mode: "oceanic",
  positions: JSON.parse(localStorage.getItem("positions_vstrips") || "{}"),
  orders: JSON.parse(localStorage.getItem("orders_vstrips") || "{}"),
  flights: {}
};

const AIRWAY_DB = [
 "ADKIT","XOKRO","SADRI","MEMAK","GIRNA","ELSAR","DUBTA","NOPEK","SULTO","RUPTI",
 "SAMAK","AVNOS","ATIDA","APASI","ANOKO","IDASO","BIKEN","LAGOG","IGOGU","MANPU",
 "DUMAR","AMVUR","AGEGA","DUGOS","NIMOV","PPB","LADER","LULDA","IGREX","VATLA",
 "LEGIN","NISUN","MIPAK","EGOLU","BIDEX",
];

// ======================= DATA =======================
let AIRWAY_INDEX = {};
let FIX_DB = {};
let FIX_COORDS = {};

// Load airway and fix data
async function loadData() {
  AIRWAY_INDEX = await fetch("airway_index.json").then(r => r.json());
  FIX_DB = await fetch("fixdb.json").then(r => r.json());

  const rawCoords = await fetch("fixcoord.json").then(r => r.json());
  FIX_COORDS = {};
  Object.keys(rawCoords).forEach(k => {
    FIX_COORDS[k.toUpperCase().trim()] = rawCoords[k];
  });

  console.log("✅ Airway graph loaded");
}

// Load data at start
loadData();

// ======================= HELPERS =======================
function cleanToken(token) {
  if (!token) return "";
  if (token.includes("/")) token = token.split("/")[0];
  return token.trim();
}

function isAirway(token) {
  return /^[A-Z]\d+[A-Z]*$/.test(token);
}

function isProcedure(token) {
  return /\d+[A-Z]$/.test(token);
}

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
  let result = [];
  for (let i = 0; i < tokens.length; i++) {
    let token = cleanToken(tokens[i]);
    if (isProcedure(token) || !isAirway(token)) {
      result.push(token);
      continue;
    }
    const entry = cleanToken(tokens[i - 1]);
    const exit = cleanToken(tokens[i + 1]);
    if (!entry || !exit) continue;

    const segment = findPath(entry, exit, token);
    if (segment.length > 0) {
      if (result[result.length - 1] === segment[0]) {
        result.push(...segment.slice(1));
      } else {
        result.push(...segment);
      }
      i++;
    }
  }
  return result;
}

// ======================= OCEANIC =======================
const OCEANIC_SET = new Set(AIRWAY_DB);

function isOceanicFix(fix) {
  return OCEANIC_SET.has(fix);
}

function extractRegistration(remarks) {
  if (!remarks || typeof remarks !== 'string') return "----";
  const match = remarks.match(/REG\/([A-Z0-9-]+)/i);
  return match ? match[1] : "----";
}

function expandRouteFromVatsim(route, cruiseAltitude) {
  if (!route) return [];
  if (!AIRWAY_INDEX || Object.keys(AIRWAY_INDEX).length === 0) {
    const tokens = route.toUpperCase().match(/[A-Z0-9]+/g) || [];
    return tokens.filter(fix => OCEANIC_SET.has(fix));
  }
  const tokens = route.toUpperCase().match(/[A-Z0-9]+/g) || [];
  const expanded = expandRoute(tokens);
  return expanded.filter(fix => OCEANIC_SET.has(fix));
}

// ======================= DIRECTION DETECTION =======================
function getDirectionFromFixes(fixes) {
  if (!fixes || fixes.length < 2) return null;

  // get all valid longitudes
  const lons = fixes.map(fix => FIX_COORDS[fix]?.lon).filter(lon => typeof lon === "number");
  if (lons.length < 2) return null;

  const firstLon = lons[0];
  const lastLon = lons[lons.length - 1];

  return lastLon < firstLon ? "westbound" : lastLon > firstLon ? "eastbound" : null;
}

// ======================= ADD OCEANIC STRIP =======================
async function addOceanicStrip() {
  const input = document.getElementById("oceanicCallsign");
  const callsign = (input.value || "").trim().toUpperCase();
  if (!callsign) return alert("Please enter a callsign");

  try {
    const response = await fetch(API_URL);
    const data = await response.json();
    const p = data.pilots.find(p => p.callsign === callsign);

    if (!p) return alert("Callsign not found on VATSIM");

    const flightPlan = p.flight_plan || {};
    const remarks = flightPlan.remarks || "";
    const expandedFixes = expandRouteFromVatsim(flightPlan.route, flightPlan.altitude);

    state.flights[callsign] = {
      callsign,
      dep: flightPlan.departure || "----",
      arr: flightPlan.arrival || "----",
      aircraft: flightPlan.aircraft_short || "----",
      cruise: flightPlan.altitude || "----",
      registration: extractRegistration(remarks),
      route: flightPlan.route || "",
      type: "oceanic",
      prefilledFixes: expandedFixes.length > 0 ? expandedFixes : null
    };

    state.positions[callsign] ||= getCols()[0];
    saveOrders();
    render();
    input.value = "";
  } catch (err) {
    console.error(err);
    alert("Failed to fetch flight data from VATSIM");
  }
}

// ======================= BUILD OCEANIC STRIP =======================
function buildOceanicStrip(f) {
  const div = document.createElement("div");
  div.className = "strip oceanic";
  div.draggable = true;
  div.dataset.callsign = f.callsign;

  let flNum = parseInt(f.cruise.toString().replace(/\D/g, ''), 10);
  if (flNum >= 1000) flNum = Math.floor(flNum / 100);

  let waypoints = f.prefilledFixes && f.prefilledFixes.length > 0 ? f.prefilledFixes : [];
  let direction = getDirectionFromFixes(waypoints);

  if (direction === "westbound") div.style.background = "#dbeafe";
  else if (direction === "eastbound") div.style.background = "#fef9c3";
  else div.style.background = (flNum % 20 === 0) ? "#f3f6ff" : "#f3fff3";

  if (direction === "westbound") div.style.border = "#2564eb7e";
  else if (direction === "eastbound") div.style.border = "#f3fff39d";
  else div.style.border = (flNum % 20 === 0) ? "#2564eb7e" : "#f3fff39d";

  div.style.borderRadius = "8px";
  div.style.padding = "4px";

  var colCount = Math.min(Math.max(waypoints.length, 4), 12);

  // store fix coordinates for estimate calculation
  div.fixCoords = waypoints.map(fix => {
    const c = FIX_COORDS[fix];
    if (!c) console.warn("Missing fix coords:", fix);
    return c || {lat:0, lon:0};
  });

  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  table.style.fontSize = "12px";

  table.innerHTML = `
    <tr>
      <td class="callsign-cell" style="font-weight:bold; cursor:pointer;">${f.aircraft}</td>
      <td>1</td>
      <td>${f.dep}</td>
      <td rowspan="3" style="font-weight:bold; border:1px solid #2563eb; width:40px;"><input value="${flNum}" placeholder="${flNum}"></td>
      ${Array.from({length: colCount}).map((_, i) => {
        const fix = waypoints[i] || "";
        const highlightClass = isOceanicFix(fix) ? "highlighted-fix" : "";
        return `<td><input class="act-box ${highlightClass}" value="${fix}" placeholder="FIX"></td>`;
      }).join('')}
    </tr>
    <tr>
      <td colspan="2" style="background:#fde047; font-weight:bold; color:black; border:1px solid black;">${f.callsign}</td>
      <td><input class="act-box" placeholder="MACH"></td>
      ${Array.from({length: colCount}).map(() => `<td><input class="act-box est-box" placeholder="EST"></td>`).join('')}
    </tr>
    <tr>
      <td></td>
      <td>${f.registration}</td>
      <td>${f.arr}</td>
      ${Array.from({length: colCount}).map(() => `<td><input class="act-box" placeholder="ACT"></td>`).join('')}
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
      inp.addEventListener("input", () => calculateEstimates(div));
    }
  });

  table.querySelector(".callsign-cell").addEventListener("dblclick", () => {
    div.remove();
    delete state.flights[f.callsign];
    saveOrders();
  });

  div.appendChild(table);
  enableDrag(div);
  return div;
}

// ======================= CALCULATE ESTIMATES =======================
function calculateEstimates(stripDiv) {
  const table = stripDiv.querySelector("table");
  const estInputs = table.querySelectorAll(".est-box");
  if (estInputs.length === 0) return;

  const gsInput = table.querySelector("input[placeholder='MACH']");
  let gs = parseInt(gsInput?.value || "480", 10);
  if (!gs || gs <= 0) gs = 480;

  const coords = stripDiv.fixCoords;
  if (!coords || coords.length === 0) return;

  // Find first filled EST
  let firstEstIndex = -1;
  for (let i=0; i<estInputs.length; i++) {
    if (estInputs[i].value.trim() !== "") {
      firstEstIndex = i;
      break;
    }
  }
  if (firstEstIndex === -1) return;

  const parseHHMM = str => { const h=parseInt(str.slice(0,2),10); const m=parseInt(str.slice(2,4),10); return h*60+m; };
  const formatHHMM = mins => { const h=Math.floor(mins/60).toString().padStart(2,'0'); const m=Math.round(mins%60).toString().padStart(2,'0'); return h+m; };

  let baseMins = parseHHMM(estInputs[firstEstIndex].value);

  for (let i=firstEstIndex+1; i<estInputs.length; i++) {
    const prev = coords[i-1]; const curr = coords[i];
    if (!prev || !curr) continue;

    const R = 3440.065;
    const toRad = deg => deg*Math.PI/180;
    const dLat = toRad(curr.lat - prev.lat);
    const dLon = toRad(curr.lon - prev.lon);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(prev.lat))*Math.cos(toRad(curr.lat))*Math.sin(dLon/2)**2;
    const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const dist = R * c;

    const timeMins = (dist/gs)*60;
    baseMins += timeMins;
    estInputs[i].value = formatHHMM(baseMins);
  }
}

// ======================= CUSTOM STRIP =======================
async function addCustomStrip() {
  const input = document.getElementById("customStripText");
  const text = (input.value || "").trim();
  if (!text) return alert("Please enter some text for the strip");

  const custom = {
    callsign: "CUSTOM-" + Date.now(),
    aircraft: text,
    dep: "",
    arr: "",
    cruise: "----",
    registration: "",
    prefilledFixes: [],
  };

  state.flights[custom.callsign] = custom;
  state.positions[custom.callsign] ||= getCols()[0];
  saveOrders();
  render();
  input.value = "";
}

function buildCustomStrip(f) {
  const div = document.createElement("div");
  div.className = "strip custom";
  div.draggable = true;
  div.dataset.callsign = f.callsign;

  div.style.background = "#fde2e2";
  div.style.border = "1px solid #f87171";
  div.style.borderRadius = "8px";
  div.style.padding = "6px";
  div.style.textAlign = "center";
  div.style.fontWeight = "bold";
  div.textContent = f.aircraft;

  div.addEventListener("dblclick", () => {
    div.remove();
    delete state.flights[f.callsign];
    saveOrders();
  });

  enableDrag(div);
  return div;
}

// ======================= SAVE & RENDER =======================
function getCols() { return MODES[state.mode]; }

function saveOrders() {
  const orders = {};
  getCols().forEach(col => {
    const lane = document.getElementById(col);
    if (lane) {
      orders[col] = [...lane.querySelectorAll(".strip")].map(s => s.dataset.callsign);
    }
  });

  state.orders = orders;
  localStorage.setItem("orders_vstrips", JSON.stringify(orders));
  localStorage.setItem("positions_vstrips", JSON.stringify(state.positions));
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

    lane.addEventListener("dragover", e => { e.preventDefault(); lane.style.background = "#dbeafe"; });
    lane.addEventListener("dragleave", () => { lane.style.background = ""; });
    lane.addEventListener("drop", e => {
      e.preventDefault();
      lane.style.background = "";
      const cs = e.dataTransfer.getData("text/plain");
      const strip = document.querySelector(`.strip[data-callsign="${cs}"]`);
      if (strip) { lane.appendChild(strip); state.positions[cs] = col; saveOrders(); }
    });
  });

  getCols().forEach(col => {
    const lane = document.getElementById(col);
    Object.values(state.flights).filter(f => state.positions[f.callsign] === col)
      .forEach(f => {
        let strip = f.callsign.startsWith("CUSTOM-") ? buildCustomStrip(f) : buildOceanicStrip(f);
        lane.appendChild(strip);
      });
  });
}

function enableDrag(strip) {
  strip.addEventListener("dragstart", e => {
    strip.classList.add("dragging");
    e.dataTransfer.setData("text/plain", strip.dataset.callsign);
    setTimeout(() => strip.style.opacity = "0.4", 0);
  });
  strip.addEventListener("dragend", () => {
    strip.classList.remove("dragging");
    strip.style.opacity = "1";
    saveOrders();
  });
}

// ======================= UTC CLOCK =======================
function updateUTCTime() {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  document.getElementById('utc-time').textContent = `${h}:${m}:${s} Z`;
}
updateUTCTime();
setInterval(updateUTCTime, 1000);

// ======================= INIT =======================
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addOceanicBtn").onclick = addOceanicStrip;
  document.getElementById("addCustomBtn").onclick = addCustomStrip;
  render();
});