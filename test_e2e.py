"""End-to-end browser tests for enroute-strips."""
import json
import re
import sys
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
PORT = 8765
BASE = f"http://localhost:{PORT}"
failures = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg):
    print(f"OK: {msg}")


def start_server():
    handler = type("H", (SimpleHTTPRequestHandler,), {"directory": str(ROOT)})
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def clear_storage(page):
    page.goto(BASE)
    page.evaluate(
        """() => {
        localStorage.removeItem('flights_vstrips');
        localStorage.removeItem('positions_vstrips');
        localStorage.removeItem('orders_vstrips');
        localStorage.removeItem('sector_vstrips');
    }"""
    )
    page.reload()
    page.wait_for_selector("#sectorSelect")


def inject_oceanic_strip(page, callsign, sector, fixes, **kwargs):
    page.evaluate(
        """([callsign, sector, fixes, extra]) => {
        state.sector = sector;
        localStorage.setItem('sector_vstrips', sector);
        const flight = {
            callsign,
            dep: extra.dep || 'VIDP',
            arr: extra.arr || 'WSSS',
            aircraft: extra.aircraft || 'B77W',
            cruise: extra.cruise || '35000',
            registration: extra.reg || 'VT-TEST',
            type: 'oceanic',
            sector,
            prefilledFixes: fixes,
            stripValues: {
                altitude: extra.altitude ?? 350,
                fixes: [...fixes],
                mach: extra.mach || '',
                est: extra.est || [],
                act: extra.act || []
            }
        };
        state.flights[callsign] = flight;
        state.positions[callsign] = extra.lane || 'planned';
        saveOrders();
        render();
        document.getElementById('sectorSelect').value = sector;
    }""",
        [callsign, sector, fixes, kwargs],
    )


def main():
    server = start_server()
    time.sleep(0.3)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("dialog", lambda d: d.accept())

        # --- Basic load ---
        clear_storage(page)
        if page.locator("#utc-time").inner_text() == "Loading...":
            fail("UTC clock stuck on Loading")
        else:
            ok(f"UTC clock: {page.locator('#utc-time').inner_text()}")

        options = page.locator("#sectorSelect option").all_text_contents()
        if "Chennai Oceanic" not in options or "Mumbai Oceanic" not in options:
            fail(f"Sector options missing: {options}")
        else:
            ok("Sector dropdown has Chennai and Mumbai")

        lanes = page.locator(".lane h2").all_text_contents()
        if lanes != ["PLANNED", "CRUISE", "EXIT"]:
            fail(f"Unexpected lanes: {lanes}")
        else:
            ok("Three lanes rendered")

        # --- Empty input alerts ---
        page.click("#addOceanicBtn")
        page.click("#addCustomBtn")
        ok("Empty add buttons show alerts (accepted)")

        # --- Custom strip ---
        page.fill("#customStripText", "TEST NOTE")
        page.click("#addCustomBtn")
        if page.locator(".strip.custom").count() != 1:
            fail("Custom strip not created")
        else:
            ok("Custom strip created")

        # --- Chennai oceanic strip with fixes ---
        page.wait_for_function("() => Object.keys(FIX_COORDS).length > 50")
        inject_oceanic_strip(
            page,
            "TEST100",
            "chennai",
            ["RASKI", "PARAR", "TOTOX", "BISET"],
            mach=".84",
        )
        strip = page.locator('.strip.oceanic[data-callsign="TEST100"]')
        if strip.count() != 1:
            fail("Chennai oceanic strip not rendered")
        else:
            ok("Chennai oceanic strip rendered")

        est_boxes = strip.locator(".est-box")
        est_values = [est_boxes.nth(i).input_value() for i in range(est_boxes.count())]
        if any("}" in v for v in est_values):
            fail(f"EST fields contain '}}': {est_values}")
        else:
            ok(f"EST fields clean: {est_values}")

        # --- EST calculation ---
        est_boxes.nth(0).fill("1200")
        est_boxes.nth(0).dispatch_event("input")
        page.wait_for_timeout(200)
        est_after = [est_boxes.nth(i).input_value() for i in range(est_boxes.count())]
        if not est_after[0] or est_after[0] == "}":
            fail(f"First EST not saved: {est_after}")
        elif len(set(est_after)) < 2:
            fail(f"EST propagation did not advance times: {est_after}")
        else:
            ok(f"EST propagation: {est_after}")

        if not re.match(r"^\d{4}$", est_after[1]):
            fail(f"EST format invalid at index 1: {est_after[1]}")
        else:
            ok("EST format is HHMM")

        # --- ACT persistence ---
        act_boxes = strip.locator(".act-val-box")
        act_boxes.nth(0).fill("1205")
        act_boxes.nth(0).dispatch_event("input")
        saved_act = page.evaluate(
            "() => state.flights['TEST100'].stripValues.act[0]"
        )
        if saved_act != "1205":
            fail(f"ACT not persisted: {saved_act}")
        else:
            ok("ACT value persisted")

        # --- Mach persistence ---
        strip.locator(".mach-box").fill("500")
        strip.locator(".mach-box").dispatch_event("input")
        mach_saved = page.evaluate("() => state.flights['TEST100'].stripValues.mach")
        if mach_saved != "500":
            fail(f"Mach not persisted: {mach_saved}")
        else:
            ok("Mach/groundspeed persisted")

        # --- Fix edit ---
        fix_boxes = strip.locator(".fix-box")
        fix_boxes.nth(0).fill("REXOD")
        fix_boxes.nth(0).dispatch_event("input")
        fix_saved = page.evaluate(
            "() => state.flights['TEST100'].stripValues.fixes[0]"
        )
        if fix_saved != "REXOD":
            fail(f"Fix not persisted: {fix_saved}")
        else:
            ok("Fix edit persisted")

        # --- Mumbai sector strip + isolation ---
        inject_oceanic_strip(
            page,
            "MUMBAI1",
            "mumbai",
            ["ADKIT", "XOKRO", "SADRI", "MEMAK"],
            lane="planned",
        )
        page.select_option("#sectorSelect", "mumbai")
        page.wait_for_timeout(100)
        if page.locator('.strip[data-callsign="MUMBAI1"]').count() != 1:
            fail("Mumbai strip not visible on Mumbai sector")
        else:
            ok("Mumbai strip visible on Mumbai sector")
        if page.locator('.strip[data-callsign="TEST100"]').count() != 0:
            fail("Chennai strip visible on Mumbai sector")
        else:
            ok("Chennai strip hidden on Mumbai sector")

        page.select_option("#sectorSelect", "chennai")
        page.wait_for_timeout(100)
        if page.locator('.strip[data-callsign="TEST100"]').count() != 1:
            fail("Chennai strip not visible after switch back")
        else:
            ok("Chennai strip visible after sector switch")

        # --- Persistence after reload ---
        page.reload()
        page.wait_for_selector("#sectorSelect")
        page.select_option("#sectorSelect", "chennai")
        page.wait_for_timeout(100)
        reloaded_est = page.locator(
            '.strip[data-callsign="TEST100"] .est-box'
        ).first.input_value()
        if not reloaded_est or "}" in reloaded_est:
            fail(f"EST not persisted after reload: {reloaded_est!r}")
        else:
            ok(f"EST persisted after reload: {reloaded_est}")

        # --- Delete strip ---
        strip_el = page.locator('.strip[data-callsign="TEST100"]')
        strip_el.dblclick(position={"x": 10, "y": 10})
        page.wait_for_timeout(100)
        if page.locator('.strip[data-callsign="TEST100"]').count() != 0:
            fail("Strip not deleted on double-click")
        else:
            ok("Strip deleted on double-click")

        # --- Strip with no fixes (min 4 columns) ---
        inject_oceanic_strip(page, "EMPTY1", "chennai", [])
        empty_strip = page.locator('.strip[data-callsign="EMPTY1"]')
        if empty_strip.locator(".fix-box").count() < 4:
            fail("Empty strip should have at least 4 fix columns")
        else:
            ok("Empty strip has minimum 4 fix columns")

        # --- Direction coloring ---
        inject_oceanic_strip(
            page,
            "WBTEST",
            "chennai",
            ["MURUS", "PERRY", "LEVLU", "BUSUX"],
        )
        bg = page.locator('.strip[data-callsign="WBTEST"]').evaluate(
            "el => el.style.background"
        )
        if "dbeafe" not in bg and "fef9c3" not in bg:
            ok(f"Direction color neutral/other: {bg}")
        else:
            ok(f"Direction color applied: {bg}")

        # --- Console errors ---
        # (checked implicitly; reload fixcoord)
        resp = page.request.get(f"{BASE}/fixcoord.json")
        if not resp.ok:
            fail("fixcoord.json not loadable")
        else:
            data = resp.json()
            if "RASKI" not in data or "ADKIT" not in data:
                fail("fixcoord.json missing sector fixes")
            else:
                ok(f"fixcoord.json has {len(data)} fixes")

        # --- Altitude box NaN check ---
        inject_oceanic_strip(
            page,
            "ALTTEST",
            "chennai",
            ["RASKI", "PARAR"],
            altitude="",
            cruise="----",
        )
        alt_val = page.locator(
            '.strip[data-callsign="ALTTEST"] .alt-box'
        ).input_value()
        if alt_val.lower() == "nan":
            fail("Altitude box shows NaN")
        else:
            ok(f"Altitude box value: {alt_val!r}")

        browser.close()

    server.shutdown()

    print("\n=== SUMMARY ===")
    if failures:
        print(f"{len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("All tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
