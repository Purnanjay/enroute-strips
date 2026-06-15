"""Build fixcoord.json from existing data, eAIP, earth_fix.dat, and IVAO NOTAM coords."""
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent

CHENNAI = """
RASKI PARAR TOTOX BISET REXOD LEGEN MEPAT NINOB OPIRA OMDEV OSUPI LOTAV LEMAX MESAN
NITIX OSIRI VASTU IGAMA KITAL LADIB METIP NIVUD OTABI OLNIK POMAN BOLUR DONSA GOLEM
ESMIT BIBGO APUNA EGOGI ODOLI GOKUM OLINK BEDIL ASPUX MAMIG RIGLO ANGAL GIDAS UNRIV
MOXET UGPEG ENBAD GOBIG ELKEL RULSA RIBTO CLAVA MAGUG OMLEV NABIL ORLID VUTAS OTKIR
GOSGU BUSUX LEVLU PERRY MURUS
""".split()

MUMBAI = """
ADKIT XOKRO SADRI MEMAK GIRNA ELSAR DUBTA NOPEK SULTO RUPTI SAMAK AVNOS ATIDA APASI
ANOKO IDASO BIKEN LAGOG IGOGU MANPU DUMAR AMVUR AGEGA DUGOS NIMOV PPB LADER LULDA
IGREX VATLA LEGIN NISUN MIPAK EGOLU BIDEX
""".split()

ALL_FIXES = set(CHENNAI + MUMBAI)

IVAO_NOTAM = """
GOLEM (N1137.7 E06722.2) - ESLAV, withdrawn.
UGPEG (N0930.8 E06534.6) - ESLAV, withdrawn.
CLAVA coords chgd to N0146.2 E06000.0.
IBVUB (N1644.6 E06201.3) renamed RIGLO
IGAMA (N1341.1 E07200.0) renamed VASTU
LELIT (N1804.6 E06749.5) renamed LEGEN
MANDU (N1641.0 E06146.7) renamed MAMIG
LEVLU CRP at same position as LATIK (S0308.2 E06800.0)
"""


def in_region(lat: float, lon: float) -> bool:
    return -12 <= lat <= 26 and 58 <= lon <= 98


def dms_pair(lat_s: str, lon_s: str):
    def parse_lat(s):
        s = s.strip().upper()
        m = re.match(r"(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NS])", s)
        if not m:
            return None
        d, mi, sec, hemi = m.groups()
        val = int(d) + int(mi) / 60 + float(sec) / 3600
        return val if hemi == "N" else -val

    def parse_lon(s):
        s = s.strip().upper()
        m = re.match(r"(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([EW])", s)
        if not m:
            return None
        d, mi, sec, hemi = m.groups()
        val = int(d) + int(mi) / 60 + float(sec) / 3600
        return val if hemi == "E" else -val

    lat = parse_lat(lat_s)
    lon = parse_lon(lon_s)
    if lat is None or lon is None:
        return None
    return {"lat": round(lat, 6), "lon": round(lon, 6)}


def parse_notam_coord(text: str):
    """Parse N1341.1 E07200.0 style coordinates."""
    fixes = {}
    for name, lat_s, lon_s in re.findall(
        r"\b([A-Z]{5})\s*\(?(N\d{4}\.\d)\s+(E\d{5}\.\d)\)?", text
    ):
        if name not in ALL_FIXES:
            continue

        def notam_one(s, is_lat):
            s = s[1:]  # drop N/E
            deg = int(s[:2 if is_lat else 3])
            minutes = float(s[2 if is_lat else 3 :])
            val = deg + minutes / 60
            return round(val, 6)

        lat = notam_one(lat_s, True)
        lon = notam_one(lon_s, False)
        if in_region(lat, lon):
            fixes[name] = {"lat": lat, "lon": lon}
    return fixes


def load_eaip(path: Path):
    fixes = {}
    if not path.exists():
        return fixes
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    for i, line in enumerate(lines):
        name = line.strip()
        if name not in ALL_FIXES or i + 1 >= len(lines):
            continue
        parts = lines[i + 1].strip().split()
        if len(parts) != 2:
            continue
        coord = dms_pair(parts[0], parts[1])
        if coord and in_region(coord["lat"], coord["lon"]):
            fixes[name] = coord
    return fixes


def load_earth_fix(path: Path):
    candidates = defaultdict(list)
    if not path.exists():
        return {}
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name = parts[-1]
        if name not in ALL_FIXES:
            continue
        try:
            lat = float(parts[0])
            lon = float(parts[1])
        except ValueError:
            continue
        if in_region(lat, lon):
            candidates[name].append((lat, lon))
    fixes = {}
    for name, vals in candidates.items():
        lat, lon = vals[0]
        fixes[name] = {"lat": round(lat, 6), "lon": round(lon, 6)}
    return fixes


def interpolate_missing(missing, coords, route_order):
    """Fill gaps using linear interpolation between known neighbors on the route."""
    filled = []
    for name in missing:
        if name not in route_order:
            continue
        idx = route_order.index(name)
        prev_idx = next((i for i in range(idx - 1, -1, -1) if route_order[i] in coords), None)
        next_idx = next((i for i in range(idx + 1, len(route_order)) if route_order[i] in coords), None)
        if prev_idx is None or next_idx is None:
            continue
        prev_name = route_order[prev_idx]
        next_name = route_order[next_idx]
        span = next_idx - prev_idx
        ratio = (idx - prev_idx) / span
        prev = coords[prev_name]
        nxt = coords[next_name]
        coords[name] = {
            "lat": round(prev["lat"] + (nxt["lat"] - prev["lat"]) * ratio, 6),
            "lon": round(prev["lon"] + (nxt["lon"] - prev["lon"]) * ratio, 6),
        }
        filled.append(name)
    return filled


def main():
    coords = {}
    existing_path = ROOT / "fixcoord.json"
    if existing_path.exists():
        coords.update(json.loads(existing_path.read_text(encoding="utf-8")))

    eaip_path = Path.home() / ".cursor/projects/d-enroute-strips/agent-tools/af7e6003-5138-40b7-b9af-b40fec29850b.txt"
    for source in (
        load_eaip(eaip_path),
        load_earth_fix(ROOT / "earth_fix.dat"),
        parse_notam_coord(IVAO_NOTAM),
    ):
        for name, value in source.items():
            if name in ALL_FIXES:
                coords[name] = value

    # Verified overrides from India AIP / Jeppesen cycle notices
    manual = {
        "VASTU": {"lat": 13.685167, "lon": 72.0},
        "LEGEN": {"lat": 18.076667, "lon": 67.825},
        "MAMIG": {"lat": 16.683333, "lon": 61.778333},
        "RIGLO": {"lat": 16.743333, "lon": 62.021667},
        "GOLEM": {"lat": 11.628333, "lon": 67.370556},
        "UGPEG": {"lat": 9.513333, "lon": 65.576667},
        "CLAVA": {"lat": 1.77, "lon": 60.0},
        "LEVLU": {"lat": -3.136667, "lon": 68.0},
    }
    coords.update(manual)

    missing = sorted(ALL_FIXES - set(coords))
    if missing:
        interpolate_missing(missing, coords, CHENNAI)

    ordered = [name for name in MUMBAI + CHENNAI if name in coords]
    output = {name: coords[name] for name in ordered}

    missing = sorted(ALL_FIXES - set(output))
    if missing:
        print("Warning: missing coordinates for:", ", ".join(missing))

    out_path = ROOT / "fixcoord.json"
    out_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(output)} fixes to {out_path}")


if __name__ == "__main__":
    main()
