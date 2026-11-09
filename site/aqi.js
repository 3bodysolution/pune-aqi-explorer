/* CPCB AQI helpers: sub-index maths for the Open-Meteo model estimate, category colours, and pure data derivations (AQI.derive) used by app.js and testable in node. */
(function (global) {
  'use strict';

  // [conc_lo, conc_hi, idx_lo, idx_hi]; CO in mg/m3, others in ug/m3
  var BREAKPOINTS = {
    pm25: [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 380, 400, 500]],
    pm10: [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 510, 400, 500]],
    no2: [[0, 40, 0, 50], [40, 80, 50, 100], [80, 180, 100, 200], [180, 280, 200, 300], [280, 400, 300, 400], [400, 520, 400, 500]],
    so2: [[0, 40, 0, 50], [40, 80, 50, 100], [80, 380, 100, 200], [380, 800, 200, 300], [800, 1600, 300, 400], [1600, 2400, 400, 500]],
    co: [[0, 1, 0, 50], [1, 2, 50, 100], [2, 10, 100, 200], [10, 17, 200, 300], [17, 34, 300, 400], [34, 51, 400, 500]],
    o3: [[0, 50, 0, 50], [50, 100, 50, 100], [100, 168, 100, 200], [168, 208, 200, 300], [208, 748, 300, 400], [748, 1000, 400, 500]]
  };

  // Open-Meteo hourly variable -> internal key
  var API_VARS = {
    pm2_5: 'pm25', pm10: 'pm10', nitrogen_dioxide: 'no2',
    sulphur_dioxide: 'so2', carbon_monoxide: 'co', ozone: 'o3'
  };
  var MIN_HOURS = 18;

  var POLLUTANT_NAMES = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO\u2082', so2: 'SO\u2082', co: 'CO', o3: 'Ozone (O\u2083)', nh3: 'NH\u2083' };

  var CATEGORY_COLORS = {
    'Good': '#009865', 'Satisfactory': '#8BC34A', 'Moderate': '#F2C511',
    'Poor': '#F57C00', 'Very Poor': '#E53935', 'Severe': '#8E1B1B'
  };

  function subIndex(pollutant, c) {
    if (c == null || isNaN(c) || c < 0) return null;
    var t = BREAKPOINTS[pollutant];
    for (var i = 0; i < t.length; i++) {
      var b = t[i];
      if (c <= b[1]) return b[2] + (b[3] - b[2]) * (c - b[0]) / (b[1] - b[0]);
    }
    return 500;
  }

  /** Category object for an AQI value. cats = meta.categories [{max,name}]. */
  function categoryFor(v, cats) {
    if (v == null || isNaN(v)) return null;
    for (var i = 0; i < cats.length; i++) if (v <= cats[i].max) return cats[i];
    return cats[cats.length - 1];
  }

  function colorFor(v, cats) {
    var c = categoryFor(v, cats);
    return c ? CATEGORY_COLORS[c.name] : null;
  }

  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (x) {
      x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** Black or white, whichever has more contrast on the given background hex. */
  function textOn(hex) {
    var L = luminance(hex);
    return (1.05) / (L + 0.05) >= (L + 0.05) / 0.05 ? '#ffffff' : '#111111';
  }

  /**
   * hourly = Open-Meteo `hourly` object {time:[], pm10:[], pm2_5:[], ...}
   * Returns [{date, means:{pm25,...}, sub:{...}, aqi, dominant}] sorted by date.
   * aqi is null when neither PM2.5 nor PM10 daily mean is available.
   */
  function computeDaily(hourly) {
    var days = {};
    var times = hourly.time || [];
    times.forEach(function (t, i) {
      var d = t.slice(0, 10);
      var rec = days[d] || (days[d] = {});
      Object.keys(API_VARS).forEach(function (apiKey) {
        var arr = hourly[apiKey];
        if (!arr) return;
        var v = arr[i];
        if (v == null || isNaN(v)) return;
        var k = API_VARS[apiKey];
        (rec[k] || (rec[k] = [])).push(v);
      });
    });
    return Object.keys(days).sort().map(function (date) {
      var means = {}, sub = {};
      var best = null, dominant = null;
      Object.keys(days[date]).forEach(function (k) {
        var vals = days[date][k];
        if (vals.length < MIN_HOURS) return;
        var m = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        if (k === 'co') m = m / 1000; // ug/m3 -> mg/m3
        means[k] = m;
        var s = subIndex(k, m);
        if (s != null) {
          sub[k] = Math.min(500, s);
          if (best == null || sub[k] > best) { best = sub[k]; dominant = k; }
        }
      });
      var hasPM = means.pm25 != null || means.pm10 != null;
      return { date: date, means: means, sub: sub, aqi: hasPM && best != null ? Math.round(best) : null, dominant: hasPM ? dominant : null };
    });
  }

  /* ------------------------------------------------------------------
   * Formatting helpers (Indian English, UTC date arithmetic so results do not depend on the browser's time zone)
   * ------------------------------------------------------------------ */
  var DAY = 864e5;
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON3 = MONTH_NAMES.map(function (m) { return m.slice(0, 3); });
  var ORDER = ['Good', 'Satisfactory', 'Moderate', 'Poor', 'Very Poor', 'Severe'];
  var RANGES = { 'Good': '0–50', 'Satisfactory': '51–100', 'Moderate': '101–200', 'Poor': '201–300', 'Very Poor': '301–400', 'Severe': '401–500' };

  // CPCB health advisory (National AQI) for each category.
  var ADVISORY = {
    'Good': 'Minimal impact.',
    'Satisfactory': 'Minor breathing discomfort to sensitive people.',
    'Moderate': 'Breathing discomfort to people with lung disease such as asthma, and discomfort to people with heart disease, children and older adults.',
    'Poor': 'Breathing discomfort to most people on prolonged exposure.',
    'Very Poor': 'Respiratory illness on prolonged exposure.',
    'Severe': 'Affects healthy people and seriously impacts those with existing diseases.'
  };

  var POLLUTANT_PLAIN = {
    pm25: 'fine particles (PM2.5)', pm10: 'coarse dust (PM10)', no2: 'nitrogen dioxide (NO₂)', so2: 'sulphur dioxide (SO₂)',
    co: 'carbon monoxide (CO)', o3: 'ozone (O₃)', nh3: 'ammonia (NH₃)'
  };

  function parseISO(s) { var p = String(s).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function isoOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(iso, n) { return isoOf(parseISO(iso) + n * DAY); }
  function fmtDate(iso) { var d = new Date(parseISO(iso)); return d.getUTCDate() + ' ' + MON3[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function fmtDay(iso) { var d = new Date(parseISO(iso)); return d.getUTCDate() + ' ' + MON3[d.getUTCMonth()]; }
  function fmtMonthYear(ym) { var p = ym.split('-'); return MONTH_NAMES[+p[1] - 1] + ' ' + p[0]; }
  function weekday(iso) { return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(parseISO(iso)).getUTCDay()]; }
  function fmtHour(h) { return h === 0 ? '12 am' : h < 12 ? h + ' am' : h === 12 ? '12 pm' : (h - 12) + ' pm'; }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  function median(a) {
    var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length;
    return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null;
  }
  function catIndex(name) { return ORDER.indexOf(name); }
  function catOf(v, cats) { var c = categoryFor(Math.round(v), cats); return c ? c.name : null; }

  /** Daily series {start, v[]} -> [{date, v}] (null = no data). */
  function seriesRows(s) {
    if (!s || !s.start) return [];
    return s.v.map(function (v, i) { return { date: addDays(s.start, i), v: num(v) ? v : null }; });
  }

  var derive = {};

  /** Hero: city figure, category, advisory, dominant pollutant, time window. */
  derive.hero = function (latest) {
    var c = latest.city || {};
    var doms = {}, wins = {};
    (latest.stations || []).forEach(function (s) {
      if (s.aqi != null && s.dominant) doms[s.dominant] = (doms[s.dominant] || 0) + 1;
      if (s.aqi != null && s.window_end) wins[s.window_end] = (wins[s.window_end] || 0) + 1;
    });
    function top(o) { var k = Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }); return k.length ? k[0] : null; }
    var win = top(wins);
    return {
      aqi: num(c.aqi) ? c.aqi : null, category: c.category || null, advisory: c.category ? ADVISORY[c.category] : null,
      nStations: c.stations, dominant: top(doms), windowEnd: win,
      windowTime: win ? win.slice(11).replace(' IST', '') : null
    };
  };

  /** Is the latest hour much cleaner than the 24-hour AQI? Uses the median of stations' last-hour PM2.5. */
  derive.lag = function (latest, cats) {
    var c = latest.city || {};
    if (!num(c.aqi)) return null;
    var pm = (latest.stations || []).map(function (s) { return s.last_hour && s.last_hour.pm25; }).filter(num);
    if (pm.length < 3) return null;
    var med = median(pm), sub = subIndex('pm25', med);
    var now = catOf(sub, cats), cityCat = catOf(c.aqi, cats);
    if (catIndex(cityCat) - catIndex(now) < 1) return null;
    return { median: med, sub: sub, category: now, cityCategory: cityCat, n: pm.length };
  };

  /** Stations merged from latest.json + meta (locality -> group). */
  derive.stations = function (meta, latest) {
    var loc = {};
    (meta.stations || []).forEach(function (s) { loc[s.id] = s; });
    return (latest.stations || []).map(function (s) {
      var m = loc[s.id] || {};
      return {
        id: s.id, name: s.name, locality: m.locality || '', group: /\(PCMC\)/.test(m.locality || '') ? 'Pimpri-Chinchwad' : 'Pune',
        aqi: num(s.aqi) ? s.aqi : null, category: s.category, dominant: s.dominant, note: s.note, last_hour: s.last_hour || {}, window_end: s.window_end
      };
    });
  };

  /** Plain-language version of a station's "no value" note. */
  derive.plainNote = function (note) {
    if (!note) return 'No current reading.';
    var m = /^no data since (\d{4}-\d{2}-\d{2})T?\s?(\d{2}:\d{2})?/.exec(note);
    if (m) {
      var hrs = m[2] ? (Date.now() - Date.parse(m[1] + 'T' + m[2] + ':00Z')) / 3600000 : Infinity;
      if (hrs < 48) return 'No reading for ' + Math.round(hrs) + ' hours.';
      return 'No readings since ' + fmtDate(m[1]) + '.';
    }
    if (/fetch failed/.test(note)) return 'Could not be fetched in the latest update.';
    if (/not enough pollutants/.test(note)) return 'Not enough pollutant readings in the last 24 hours.';
    if (/delayed/.test(note)) return 'Latest readings are delayed.';
    if (/no recent readings/.test(note)) return 'No recent readings.';
    return note.charAt(0).toUpperCase() + note.slice(1) + '.';
  };

  /** How a station compares with the city figure. */
  derive.compare = function (st, latest) {
    var c = latest.city && latest.city.aqi;
    if (st.aqi == null || !num(c)) return null;
    var d = st.aqi - c;
    return { diff: d, text: d === 0 ? 'the same as' : Math.abs(d) + ' ' + (Math.abs(d) === 1 ? 'point' : 'points') + (d > 0 ? ' higher than' : ' lower than') };
  };

  /** Month-of-year climatology plus winter/monsoon ratio. */
  derive.months = function (summary, insights) {
    var mc = summary.month_clim, rows = [];
    for (var m = 1; m <= 12; m++) if (num(mc[m])) rows.push({ m: m, name: MONTH_NAMES[m - 1], short: MON3[m - 1], v: mc[m] });
    var worst = rows.reduce(function (a, b) { return b.v > a.v ? b : a; }), best = rows.reduce(function (a, b) { return b.v < a.v ? b : a; });
    var ins = (insights || []).filter(function (i) { return i.id === 'seasonality'; })[0];
    var w, mo;
    if (ins && ins.data) { w = ins.data.winter; mo = ins.data.monsoon; }
    else {
      w = mean(rows.filter(function (r) { return [11, 12, 1, 2].indexOf(r.m) >= 0; }).map(function (r) { return r.v; }));
      mo = mean(rows.filter(function (r) { return [6, 7, 8, 9].indexOf(r.m) >= 0; }).map(function (r) { return r.v; }));
    }
    return { rows: rows, worst: worst, best: best, winter: w, monsoon: mo, ratio: w / mo };
  };

  /** Hour-of-day profile averaged across stations that have a value for that hour. */
  derive.hourly = function (summary) {
    function avg(season) {
      var out = [];
      for (var h = 0; h < 24; h++) {
        var vs = [];
        Object.keys(summary.hourly_profile).forEach(function (k) {
          var p = summary.hourly_profile[k][season];
          if (p && num(p[h])) vs.push(p[h]);
        });
        out.push(vs.length ? mean(vs) : null);
      }
      return out;
    }
    var w = avg('winter'), mo = avg('monsoon');
    var peak = null, low = null;
    w.forEach(function (v, h) {
      if (v == null) return;
      if (peak == null || v > w[peak]) peak = h;
      if (low == null || v < w[low]) low = h;
    });
    return { winter: w, monsoon: mo, peak: peak, low: low };
  };

  /** Latest complete year in station_year and ranked station means. */
  derive.areas = function (summary, meta) {
    var years = {};
    Object.keys(summary.station_year).forEach(function (k) { Object.keys(summary.station_year[k]).forEach(function (y) { years[y] = 1; }); });
    var ys = Object.keys(years).map(Number).sort(function (a, b) { return a - b; });
    var year = ys[ys.length - 1];
    var names = {};
    (meta.stations || []).forEach(function (s) { names[s.id] = s.name; });
    var rows = Object.keys(summary.station_year).filter(function (k) { return summary.station_year[k][year]; }).map(function (k) {
      var r = summary.station_year[k][year];
      return { id: k, name: names[k] || k, mean: r.mean, days: r.days, poor: r.pct_poor_or_worse };
    }).sort(function (a, b) { return b.mean - a.mean; });
    return { year: year, rows: rows, total: (meta.stations || []).length, minDays: meta.rules && meta.rules.min_days_year };
  };

  var COMPLETE_DAYS = 300;
  /** Share of days per category per year, from city_year[*].cat_days. */
  derive.shares = function (summary) {
    var rows = [];
    Object.keys(summary.city_year).sort().forEach(function (y) {
      var c = summary.city_year[y];
      if (!(c.city_days > 0)) return;
      var x = 0, parts = [];
      ORDER.forEach(function (name) {
        var d = c.cat_days[name] || 0;
        var f = d / c.city_days;
        if (d > 0) parts.push({ cat: name, days: d, pct: f * 100, x1: x, x2: x + f });
        x += f;
      });
      rows.push({
        year: +y, days: c.city_days, parts: parts,
        okShare: ((c.cat_days.Good || 0) + (c.cat_days.Satisfactory || 0)) / c.city_days * 100,
        stations: c.stations.length
      });
    });
    var full = rows.filter(function (r) { return r.days >= COMPLETE_DAYS; });
    return { rows: rows, first: full[0] || null, last: full[full.length - 1] || null, completeDays: COMPLETE_DAYS };
  };

  /** Median of station means per year. */
  derive.yearTrend = function (summary) {
    var rows = Object.keys(summary.city_year).sort().map(function (y) {
      var c = summary.city_year[y];
      return { year: +y, v: c.median_of_station_means, n: c.stations.length };
    });
    var ok = rows.filter(function (r) { return r.n >= 3; });
    var worst = ok.reduce(function (a, b) { return b.v > a.v ? b : a; }, ok[0]);
    var best = ok.reduce(function (a, b) { return b.v < a.v ? b : a; }, ok[0]);
    return { rows: rows, worst: worst, best: best, single: rows.filter(function (r) { return r.n === 1; }).map(function (r) { return r.year; }) };
  };

  /** Diwali: before vs Diwali per year and the average rise (mean of ratios, as in tools/process.py). */
  derive.diwali = function (insights) {
    var ins = (insights || []).filter(function (i) { return i.id === 'diwali'; })[0];
    if (!ins || !ins.data || !ins.data.years.length) return null;
    var yrs = ins.data.years.map(function (y) { return { year: y.year, before: y.before, diwali: y.diwali, pct: (y.diwali / y.before - 1) * 100 }; });
    var avg = (mean(yrs.map(function (y) { return y.diwali / y.before; })) - 1) * 100;
    return { rows: yrs, avg: avg, caveat: ins.caveat, text: ins.text };
  };

  /** Dominant-pollutant share (drivers insight). */
  derive.drivers = function (insights) {
    var ins = (insights || []).filter(function (i) { return i.id === 'drivers'; })[0];
    if (!ins || !ins.data) return null;
    var sh = ins.data.share;
    var rows = Object.keys(sh).map(function (k) { return { key: k, name: POLLUTANT_NAMES[k] || k, v: sh[k] }; })
      .sort(function (a, b) { return b.v - a.v; });
    var pm = (sh.pm25 || 0) + (sh.pm10 || 0);
    var m = /\(([^)]+)\)/.exec(ins.title || '');
    return { rows: rows, particles: pm, period: m ? m[1] : '', caveat: ins.caveat };
  };

  /** Model forecast: split Open-Meteo daily results into recent days and upcoming days. */
  derive.forecast = function (days, today) {
    var valid = days.filter(function (d) { return d.aqi != null; });
    var past = valid.filter(function (d) { return d.date <= today; }).slice(-30);
    var future = valid.filter(function (d) { return d.date > today; });
    return { past: past, future: future, all: past.concat(future) };
  };

  /** Every templated headline, from data only. */
  derive.headlines = function (D) {
    var out = {}, cats = D.meta.categories;
    var hero = D.latest ? derive.hero(D.latest) : { aqi: null };
    out.hero = hero.aqi == null ? 'No city figure right now' : 'AQI ' + hero.aqi + ', ' + hero.category;
    var lag = D.latest ? derive.lag(D.latest, cats) : null;
    out.lag = lag ? 'In the last hour, fine-particle (PM2.5) levels were about ' + Math.round(lag.median) + ' µg/m³, which on its own would be rated ' + lag.category + '.' : null;
    var mo = derive.months(D.summary, D.insights);
    out.months = mo.worst.name + ' is the worst month for Pune’s air; ' + mo.best.name + ' is the cleanest';
    out.ratio = 'Winter air (Nov–Feb) is ' + mo.ratio.toFixed(1) + '× worse than monsoon air (Jun–Sep)';
    var h = derive.hourly(D.summary);
    out.hourly = 'In winter, the air is worst around ' + fmtHour(h.peak) + ' and cleanest around ' + fmtHour(h.low);
    var ar = derive.areas(D.summary, D.meta);
    out.areas = ar.rows[0].name + ' had the highest average AQI in ' + ar.year + ' (' + Math.round(ar.rows[0].mean) + ')';
    var sh = derive.shares(D.summary);
    if (sh.first && sh.last) {
      var a = Math.round(sh.first.okShare), b = Math.round(sh.last.okShare);
      out.shares = Math.abs(b - a) < 1 ? 'Good or Satisfactory days stayed near ' + b + '% between ' + sh.first.year + ' and ' + sh.last.year
        : 'Good or Satisfactory days ' + (b < a ? 'fell' : 'rose') + ' from ' + a + '% in ' + sh.first.year + ' to ' + b + '% in ' + sh.last.year;
    }
    var yt = derive.yearTrend(D.summary);
    (function () {
      var vs = yt.rows.map(function (r) { return r.v; });
      out.trend = 'Since ' + yt.rows[0].year + ', the typical station AQI has stayed between ' + Math.round(Math.min.apply(null, vs)) + ' and ' + Math.round(Math.max.apply(null, vs));
    })();
    var dw = derive.diwali(D.insights);
    out.diwali = dw ? 'Around Diwali, AQI is on average ' + Math.round(dw.avg) + '% higher than in the weeks before' : null;
    var dr = derive.drivers(D.insights);
    out.drivers = dr ? 'Particles in the air set the AQI ' + Math.round(dr.particles) + '% of the time' : null;
    return out;
  };

  var api = {
    BREAKPOINTS: BREAKPOINTS, CATEGORY_COLORS: CATEGORY_COLORS, POLLUTANT_NAMES: POLLUTANT_NAMES,
    ORDER: ORDER, RANGES: RANGES, ADVISORY: ADVISORY, POLLUTANT_PLAIN: POLLUTANT_PLAIN, MONTH_NAMES: MONTH_NAMES, MON3: MON3, DAY: DAY,
    subIndex: subIndex, categoryFor: categoryFor, colorFor: colorFor, textOn: textOn, computeDaily: computeDaily,
    catOf: catOf, catIndex: catIndex, seriesRows: seriesRows,
    fmt: { parseISO: parseISO, isoOf: isoOf, addDays: addDays, fmtDate: fmtDate, fmtDay: fmtDay, fmtMonthYear: fmtMonthYear, weekday: weekday, fmtHour: fmtHour, num: num, mean: mean, median: median },
    derive: derive
  };
  global.AQI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
