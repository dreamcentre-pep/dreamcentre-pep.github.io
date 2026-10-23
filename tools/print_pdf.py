"""Render the A4 print edition of an issue: python tools/print_pdf.py 2026-10-25"""
import functools, http.server, os, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
date = sys.argv[1]
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.makedirs(os.path.join(ROOT, 'print'), exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 900, 'height': 1200})
    page.emulate_media(color_scheme='light')
    page.goto(f'http://127.0.0.1:8765/?issue={date}&print=1', wait_until='networkidle')
    page.wait_for_timeout(1500)
    page.pdf(path=os.path.join(ROOT, 'print', f'{date}.pdf'), format='A4', print_background=True,
             margin={'top': '12mm', 'bottom': '12mm', 'left': '10mm', 'right': '10mm'})
    b.close()
srv.shutdown()
print('printed', date)
