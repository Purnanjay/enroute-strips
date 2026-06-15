"""Test 2FAST / GOLEM / GS=466 / EST=0900 scenario."""
import json
import math
import time
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
PORT = 8777
BASE = f"http://localhost:{PORT}"
R = 3440.065


def start_server():
    handler = type("H", (SimpleHTTPRequestHandler,), {"directory": str(ROOT)})
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server


def haversine_nm(a, b):
    to_rad = math.radians
    d_lat = to_rad(b["lat"] - a["lat"])
    d_lon = to_rad(b["lon"] - a["lon"])
    x = (
        math.sin(d_lat / 2) ** 2
        + math.cos(to_rad(a["lat"]))
        * math.cos(to_rad(b["lat"]))
        * math.sin(d_lon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(x), math.sqrt(1 - x))


def format_hhmm(mins):
    mins = int(round(((mins % 1440) + 1440) % 1440))
    return f"{mins // 60:02d}{mins % 60:02d}"


def parse_hhmm(s):
    s = "".join(c for c in s if c.isdigit()).zfill(4)
    return int(s[:2]) * 60 + int(s[2:4])


def expected_ests(fixes, coords, gs, anchor_idx, anchor_time):
    ests = [""] * len(fixes)
    ests[anchor_idx] = anchor_time
    base = parse_hhmm(anchor_time)
    for i in range(anchor_idx + 1, len(fixes)):
        dist = haversine_nm(coords[fixes[i - 1]], coords[fixes[i]])
        base += (dist / gs) * 60
        ests[i] = format_hhmm(base)
    return ests


def fetch_vatsim_2fast():
    try:
        data = json.loads(
            urllib.request.urlopen(
                "https://data.vatsim.net/v3/vatsim-data.json", timeout=20
            ).read()
        )
        return next((p for p in data.get("pilots", []) if p.get("callsign") == "2FAST"), None)
    except Exception as e:
        print("VATSIM fetch failed:", e)
        return None


def main():
    coords = json.loads((ROOT / "fixcoord.json").read_text(encoding="utf-8"))
    pilot = fetch_vatsim_2fast()
    if pilot:
        print("2FAST on VATSIM, route:", pilot.get("flight_plan", {}).get("route", ""))
    else:
        print("2FAST not on VATSIM — will add strip via API attempt then report")

    server = start_server()
    time.sleep(0.3)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("dialog", lambda d: d.accept())

        page.goto(BASE)
        page.evaluate(
            """() => {
            localStorage.clear();
        }"""
        )
        page.reload()
        page.wait_for_selector("#sectorSelect")
        page.wait_for_function("() => Object.keys(FIX_COORDS).length > 50")

        page.select_option("#sectorSelect", "chennai")
        page.fill("#oceanicCallsign", "2FAST")
        page.click("#addOceanicBtn")
        page.wait_for_timeout(5000)

        strip = page.locator('.strip.oceanic[data-callsign="2FAST"]')
        if strip.count() == 0:
            print("FAIL: No strip created for 2FAST")
            browser.close()
            server.shutdown()
            return 1

        callsign = strip.get_attribute("data-callsign")
        print("Strip callsign:", callsign)

        route_fixes = page.evaluate(
            f"() => state.flights['{callsign}']?.routeFixes || []"
        )
        vatsim_route = page.evaluate(
            f"() => state.flights['{callsign}']?.vatsimRoute || ''"
        )
        print("vatsimRoute:", vatsim_route)
        print("routeFixes (VATSIM only):", route_fixes)

        if not route_fixes:
            print("SKIP: No sector fixes on VATSIM route for 2FAST")
            browser.close()
            server.shutdown()
            return 0

        next_fix = "GOLEM" if "GOLEM" in route_fixes else route_fixes[0]
        print("Using next waypoint:", next_fix)
        next_wp = strip.locator(".fix-box").first
        next_wp.fill(next_fix)
        next_wp.press("Enter")
        page.wait_for_timeout(300)

        strip = page.locator(f'.strip.oceanic[data-callsign="{callsign}"]')
        fixes = [
            strip.locator(".fix-box").nth(i).input_value()
            for i in range(strip.locator(".fix-box").count())
        ]
        print(f"Fixes after {next_fix}:", fixes)
        expected_count = min(len(route_fixes) - route_fixes.index(next_fix), 5)
        if len(fixes) != expected_count:
            print(f"FAIL: Expected {expected_count} waypoints on strip, got {len(fixes)}")

        anchor_idx = fixes.index(next_fix) if next_fix in fixes else 0
        if anchor_idx != 0:
            print("NOTE: next waypoint at index", anchor_idx)

        strip.locator(".mach-box").fill("466")
        strip.locator(".mach-box").dispatch_event("input")

        est_boxes = strip.locator(".est-box")
        est_boxes.nth(anchor_idx).fill("0900")
        est_boxes.nth(anchor_idx).dispatch_event("blur")
        page.wait_for_timeout(300)

        strip = page.locator(f'.strip.oceanic[data-callsign="{callsign}"]')
        est_boxes = strip.locator(".est-box")
        actual_ests = [
            est_boxes.nth(i).input_value() for i in range(est_boxes.count())
        ]
        print("All EST:", actual_ests[:anchor_idx + 7])

        next5 = actual_ests[anchor_idx + 1 : anchor_idx + 6]
        print(f"Next EST after {next_fix}:", next5)

        available_next = len(fixes) - anchor_idx - 1
        if available_next == 0:
            print("OK: No further waypoints on VATSIM route after anchor")
            missing = []
            mismatches = []
        else:
            check_count = min(available_next, 5)
            next_checked = actual_ests[anchor_idx + 1 : anchor_idx + 1 + check_count]
            missing = [e for e in next_checked if not e.strip()]
            if missing:
                print(f"FAIL: {len(missing)} EST values empty after anchor")
            else:
                print(f"OK: All {check_count} downstream EST populated")

            fix_coords = {k: coords[k] for k in fixes if k in coords}
            exp = expected_ests(fixes, fix_coords, 466, anchor_idx, "0900")
            exp_checked = exp[anchor_idx + 1 : anchor_idx + 1 + check_count]

            print("Expected:", exp_checked)

            mismatches = []
            for i, (a, e) in enumerate(zip(next_checked, exp_checked)):
                if a != e:
                    mismatches.append((anchor_idx + 1 + i, fixes[anchor_idx + 1 + i], a, e))

            if mismatches:
                print("FAIL: EST mismatches:")
                for idx, fix, a, e in mismatches:
                    print(f"  [{idx}] {fix}: got {a}, expected {e}")
            else:
                print("OK: EST values match calculated times")

        browser.close()

    server.shutdown()
    return 1 if missing or mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main())
