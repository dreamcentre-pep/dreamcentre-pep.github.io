"""Print-shop edition (CorelDRAW layout) for one issue. Run by .github/workflows/printshop.yml.
python printshop/run.py DATE CODE
The one-time CODE comes from the PEP Google script; with it this fetches the private kit
(fonts + template, never stored in the repository), the issue data, builds the PDF and posts it back to Drive."""
import base64, io, json, os, sys, urllib.request, zipfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
FEED = json.load(open(os.path.join(ROOT, 'config.json')))['feed'].strip()


def call(params=None, body=None):
    url = FEED + ('?' + urllib.parse.urlencode(params) if params else '')
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'pep-printshop', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.loads(r.read().decode('utf-8'))
    if out.get('ok') is False:
        raise SystemExit('Google script said: ' + str(out.get('error')))
    return out


def main(date, code):
    import urllib.parse  # noqa
    # 1. private kit
    first = call({'p': 'printkit', 'd': date, 'k': code, 'part': 0})
    raw = base64.b64decode(first['b64'])
    for i in range(1, first['parts']):
        raw += base64.b64decode(call({'p': 'printkit', 'd': date, 'k': code, 'part': i})['b64'])
    zipfile.ZipFile(io.BytesIO(raw)).extractall(HERE)
    import otf2ttf  # Trajan as TrueType: some Chromium versions misplace its CFF glyphs
    otf2ttf.convert(os.path.join(HERE, 'fonts', 'TrajanPro-Bold.otf'), os.path.join(HERE, 'fonts', 'TrajanPro-Bold.ttf'))
    os.environ['PEP_ICC'] = os.path.join(HERE, 'FOGRA39L_coated.icc')
    # 2. issue data (draft or approved), images as data URIs
    pd = call({'p': 'printdata', 'd': date, 'k': code})
    assets = pd.get('assets') or {}
    fix = lambda v: assets.get(v, v) if isinstance(v, str) else v
    I, M = pd['issue'], pd.get('month')
    I['service']['background'] = fix(I['service'].get('background'))
    for k in ('study', 'covenant', 'greaterWorks', 'messageForWeek', 'bookForWeek'):
        if I.get(k):
            I[k]['image'] = fix(I[k].get('image'))
    if M and M.get('word'):
        M['word']['image'] = fix(M['word'].get('image'))
    site = json.load(open(os.path.join(ROOT, 'data', 'site.json')))
    bundle = os.path.join(HERE, 'issue.json')
    json.dump({'site': site, 'issue': I, 'month': M}, open(bundle, 'w'))
    # 3. build
    import build
    out = os.path.join(HERE, f'PEP PRINT SHOP {date}.pdf')
    build.main(bundle, out, ROOT, os.path.join(HERE, 'template.pdf'))
    # 4. back to Drive
    r = call(body={'p': 'printupload', 'd': date, 'c': code, 'b64': base64.b64encode(open(out, 'rb').read()).decode()})
    print('saved to Drive:', r.get('url'))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
