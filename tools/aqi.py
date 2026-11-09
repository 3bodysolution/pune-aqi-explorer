"""CPCB National AQI sub-index helpers (pure stdlib)."""
BP = {  # (conc_lo, conc_hi, idx_lo, idx_hi)
 'pm25':[(0,30,0,50),(30,60,50,100),(60,90,100,200),(90,120,200,300),(120,250,300,400),(250,380,400,500)],
 'pm10':[(0,50,0,50),(50,100,50,100),(100,250,100,200),(250,350,200,300),(350,430,300,400),(430,510,400,500)],
 'no2': [(0,40,0,50),(40,80,50,100),(80,180,100,200),(180,280,200,300),(280,400,300,400),(400,520,400,500)],
 'so2': [(0,40,0,50),(40,80,50,100),(80,380,100,200),(380,800,200,300),(800,1600,300,400),(1600,2400,400,500)],
 'nh3': [(0,200,0,50),(200,400,50,100),(400,800,100,200),(800,1200,200,300),(1200,1800,300,400),(1800,2400,400,500)],
 'co':  [(0,1,0,50),(1,2,50,100),(2,10,100,200),(10,17,200,300),(17,34,300,400),(34,51,400,500)],
 'o3':  [(0,50,0,50),(50,100,50,100),(100,168,100,200),(168,208,200,300),(208,748,300,400),(748,1000,400,500)],
}
def sub(p, c):
    if c is None or c < 0: return None
    for lo, hi, ilo, ihi in BP[p]:
        if c <= hi: return ilo + (c - lo) * (ihi - ilo) / (hi - lo)
    return 500.0
def aqi(conc, pm_only=False):
    """conc: dict pollutant->value. CPCB rule: >=3 pollutants, one of PM2.5/PM10."""
    s = {p: sub(p, v) for p, v in conc.items() if v is not None and (not pm_only or p in ('pm25','pm10'))}
    s = {p: v for p, v in s.items() if v is not None}
    if not ('pm25' in s or 'pm10' in s): return None, None
    if not pm_only and len(s) < 3: return None, None
    p = max(s, key=s.get)
    return min(500.0, s[p]), p
