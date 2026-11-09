/* Pune Air Quality Explorer - all numbers come from data/*.json (incl. hourly latest.json) or the Open-Meteo API. */
(function () {
  'use strict';

  var LIVE_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=18.5204&longitude=73.8567' +
    '&hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=Asia%2FKolkata&past_days=92&forecast_days=3';
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Reference values supplied with the brief (24-h guideline / standard values).
  var REFS = {
    pm25: { cpcb: 60, who: 15 },
    pm10: { cpcb: 100, who: 45 },
    no2: { cpcb: 80, who: 25 }
  };
  var DRIVER_COLORS = { pm25: '#E53935', pm10: '#F57C00', no2: '#7E57C2', o3: '#26A69A', co: '#8D6E63', so2: '#EC407A', nh3: '#78909C' };

  var D = {};            // loaded data
  var charts = {};       // chart registry
  var state = { expYear: 'all', regionSort: { key: 'mean', dir: 'desc' }, live: null };

  // ---------- helpers ----------
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(v, d) { return v == null || isNaN(v) ? '–' : Number(v).toFixed(d == null ? 0 : d); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function expand(series) {
    if (!series || !series.start) return { dates: [], v: [], n: [] };
    var dates = new Array(series.v.length);
    var d = new Date(series.start + 'T00:00:00Z');
    for (var i = 0; i < dates.length; i++) { dates[i] = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
    return { dates: dates, v: series.v, n: series.n || [] };
  }
  function cats() { return D.meta.categories; }
  function catOf(v) { return AQI.categoryFor(v, cats()); }
  function colorOf(v) { return AQI.colorFor(v, cats()); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function getJSON(name) {
    return fetch('data/' + name).then(function (r) {
      if (!r.ok) throw new Error(name + ' ' + r.status);
      return r.json();
    });
  }
  function stationLabel(s) { return s.name + ' — ' + s.locality; }
  function safeStore(op, key, val) {
    try { return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, val); } catch (e) { return null; }
  }
  function fillSelect(sel, options, value) {
    sel.innerHTML = options.map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('');
    if (value != null && options.some(function (o) { return o.value === value; })) sel.value = value;
  }
  function catLegend(id) {
    $(id).innerHTML = cats().map(function (c) {
      return '<span><i style="background:' + AQI.CATEGORY_COLORS[c.name] + '"></i>' + esc(c.name) + '</span>';
    }).join('') + '<span><i style="background:var(--nogap)"></i>No data</span>';
  }

  // ---------- charts ----------
  function applyDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = css('--muted');
    Chart.defaults.borderColor = css('--grid');
    Chart.defaults.font.family = css('--font');
    Chart.defaults.font.size = 12;
  }
  function mk(id, config) {
    if (!window.Chart) return null;
    if (charts[id]) charts[id].destroy();
    var canvas = document.getElementById(id);
    config.options = config.options || {};
    config.options.responsive = true;
    config.options.maintainAspectRatio = false;
    config.options.animation = false;
    charts[id] = new Chart(canvas, config);
    return charts[id];
  }
  function gridCfg() { return { color: css('--grid') }; }

  // Background bands for CPCB categories
  var bandsPlugin = {
    id: 'bands',
    beforeDatasetsDraw: function (chart) {
      var y = chart.scales.y, area = chart.chartArea, ctx = chart.ctx;
      if (!y || !D.meta) return;
      var lo = 0;
      ctx.save();
      ctx.globalAlpha = parseFloat(css('--band-alpha')) || 0.13;
      cats().forEach(function (c) {
        var top = Math.min(c.max, y.max), bot = Math.max(lo, y.min);
        if (top > bot) {
          var yt = y.getPixelForValue(top), yb = y.getPixelForValue(bot);
          ctx.fillStyle = AQI.CATEGORY_COLORS[c.name];
          ctx.fillRect(area.left, yt, area.right - area.left, yb - yt);
        }
        lo = c.max;
      });
      ctx.restore();
    }
  };

  // ---------- tooltip for [data-tip] ----------
  function initTip() {
    var tip = $('#tip');
    function show(e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.getAttribute('data-tip');
      tip.hidden = false;
      var x = e.clientX + 12, y = e.clientY + 14;
      var w = tip.offsetWidth, h = tip.offsetHeight;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - 12;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - 12;
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top = Math.max(4, y) + 'px';
    }
    document.addEventListener('mousemove', show);
    document.addEventListener('click', show);
    document.addEventListener('scroll', function () { tip.hidden = true; }, true);
  }

  // ======================================================
  // 1. LIVE
  // ======================================================
  function istToday() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

  // ---------- station-based live AQI (data/latest.json, refreshed hourly by tools/fetch_latest.py) ----------
  function loadStations() {
    fetch('data/latest.json?t=' + Math.floor(Date.now() / 300000)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { state.stations = j; renderStations(); })
      .catch(function () {
        $('#station-now').innerHTML = '<p>Station readings are not available right now. The model estimate below is still shown.</p>';
      });
  }
  function renderStations() {
    var j = state.stations;
    if (!j || !D.meta) return;
    var ageH = (Date.now() - Date.parse(j.generated_utc)) / 3600000;
    var warn = ageH > 3 ? '<p class="warn">These readings were last updated ' + esc(j.generated_ist) + ' (' + Math.round(ageH) + ' h ago); the hourly update may be delayed.</p>' : '';
    var box = $('#station-now');
    if (j.city.aqi != null) {
      var cat = catOf(j.city.aqi), col = AQI.CATEGORY_COLORS[cat.name];
      box.innerHTML = warn +
        '<div class="live-big"><span class="aqi-num" style="color:' + col + '">' + j.city.aqi + '</span>' +
        '<span class="pill" style="background:' + col + ';color:' + AQI.textOn(col) + '">' + esc(cat.name) + '</span></div>' +
        '<ul class="live-meta"><li><b>Pune city AQI</b> — median of ' + j.city.stations + ' stations</li>' +
        '<li>Updated ' + esc(j.generated_ist) + '</li></ul>' +
        '<p class="small muted" style="margin:10px 0 0">Source: CPCB station readings via OpenAQ, official CPCB method.</p>';
    } else {
      box.innerHTML = warn + '<p>Too few stations reported in the last 24 hours to give a city value.</p>';
    }
    var list = j.stations.slice().sort(function (a, b) { return (b.aqi == null ? -1 : b.aqi) - (a.aqi == null ? -1 : a.aqi); });
    $('#station-list').innerHTML = list.map(function (s) {
      if (s.aqi == null) {
        return '<div class="stn na"><span class="nm">' + esc(s.name) + '</span><span class="badge-aqi">n/a</span>' +
          '<span class="sub">' + esc(s.note || 'no current value') + '</span></div>';
      }
      var c = AQI.CATEGORY_COLORS[catOf(s.aqi).name];
      var lh = s.last_hour || {};
      var now = lh.pm25 != null ? 'last hour PM2.5 ' + fmt(lh.pm25, 0) + ' µg/m³' : (lh.pm10 != null ? 'last hour PM10 ' + fmt(lh.pm10, 0) + ' µg/m³' : '');
      return '<div class="stn"><span class="nm">' + esc(s.name) + '</span>' +
        '<span class="badge-aqi" style="background:' + c + ';color:' + AQI.textOn(c) + '" data-tip="' + esc(catOf(s.aqi).name + ' · driven by ' + (AQI.POLLUTANT_NAMES[s.dominant] || s.dominant)) + '">' + s.aqi + '</span>' +
        '<span class="sub">' + esc(AQI.POLLUTANT_NAMES[s.dominant] || s.dominant) + (now ? ' · ' + esc(now) : '') + ' · to ' + esc((s.window_end || '').slice(11)) + '</span></div>';
    }).join('');
  }

  function loadLive() {
    fetch(LIVE_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.hourly || !j.hourly.time) throw new Error('unexpected response');
      state.live = AQI.computeDaily(j.hourly);
      renderLive();
    }).catch(function () {
      $('#live-now').innerHTML = '<p>Live estimate is unavailable right now (the Open-Meteo service could not be reached). ' +
        'The historical sections below are unaffected — please try again later.</p>';
      var c = $('#chart-live'); if (c) c.parentNode.hidden = true;
    });
  }

  function renderLive() {
    var days = state.live;
    if (!days || !D.meta) return;
    var today = istToday();
    var box = $('#live-now');
    var cur = null;
    for (var i = 0; i < days.length; i++) if (days[i].date === today && days[i].aqi != null) cur = days[i];
    var stale = false;
    if (!cur) {
      for (var j = days.length - 1; j >= 0; j--) if (days[j].date <= today && days[j].aqi != null) { cur = days[j]; stale = true; break; }
    }
    if (cur) {
      var cat = catOf(cur.aqi), col = AQI.CATEGORY_COLORS[cat.name];
      var chips = Object.keys(cur.means).map(function (k) {
        var unit = k === 'co' ? 'mg/m³' : 'µg/m³';
        return '<span class="chip">' + esc(AQI.POLLUTANT_NAMES[k]) + ' ' + fmt(cur.means[k], k === 'co' ? 2 : 1) + ' ' + unit + '</span>';
      }).join('');
      box.innerHTML =
        '<div class="live-big"><span class="aqi-num" style="color:' + col + '">' + cur.aqi + '</span>' +
        '<span class="pill" style="background:' + col + ';color:' + AQI.textOn(col) + '">' + esc(cat.name) + '</span></div>' +
        '<ul class="live-meta"><li><b>' + (stale ? 'Latest estimate for ' : 'Estimated AQI today, ') + esc(cur.date) + '</b></li>' +
        '<li>Dominant pollutant: <b>' + esc(AQI.POLLUTANT_NAMES[cur.dominant] || '–') + '</b></li></ul>' +
        '<div class="chips" aria-label="Daily mean concentrations">' + chips + '</div>' +
        '<p class="small muted" style="margin:10px 0 0">Daily means of hourly model values; CO shown in mg/m³.</p>';
    } else {
      box.innerHTML = '<p>No estimate could be computed for today (not enough hourly model values).</p>';
    }
    drawLiveChart(today);
  }

  function drawLiveChart(today) {
    var days = state.live;
    if (!days || !D.meta) return;
    var labels = days.map(function (d) { return d.date; });
    var fc = days.map(function (d) { return d.date > today; });
    var cols = days.map(function (d) { return colorOf(d.aqi); });
    $('#live-legend').hidden = false;
    mk('chart-live', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Estimated AQI',
          data: days.map(function (d) { return d.aqi; }),
          backgroundColor: days.map(function (d, i) { return fc[i] && cols[i] ? cols[i] + '55' : cols[i]; }),
          borderColor: days.map(function (d, i) { return cols[i]; }),
          borderWidth: days.map(function (d, i) { return fc[i] ? 2 : 0; }),
          borderSkipped: false,
          categoryPercentage: 0.9, barPercentage: 0.95
        }]
      },
      options: {
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid: gridCfg(), title: { display: true, text: 'Estimated AQI' } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return items[0].label + (fc[items[0].dataIndex] ? ' (forecast)' : ''); },
              label: function (it) {
                var d = days[it.dataIndex];
                if (d.aqi == null) return 'Not enough data';
                return 'AQI ' + d.aqi + ' – ' + catOf(d.aqi).name + (d.dominant ? ' (' + AQI.POLLUTANT_NAMES[d.dominant] + ')' : '');
              }
            }
          }
        }
      }
    });
  }

  // ======================================================
  // 2. INSIGHTS
  // ======================================================
  function renderInsights() {
    var box = $('#insight-cards');
    box.innerHTML = '';
    D.insights.forEach(function (ins) {
      var c = document.createElement('article');
      c.className = 'insight';
      var h = document.createElement('h3'); h.textContent = ins.title; c.appendChild(h);
      var p = document.createElement('p'); p.textContent = ins.text; c.appendChild(p);
      if (ins.caveat) { var q = document.createElement('p'); q.className = 'caveat'; q.textContent = ins.caveat; c.appendChild(q); }
      box.appendChild(c);
    });
  }

  // ======================================================
  // 3. EXPLORER
  // ======================================================
  function getSeries(key) {
    return key === 'city' ? expand(D.daily.city) : expand(D.daily.stations[key]);
  }
  function yearsOf(s) {
    var set = {};
    s.dates.forEach(function (d, i) { if (s.v[i] != null) set[d.slice(0, 4)] = 1; });
    return Object.keys(set).sort();
  }
  function stationOptions() {
    var o = [{ value: 'city', label: 'Pune (city median)' }];
    D.meta.stations.forEach(function (s) { o.push({ value: s.id, label: stationLabel(s) }); });
    return o;
  }

  function initExplorer() {
    var sel = $('#exp-station');
    fillSelect(sel, stationOptions(), safeStore('get', 'pune-aq-station') || 'city');
    sel.addEventListener('change', function () { safeStore('set', 'pune-aq-station', sel.value); refreshYearOptions(); renderExplorer(); renderCalendar(true); });
    $('#exp-year').addEventListener('change', function () { state.expYear = this.value; renderExplorer(); renderCalendar(true); });
    $('#hm-year').addEventListener('change', function () { renderCalendar(false); });
    refreshYearOptions();
    renderExplorer();
    renderCalendar(true);
  }

  function refreshYearOptions() {
    var s = getSeries($('#exp-station').value);
    var ys = yearsOf(s);
    var opts = [{ value: 'all', label: 'All years' }].concat(ys.map(function (y) { return { value: y, label: y }; }));
    fillSelect($('#exp-year'), opts, state.expYear);
    state.expYear = $('#exp-year').value;
  }

  function renderExplorer() {
    var key = $('#exp-station').value, yr = state.expYear;
    var s = getSeries(key);
    var idx = [];
    for (var i = 0; i < s.dates.length; i++) if (yr === 'all' || s.dates[i].indexOf(yr) === 0) idx.push(i);
    var labels = idx.map(function (i) { return s.dates[i]; });
    var vals = idx.map(function (i) { return s.v[i]; });
    var ns = idx.map(function (i) { return s.n[i]; });
    var accent = css('--accent');

    mk('chart-explorer', {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Daily AQI', data: vals, borderColor: accent, backgroundColor: accent,
          borderWidth: 1.3, spanGaps: false, tension: 0,
          pointRadius: function (ctx) {
            var i = ctx.dataIndex;
            return vals[i] != null && (i === 0 || vals[i - 1] == null) && (i === vals.length - 1 || vals[i + 1] == null) ? 2.5 : 0;
          },
          pointHoverRadius: 4
        }]
      },
      plugins: [bandsPlugin],
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid: gridCfg(), title: { display: true, text: 'AQI' } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (it) {
                var v = it.raw;
                if (v == null) return 'No data';
                return 'AQI ' + v + ' – ' + catOf(v).name;
              },
              afterLabel: function (it) {
                if (key === 'city' && ns[it.dataIndex] != null) return ns[it.dataIndex] + ' stations reporting';
                return '';
              }
            }
          }
        }
      }
    });

    // summary stats
    var present = vals.filter(function (v) { return v != null; });
    var box = $('#exp-stats');
    if (!present.length) { box.innerHTML = '<p class="muted">No data for this selection.</p>'; return; }
    var max = -1, maxDate = '';
    vals.forEach(function (v, i) { if (v != null && v > max) { max = v; maxDate = labels[i]; } });
    var counts = {};
    cats().forEach(function (c) { counts[c.name] = 0; });
    present.forEach(function (v) { counts[catOf(v).name]++; });
    box.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><b>' + present.length + '</b><span>days with data (of ' + vals.length + ' in range)</span></div>' +
      '<div class="stat"><b>' + fmt(mean(present), 1) + '</b><span>mean AQI</span></div>' +
      '<div class="stat"><b>' + max + '</b><span>max AQI (' + esc(maxDate) + ')</span></div></div>' +
      '<div class="catbar" role="img" aria-label="Share of days per category">' +
      cats().map(function (c) {
        var pct = counts[c.name] / present.length * 100;
        return '<div style="width:' + pct + '%;background:' + AQI.CATEGORY_COLORS[c.name] + '" data-tip="' + esc(c.name) + ': ' + pct.toFixed(1) + '% of days (' + counts[c.name] + ')"></div>';
      }).join('') + '</div>' +
      '<div class="cat-list">' + cats().map(function (c) {
        return '<span><i style="background:' + AQI.CATEGORY_COLORS[c.name] + '"></i>' + esc(c.name) + ' ' + (counts[c.name] / present.length * 100).toFixed(1) + '%</span>';
      }).join('') + '</div>';
  }

  // ======================================================
  // 4. CALENDAR
  // ======================================================
  function renderCalendar(resetYear) {
    var key = $('#exp-station').value;
    var s = getSeries(key);
    var ys = yearsOf(s);
    var sel = $('#hm-year');
    if (resetYear) {
      var want = state.expYear !== 'all' ? state.expYear : ys[ys.length - 1];
      fillSelect(sel, ys.map(function (y) { return { value: y, label: y }; }), want);
    }
    var wrap = $('#cal-wrap');
    var yr = sel.value;
    var stName = key === 'city' ? 'Pune (city median)' : stationLabel(D.meta.stations.filter(function (x) { return x.id === key; })[0]);
    $('#hm-title').textContent = stName;
    if (!yr) { wrap.innerHTML = '<p class="muted">No data for this station.</p>'; return; }

    var map = {};
    s.dates.forEach(function (d, i) { if (d.indexOf(yr) === 0) map[d] = s.v[i]; });
    var start = new Date(Date.UTC(+yr, 0, 1)), end = new Date(Date.UTC(+yr, 11, 31));
    var offset = start.getUTCDay(); // Sunday = 0
    var CELL = 12, GAP = 3, STEP = CELL + GAP, LEFT = 28, TOP = 18;
    var nWeeks = Math.ceil((offset + 366) / 7) + 1;
    var parts = [], monthLabels = [], lastMonth = -1;
    for (var d = new Date(start), n = 0; d <= end; d.setUTCDate(d.getUTCDate() + 1), n++) {
      var iso = d.toISOString().slice(0, 10);
      var wk = Math.floor((offset + n) / 7), dow = (offset + n) % 7;
      var x = LEFT + wk * STEP, y = TOP + dow * STEP;
      if (d.getUTCMonth() !== lastMonth && (dow === 0 || d.getUTCDate() === 1)) {
        if (d.getUTCMonth() !== lastMonth) { monthLabels.push('<text x="' + x + '" y="11">' + MONTH_NAMES[d.getUTCMonth()] + '</text>'); lastMonth = d.getUTCMonth(); }
      }
      var v = map[iso];
      var fill = v != null ? colorOf(v) : css('--nogap');
      var tip = v != null ? iso + ' · AQI ' + v + ' (' + catOf(v).name + ')' : iso + ' · no data';
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + CELL + '" height="' + CELL + '" rx="2" fill="' + fill + '" data-tip="' + tip + '"/>');
    }
    var w = LEFT + nWeeks * STEP, h = TOP + 7 * STEP;
    var dayLabels = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map(function (p) { return '<text x="0" y="' + (TOP + p[0] * STEP + 10) + '">' + p[1] + '</text>'; }).join('');
    wrap.innerHTML = '<svg class="cal-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Calendar heatmap for ' + esc(yr) + '">' +
      monthLabels.join('') + dayLabels + parts.join('') + '</svg>';
  }

  // ======================================================
  // 5. TRENDS
  // ======================================================
  function stationColor(i, n) { return 'hsl(' + Math.round(i * 360 / n) + ',60%,55%)'; }

  function renderTrends() {
    var sy = D.summary.station_year, cy = D.summary.city_year;
    var set = {};
    Object.keys(sy).forEach(function (k) { Object.keys(sy[k]).forEach(function (y) { set[y] = 1; }); });
    Object.keys(cy).forEach(function (y) { set[y] = 1; });
    var years = Object.keys(set).sort();
    var stIds = D.meta.stations.map(function (s) { return s.id; }).filter(function (k) { return sy[k] && Object.keys(sy[k]).length; });
    var datasets = stIds.map(function (k, i) {
      var meta = D.meta.stations.filter(function (s) { return s.id === k; })[0];
      var col = stationColor(i, stIds.length);
      return {
        label: meta.name, borderColor: col, backgroundColor: col, borderWidth: 1.2, pointRadius: 2.5, spanGaps: false, tension: 0,
        data: years.map(function (y) { return sy[k][y] ? sy[k][y].mean : null; })
      };
    });
    datasets.push({
      label: 'City: median of station means', borderColor: css('--text'), backgroundColor: css('--text'),
      borderWidth: 3.5, pointRadius: 4, spanGaps: false, tension: 0, order: -1,
      data: years.map(function (y) { return cy[y] ? cy[y].median_of_station_means : null; })
    });
    var idx2024 = years.indexOf('2024');
    var annot = {
      id: 'annot2024',
      afterDatasetsDraw: function (chart) {
        if (idx2024 < 0) return;
        var x = chart.scales.x.getPixelForValue(idx2024), a = chart.chartArea, ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = css('--muted'); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = css('--muted'); ctx.font = '11px ' + css('--font');
        ctx.textAlign = 'right';
        ctx.fillText('2024: data source changes', x - 6, a.top + 12);
        ctx.restore();
      }
    };
    mk('chart-yoy', {
      type: 'line', data: { labels: years, datasets: datasets }, plugins: [annot],
      options: {
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { grid: { display: false }, title: { display: true, text: 'Year' } },
          y: { beginAtZero: true, grid: gridCfg(), title: { display: true, text: 'Mean daily AQI' } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 2, font: { size: 11 } } },
          tooltip: { callbacks: { label: function (it) { return it.dataset.label + ': ' + fmt(it.raw, 1); } } }
        }
      }
    });

    // stacked 100%
    var cyYears = Object.keys(cy).sort().filter(function (y) { return cy[y].city_days > 0; });
    var skipped = Object.keys(cy).filter(function (y) { return cy[y].city_days === 0; });
    mk('chart-cats', {
      type: 'bar',
      data: {
        labels: cyYears,
        datasets: cats().map(function (c) {
          return {
            label: c.name, backgroundColor: AQI.CATEGORY_COLORS[c.name], borderWidth: 0,
            data: cyYears.map(function (y) { return cy[y].cat_days[c.name] / cy[y].city_days * 100; }),
            days: cyYears.map(function (y) { return cy[y].cat_days[c.name]; })
          };
        })
      },
      options: {
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, max: 100, grid: gridCfg(), ticks: { callback: function (v) { return v + '%'; } }, title: { display: true, text: '% of days' } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } },
          tooltip: { callbacks: { label: function (it) { return it.dataset.label + ': ' + it.raw.toFixed(1) + '% (' + it.dataset.days[it.dataIndex] + ' days)'; } } }
        }
      }
    });
    var first = D.daily.city.start;
    $('#cats-note').textContent = 'Based on days with a city-wide value (at least ' + D.meta.rules.min_stations_city + ' stations reporting; series starts ' + first + '). ' +
      (skipped.length ? 'Years without any city-wide days are omitted: ' + skipped.join(', ') + '.' : '');
  }

  // ======================================================
  // 6. REGIONS
  // ======================================================
  function cellStyle(v) {
    var col = colorOf(v);
    return 'background:' + col + ';color:' + AQI.textOn(col);
  }

  function renderRegionTable() {
    var sy = D.summary.station_year;
    var yset = {};
    Object.keys(sy).forEach(function (k) { Object.keys(sy[k]).forEach(function (y) { yset[y] = 1; }); });
    var years = Object.keys(yset).sort();
    var rows = D.meta.stations.map(function (s) {
      var vals = (D.daily.stations[s.id].v || []).filter(function (v) { return v != null; });
      return { s: s, mean: mean(vals), validYears: Object.keys(sy[s.id] || {}).length, years: sy[s.id] || {} };
    });
    var sort = state.regionSort;
    function keyVal(r) {
      if (sort.key === 'name') return r.s.name.toLowerCase();
      if (sort.key === 'locality') return r.s.locality.toLowerCase();
      if (sort.key === 'agency') return r.s.agency;
      if (sort.key === 'first') return r.s.first || '';
      if (sort.key === 'mean') return r.mean;
      if (sort.key === 'valid') return r.validYears;
      return r.years[sort.key] ? r.years[sort.key].mean : null;
    }
    rows.sort(function (a, b) {
      var x = keyVal(a), y = keyVal(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      var c = x < y ? -1 : x > y ? 1 : 0;
      return sort.dir === 'asc' ? c : -c;
    });
    function th(key, label, cls) {
      var active = sort.key === key;
      return '<th class="' + (cls || '') + '" aria-sort="' + (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
        '<button type="button" data-sort="' + esc(key) + '">' + esc(label) + (active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</button></th>';
    }
    var html = '<table><thead><tr>' + th('name', 'Station', 'sticky') + th('locality', 'Locality') + th('agency', 'Agency') + th('first', 'First – last day') +
      th('mean', 'Long-term mean', 'num') + th('valid', 'Valid years', 'num') + years.map(function (y) { return th(y, y, 'num'); }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr><td class="sticky"><b>' + esc(r.s.name) + '</b></td><td>' + esc(r.s.locality) + '</td><td>' + esc(r.s.agency) + '</td>' +
        '<td>' + esc(r.s.first || '–') + ' → ' + esc(r.s.last || '–') + '</td>' +
        '<td class="cell" style="' + (r.mean != null ? cellStyle(r.mean) : '') + '">' + fmt(r.mean, 1) + '</td>' +
        '<td class="num">' + r.validYears + '</td>' +
        years.map(function (y) {
          var e = r.years[y];
          if (!e) return '<td class="cell"></td>';
          return '<td class="cell" style="' + cellStyle(e.mean) + '" data-tip="' + esc(r.s.name + ' ' + y + ': mean ' + fmt(e.mean, 1) + ' over ' + e.days + ' days; ' + fmt(e.pct_poor_or_worse, 1) + '% Poor or worse') + '">' + fmt(e.mean, 0) + '</td>';
        }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    var wrap = $('#region-table-wrap');
    wrap.innerHTML = html;
    wrap.querySelectorAll('button[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.regionSort.key === k) state.regionSort.dir = state.regionSort.dir === 'asc' ? 'desc' : 'asc';
        else state.regionSort = { key: k, dir: (k === 'name' || k === 'locality' || k === 'agency' || k === 'first') ? 'asc' : 'desc' };
        renderRegionTable();
        var nb = wrap.querySelector('button[data-sort="' + k + '"]'); if (nb) nb.focus();
      });
    });
  }

  function renderMonthlyHeatmap() {
    var mon = D.summary.monthly;
    var months = [];
    var y0 = +D.meta.first.slice(0, 4), m0 = +D.meta.first.slice(5, 7), y1 = +D.meta.last.slice(0, 4), m1 = +D.meta.last.slice(5, 7);
    for (var y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m++) {
      if (m > 12) { m = 1; y++; if (y > y1) break; }
      months.push(y + '-' + (m < 10 ? '0' + m : m));
      if (y === y1 && m === m1) break;
    }
    var yearsRow = [], cur = null;
    months.forEach(function (ym) {
      var yy = ym.slice(0, 4);
      if (cur && cur.y === yy) cur.n++; else { cur = { y: yy, n: 1 }; yearsRow.push(cur); }
    });
    var html = '<table class="hm-table"><thead><tr><th class="sticky" rowspan="2">Station</th>' +
      yearsRow.map(function (g) { return '<th class="yr" colspan="' + g.n + '">' + g.y + '</th>'; }).join('') + '</tr><tr>' +
      months.map(function (ym) { return '<th class="mo">' + MONTH_NAMES[+ym.slice(5) - 1].charAt(0) + '</th>'; }).join('') + '</tr></thead><tbody>';
    D.meta.stations.forEach(function (s) {
      var row = mon[s.id] || {};
      html += '<tr><td class="sticky">' + esc(s.name) + '</td>' + months.map(function (ym) {
        var v = row[ym];
        if (v == null) return '<td class="m" style="background:var(--nogap)" data-tip="' + esc(s.name + ' ' + ym + ': no data') + '"></td>';
        return '<td class="m" style="background:' + colorOf(v) + '" data-tip="' + esc(s.name + ' ' + ym + ': mean AQI ' + v) + '"></td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    $('#monthly-wrap').innerHTML = html;
  }

  // ======================================================
  // 7. SEASONS
  // ======================================================
  function renderMonthClim() {
    var mc = D.summary.month_clim;
    var vals = []; for (var m = 1; m <= 12; m++) vals.push(mc[m] != null ? mc[m] : null);
    mk('chart-month', {
      type: 'bar',
      data: { labels: MONTH_NAMES, datasets: [{ label: 'Mean AQI', data: vals, backgroundColor: vals.map(colorOf), borderWidth: 0 }] },
      options: {
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: gridCfg(), title: { display: true, text: 'Mean AQI' } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (it) { return 'Mean AQI ' + fmt(it.raw, 1) + (it.raw != null ? ' – ' + catOf(it.raw).name : ''); } } }
        }
      }
    });
  }

  var SEASON_STYLE = {
    all: { label: 'All year', color: function () { return css('--text'); }, width: 3 },
    winter: { label: 'Winter (Nov–Feb)', color: function () { return '#3b82f6'; }, width: 1.8 },
    monsoon: { label: 'Monsoon (Jun–Sep)', color: function () { return '#10b981'; }, width: 1.8 },
    other: { label: 'Other (Mar–May, Oct)', color: function () { return '#f59e0b'; }, width: 1.8 }
  };

  function renderHourly() {
    var key = $('#hr-station').value;
    var prof = D.summary.hourly_profile[key] || {};
    var on = Array.prototype.map.call(document.querySelectorAll('#hr-seasons input:checked'), function (i) { return i.value; });
    var labels = []; for (var h = 0; h < 24; h++) labels.push((h < 10 ? '0' : '') + h);
    var datasets = ['all', 'winter', 'monsoon', 'other'].filter(function (s) { return on.indexOf(s) >= 0 && prof[s]; }).map(function (s) {
      var st = SEASON_STYLE[s], c = st.color();
      return { label: st.label, data: prof[s], borderColor: c, backgroundColor: c, borderWidth: st.width, pointRadius: 2, spanGaps: false, tension: 0.15 };
    });
    mk('chart-hour', {
      type: 'line', data: { labels: labels, datasets: datasets }, plugins: [bandsPlugin],
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, title: { display: true, text: 'Hour of day (IST)' } },
          y: { beginAtZero: true, grid: gridCfg(), title: { display: true, text: 'Mean hourly AQI' } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              title: function (items) { return items[0].label + ':00 IST'; },
              label: function (it) { return it.dataset.label + ': ' + fmt(it.raw, 0); }
            }
          }
        }
      }
    });
  }

  function initHourly() {
    var sel = $('#hr-station');
    var ids = Object.keys(D.summary.hourly_profile);
    var opts = D.meta.stations.filter(function (s) { return ids.indexOf(s.id) >= 0; }).map(function (s) { return { value: s.id, label: stationLabel(s) }; });
    fillSelect(sel, opts, safeStore('get', 'pune-aq-station'));
    sel.addEventListener('change', renderHourly);
    document.querySelectorAll('#hr-seasons input').forEach(function (i) { i.addEventListener('change', renderHourly); });
    renderHourly();
  }

  // ======================================================
  // 8. POLLUTANTS
  // ======================================================
  function initPollutants() {
    var P = D.pollutants;
    var opts = D.meta.stations.filter(function (s) { return P[s.id] && Object.keys(P[s.id]).length; })
      .map(function (s) { return { value: s.id, label: stationLabel(s) }; });
    var ss = $('#pol-station'), ps = $('#pol-pollutant');
    fillSelect(ss, opts, safeStore('get', 'pune-aq-station'));
    var pols = ['pm25', 'pm10', 'no2', 'o3', 'co', 'so2', 'nh3'];
    fillSelect(ps, pols.map(function (p) { return { value: p, label: AQI.POLLUTANT_NAMES[p] }; }), 'pm25');
    ss.addEventListener('change', renderPollutant);
    ps.addEventListener('change', renderPollutant);
    renderPollutant();
    renderDrivers();
  }

  function renderPollutant() {
    var st = $('#pol-station').value, pol = $('#pol-pollutant').value;
    var rec = D.pollutants[st] || {};
    var keys = Object.keys(rec).sort();
    var note = $('#pol-note');
    if (!keys.length) { mk('chart-pol', { type: 'line', data: { labels: [], datasets: [] } }); note.textContent = 'No data for this station.'; return; }
    var labels = [], d = keys[0], last = keys[keys.length - 1];
    while (d <= last) { labels.push(d); d = addDays(d, 1); }
    var data = labels.map(function (x) { return rec[x] && rec[x][pol] != null ? rec[x][pol] : null; });
    var unit = pol === 'co' ? 'mg/m³' : 'µg/m³';
    var accent = css('--accent');
    var datasets = [{
      label: AQI.POLLUTANT_NAMES[pol] + ' daily mean (' + unit + ')', data: data, borderColor: accent, backgroundColor: accent,
      borderWidth: 1.3, spanGaps: false, tension: 0,
      pointRadius: function (ctx) {
        var i = ctx.dataIndex;
        return data[i] != null && (i === 0 || data[i - 1] == null) && (i === data.length - 1 || data[i + 1] == null) ? 2.5 : 0;
      }, pointHoverRadius: 4
    }];
    var ref = REFS[pol];
    if (ref) {
      datasets.push({ label: 'CPCB 24-h standard (' + ref.cpcb + ' µg/m³)', data: labels.map(function () { return ref.cpcb; }), borderColor: '#E53935', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0 });
      datasets.push({ label: 'WHO 2021 24-h guideline (' + ref.who + ' µg/m³)', data: labels.map(function () { return ref.who; }), borderColor: '#10b981', borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0 });
      note.textContent = 'Dashed lines: CPCB 24-hour standard and WHO 2021 24-hour guideline for ' + AQI.POLLUTANT_NAMES[pol] + '.';
    } else {
      note.textContent = 'No 24-hour reference line is drawn for ' + AQI.POLLUTANT_NAMES[pol] + '. Concentrations are as published in the source files (CPCB reports CO in mg/m³, the others in µg/m³).';
    }
    mk('chart-pol', {
      type: 'line', data: { labels: labels, datasets: datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
          y: { beginAtZero: true, grid: gridCfg(), title: { display: true, text: AQI.POLLUTANT_NAMES[pol] + ' (' + unit + ')' } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 18, boxHeight: 2, font: { size: 11 } } },
          tooltip: { callbacks: { label: function (it) { return it.raw == null ? it.dataset.label.split(' (')[0] + ': no data' : it.dataset.label.indexOf('daily') >= 0 ? fmt(it.raw, 2) + ' ' + unit : it.dataset.label; } } }
        }
      }
    });
  }

  function renderDrivers() {
    var ins = D.insights.filter(function (i) { return i.id === 'drivers'; })[0];
    var note = $('#drivers-note');
    if (!ins || !ins.data || !ins.data.share) { note.textContent = 'Dominant-pollutant data not available.'; return; }
    var share = ins.data.share;
    var keys = Object.keys(share).sort(function (a, b) { return share[b] - share[a]; });
    mk('chart-drivers', {
      type: 'doughnut',
      data: {
        labels: keys.map(function (k) { return AQI.POLLUTANT_NAMES[k] || k; }),
        datasets: [{ data: keys.map(function (k) { return share[k]; }), backgroundColor: keys.map(function (k) { return DRIVER_COLORS[k] || '#999'; }), borderColor: css('--card'), borderWidth: 2 }]
      },
      options: {
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12 } },
          tooltip: { callbacks: { label: function (it) { return it.label + ': ' + it.raw + '% of hours'; } } }
        }
      }
    });
    note.textContent = ins.caveat || '';
  }

  // ======================================================
  // 9. METHODOLOGY
  // ======================================================
  function renderMethod() {
    var m = D.meta, r = m.rules;
    var cityStart = D.daily.city.start;
    var karve = m.stations.filter(function (s) { return s.id === 'karve'; })[0];
    $('#method-body').innerHTML =
      '<h3>Source</h3><p>Hourly readings from the CPCB continuous ambient air quality monitoring stations (CAAQMS) in Pune, operated by CPCB/MPCB/IITM and compiled by ' +
      '<a href="' + esc(m.source.url) + '" rel="noopener">data.opencity.in</a> (' + esc(m.source.name) + '). Licence: ' + esc(m.source.license) + '. ' +
      'Dataset generated ' + esc(m.generated) + '; station data runs from ' + esc(m.first) + ' to ' + esc(m.last) + '.</p>' +
      '<h3>How daily values are built</h3><ul>' +
      '<li>A <b>daily value</b> is the mean of hourly AQI values and needs at least <b>' + r.min_hours + '</b> hourly values in that day.</li>' +
      '<li>A <b>station-year</b> mean needs at least <b>' + r.min_days_year + '</b> valid days in that year; other years are left blank.</li>' +
      '<li>The <b>city median</b> for a day needs at least <b>' + r.min_stations_city + '</b> stations reporting. It is the median of the stations\' daily values.</li>' +
      '<li>Physically implausible sensor readings were removed before averaging. Missing data are shown as gaps, never as zero or interpolated.</li>' +
      '<li>Categories follow the CPCB AQI scale: ' + cats().map(function (c) { return esc(c.name) + ' (≤' + c.max + ')'; }).join(', ') + '.</li>' +
      '<li><b>Quality check:</b> a station-month is excluded when its mean is at least ' + r.qc_ratio + '× the median of the other stations in the same month (likely sensor fault). ' +
      (m.qc_excluded && m.qc_excluded.length ? 'Excluded: ' + m.qc_excluded.map(function (f) {
        var s = m.stations.filter(function (x) { return x.id === f.station; })[0];
        return esc(s ? s.name : f.station) + ' ' + esc(f.month) + ' (' + f.mean + ' vs ' + f.others_median + ')';
      }).join('; ') + '.' : 'Nothing was excluded.') + '</li></ul>' +
      '<h3>Things to keep in mind</h3><ul>' +
      '<li><b>The city median only exists from ' + esc(cityStart) + '.</b> Before that only ' + esc(karve ? karve.name : 'one station') + ' reported, so earlier years show a single station and the city series (and category shares) begin later.</li>' +
      '<li><b>2016 and earlier</b> are not available as open station data, so this site starts in ' + esc(m.first.slice(0, 4)) + '.</li>' +
      '<li><b>Method change in 2024.</b> 2017–23 files publish hourly AQI directly; from 2024 the AQI is computed from 15-minute pollutant concentrations. Year-to-year comparisons across this boundary are indicative.</li>' +
      '<li><b>Time zone.</b> The 2024–25 CPCB-file timestamps are labelled UTC in the source but follow local (IST) time, judging by the daily profile, so they are used as IST.</li>' +
      '<li><b>Latest data.</b> Station data currently ends at <b>' + esc(m.last) + '</b>.' +
      (m.supplement ? ' Readings from ' + esc(m.supplement.from_) + ' come from the <a href="' + esc(m.supplement.url) + '" rel="noopener">OpenAQ</a> archive (licence ' + esc(m.supplement.license) + '), which republishes the CPCB station values unchanged — checked hour-by-hour against the CPCB 2025 files. OpenAQ labels some gases with wrong units, so values are used in CPCB&#39;s native units. OpenAQ runs a few days behind.' : '') + '</li>' +
      (m.partial_year ? '<li><b>' + m.partial_year + ' is incomplete</b> (no data after ' + esc(m.last) + ', so most of its winter is missing). It appears in the daily views but is left out of year-to-year averages and rankings, where it would look misleadingly clean.</li>' : '') +
      '<li>Pollutant concentrations (and the drivers chart) exist only from 2024 onward. Dominant-pollutant shares are based on hourly values.</li>' +
      '<li><b>Live now</b> uses the stations&#39; latest readings (via OpenAQ, refreshed hourly) and the official CPCB method: 24-hour averages, with CO and ozone using their highest 8-hour average, and at least 16 hours of data. The city figure is the median of the stations. The <b>model trend &amp; forecast</b> below it comes from Copernicus CAMS via Open-Meteo, a coarse-resolution model that cannot see local events such as fireworks.</li></ul>' +
      '<h3>Refreshing the data</h3><p>See <code>README.md</code>: download the station CSVs into <code>raw/</code> and run <code>python tools/process.py raw site/data</code>.</p>' +
      '<h3>Credits</h3><p>Data: CPCB, MPCB, IITM via data.opencity.in' + (m.supplement ? ' and OpenAQ' : '') + '. Live estimates: Open-Meteo and Copernicus Atmosphere Monitoring Service (CAMS).</p>';

    var years = {};
    m.stations.forEach(function (s) { Object.keys(s.days_by_year).forEach(function (y) { years[y] = 1; }); });
    var ys = Object.keys(years).sort();
    var html = '<table><thead><tr><th class="sticky">Station</th>' + ys.map(function (y) { return '<th class="num">' + y + '</th>'; }).join('') + '</tr></thead><tbody>';
    m.stations.forEach(function (s) {
      html += '<tr><td class="sticky">' + esc(s.name) + '</td>' + ys.map(function (y) {
        var n = s.days_by_year[y];
        var ok = n != null && n >= r.min_days_year;
        return '<td class="num"' + (ok ? ' style="font-weight:700"' : '') + '>' + (n != null ? n : '') + '</td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table><p class="small muted">Bold = meets the station-year rule (≥' + r.min_days_year + ' valid days). Blank = no valid days.</p>';
    $('#coverage-wrap').innerHTML = html;
  }

  // ======================================================
  // boot
  // ======================================================
  function renderAllCharts() {
    applyDefaults();
    if (state.live) renderLive();
    if (state.stations) renderStations();
    if (!D.meta) return;
    renderExplorer(); renderTrends(); renderMonthClim(); renderHourly(); renderPollutant(); renderDrivers();
    renderCalendar(false);
  }

  function initNavHighlight() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.topnav a'));
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id); });
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    links.forEach(function (a) { var s = document.querySelector(a.getAttribute('href')); if (s) io.observe(s); });
  }

  function showGlobalError(msg) {
    var e = $('#global-error'); e.hidden = false; e.textContent = msg;
  }

  function boot() {
    initTip();
    initNavHighlight();
    if (!window.Chart) showGlobalError('The charting library (Chart.js) could not be loaded, so charts are unavailable. Tables and text still work.');
    applyDefaults();
    loadLive(); // independent of the local data
    loadStations();

    Promise.all(['meta', 'daily', 'summary', 'insights', 'pollutants'].map(function (n) { return getJSON(n + '.json'); }))
      .then(function (r) {
        D.meta = r[0]; D.daily = r[1]; D.summary = r[2]; D.insights = r[3]; D.pollutants = r[4];
        $('#data-badge').textContent = 'Data: ' + D.meta.first + ' – ' + D.meta.last;
        catLegend('#cat-legend-1'); catLegend('#cat-legend-2'); catLegend('#cat-legend-3');
        renderInsights();
        initExplorer();
        renderTrends();
        renderRegionTable();
        renderMonthlyHeatmap();
        renderMonthClim();
        initHourly();
        initPollutants();
        renderMethod();
        if (state.live) renderLive(); // live arrived first: draw chart now categories exist
        if (state.stations) renderStations();
      })
      .catch(function (err) {
        showGlobalError('Could not load the data files (' + err.message + '). The site must be served over HTTP, e.g. "python -m http.server 8000" inside the site folder.');
      });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { setTimeout(renderAllCharts, 50); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
