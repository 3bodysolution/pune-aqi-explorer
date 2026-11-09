"""Current official-method AQI for every Pune CAAQMS station -> site/data/latest.json.

Usage:  python tools/fetch_latest.py site/data
Key:    env OPENAQ_API_KEY or file `openaq.key` (never shipped to the browser).
Method (CPCB National AQI): 24-h average for PM2.5, PM10, NO2, SO2, NH3 (needs >=16 hourly values);
CO and O3 use the maximum 8-h running average within the same 24 h (needs >=6 values per 8-h window).
AQI = max sub-index; requires >=3 pollutants including PM2.5 or PM10. City value = median of stations.
Values are CPCB's own numbers republished by OpenAQ; OpenAQ's unit labels for gases are ignored (they are
wrong for CPCB data, verified against CPCB files), so values are used in CPCB native units.
"""
import json, os, re, sys, time, statistics as st, datetime as dt, urllib.request, urllib.parse, urllib.error
sys.path.insert(0, os.path.dirname(__file__))
from aqi import sub

OUT = sys.argv[1]
KEY = os.environ.get('OPENAQ_API_KEY') or (open('openaq.key').read().strip() if os.path.exists('openaq.key') else None)
if not KEY: sys.exit('No OpenAQ key: set OPENAQ_API_KEY or create openaq.key')
API = 'https://api.openaq.org/v3'
# station id -> (regex on OpenAQ location name, display name)  — keep in sync with tools/process.py
STN = {
    'karve': (r'karve road pune, pune', 'Karve Road'), 'shivajinagar': (r'revenue colony', 'Revenue Colony–Shivajinagar'),
    'kothrud': (r'kothrud', 'MIT–Kothrud'), 'hadapsar': (r'hadapsar', 'Hadapsar'), 'alandi': (r'alandi', 'Alandi'),
    'bhosari': (r'bhosari', 'Bhosari'), 'nigdi': (r'nigdi', 'Transport Nagar–Nigdi'), 'mhada': (r'mhada', 'Mhada Colony'),
    'katraj': (r'katraj', 'Katraj Dairy'), 'sppu': (r'savitribai', 'Savitribai Phule Pune University'),
    'bhumkar': (r'bhumkar', 'Bhumkar Nagar'), 'pashan': (r'panchawati|pashan', 'Panchawati–Pashan'),
    'dhankawadi': (r'dhankawadi', 'Dhankawadi'), 'gavalinagar': (r'gavalinagar', 'Gavalinagar'),
    'wakad': (r'park street wakad', 'Park Street Wakad'), 'thergaon': (r'thergaon', 'Thergaon'),
    'savtamali': (r'savta mali', 'Savta Mali Nagar'),
}
POLS = ('pm25', 'pm10', 'no2', 'so2', 'nh3', 'co', 'o3')
LIM = {'pm25': 1000, 'pm10': 1500, 'no2': 1000, 'nh3': 3000, 'so2': 3000, 'co': 100, 'o3': 1500}  # same as process.py
CATS = [(50, 'Good'), (100, 'Satisfactory'), (200, 'Moderate'), (300, 'Poor'), (400, 'Very Poor'), (10**9, 'Severe')]
STALE_H = 3   # a station whose newest hour is older than this is reported as not current


def get(path, **q):
    url = f'{API}{path}?{urllib.parse.urlencode(q)}'
    for attempt in range(4):
        time.sleep(1.1)  # free tier: 60 requests/minute
        try:
            req = urllib.request.Request(url, headers={'X-API-Key': KEY, 'User-Agent': 'pune-aqi-explorer'})
            with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3: time.sleep(5 * (attempt + 1)); continue
            raise


now = dt.datetime.now(dt.timezone.utc)
locs = []
for lat, lon in ((18.52, 73.86), (18.63, 73.80)):
    locs += get('/locations', coordinates=f'{lat},{lon}', radius=25000, limit=1000)['results']
best = {}
for L in locs:
    name = L.get('name') or ''
    if not re.search(r'MPCB|IITM|CPCB', name + ' ' + str((L.get('provider') or {}).get('name')), re.I): continue
    k = next((k for k, (rx, _) in STN.items() if re.search(rx, name, re.I)), None)
    last = (L.get('datetimeLast') or {}).get('utc') or ''
    if k and last > (best.get(k, (None, ''))[1]): best[k] = (L['id'], last)   # newest location wins (e.g. Bhosari moved id)

stations = []
for k, (lid, last) in sorted(best.items()):
    name = STN[k][1]
    rec = dict(id=k, name=name, openaq_location=lid, aqi=None, category=None, dominant=None, sub={}, window_end=None,
               last_hour={}, note=None)
    if dt.datetime.fromisoformat(last.replace('Z', '+00:00')) < now - dt.timedelta(hours=STALE_H):
        rec['note'] = f'no data since {last[:16].replace("T", " ")} UTC'; stations.append(rec); continue
    try:
        sensors = get(f'/locations/{lid}/sensors')['results']
        series = {}
        for s in sensors:
            p = s['parameter']['name']
            if p not in POLS: continue
            h = get(f"/sensors/{s['id']}/hours", datetime_from=(now - dt.timedelta(hours=30)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                    limit=100)['results']
            vals = {x['period']['datetimeTo']['utc']: x['value'] for x in h
                    if x.get('value') is not None and 0 <= x['value'] <= LIM[p]}
            if vals: series[p] = vals
        if not series: rec['note'] = 'no recent readings'; stations.append(rec); continue
        end = max(t for v in series.values() for t in v)
        end_dt = dt.datetime.fromisoformat(end.replace('Z', '+00:00'))
        win = [(end_dt - dt.timedelta(hours=i)).strftime('%Y-%m-%dT%H:%M:%SZ') for i in range(24)][::-1]  # 24 hourly slots
        for p, vals in series.items():
            v = [vals.get(t) for t in win]
            if p in ('co', 'o3'):
                runs = [[x for x in v[i:i + 8] if x is not None] for i in range(17)]
                runs = [st.fmean(r) for r in runs if len(r) >= 6]
                c = max(runs) if runs else None
            else:
                got = [x for x in v if x is not None]
                c = st.fmean(got) if len(got) >= 16 else None
            if c is not None: rec['sub'][p] = round(sub(p, c))
            if vals.get(end) is not None and p in ('pm25', 'pm10'): rec['last_hour'][p] = round(vals[end], 1)
        if ('pm25' in rec['sub'] or 'pm10' in rec['sub']) and len(rec['sub']) >= 3:
            rec['dominant'] = max(rec['sub'], key=rec['sub'].get)
            rec['aqi'] = min(500, rec['sub'][rec['dominant']])
            rec['category'] = next(n for hi, n in CATS if rec['aqi'] <= hi)
        else:
            rec['note'] = 'not enough pollutants with 16+ hours of data in the last 24 h'
        rec['window_end'] = (end_dt + dt.timedelta(hours=5, minutes=30)).strftime('%Y-%m-%d %H:%M IST')
        if end_dt < now - dt.timedelta(hours=STALE_H): rec['note'] = 'data delayed'; rec['aqi'] = None; rec['category'] = None
    except Exception as e:  # one failing station must not break the whole update
        rec['note'] = f'fetch failed ({type(e).__name__})'
    stations.append(rec)
    print(f"{k:13s} AQI {rec['aqi']} {rec['dominant']} sub={rec['sub']} now={rec['last_hour']} end={rec['window_end']} {rec['note'] or ''}", flush=True)

valid = [s['aqi'] for s in stations if s['aqi'] is not None]
city = round(st.median(valid)) if len(valid) >= 3 else None
out = dict(generated_utc=now.strftime('%Y-%m-%dT%H:%M:%SZ'),
           generated_ist=(now + dt.timedelta(hours=5, minutes=30)).strftime('%Y-%m-%d %H:%M IST'),
           city=dict(aqi=city, category=next(n for hi, n in CATS if city <= hi) if city is not None else None,
                     stations=len(valid)),
           method='CPCB National AQI: 24-h averages (CO, O3: max 8-h average) over the latest 24 hours per station; '
                  'city value = median of stations.',
           source='CPCB CAAQMS station readings via OpenAQ', stations=stations)
tmp = os.path.join(OUT, 'latest.json.tmp')
with open(tmp, 'w', encoding='utf-8') as f: json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
os.replace(tmp, os.path.join(OUT, 'latest.json'))
print('City median AQI:', city, f'({len(valid)} stations)')
