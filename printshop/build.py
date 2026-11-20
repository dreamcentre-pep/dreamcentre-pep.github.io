"""Print-shop edition in the CorelDRAW layout.
python build.py issue.json out.pdf [fonts_dir]
issue.json = {"site":..., "issue":..., "month":...}; image paths are resolved relative to ROOT (website root) or are data: URIs."""
import base64, functools, http.server, io, json, os, re, subprocess, sys, threading
import pikepdf, pymupdf
from PIL import Image
from playwright.sync_api import sync_playwright
import plates

HERE = os.path.dirname(os.path.abspath(__file__))
ICC = os.environ.get('PEP_ICC', '/usr/share/texlive/texmf-dist/tex/generic/colorprofiles/FOGRA39L_coated.icc')
MM = 72 / 25.4


def load_img(src, root):
    if src.startswith('data:'):
        return Image.open(io.BytesIO(base64.b64decode(src.split(',', 1)[1]))).convert('RGB')
    return Image.open(os.path.join(root, src)).convert('RGB')


def cover_crop(im, w, h):
    """crop to aspect w:h (centre) and return"""
    r = w / h
    if im.width / im.height > r:
        nw = int(im.height * r); x = (im.width - nw) // 2
        return im.crop((x, 0, x + nw, im.height))
    nh = int(im.width / r); y = (im.height - nh) // 2
    return im.crop((0, y, im.width, y + nh))


def jpeg(im, q=93):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q, subsampling=0); return b.getvalue()


def xo(pdf, xref):
    for pg in pdf.pages:
        x = pg.Resources.get('/XObject')
        if x is not None and ('/Im%d' % xref) in x:
            return x['/Im%d' % xref]
    raise KeyError(xref)


def put_image(pdf, xref, im):
    o = xo(pdf, xref)
    o.write(jpeg(im), filter=pikepdf.Name.DCTDecode)
    o.Width, o.Height = im.width, im.height
    o.ColorSpace = pikepdf.Name.DeviceRGB; o.BitsPerComponent = 8
    for k in ('/DecodeParms', '/Decode'):
        if k in o: del o[k]


def blank_image(pdf, xref):
    o = xo(pdf, xref)
    o.write(b'\xff\xff\xff'); o.Width = 1; o.Height = 1
    o.ColorSpace = pikepdf.Name.DeviceRGB; o.BitsPerComponent = 8
    for k in ('/DecodeParms', '/Decode', '/Filter'):
        if k in o: del o[k]
    m = pdf.make_stream(b'\x00'); m.Type = pikepdf.Name.XObject; m.Subtype = pikepdf.Name.Image
    m.Width = 1; m.Height = 1; m.ColorSpace = pikepdf.Name.DeviceGray; m.BitsPerComponent = 8
    o.SMask = m


def make_plate(template, out, data, root):
    I, M = data['issue'], data.get('month') or {}
    tmp = out + '.tmp.pdf'
    plates.build(template, tmp, data['accent'])
    pdf = pikepdf.open(tmp)
    # page 1: cover goes into the composite hero bitmap (x47); x14 is a duplicate layer
    cov = (I.get('service') or {}).get('background')
    o47 = Image.open(io.BytesIO(pdf.get_object((47, 0)).read_bytes())).convert('RGB') if False else None
    base = pymupdf.open(template)
    pm = pymupdf.Pixmap(base, 47)
    if pm.n - pm.alpha > 3: pm = pymupdf.Pixmap(pymupdf.csRGB, pm)
    hero = Image.frombytes('RGB', (pm.width, pm.height), pm.samples) if not pm.alpha else Image.frombytes('RGBA', (pm.width, pm.height), pm.samples).convert('RGB')
    if cov:
        k = hero.height / 389.0
        y0, y1 = int(85 * k), int(340.6 * k)
        c = cover_crop(load_img(cov, root), hero.width, y1 - y0).resize((hero.width, y1 - y0), Image.LANCZOS)
        hero.paste(c, (0, y0))
        # title colour: white on a dark cover, black on a bright one (area behind the title)
        reg = hero.crop((int(165 * k), int(90 * k), int(465 * k), int(202 * k))).convert('L').resize((60, 22))
        lum = sum(reg.getdata()) / (60 * 22) / 255
        data['titleColor'] = '#ffffff' if lum < 0.5 else '#000000'
        # bottom bands on page 1 and the last page are a crop of the cover
        src = load_img(cov, root)
        bh = max(1, int(src.width * 25.5669 / 595.2756))
        band = src.crop((0, (src.height - bh) // 2, src.width, (src.height - bh) // 2 + bh))
        band = band.resize((3000, int(3000 * 25.5669 / 595.2756)), Image.LANCZOS)
        band = band.transpose(Image.FLIP_TOP_BOTTOM).transpose(Image.TRANSPOSE)  # match the strip's rotated placement
        put_image(pdf, 90, band)
        put_image(pdf, 323, band)
    put_image(pdf, 47, hero)
    for x in (14, 82, 83, 85):
        blank_image(pdf, x)
    # page 2 hero (month image)
    w = (M.get('word') or {})
    if w.get('image'):
        put_image(pdf, 144, cover_crop(load_img(w['image'], root), 2205, 1032).resize((2205, 1032), Image.LANCZOS) if False else cover_crop(load_img(w['image'], root), 735 * 3, 344 * 3))
    # page 3: study header, greater works, covenant
    st, gw, cv = I.get('study') or {}, I.get('greaterWorks') or {}, I.get('covenant') or {}
    if st.get('image'):
        put_image(pdf, 193, cover_crop(load_img(st['image'], root), 1596, 885))
    for x in (152, 191, 192):
        blank_image(pdf, x)
    if gw.get('image'):
        put_image(pdf, 183, cover_crop(load_img(gw['image'], root), 1602, 686))
    if cv.get('image'):
        put_image(pdf, 190, cover_crop(load_img(cv['image'], root), 555, 539))
        blank_image(pdf, 189)
    pdf.save(out)
    os.remove(tmp)


def render_overlay(data, out, root):
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    # serve shop dir; assets resolved from root
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=HERE))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={'width': 900, 'height': 1200})
        pg.route('**/assets/**', lambda r: r.fulfill(path=os.path.join(root, 'assets', r.request.url.split('/assets/', 1)[1].split('?')[0])))
        pg.add_init_script('window.DATA=' + json.dumps(data) + ';')
        pg.goto(f'http://127.0.0.1:{port}/shop.html', wait_until='networkidle')
        pg.wait_for_function('window.READY===true', timeout=120000)
        pg.wait_for_timeout(300)
        pg.pdf(path=out, print_background=True, prefer_css_page_size=True, margin={'top': '0', 'bottom': '0', 'left': '0', 'right': '0'})
        b.close()
    srv.shutdown()


def compose(plate, overlay, pages, out, label):
    final = pymupdf.open()
    B, S = 3 * MM, 10 * MM
    for i, pn in enumerate(pages):
        # one fresh document per page: sharing sources across pages mixes up soft masks
        P, O = pymupdf.open(plate), pymupdf.open(overlay)
        doc = pymupdf.open()
        W0, H0 = P[0].rect.width, P[0].rect.height
        W, H = W0 + 2 * (B + S), H0 + 2 * (B + S)
        pg = doc.new_page(width=W, height=H)
        tx0, ty0 = S + B, S + B
        trim = pymupdf.Rect(tx0, ty0, tx0 + W0, ty0 + H0)
        bleed = pymupdf.Rect(S, S, W - S, H - S)
        # bleed: the page scaled up slightly underneath, then white trim area, then the real page
        sc = max(bleed.width / W0, bleed.height / H0)
        ew, eh = W0 * sc, H0 * sc
        pg.show_pdf_page(pymupdf.Rect(W / 2 - ew / 2, H / 2 - eh / 2, W / 2 + ew / 2, H / 2 + eh / 2), P, pn)
        # mask outside the bleed box (slug) back to white
        sh = pg.new_shape()
        for r in (pymupdf.Rect(0, 0, W, S), pymupdf.Rect(0, H - S, W, H), pymupdf.Rect(0, 0, S, H), pymupdf.Rect(W - S, 0, W, H)):
            sh.draw_rect(r)
        sh.draw_rect(trim)
        sh.finish(fill=(1, 1, 1), color=None, width=0); sh.commit()
        pg.show_pdf_page(trim, P, pn)
        pg.show_pdf_page(trim, O, i)
        sh = pg.new_shape(); L = 6 * MM; g = B + 1 * MM
        for x in (trim.x0, trim.x1):
            for y, d in ((trim.y0, -1), (trim.y1, 1)):
                sh.draw_line((x, y + d * g), (x, y + d * (g + L)))
        for y in (trim.y0, trim.y1):
            for x, d in ((trim.x0, -1), (trim.x1, 1)):
                sh.draw_line((x + d * g, y), (x + d * (g + L), y))
        sh.finish(color=(0, 0, 0), width=0.25); sh.commit()
        pg.insert_text((S + B, H - 3 * MM), f'{label}  |  page {i + 1} of {len(pages)}  |  A4 trim 210x297 mm, 3 mm bleed', fontsize=6, color=(0, 0, 0))
        pg.set_bleedbox(bleed); pg.set_trimbox(trim)
        tmp = f'{out}.{i}.pdf'; doc.save(tmp, garbage=3, deflate=True); doc.close()
        final.insert_pdf(pymupdf.open(tmp)); os.remove(tmp)
    final.save(out, garbage=3, deflate=True)


def to_cmyk(src, out):
    # neutral RGB fills -> gray so black text prints on the K plate only
    q = src + '.q.pdf'
    subprocess.run(['qpdf', '--qdf', '--object-streams=disable', src, q], check=True)
    d = open(q, 'rb').read()
    def f(m):
        r, g, b = (float(x) for x in m.group(1, 2, 3))
        if max(r, g, b) - min(r, g, b) <= 0.03:
            y = round(0.2126 * r + 0.7152 * g + 0.0722 * b, 4)
            return b'%g %s' % (y, {b'rg': b'g', b'RG': b'G', b'scn': b'g', b'SCN': b'G', b'sc': b'g', b'SC': b'G'}[m.group(4)])
        return m.group(0)
    d = re.sub(rb'(?<![\d.])(\d*\.?\d+) (\d*\.?\d+) (\d*\.?\d+) (rg|RG)\b', f, d)
    open(q, 'wb').write(d)
    q2 = src + '.q2.pdf'
    with open(q2, 'wb') as fh:
        subprocess.run(['fix-qdf', q], stdout=fh, check=True)
    # drop RGB transparency-group colour spaces
    doc = pymupdf.open(q2)
    # soft-mask groups keep their colour space (needed for luminosity masks)
    masks = set()
    for x in range(1, doc.xref_length()):
        try:
            t = doc.xref_get_key(x, 'G')
            if t[0] == 'xref' and doc.xref_get_key(x, 'S')[1] in ('/Luminosity', '/Alpha'):
                masks.add(int(t[1].split()[0]))
        except Exception:
            pass
    for x in range(1, doc.xref_length()):
        if x in masks:
            continue
        try:
            g = doc.xref_get_key(x, 'Group')
            if g[0] == 'dict' and '/DeviceRGB' in g[1]:
                doc.xref_set_key(x, 'Group/CS', 'null')
            elif g[0] == 'xref':
                gx = int(g[1].split()[0])
                if doc.xref_get_key(gx, 'CS')[1] == '/DeviceRGB':
                    doc.xref_set_key(gx, 'CS', 'null')
        except Exception:
            pass
    q3 = src + '.q3.pdf'; doc.save(q3, garbage=3, deflate=True)
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
                    '-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', '-sOutputICCProfile=' + ICC,
                    '-dOverrideICC=true', '-dRenderIntent=1', '-dBlackPtComp=1', '-dPDFSETTINGS=/prepress',
                    '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode', '-dJPEGQ=95',
                    '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dEmbedAllFonts=true',
                    '-dSubsetFonts=true', '-dPreserveTrimBox=true', '-o', out, q3], check=True)
    for t in (q, q2, q3):
        os.remove(t)


def accent_of(data, root):
    """Accent: the issue's own, else picked from the cover the same way the website does."""
    import colorsys
    a = data['issue'].get('accent')
    if a and re.match(r'^#[0-9a-fA-F]{6}$', a):
        return a
    try:
        im = load_img(data['issue']['service']['background'], root); im.thumbnail((120, 120))
        bins = {}
        for r, g, b in im.getdata():
            mx, mn = max(r, g, b), min(r, g, b)
            if mx < 90 or mx - mn < 60:
                continue
            h = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)[0] * 360
            bins.setdefault(round(h / 15), []).append((r, g, b))
        best = max(bins.values(), key=len) if bins else []
        if len(best) < 20:
            return '#fec91b'
        avg = [sum(p[j] for p in best) / len(best) / 255 for j in range(3)]
        h, l, s = colorsys.rgb_to_hls(*avg)
        l = min(max(l, .45), .62); s = max(s, .55)
        return '#%02x%02x%02x' % tuple(round(v * 255) for v in colorsys.hls_to_rgb(h, l, s))
    except Exception:
        return '#fec91b'


def main(issue_json, out, root, template=os.path.join(HERE, 'template.pdf')):
    data = json.load(open(issue_json))
    data['accent'] = accent_of(data, root)
    w = (data.get('month') or {}).get('word') or {}
    data['includeMonth'] = bool(w.get('title')) and any((b.get('p') or b.get('lead')) for b in (w.get('blocks') or []))
    pages = [0, 1, 2, 3, 4] if data['includeMonth'] else [0, 2, 3, 4]
    work = out + '.work'
    os.makedirs(work, exist_ok=True)
    make_plate(template, f'{work}/plate.pdf', data, root)
    render_overlay(data, f'{work}/overlay.pdf', root)
    compose(f'{work}/plate.pdf', f'{work}/overlay.pdf', pages, f'{work}/rgb.pdf', 'PEP Magazine ' + data['issue']['date'])
    to_cmyk(f'{work}/rgb.pdf', out)
    print('built', out, 'pages', len(pages))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, '..', 'repo'))
