/* CPCB-style daily AQI from hourly pollutant concentrations (used for the live Open-Meteo estimate). */
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

  var api = {
    BREAKPOINTS: BREAKPOINTS, CATEGORY_COLORS: CATEGORY_COLORS, POLLUTANT_NAMES: POLLUTANT_NAMES,
    subIndex: subIndex, categoryFor: categoryFor, colorFor: colorFor, textOn: textOn, computeDaily: computeDaily
  };
  global.AQI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
