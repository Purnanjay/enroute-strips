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
 "ADKIT","XOKRO","SADRI","MEMAK","GIRNA","ELSAR","DUBTA","NOPEX","SULTO","RUPTI",
 "SAMAK","AVNOS","ATIDA","APASI","ANOKO","IDASO","BIKEN","LAGOG","IGOGU","MANPU",
 "DUMAR","AMVUR","AGEGA","DUGOS","NIMOV","PPB","LADER","LULDA","IGREX","VATLA",
 "LEGIN","NISUN","MIPAK","EGOLU","BIDEX",
];

// ======================= ADDED FROM FIRST CODE =======================
let AIRWAY_INDEX = {};
let FIX_DB = {};

async function loadData() {
  AIRWAY_INDEX = await fetch("airway_index.json").then(r => r.json());
  FIX_DB = await fetch("fixdb.json").then(r => r.json());
  console.log("✅ Airway graph loaded");
}

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

    if (isProcedure(token)) {
      result.push(token);
      continue;
    }

    if (!isAirway(token)) {
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

loadData();
// ===================================================================


// ======================= INJECTION =======================
const OCEANIC_SET = new Set(AIRWAY_DB);

function isOceanicFix(fix) {
  return OCEANIC_SET.has(fix);
}
// ========================================================


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

// ======================= HELPERS =======================
function getCols() {
  return MODES[state.mode];
}

function extractRegistration(remarks) {
  if (!remarks || typeof remarks !== 'string') return "----";
  const match = remarks.match(/REG\/([A-Z0-9-]+)/i);
  return match ? match[1] : "----";
}

// ======================= ROUTE EXPANSION =======================
function expandRouteFromVatsim(route, cruiseAltitude) {
  if (!route) return [];

  // prevent crash before data loads
  if (!AIRWAY_INDEX || Object.keys(AIRWAY_INDEX).length === 0) {
    console.warn("AIRWAY_INDEX not loaded yet");
    const tokens = route.toUpperCase().match(/[A-Z0-9]+/g) || [];
    return tokens.filter(fix => OCEANIC_SET.has(fix));
  }

  const tokens = route.toUpperCase().match(/[A-Z0-9]+/g) || [];

  // ✅ FULL expansion
  const expanded = expandRoute(tokens);

  // ✅ FILTER only oceanic fixes
  return expanded.filter(fix => OCEANIC_SET.has(fix));
}

// ======================= ADD STRIP =======================
async function addOceanicStrip() {
  const input = document.getElementById("oceanicCallsign");
  const callsign = (input.value || "").trim().toUpperCase();
  if (!callsign) {
    alert("Please enter a callsign");
    return;
  }

  try {
    const response = await fetch(API_URL);
    const data = await response.json();
    const p = data.pilots.find(p => p.callsign === callsign);

    if (!p) {
      alert("Callsign not found on VATSIM");
      return;
    }

    const flightPlan = p.flight_plan || {};
    const remarks = flightPlan.remarks || "";

    const expandedFixes = expandRouteFromVatsim(flightPlan.route, flightPlan.altitude);

    state.flights[callsign] = {
      callsign,
      dep: flightPlan.departure || "----",
      arr: flightPlan.arrival || "----",
      aircraft: flightPlan.aircraft_short || "----",
      cruise: flightPlan.altitude || "350",
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
    console.error("Error:", err);
    alert("Failed to fetch flight data from VATSIM");
  }
}

// ======================= STRIP BUILDER =======================
function buildOceanicStrip(f) {
  const div = document.createElement("div");
  div.className = "strip oceanic";
  div.draggable = true;
  div.dataset.callsign = f.callsign;

  let flNum = parseInt(f.cruise.toString().replace(/\D/g, ''), 10);
  if (flNum >= 1000) flNum = Math.floor(flNum / 100);

  div.style.background = (flNum % 2 === 0) ? "#f3f6ff" : "#f3fff3";
  div.style.border = "1px solid #2563eb";
  div.style.borderRadius = "8px";
  div.style.padding = "4px";

  let waypoints = f.prefilledFixes && f.prefilledFixes.length > 0 
                  ? f.prefilledFixes 
                  : [];

  var colCount = Math.min(Math.max(waypoints.length, 4), 12);

  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  table.style.fontSize = "12px";

  table.innerHTML = `
    <tr>
      <td class="callsign-cell" style="font-weight:bold; cursor:pointer;">${f.aircraft}</td>
      <td>1</td>
      <td>${f.dep}</td>
      <td rowspan="3" style="font-weight:bold; background:#dbeafe; border:1px solid #2563eb; width:40px;"><input value="${flNum}" placeholder="${flNum}"></td>
      ${Array.from({length: colCount}).map((_, i) => {
        const fix = waypoints[i] || "";
        const highlightClass = isOceanicFix(fix) ? "highlighted-fix" : "";
        return `<td><input class="act-box ${highlightClass}" value="${fix}" placeholder="FIX"></td>`;
      }).join('')}
    </tr>
    <tr>
      <td colspan="2" style="background:#fde047; font-weight:bold; color:black; border: 1px solid black;">${f.callsign}</td>
      <td><input class="act-box" placeholder="MACH"></td>
      ${Array.from({length: colCount}).map(() => `<td><input class="act-box" placeholder="EST"></td>`).join('')}
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

// ======================= SAVE & RENDER =======================
function saveOrders() {
  const orders = {};
  getCols().forEach(col => {
    const lane = document.getElementById(col);
    if (lane) {
      orders[col] = [...lane.querySelectorAll(".strip")]
        .map(s => s.dataset.callsign);
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

    lane.addEventListener("dragover", e => {
      e.preventDefault();
      lane.style.background = "#dbeafe";
    });
    lane.addEventListener("dragleave", () => {
      lane.style.background = "";
    });
    lane.addEventListener("drop", e => {
      e.preventDefault();
      lane.style.background = "";
      const cs = e.dataTransfer.getData("text/plain");
      const strip = document.querySelector(`.strip[data-callsign="${cs}"]`);
      if (strip) {
        lane.appendChild(strip);
        state.positions[cs] = col;
        saveOrders();
      }
    });
  });

  getCols().forEach(col => {
    const lane = document.getElementById(col);
    Object.values(state.flights)
      .filter(f => state.positions[f.callsign] === col)
      .forEach(f => {
        lane.appendChild(buildOceanicStrip(f));
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

// ======================= INIT =======================
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addOceanicBtn").onclick = addOceanicStrip;
  render();
});
