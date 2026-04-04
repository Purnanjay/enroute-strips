import json

GRAPH = {}
FIX_DB = {}
AIRWAY_INDEX = {}

# ------------------ PARSE NAV ------------------

with open("earth_nav.txt", "r", encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split()

        if len(parts) < 8:
            continue

        try:
            lat = float(parts[1])
            lon = float(parts[2])
            name = parts[7]

            FIX_DB[name] = {
                "lat": lat,
                "lon": lon
            }
        except:
            continue

# ------------------ PARSE AWY ------------------

with open("earth_awy.txt", "r", encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split()

        if len(parts) < 5:
            continue

        from_fix = parts[0]
        to_fix = parts[3]
        airway_field = parts[-1]

        airways = airway_field.split("-")

        for airway in airways:

            # GRAPH (bidirectional)
            GRAPH.setdefault(from_fix, []).append({
                "to": to_fix,
                "airway": airway
            })

            GRAPH.setdefault(to_fix, []).append({
                "to": from_fix,
                "airway": airway
            })

            # AIRWAY INDEX (faster lookup)
            AIRWAY_INDEX.setdefault(airway, []).append([from_fix, to_fix])

# ------------------ SAVE FILES ------------------

with open("graph.json", "w") as f:
    json.dump(GRAPH, f)

with open("fixdb.json", "w") as f:
    json.dump(FIX_DB, f)

with open("airway_index.json", "w") as f:
    json.dump(AIRWAY_INDEX, f)

print("✅ Conversion complete!")