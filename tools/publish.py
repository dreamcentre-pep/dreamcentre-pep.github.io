"""Pull the approved issue from the PEP Google script and write it into the site.
Run by .github/workflows/publish.yml. Prints changed=true|false to $GITHUB_OUTPUT."""
import base64, io, json, os, sys, urllib.request
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, *a)
cfg = json.load(open(P('config.json')))
FEED = cfg.get('feed', '').strip()


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'pep-publisher'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode('utf-8'))


def out(changed, date=''):
    gh = os.environ.get('GITHUB_OUTPUT')
    if gh:
        with open(gh, 'a') as f:
            f.write(f'changed={"true" if changed else "false"}\ndate={date}\n')
    print('changed' if changed else 'no change', date)


def save_img(entry, path, max_w=1800):
    im = Image.open(io.BytesIO(base64.b64decode(entry['b64'])))
    im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    os.makedirs(os.path.dirname(P(path)), exist_ok=True)
    im.save(P(path), 'WEBP', quality=80, method=6)


def main():
    if not FEED:
        return out(False)
    state_p = P('data', 'state.json')
    state = json.load(open(state_p)) if os.path.exists(state_p) else {}
    info = get(FEED + '?p=feedinfo')
    if not info.get('ok') or (info.get('date') == state.get('date') and info.get('version') == state.get('version')):
        return out(False)
    full = get(FEED + '?p=feed')
    date, ym = full['date'], full['date'][:7]
    issue, month, imgs = full['issue'], full.get('month'), full.get('images', {})
    paths = {}
    for key, entry in imgs.items():
        folder = ym if key == 'month' else date
        paths[key] = f'assets/{folder}/{key}.webp'
        save_img(entry, paths[key], 1000 if key in ('book', 'message') else 1800)
    swap = lambda v: paths.get(v, v) if isinstance(v, str) else v
    issue['service']['background'] = swap(issue['service']['background'])
    for k in ('study', 'covenant', 'greaterWorks', 'messageForWeek', 'bookForWeek'):
        if issue.get(k):
            issue[k]['image'] = swap(issue[k].get('image'))
    if month and month.get('word'):
        month['word']['image'] = swap(month['word'].get('image'))
    issue.pop('preview', None)
    issue['status'] = 'approved'
    issue['printPdf'] = f'print/{date}.pdf'
    site = json.load(open(P('data', 'site.json')))
    site['archive'] = sorted(set(site.get('archive', []) + [date]), reverse=True)
    json.dump(site, open(P('data', 'site.json'), 'w'), ensure_ascii=False, indent=1)
    bundle = {'site': site, 'issue': issue, 'month': month}
    os.makedirs(P('data', 'issues'), exist_ok=True)
    for f in (P('data', 'issues', f'{date}.json'), P('data', 'current.json')):
        json.dump(bundle, open(f, 'w'), ensure_ascii=False)
    json.dump({'date': date, 'version': info.get('version')}, open(state_p, 'w'))
    out(True, date)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # keep the live site as it is
        print('publish failed:', e, file=sys.stderr)
        out(False)
        sys.exit(1)
