"""Fetch 2026+ Pune station data from OpenAQ (mirrors CPCB CAAQMS) into raw/o_<station>.csv.

Usage:  python tools/fetch_openaq.py raw [--from 2026-01-01]
Key:    env OPENAQ_API_KEY, or a file named `openaq.key` in the working directory
        (free key: https://explore.openaq.org/register). The key is only used to look up
        which OpenAQ locations are the Pune stations; readings come from OpenAQ's public
        archive (s3://openaq-data-archive), which needs no key.
Output columns match the 2024-25 CPCB files, so tools/process.py reads them unchanged.
"""
import concurrent.futures, csv, gzip, io, json, os, re, sys, urllib.request, urllib.parse, datetime as dt, xml.etree.ElementTree as ET

RAW = sys.argv[1]
START = dt.date.fromisoformat(sys.argv[sys.argv.index('--from') + 1]) if '--from' in sys.argv else dt.date(2026, 1, 1)
KEY = os.environ.get('OPENAQ_API_KEY') or (open('openaq.key').read().strip() if os.path.exists('openaq.key') else None)
if not KEY: sys.exit('No OpenAQ key: set OPENAQ_API_KEY or create openaq.key')

# station id -> regex matched against the OpenAQ location name (CPCB naming)
MATCH = {
    'karve': r'karve', 'shivajinagar': r'revenue colony|shivajinagar', 'kothrud': r'kothrud',
    'hadapsar': r'hadapsar', 'alandi': r'alandi', 'bhosari': r'bhosari', 'nigdi': r'nigdi',
    'mhada': r'mhada', 'katraj': r'katraj', 'sppu': r'savitribai|university', 'bhumkar': r'bhumkar',
    'pashan': r'panchawati|pashan', 'dhankawadi': r'dhankawadi',
    'gavalinagar': r'gavalinagar', 'wakad': r'park street wakad', 'thergaon': r'thergaon', 'savtamali': r'savta mali',
}
COLS = ['pm25', 'pm10', 'no', 'no2', 'nox', 'nh3', 'so2', 'co', 'o3']   # order of the CPCB file columns 5..13
HEADER = ['Station ID', 'State', 'City', 'Station Name', 'Timestamp', 'PM2.5 (µg/m³)', 'PM10 (µg/m³)', 'NO (µg/m³)',
          'NO2 (µg/m³)', 'NOx (ppb)', 'NH3 (µg/m³)', 'SO2 (µg/m³)', 'CO (mg/m³)', 'Ozone (µg/m³)']
MW = dict(no2=46.01, so2=64.07, o3=48.00, nh3=17.03, no=30.01, co=28.01)  # g/mol, for ppm/ppb -> mass at 25 °C


def get(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'pune-aqi-explorer', **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r: return r.read()


def to_target_unit(p, units, v):
    """OpenAQ republishes CPCB numbers verbatim (checked hour-by-hour against the CPCB 2025 files:
    identical values) but some gas unit labels are wrong (e.g. CO tagged 'ppb' is really mg/m³).
    So values are taken as-is in CPCB native units: µg/m³, CO mg/m³, NOx ppb. Labels are ignored."""
    return v


# 1) discover locations near Pune
locs = []
for lat, lon in ((18.52, 73.86), (18.63, 73.80)):   # central Pune + PCMC (API radius max 25 km)
    q = urllib.parse.urlencode(dict(coordinates=f'{lat},{lon}', radius=25000, limit=1000))
    locs += json.loads(get(f'https://api.openaq.org/v3/locations?{q}', {'X-API-Key': KEY}))['results']
seen, mapping = set(), {}
print('OpenAQ locations within 25 km:')
for L in locs:
    if L['id'] in seen: continue
    seen.add(L['id'])
    name = L.get('name') or ''
    st = next((k for k, rx in MATCH.items() if re.search(rx, name, re.I)), None)
    last = (L.get('datetimeLast') or {}).get('local')
    print(f"  {L['id']:>8}  {name[:55]:55s} provider={(L.get('provider') or {}).get('name')}  last={last}  -> {st}")
    # keep only official CAAQMS stations (CPCB names end in '- MPCB' / '- IITM'), not low-cost sensors
    official = re.search(r'MPCB|IITM|CPCB', name + ' ' + str((L.get('provider') or {}).get('name')), re.I)
    if st and official and last and last[:10] >= START.isoformat(): mapping.setdefault(st, []).append((L['id'], name))
print('Mapped:', json.dumps(mapping, indent=1))

# 2) download archive files for each mapped location and pivot to hourly rows
S3 = 'https://openaq-data-archive.s3.amazonaws.com'
units_seen, skipped = {}, {}
for st, ids in mapping.items():
    rows = {}
    # stations with no CPCB files get their full OpenAQ history; others only fill in after those files end
    S = START if any(os.path.exists(os.path.join(RAW, f'{x}_{st}.csv')) for x in ('h', 'q')) else dt.date(2017, 1, 1)
    for lid, lname in ids:
        token, keys = None, []
        for y in range(S.year, dt.date.today().year + 1):
            while True:
                q = dict(**{'list-type': '2', 'prefix': f'records/csv.gz/locationid={lid}/year={y}/'})
                if token: q['continuation-token'] = token
                x = ET.fromstring(get(f'{S3}/?{urllib.parse.urlencode(q)}'))
                ns = {'s': x.tag.split('}')[0][1:]}
                keys += [k.text for k in x.findall('s:Contents/s:Key', ns)]
                t = x.find('s:NextContinuationToken', ns); token = t.text if t is not None else None
                if not token: break
        def _dl(k):
            cp = os.path.join(RAW, 'openaq_cache', k.rsplit('/', 1)[1])
            day = re.search(r'-(\d{8})\.csv\.gz$', k).group(1)
            if dt.date(int(day[:4]), int(day[4:6]), int(day[6:])) < S: return
            if not os.path.exists(cp) or (dt.date.today() - dt.date(int(day[:4]), int(day[4:6]), int(day[6:]))).days <= 2:
                os.makedirs(os.path.dirname(cp), exist_ok=True)
                data = get(f'{S3}/{k}')
                with open(cp + '.part', 'wb') as f: f.write(data)
                os.replace(cp + '.part', cp)
        with concurrent.futures.ThreadPoolExecutor(16) as ex: list(ex.map(_dl, keys))
        print(f'  {st}: {lid} {len(keys)} archive files', flush=True)
        for k in keys:
            day = re.search(r'-(\d{8})\.csv\.gz$', k).group(1)
            if dt.date(int(day[:4]), int(day[4:6]), int(day[6:])) < S: continue
            cp = os.path.join(RAW, 'openaq_cache', k.rsplit('/', 1)[1])
            for r in csv.DictReader(io.StringIO(gzip.decompress(open(cp, 'rb').read()).decode('utf-8'))):
                p = r['parameter'].lower()
                if p not in COLS: continue
                units_seen.setdefault(p, set()).add(r['units'])
                v = to_target_unit(p, r['units'], float(r['value']))
                if v is None: skipped[(p, r['units'])] = skipped.get((p, r['units']), 0) + 1; continue
                # archive datetimes carry the local offset (+05:30); keep local wall-clock time = IST
                ts = r['datetime'][:19]
                rows.setdefault(ts, {})[p] = v
    out = os.path.join(RAW, f'o_{st}.csv')
    with open(out, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f); w.writerow(HEADER)
        for ts in sorted(rows):
            w.writerow([f'openaq_{ids[0][0]}', 'Maharashtra', 'Pune', ids[0][1], ts + '.000000+0000'] +
                       [round(rows[ts][p], 3) if p in rows[ts] else '' for p in COLS])
    print(f'{st:13s} {len(rows):6d} timestamps -> {out}  ({rows and min(rows)} .. {rows and max(rows)})')
print('Units seen:', {p: sorted(u) for p, u in units_seen.items()})
if skipped: print('Skipped (unknown unit):', skipped)
