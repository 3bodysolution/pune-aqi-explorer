"""Build site/data/*.json from raw CPCB station CSVs (data.opencity.in).

Usage:  python tools/process.py raw site/data
Pure standard library. Every number shown on the website comes from here.
"""
import csv, json, os, sys, statistics as st, collections, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
from aqi import aqi

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

STATIONS = [  # key, display name, locality, agency
    ('karve', 'Karve Road', 'Karve Road / Erandwane', 'MPCB'),
    ('shivajinagar', 'Revenue Colony–Shivajinagar', 'Shivajinagar', 'IITM'),
    ('kothrud', 'MIT–Kothrud', 'Kothrud', 'IITM'),
    ('hadapsar', 'Hadapsar', 'Hadapsar', 'IITM'),
    ('alandi', 'Alandi', 'Alandi', 'IITM'),
    ('bhosari', 'Bhosari', 'Bhosari (PCMC)', 'IITM'),
    ('nigdi', 'Transport Nagar–Nigdi', 'Nigdi (PCMC)', 'IITM'),
    ('mhada', 'Mhada Colony', 'Mhada Colony', 'IITM'),
    ('katraj', 'Katraj Dairy', 'Katraj', 'MPCB'),
    ('sppu', 'Savitribai Phule Pune University', 'Ganeshkhind / SPPU', 'MPCB'),
    ('bhumkar', 'Bhumkar Nagar', 'Wakad–Tathawade (PCMC)', 'IITM'),
    ('pashan', 'Panchawati–Pashan', 'Pashan', 'IITM'),
    ('dhankawadi', 'Dhankawadi', 'Dhankawadi', 'IITM'),
    ('gavalinagar', 'Gavalinagar', 'Gavalinagar, Bhosari (PCMC)', 'MPCB'),
    ('wakad', 'Park Street Wakad', 'Wakad (PCMC)', 'MPCB'),
    ('thergaon', 'Thergaon', 'Thergaon (PCMC)', 'MPCB'),
    ('savtamali', 'Savta Mali Nagar', 'Pimpri (PCMC)', 'IITM'),
]
MONTHS = {m: i for i, m in enumerate(['January', 'February', 'March', 'April', 'May', 'June', 'July',
                                       'August', 'September', 'October', 'November', 'December'], 1)}
COLS = {'pm25': 5, 'pm10': 6, 'no2': 8, 'nh3': 10, 'so2': 11, 'co': 12, 'o3': 13}
# Physically implausible readings (sensor faults) are dropped.
LIM = {'pm25': 1000, 'pm10': 1500, 'no2': 1000, 'nh3': 3000, 'so2': 3000, 'co': 100, 'o3': 1500}
MIN_HOURS = 16     # hours needed for a valid daily value
MIN_DAYS = 219     # days (60%) needed for a valid station-year
MIN_STN_CITY = 3   # stations needed for a city-wide daily value
QC_RATIO = 2.5     # station-month mean >= this x median of other stations' same-month means -> excluded
CATS = [(50, 'Good'), (100, 'Satisfactory'), (200, 'Moderate'), (300, 'Poor'), (400, 'Very Poor'), (10**9, 'Severe')]
def cat(v): return next(n for hi, n in CATS if v <= hi)


def old_hourly(fn):
    """2017-2023 files: per-month blocks, rows=day, cols=hour, values=hourly AQI."""
    out, ym = {}, None
    with open(fn, encoding='utf-8-sig') as f:
        for r in csv.reader(f):
            if not r or r[0] == 'Year': continue
            h = r[0].split('-')
            if len(h) == 2 and h[0] in MONTHS: ym = (int(h[1]), MONTHS[h[0]]); continue
            if r[0].strip().isdigit() and ym:
                for hr, v in enumerate(r[1:25]):
                    v = v.strip()
                    if v:
                        x = float(v)
                        if 0 <= x <= 500:
                            out[(dt.date(ym[0], ym[1], int(r[0])), hr)] = (x, None)
    return out


def new_hourly(fn):
    """2024-25 files: 15-min concentrations. Timestamps are labelled +0000 but are IST
    (diurnal profile: minimum ~05-06h, peaks ~09h and ~20-21h local), so used as-is."""
    acc = collections.defaultdict(lambda: collections.defaultdict(list))
    with open(fn, encoding='utf-8') as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) < 14 or len(row[4]) < 13: continue
            k = (dt.date.fromisoformat(row[4][:10]), int(row[4][11:13]))
            for p, c in COLS.items():
                v = row[c].strip()
                if v:
                    try: x = float(v)
                    except ValueError: continue
                    if 0 <= x <= LIM[p]: acc[k][p].append(x)
    out, conc = {}, {}
    for k, d in acc.items():
        m = {p: st.fmean(v) for p, v in d.items()}
        a, dom = aqi(m)
        conc[k] = m
        if a is not None: out[k] = (a, dom)
    return out, conc


stations, daily, hourly_prof, dominant, pol_daily = [], {}, {}, {}, {}
raw_store = {}
for key, name, loc, agency in STATIONS:
    hours, conc = {}, {}
    src = []
    if os.path.exists(f'{RAW}/h_{key}.csv'): hours.update(old_hourly(f'{RAW}/h_{key}.csv')); src.append('2017-2023 hourly AQI')
    if os.path.exists(f'{RAW}/q_{key}.csv'):
        h2, conc = new_hourly(f'{RAW}/q_{key}.csv'); hours.update(h2); src.append('2024-2025 15-min concentrations')
    if os.path.exists(f'{RAW}/o_{key}.csv'):  # OpenAQ archive (tools/fetch_openaq.py): only days after existing data
        cut = max((d for d, h in hours), default=dt.date.min)
        h3, c3 = new_hourly(f'{RAW}/o_{key}.csv')
        h3 = {k: v for k, v in h3.items() if k[0] > cut}
        if h3:
            hours.update(h3); conc.update({k: v for k, v in c3.items() if k[0] > cut})
            src.append(f'OpenAQ archive from {min(k[0] for k in h3).isoformat()}')
    byday = collections.defaultdict(list)
    for (d, hr), (v, dom) in hours.items(): byday[d].append(v)
    dv = {d: round(st.fmean(v)) for d, v in byday.items() if len(v) >= MIN_HOURS}
    daily[key] = dv
    raw_store[key] = (hours, conc, name, loc, agency, src)

# ---- QC: flag station-months implausibly far above the other stations (likely sensor faults) ----
def month_means(dv):
    b = collections.defaultdict(list)
    for d, v in dv.items(): b[(d.year, d.month)].append(v)
    return {m: st.fmean(v) for m, v in b.items() if len(v) >= 15}
mm = {k: month_means(v) for k, v in daily.items()}
flags = []
for k in mm:
    for m, v in mm[k].items():
        others = [mm[o][m] for o in mm if o != k and m in mm[o]]
        if len(others) >= 2 and v / st.median(others) >= QC_RATIO:
            flags.append(dict(station=k, month=f'{m[0]}-{m[1]:02d}', mean=round(v), others_median=round(st.median(others)),
                              ratio=round(v / st.median(others), 2)))
flagged = {(f['station'], f['month']) for f in flags}
def ok(k, d): return (k, f'{d.year}-{d.month:02d}') not in flagged
for k in daily: daily[k] = {d: v for d, v in daily[k].items() if ok(k, d)}

for key, (hours, conc, name, loc, agency, src) in raw_store.items():
    dv = daily[key]
    hours = {k: v for k, v in hours.items() if ok(key, k[0])}
    # hour-of-day profile by season, from valid hourly values
    prof = collections.defaultdict(lambda: collections.defaultdict(list))
    for (d, hr), (v, dom) in hours.items():
        s = 'winter' if d.month in (11, 12, 1, 2) else 'monsoon' if d.month in (6, 7, 8, 9) else 'other'
        prof[s][hr].append(v); prof['all'][hr].append(v)
    hourly_prof[key] = {s: [round(st.fmean(p[h])) if p[h] else None for h in range(24)] for s, p in prof.items()}
    dominant[key] = dict(collections.Counter(dom for (d, hr), (v, dom) in hours.items() if dom))
    # daily pollutant means (2024-25 only)
    pd_ = collections.defaultdict(lambda: collections.defaultdict(list))
    for (d, hr), m in conc.items():
        if not ok(key, d): continue
        for p in ('pm25', 'pm10', 'no2', 'o3', 'co', 'so2', 'nh3'):
            if p in m: pd_[d][p].append(m[p])
    pol_daily[key] = {d.isoformat(): {p: round(st.fmean(v), 2) for p, v in ps.items() if len(v) >= MIN_HOURS}
                      for d, ps in pd_.items()}
    yrs = collections.Counter(d.year for d in dv)
    stations.append(dict(id=key, name=name, locality=loc, agency=agency, sources=src,
                         first=min(dv).isoformat() if dv else None, last=max(dv).isoformat() if dv else None,
                         days_by_year={str(y): n for y, n in sorted(yrs.items())},
                         excluded_months=[f['month'] for f in flags if f['station'] == key]))
    print(f'{key:13s} days={len(dv):5d} {dict(sorted(yrs.items()))}')
print('QC flagged:', [(f['station'], f['month'], f['ratio']) for f in flags])

all_days = sorted({d for v in daily.values() for d in v})
D0, D1 = all_days[0], all_days[-1]
PARTIAL_YEAR = D1.year if D1 < dt.date(D1.year, 12, 31) else None

# ---- city-wide daily series: median of stations reporting that day ----
city = {}
for d in all_days:
    vs = [daily[k][d] for k in daily if d in daily[k]]
    if len(vs) >= MIN_STN_CITY: city[d] = (round(st.median(vs)), len(vs))

# ---- station-year means (valid years only) ----
syear = {k: {} for k in daily}
for k, dv in daily.items():
    by = collections.defaultdict(list)
    for d, v in dv.items(): by[d.year].append(v)
    for y, v in by.items():
        if y == PARTIAL_YEAR: continue  # incomplete calendar year: excluded from year-level stats
        if len(v) >= MIN_DAYS: syear[k][y] = dict(mean=round(st.fmean(v), 1), days=len(v),
                                                  pct_poor_or_worse=round(100 * sum(x > 200 for x in v) / len(v), 1))
years = sorted({y for v in syear.values() for y in v})
city_year = {}
for y in years:
    ks = [k for k in syear if y in syear[k]]
    cd = [v for d, (v, n) in city.items() if d.year == y]
    city_year[y] = dict(median_of_station_means=round(st.median(syear[k][y]['mean'] for k in ks), 1),
                        stations=ks, city_days=len(cd),
                        cat_days={c: sum(cat(v) == c for v in cd) for _, c in CATS})

# ---- monthly climatology (city series) ----
mon = collections.defaultdict(list)
for d, (v, n) in city.items(): mon[d.month].append(v)
month_clim = {m: round(st.fmean(mon[m]), 1) for m in range(1, 13) if mon[m]}

# ---- monthly series per station (for heatmaps) ----
monthly = {}
for k, dv in daily.items():
    b = collections.defaultdict(list)
    for d, v in dv.items(): b[f'{d.year}-{d.month:02d}'].append(v)
    monthly[k] = {m: round(st.fmean(v)) for m, v in sorted(b.items()) if len(v) >= 15}

# ================= INSIGHTS (all text generated from computed numbers) =================
ins = []
def add(id_, title, text, data, caveat=None): ins.append(dict(id=id_, title=title, text=text, data=data, caveat=caveat))

w = st.fmean(v for m, v in month_clim.items() if m in (11, 12, 1, 2))
mo = st.fmean(v for m, v in month_clim.items() if m in (6, 7, 8, 9))
worst_m = max(month_clim, key=month_clim.get); best_m = min(month_clim, key=month_clim.get)
MN = list(MONTHS)
add('seasonality', f'Winter AQI is {w / mo:.1f}× the monsoon level',
    f'Across {min(city).year}–{max(city).year} (days with ≥{MIN_STN_CITY} stations reporting), the city-wide daily AQI averages {w:.0f} in Nov–Feb versus {mo:.0f} in Jun–Sep — '
    f'{w / mo:.1f}× higher. {MN[worst_m - 1]} is the worst month on average ({month_clim[worst_m]:.0f}); '
    f'{MN[best_m - 1]} the cleanest ({month_clim[best_m]:.0f}).',
    dict(winter=round(w, 1), monsoon=round(mo, 1), month_clim=month_clim))

ym = {y: c['median_of_station_means'] for y, c in city_year.items() if len(c['stations']) >= 3}
by_, wy = min(ym, key=ym.get), max(ym, key=ym.get)
add('yearly', 'Year-by-year: best and worst years',
    f'Among years with at least 3 stations meeting the coverage bar, {wy} had the highest typical station-average AQI '
    f'({ym[wy]:.0f}) and {by_} the lowest ({ym[by_]:.0f}).',
    dict(by_year=ym, stations_per_year={y: len(c["stations"]) for y, c in city_year.items()}),
    'The set of stations differs between years, and from 2024 the AQI is computed from pollutant concentrations '
    '(see Methodology), so treat year-to-year changes as indicative.')

lt = {}
for k in syear:
    vals = [v for d, v in daily[k].items()]
    if len(vals) >= 2 * MIN_DAYS: lt[k] = round(st.fmean(vals), 1)
wk_, bk = max(lt, key=lt.get), min(lt, key=lt.get)
nm = {s[0]: s[1] for s in STATIONS}
add('regions', 'The most and least polluted areas',
    f'Over their full records, {nm[wk_]} has the highest average daily AQI ({lt[wk_]:.0f}) and '
    f'{nm[bk]} the lowest ({lt[bk]:.0f}) among stations with at least {2 * MIN_DAYS} valid days.',
    dict(longterm_mean=lt), 'Stations cover different periods; compare same-year values in the region table for a fair comparison.')

# Same-year fairness: rank within each year
rank = {y: sorted(((syear[k][y]['mean'], k) for k in syear if y in syear[k]), reverse=True) for y in years}
top_counts = collections.Counter(r[0][1] for y, r in rank.items() if len(r) >= 3)
if top_counts:
    k, n = top_counts.most_common(1)[0]
    add('consistent_hotspot', 'A consistent hotspot',
        f'{nm[k]} was the most polluted station in {n} of {sum(len(r) >= 3 for r in rank.values())} years '
        f'(comparing only stations with valid data in the same year).',
        dict(rank_by_year={y: [[kk, m] for m, kk in r] for y, r in rank.items()}))

def window_mean(k, a, b):
    v = [daily[k][d] for d in daily[k] if a <= d <= b]
    return st.fmean(v) if len(v) >= 0.7 * ((b - a).days + 1) else None
pairs = []
for k in daily:
    a = window_mean(k, dt.date(2020, 4, 1), dt.date(2020, 5, 31)); b = window_mean(k, dt.date(2019, 4, 1), dt.date(2019, 5, 31))
    if a and b: pairs.append((k, round(b), round(a)))
if pairs:
    ch = st.fmean((a - b) / b * 100 for k, b, a in pairs)
    add('lockdown', 'The 2020 lockdown effect',
        (f'Only one station ({nm[pairs[0][0]]}) has data for both periods: its' if len(pairs) == 1 else
         f'At the {len(pairs)} stations with data in both periods,') + f' average AQI in Apr–May 2020 was '
        f'{abs(ch):.0f}% {"lower" if ch < 0 else "higher"} than in Apr–May 2019.',
        dict(stations=[dict(id=k, y2019=b, y2020=a) for k, b, a in pairs]),
        'Based on a single station, so this is an indication rather than a city-wide measurement.' if len(pairs) == 1 else None)

DIWALI = {2017: (10, 19), 2018: (11, 7), 2019: (10, 27), 2020: (11, 14), 2021: (11, 4), 2022: (10, 24),
          2023: (11, 12), 2024: (11, 1), 2025: (10, 21)}  # Lakshmi Puja dates
dw = []
for y, (m, d) in DIWALI.items():
    c = dt.date(y, m, d)
    a = [city[x][0] for x in (c + dt.timedelta(i) for i in range(-1, 3)) if x in city]
    b = [city[x][0] for x in (c + dt.timedelta(i) for i in range(-21, -13)) if x in city]
    if len(a) >= 3 and len(b) >= 5: dw.append(dict(year=y, diwali=round(st.fmean(a)), before=round(st.fmean(b))))
if dw:
    r = st.fmean(x['diwali'] / x['before'] for x in dw)
    add('diwali', 'Diwali spikes',
        f'Across the {len(dw)} Diwalis (of {len(DIWALI)}) with enough data, city-wide AQI over the Diwali days (day before Lakshmi Puja to '
        f'2 days after) averaged {(r - 1) * 100:.0f}% above the same city level two to three weeks earlier.',
        dict(years=dw), 'Part of this rise is seasonal (post-monsoon air gets worse through Oct–Nov anyway).')

hp = collections.defaultdict(list)
for k, p in hourly_prof.items():
    for h, v in enumerate(p.get('winter', [])):
        if v is not None: hp[h].append(v)
hm = {h: st.fmean(v) for h, v in hp.items()}
wh, bh = max(hm, key=hm.get), min(hm, key=hm.get)
add('diurnal', 'Time of day matters',
    f'In winter, the average hourly AQI across stations peaks around {wh:02d}:00 ({hm[wh]:.0f}) and is lowest around ' +
    (f'{bh:02d}:00 ({hm[bh]:.0f}). If you exercise outdoors in winter, the afternoon is typically the cleaner window.' if 12 <= bh <= 18 else
     f'{bh:02d}:00 ({hm[bh]:.0f}).'),
    dict(winter_profile={h: round(v) for h, v in sorted(hm.items())}))

wd = collections.defaultdict(list)
for d, (v, n) in city.items(): wd[d.weekday()].append(v)
wkday = st.fmean(v for i in range(5) for v in wd[i]); wkend = st.fmean(v for i in (5, 6) for v in wd[i])
add('weekend', 'Weekends vs weekdays',
    f'City-wide average AQI is {wkday:.0f} on weekdays and {wkend:.0f} on weekends '
    f'({(wkend - wkday) / wkday * 100:+.1f}%).', dict(by_weekday={i: round(st.fmean(wd[i]), 1) for i in range(7)}))

dom_tot = collections.Counter()
for k, c in dominant.items(): dom_tot.update(c)
tot = sum(dom_tot.values())
if tot:
    top = dom_tot.most_common(3)
    PN = dict(pm25='PM2.5', pm10='PM10', no2='NO₂', o3='Ozone', co='CO', so2='SO₂', nh3='NH₃')
    add('drivers', f'What drives Pune\'s AQI ({min(d for k in pol_daily for d in pol_daily[k])[:4]}–{D1.year})',
        'The pollutant setting the hourly AQI was ' + ', '.join(f'{PN[p]} {n / tot * 100:.0f}%' for p, n in top) +
        f' of the time across all stations. Particulate matter (PM10 + PM2.5) was the deciding pollutant '
        f'{(dom_tot["pm10"] + dom_tot["pm25"]) / tot * 100:.0f}% of the time.',
        dict(share={p: round(n / tot * 100, 1) for p, n in dom_tot.items()}, by_station=dominant),
        'Individual pollutants are only available from 2024 onward. CO and O₃ sub-indices here use hourly values against 8-hour '
        'breakpoints, which can overstate their role relative to the official daily AQI.')

good = sum(1 for v, n in city.values() if v <= 100); tot_d = len(city)
add('share_ok', 'How often is the air acceptable?',
    f'On {good / tot_d * 100:.0f}% of the {tot_d} days with a city-wide value, Pune\'s median AQI was Good or '
    f'Satisfactory (≤100); on {sum(1 for v, n in city.values() if v > 200) / tot_d * 100:.0f}% it was Poor or worse (>200).',
    dict(days=tot_d))

# ================= WRITE =================
def J(name, obj):
    with open(f'{OUT}/{name}', 'w', encoding='utf-8') as f: json.dump(obj, f, separators=(',', ':'), ensure_ascii=False)

def series(dv):  # compact: start date + array (None for missing)
    if not dv: return dict(start=None, v=[])
    a, b = min(dv), max(dv)
    return dict(start=a.isoformat(), v=[dv.get(a + dt.timedelta(i)) for i in range((b - a).days + 1)])

J('meta.json', dict(generated=dt.date.today().isoformat(), first=D0.isoformat(), last=D1.isoformat(),
                    stations=stations, categories=[dict(max=hi if hi < 10**9 else 500, name=n) for hi, n in CATS],
                    partial_year=PARTIAL_YEAR, rules=dict(min_hours=MIN_HOURS, min_days_year=MIN_DAYS, min_stations_city=MIN_STN_CITY, qc_ratio=QC_RATIO),
                    qc_excluded=flags,
                    source=dict(name='CPCB CAAQMS via data.opencity.in',
                                url='https://data.opencity.in/dataset/pune-hourly-air-quality-reports',
                                license='Public Domain (per dataset page)'),
                    supplement=dict(name='OpenAQ archive (verbatim CPCB CAAQMS values)', url='https://openaq.org',
                                    license='CC BY 4.0 (OpenAQ platform)', from_='2026-01-01') if any(
                        os.path.exists(f'{RAW}/o_{k[0]}.csv') for k in STATIONS) else None))
J('daily.json', dict(city=dict(start=series({d: v for d, (v, n) in city.items()})['start'],
                               v=series({d: v for d, (v, n) in city.items()})['v'],
                               n=series({d: n for d, (v, n) in city.items()})['v']),
                     stations={k: series(v) for k, v in daily.items()}))
J('summary.json', dict(station_year=syear, city_year=city_year, month_clim=month_clim, monthly=monthly,
                       hourly_profile=hourly_prof))
J('pollutants.json', pol_daily)
J('insights.json', ins)
sys.stdout.reconfigure(encoding='utf-8'); print('\nINSIGHTS'); [print('-', i['title'], '::', i['text']) for i in ins]
