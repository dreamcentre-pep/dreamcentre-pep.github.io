"""Render the 5-page A4 print edition of an issue: python tools/print_pdf.py 2026-10-25
Uses print.html. Page size (home printer A4, or print-shop A4 + 3 mm bleed) comes from
data/site.json -> "print": {"mode": "home" | "shop"}."""
import functools, http.server, os, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
date = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'print', f'{date}.pdf')
extra = sys.argv[3] if len(sys.argv) > 3 else ''


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


handler = functools.partial(Quiet, directory=ROOT)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.makedirs(os.path.dirname(out), exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1000, 'height': 1400})
    page.emulate_media(media='print', color_scheme='light')
    page.goto(f'http://127.0.0.1:8765/print.html?issue={date}{extra}', wait_until='networkidle')
    page.wait_for_function('window.PEP_PRINT_READY === true', timeout=60000)
    page.wait_for_timeout(500)
    page.pdf(path=out, print_background=True, prefer_css_page_size=True,
             margin={'top': '0', 'bottom': '0', 'left': '0', 'right': '0'})
    b.close()
srv.shutdown()
print('printed', date, '->', out)
