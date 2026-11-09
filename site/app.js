/* Pune Air Quality - front end. Every number on the page comes from site/data/*.json or the Open-Meteo API.
 * Charts: Observable Plot (SVG). Pure data derivations live in aqi.js (AQI.derive). */
(function () {
  'use strict';

  var A = window.AQI, V = A.derive, F = A.fmt;
  var LIVE_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=18.5204&longitude=73.8567' +
    '&hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=Asia%2FKolkata&past_days=30&forecast_days=3';
  var CITY = '__city';
  var POL_LIM = { pm25: { ind: 60, who: 15 }, pm10: { ind: 100, who: 45 }, no2: { ind: 80, who: 25 } }; // ug/m3, 24-hour
  var POL_ORDER = ['pm25', 'pm10', 'no2', 'o3', 'co', 'so2', 'nh3'];
  var STALE_MS = 3 * 3600 * 1000;
  var SANS = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

  var D = {};            // loaded data
  var C = {};            // colours read from CSS custom properties
  var figs = {};         // figure registry
  var state = { sel: '', xStation: CITY, xYear: null, xPol: 'pm25', live: null, liveError: false };

  /* ------------------------------------------------------------------ helpers */
  function $(s, r) { return (r || document).querySelector(s); }
  function h(tag, props, kids) {
    var e = document.createElement(tag), k;
    if (props) for (k in props) {
      if (props[k] == null) continue;
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'style') e.style.cssText = props[k];
      else e.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function fix(x, n) { return Number(x).toFixed(n == null ? 0 : n); }
  function slug(name) { return name.toLowerCase().replace(/\s+/g, '-'); }
  function cats() { return D.meta.categories; }
  function catName(v) { return A.catOf(v, cats()); }
  function aqiColor(v) { var n = catName(v); return n ? C.cat[n] : C.nodata; }
  function unit(k) { return k === 'co' ? 'mg/m³' : 'µg/m³'; }
  function polName(k) { return A.POLLUTANT_NAMES[k] || k; }
  function msg(text) { return h('p', { class: 'msg', text: text }); }
  function safe(fn, label) { try { fn(); } catch (e) { if (window.console) console.error(label || 'render', e); } }

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    function g(n) { return cs.getPropertyValue(n).trim(); }
    C = {
      paper: g('--paper'), ink: g('--ink'), ink2: g('--ink-2'), ink3: g('--ink-3'), rule: g('--rule'), grid: g('--grid'),
      accent: g('--accent'), mute: g('--mute-mark'), nodata: g('--nodata'),
      cat: {
        'Good': g('--c-good'), 'Satisfactory': g('--c-satisfactory'), 'Moderate': g('--c-moderate'),
        'Poor': g('--c-poor'), 'Very Poor': g('--c-very-poor'), 'Severe': g('--c-severe')
      }
    };
  }

  function legendEl(withNoData) {
    var ul = h('ul', { class: 'legend', 'aria-label': 'AQI categories, from cleanest to most polluted' });
    A.ORDER.forEach(function (n) {
      ul.appendChild(h('li', null, [h('span', { class: 'swatch sw-' + slug(n) }), n + ' ' + A.RANGES[n]]));
    });
    if (withNoData) ul.appendChild(h('li', null, [h('span', { class: 'swatch sw-nodata' }), 'No data']));
    return ul;
  }

  function tableEl(head, rows) {
    var thead = h('thead', null, [h('tr', null, head.map(function (t, i) {
      var numeric = rows.length && typeof rows[0][i] === 'number';
      return h('th', { scope: 'col', class: numeric ? 'n' : '', text: t });
    }))]);
    var tbody = h('tbody', null, rows.map(function (r) {
      return h('tr', null, r.map(function (c) {
        return h('td', { class: typeof c === 'number' ? 'n' : '', text: c == null ? '' : String(c) });
      }));
    }));
    return h('table', null, [thead, tbody]);
  }

  /* ------------------------------------------------------------------ figure scaffolding */
  function mountFigures() {
    Array.prototype.forEach.call(document.querySelectorAll('figure[data-fig]'), function (root) {
      var id = root.getAttribute('data-fig');
      var f = { id: id, root: root, lastW: 0, draw: null };
      f.titleEl = h('h3', { class: 'chart-title' });
      f.subEl = h('p', { class: 'chart-sub' });
      root.appendChild(f.titleEl); root.appendChild(f.subEl);
      var lg = root.getAttribute('data-legend');
      if (lg) root.appendChild(legendEl(lg === 'aqi-nodata'));
      f.plotEl = h('div', { class: 'plot' + (root.getAttribute('data-scroll') ? ' scroll' : ''), role: id === 'grid' ? null : 'img' });
      root.appendChild(f.plotEl);
      if (id !== 'grid') {
        f.tblEl = h('div', { class: 'tbl' });
        root.appendChild(h('details', { class: 'datatable' }, [h('summary', { text: 'Show data table' }), f.tblEl]));
      }
      root.appendChild(h('p', { class: 'source', text: root.getAttribute('data-source') || '' }));
      figs[id] = f;
    });
  }

  function setFig(id, o) {
    var f = figs[id]; if (!f) return;
    if (o.title != null) f.titleEl.textContent = o.title;
    if (o.sub != null) f.subEl.textContent = o.sub;
    if (o.aria != null) f.plotEl.setAttribute('aria-label', o.aria);
    if (f.tblEl && o.head) { clear(f.tblEl); f.tblEl.appendChild(tableEl(o.head, o.rows || [])); }
  }

  function plotWidth(f) {
    var w = f.plotEl.clientWidth || f.root.clientWidth;
    return Math.max(280, Math.floor(w || 900));
  }

  function redraw(id) {
    var f = figs[id]; if (!f || !f.draw) return;
    var w = plotWidth(f);
    f.lastW = f.plotEl.clientWidth;
    clear(f.plotEl);
    try { f.plotEl.appendChild(f.draw(w)); }
    catch (e) { if (window.console) console.error(id, e); f.plotEl.appendChild(msg('This chart could not be drawn in your browser. The data table below has the numbers.')); }
  }
  function redrawAll() { Object.keys(figs).forEach(redraw); }

  function setupResize() {
    if (!window.ResizeObserver) { window.addEventListener('resize', debounced); return; }
    var ro = new ResizeObserver(debounced);
    Object.keys(figs).forEach(function (id) { ro.observe(figs[id].root); });
    var t;
    function debounced() {
      clearTimeout(t);
      t = setTimeout(function () {
        Object.keys(figs).forEach(function (id) {
          var f = figs[id];
          if (f.draw && Math.abs(f.plotEl.clientWidth - f.lastW) > 1) redraw(id);
        });
      }, 150);
    }
  }

  /* ------------------------------------------------------------------ Plot helpers */
  function pBase(w, hgt, o) {
    return Object.assign({
      width: w, height: hgt, color: { type: 'identity' }, opacity: { type: 'identity' },
      style: { background: 'transparent', color: C.ink, fontFamily: SANS, fontSize: '12px', overflow: 'visible' }
    }, o || {});
  }
  function tipOpts() { return { fill: C.paper, stroke: C.ink3, fontSize: 12 }; }
  function merge(a, b) { return Object.assign({}, a, b); }
  function K(v) { return function () { return v; }; } // constant channel
  function yTicks(max, n) { return d3.ticks(0, max, n || 5).filter(function (t) { return t > 0; }); } // no 0 tick: it would collide with the first x label

  /** Ranked horizontal bars. rows: [{key,name,value,color,label,tip,sel}] already sorted. */
  function rankBars(w, rows, o) {
    var rowH = o.rowH || 40, bw = 18, pad = 1 - bw / rowH;
    var mt = 4, mb = 30, mr = o.marginRight || 100;
    var hgt = Math.round(rowH * (rows.length + pad)) + mt + mb;
    var keys = rows.map(function (r) { return r.key; });
    var anySel = rows.some(function (r) { return r.sel; });
    var dy = -(bw / 2 + 3);
    return Plot.plot(pBase(w, hgt, {
      marginTop: mt, marginBottom: mb, marginLeft: 12, marginRight: mr,
      x: { domain: o.domain, ticks: o.ticks, tickFormat: o.tickFormat, label: null, tickSize: 0 },
      y: { domain: keys, axis: null, padding: pad },
      marks: [
        Plot.gridX({ stroke: C.grid, strokeOpacity: 1, ticks: o.ticks }),
        Plot.barX(rows, { y: 'key', x: 'value', fill: 'color', fillOpacity: function (r) { return anySel && !r.sel ? 0.5 : 1; }, rx: 2 }),
        Plot.text(rows.filter(function (r) { return !r.sel; }), { y: 'key', x: K(o.domain[0]), text: 'name', textAnchor: 'start', lineAnchor: 'bottom', dy: dy, fill: C.ink2 }),
        Plot.text(rows.filter(function (r) { return r.sel; }), { y: 'key', x: K(o.domain[0]), text: function (r) { return r.name + ' (your area)'; }, textAnchor: 'start', lineAnchor: 'bottom', dy: dy, fill: C.ink, fontWeight: 700 }),
        Plot.text(rows, { y: 'key', x: 'value', text: 'label', textAnchor: 'start', dx: 6, fill: C.ink }),
        Plot.tip(rows, Plot.pointerY(merge(tipOpts(), { y: 'key', x: 'value', title: 'tip' })))
      ]
    }));
  }

  /* ------------------------------------------------------------------ hero */
  function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
  function istToday() { return istNow().toISOString().slice(0, 10); }
  function fmtUpdated(latest) {
    var m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(latest.generated_ist || '');
    if (!m) return latest.generated_ist || '';
    var hr = +m[2];
    return F.fmtDate(m[1]) + ', ' + ((hr % 12) || 12) + ':' + m[3] + ' ' + (hr < 12 ? 'am' : 'pm') + ' IST';
  }
  function ageText(ms) {
    var hrs = Math.round(ms / 3600000);
    if (hrs < 48) return hrs + ' hours';
    return Math.round(hrs / 24) + ' days';
  }

  var BOUNDS = [[0, 50], [50, 100], [100, 200], [200, 300], [300, 400], [400, 500]];
  function scaleEl(value) {
    var wrap = h('div', { class: 'scale-wrap' });
    var ul = h('ul', { class: 'scale', 'aria-label': 'The AQI scale: six categories from Good to Severe' });
    A.ORDER.forEach(function (n) {
      ul.appendChild(h('li', { class: 'sw-' + slug(n), style: 'color:' + A.textOn(A.CATEGORY_COLORS[n]) }, [h('b', { text: n }), h('span', { text: A.RANGES[n] })]));
    });
    wrap.appendChild(ul);
    if (value != null) {
      var i = A.catIndex(catName(value)), b = BOUNDS[i];
      var frac = Math.max(0, Math.min(1, (value - b[0]) / (b[1] - b[0])));
      var pos = ((i + frac) / 6 * 100).toFixed(2) + '%';
      wrap.appendChild(h('div', { class: 'scale-marker', style: '--pos:' + pos, 'aria-hidden': 'true' }, [h('span', { text: String(value) })]));
    }
    return wrap;
  }

  function renderHero() {
    var body = $('#hero-body'), slot = $('#hero-scale-slot');
    clear(body); clear(slot);
    var L = D.latest;
    if (!L) {
      body.appendChild(h('div', { class: 'callout warn' }, [h('p', { text: 'The latest readings could not be loaded. Please try again later. The charts further down use saved history and still work.' })]));
      slot.appendChild(scaleEl(null));
      return;
    }
    var hero = V.hero(L);
    if (hero.aqi == null) {
      body.appendChild(h('p', { class: 'lede', text: 'There is no city-wide AQI right now. Fewer than three stations have enough recent readings.' }));
    } else {
      body.appendChild(h('div', { class: 'hero-figure' }, [
        h('span', { class: 'hero-num', text: String(hero.aqi), 'aria-label': 'AQI ' + hero.aqi }),
        h('span', { class: 'hero-cat' }, [h('span', { class: 'swatch sw-' + slug(hero.category) }), hero.category])
      ]));
      body.appendChild(h('p', { class: 'hero-advice' }, [h('span', { class: 'lbl', text: 'CPCB health advisory' }), hero.advisory]));
      var bits = ['City figure: the middle value of ' + hero.nStations + ' stations'];
      if (hero.windowTime) bits[0] += ', each averaged over the 24 hours to ' + F.fmtHour(parseInt(hero.windowTime, 10)).replace(' ', ' ') + ' IST';
      body.appendChild(h('p', { class: 'hero-meta', text: bits[0] + '.' + (hero.dominant ? ' Main pollutant: ' + A.POLLUTANT_PLAIN[hero.dominant] + '.' : '') }));
    }
    var upd = h('p', { class: 'hero-meta', text: 'Updated ' + fmtUpdated(L) + '.' });
    body.appendChild(upd);
    var gen = Date.parse(L.generated_utc);
    if (isFinite(gen) && Date.now() - gen > STALE_MS) {
      body.appendChild(h('div', { class: 'callout warn', role: 'status' }, [h('p', { text: 'These readings are about ' + ageText(Date.now() - gen) + ' old. The automatic update may have stopped, so the air outside could be different now.' })]));
    }
    var lag = V.lag(L, cats());
    if (lag) {
      body.appendChild(h('div', { class: 'callout' }, [h('p', { text: 'The air has improved over the last few hours. In the last hour, fine particles (PM2.5) were about ' + Math.round(lag.median) + ' µg/m³ (median of ' + lag.n + ' stations), which on its own would be rated ' + lag.category + '. The AQI is a 24-hour average, so it falls slowly after the air improves.' })]));
    }
    slot.appendChild(h('p', { class: 'kicker', text: 'What the numbers mean', style: 'margin-top:32px' }));
    slot.appendChild(scaleEl(hero.aqi));
  }

  /* ------------------------------------------------------------------ station picker + ranking */
  function stationList() { return V.stations(D.meta, D.latest); }

  function setupPicker() {
    var sel = $('#sel-station');
    var list = stationList();
    ['Pune', 'Pimpri-Chinchwad'].forEach(function (g) {
      var og = h('optgroup', { label: g });
      list.filter(function (s) { return s.group === g; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (s) {
        og.appendChild(h('option', { value: s.id, text: s.name + (s.aqi == null ? ' (no current reading)' : '') }));
      });
      if (og.children.length) sel.appendChild(og);
    });
    sel.addEventListener('change', function () { state.sel = sel.value; renderDetail(); redraw('stations'); });
  }

  function renderDetail() {
    var box = $('#station-detail'); clear(box);
    if (!state.sel) { box.hidden = true; return; }
    var s = stationList().filter(function (x) { return x.id === state.sel; })[0];
    if (!s) { box.hidden = true; return; }
    box.hidden = false;
    if (s.aqi == null) {
      box.appendChild(h('p', null, [h('b', { text: s.name + ': ' }), 'no current AQI. ' + V.plainNote(s.note)]));
    } else {
      box.appendChild(h('p', { class: 'big' }, [s.name + ': ', h('span', { class: 'num', text: String(s.aqi) }), ' ', h('span', { class: 'swatch sw-' + slug(s.category) }), ' ' + s.category]));
      var cmp = V.compare(s, D.latest);
      if (cmp) box.appendChild(h('p', { text: 'That is ' + cmp.text + ' the city figure of ' + D.latest.city.aqi + ' (the median of all stations with a reading).' }));
    }
    var lh = s.last_hour;
    if (lh.pm25 != null) box.appendChild(h('p', { class: 'muted', text: 'PM2.5 in the last hour: ' + fix(lh.pm25, 0) + ' µg/m³. The AQI above is a 24-hour average, so the two can differ.' }));
    else if (lh.pm10 != null) box.appendChild(h('p', { class: 'muted', text: 'PM10 in the last hour: ' + fix(lh.pm10, 0) + ' µg/m³.' }));
  }

  function setupStations() {
    var list = stationList();
    var withV = list.filter(function (s) { return s.aqi != null; }).sort(function (a, b) { return b.aqi - a.aqi; });
    var without = list.filter(function (s) { return s.aqi == null; });
    var f = figs.stations;
    if (!withV.length) {
      setFig('stations', { title: 'No station has a current reading', sub: '', aria: 'No data', head: ['Station'], rows: [] });
      f.draw = function () { return msg('No station has enough recent data right now.'); };
    } else {
      var hi = withV[0], lo = withV[withV.length - 1];
      setFig('stations', {
        title: withV.length > 1 ? 'Right now, ' + hi.name + ' has the worst air (AQI ' + hi.aqi + ') and ' + lo.name + ' the best (' + lo.aqi + ')' : withV[0].name + ' is the only station with a current reading (AQI ' + hi.aqi + ')',
        sub: 'AQI over the last 24 hours at each station with a current reading. ' + withV.length + ' of ' + list.length + ' stations are reporting.',
        aria: 'Bar chart of the current AQI at ' + withV.length + ' stations, from ' + lo.aqi + ' at ' + lo.name + ' to ' + hi.aqi + ' at ' + hi.name + '. Each bar is labelled with its AQI and category.',
        head: ['Station', 'Area', 'AQI', 'Category', 'PM2.5 last hour (µg/m³)'],
        rows: list.slice().sort(function (a, b) { return (b.aqi == null ? -1 : b.aqi) - (a.aqi == null ? -1 : a.aqi); }).map(function (s) {
          return [s.name, s.group, s.aqi == null ? 'No reading' : s.aqi, s.category || V.plainNote(s.note), s.last_hour.pm25 != null ? s.last_hour.pm25 : ''];
        })
      });
      f.draw = function (w) {
        var rows = withV.map(function (s) {
          return {
            key: s.id, name: s.name, value: s.aqi, color: C.cat[s.category], sel: s.id === state.sel, label: s.aqi + ' · ' + s.category,
            tip: s.name + '\nAQI ' + s.aqi + ' · ' + s.category + (s.dominant ? '\nMain pollutant: ' + A.POLLUTANT_PLAIN[s.dominant] : '')
          };
        });
        return rankBars(w, rows, { domain: [0, 500], ticks: [0, 100, 200, 300, 400, 500], rowH: 40, marginRight: 104 });
      };
    }
    var ul = $('#nodata-list'); clear(ul);
    if (without.length) {
      ul.appendChild(h('li', { class: 'small' }, [h('b', { text: 'Stations with no current value (' + without.length + ')' })]));
      without.forEach(function (s) { ul.appendChild(h('li', null, [h('b', { text: s.name }), h('span', { text: V.plainNote(s.note) })])); });
    }
  }

  /* ------------------------------------------------------------------ when */
  function setupWhen() {
    var mo = V.months(D.summary, D.insights);
    var hr = V.hourly(D.summary);
    var from = D.daily && D.daily.city && D.daily.city.start ? F.fmtMonthYear(D.daily.city.start.slice(0, 7)) : '';
    var to = D.meta.last ? F.fmtMonthYear(D.meta.last.slice(0, 7)) : '';
    $('#when-lede').textContent = 'Pune’s air follows the seasons and the clock. ' + V.headlines(D).ratio + '.';
    // (a) months
    setFig('months', {
      title: mo.worst.name + ' is the worst month for Pune’s air; ' + mo.best.name + ' is the cleanest',
      sub: 'Average city AQI for each month of the year, ' + from + ' to ' + to + '. Winter (Nov–Feb) averages ' + fix(mo.winter) + '; monsoon (Jun–Sep) averages ' + fix(mo.monsoon) + ', so winter is ' + fix(mo.ratio, 1) + '× worse.',
      aria: 'Column chart of average AQI by month. ' + mo.worst.name + ' is highest at ' + fix(mo.worst.v) + ' (' + catName(mo.worst.v) + '); ' + mo.best.name + ' is lowest at ' + fix(mo.best.v) + ' (' + catName(mo.best.v) + ').',
      head: ['Month', 'Average AQI', 'Category'],
      rows: mo.rows.map(function (r) { return [r.name, Math.round(r.v * 10) / 10, catName(r.v)]; })
    });
    figs.months.draw = function (w) {
      var ymax = Math.ceil(Math.max.apply(null, mo.rows.map(function (r) { return r.v; })) * 1.25 / 50) * 50;
      var rows = mo.rows.map(function (r) { return { m: r.short, name: r.name, v: r.v, color: aqiColor(r.v), cat: catName(r.v) }; });
      var ext = rows.filter(function (r) { return r.name === mo.worst.name || r.name === mo.best.name; });
      return Plot.plot(pBase(w, Math.max(260, Math.min(340, w * 0.55)), {
        marginTop: 36, marginBottom: 28, marginLeft: 34, marginRight: 24,
        x: { domain: rows.map(function (r) { return r.m; }), label: null, tickSize: 0, padding: 0.35 },
        y: { domain: [0, ymax], label: null, ticks: 5, tickSize: 0 },
        marks: [
          Plot.gridY({ stroke: C.grid, strokeOpacity: 1 }),
          Plot.barY(rows, { x: 'm', y: 'v', fill: 'color', rx: 2 }),
          Plot.ruleY([0], { stroke: C.ink3 }),
          Plot.text(ext, { x: 'm', y: 'v', text: function (r) { return fix(r.v) + '\n' + r.cat; }, dy: -6, lineAnchor: 'bottom', fill: C.ink, fontWeight: 600 }),
          Plot.tip(rows, Plot.pointerX(merge(tipOpts(), { x: 'm', y: 'v', title: function (r) { return r.name + '\nAverage AQI ' + fix(r.v) + ' · ' + r.cat; } })))
        ]
      }));
    };
    // (b) hours
    var hrs = [];
    for (var i = 0; i < 24; i++) hrs.push({ h: i, winter: hr.winter[i], monsoon: hr.monsoon[i] });
    setFig('hourly', {
      title: 'In winter, the air is worst around ' + F.fmtHour(hr.peak) + ' and cleanest around ' + F.fmtHour(hr.low),
      sub: 'Average hourly AQI across stations, by time of day. Winter is November to February; monsoon is June to September.',
      aria: 'Line chart of average AQI by hour of day. In winter the peak is around ' + F.fmtHour(hr.peak) + ' (' + fix(hr.winter[hr.peak]) + ') and the low is around ' + F.fmtHour(hr.low) + ' (' + fix(hr.winter[hr.low]) + '). Monsoon air is cleaner at every hour.',
      head: ['Hour', 'Winter AQI', 'Monsoon AQI'],
      rows: hrs.map(function (r) { return [F.fmtHour(r.h), r.winter == null ? '' : Math.round(r.winter), r.monsoon == null ? '' : Math.round(r.monsoon)]; })
    });
    figs.hourly.draw = function (w) {
      var all = hrs.reduce(function (a, r) { return a.concat([r.winter, r.monsoon]); }, []).filter(F.num);
      var ymax = Math.ceil(Math.max.apply(null, all) * 1.2 / 50) * 50;
      function last(k) { for (var j = 23; j >= 0; j--) if (hrs[j][k] != null) return { h: j, v: hrs[j][k] }; return null; }
      var lw = last('winter'), lm = last('monsoon');
      var wAbove = !lw || !lm || lw.v >= lm.v;
      var ends = [];
      if (lw) ends.push({ h: lw.h, v: lw.v, t: 'Winter', c: C.accent });
      if (lm) ends.push({ h: lm.h, v: lm.v, t: 'Monsoon', c: C.mute });
      var pk = { h: hr.peak, v: hr.winter[hr.peak] }, lo = { h: hr.low, v: hr.winter[hr.low] };
      var wide = hrs.filter(function (r) { return r.winter != null || r.monsoon != null; });
      return Plot.plot(pBase(w, Math.max(260, Math.min(340, w * 0.5)), {
        marginTop: 28, marginBottom: 28, marginLeft: 34, marginRight: w < 480 ? 66 : 80,
        x: { domain: [0, 23], ticks: w < 480 ? [0, 6, 12, 18] : [0, 3, 6, 9, 12, 15, 18, 21], tickFormat: F.fmtHour, label: null, tickSize: 0 },
        y: { domain: [0, ymax], label: null, ticks: yTicks(ymax), tickSize: 0 },
        marks: [
          Plot.gridY({ stroke: C.grid, strokeOpacity: 1, ticks: yTicks(ymax) }),
          Plot.lineY(hrs.filter(function (r) { return r.monsoon != null; }), { x: 'h', y: 'monsoon', stroke: C.mute, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
          Plot.lineY(hrs.filter(function (r) { return r.winter != null; }), { x: 'h', y: 'winter', stroke: C.accent, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
          Plot.dot(ends, { x: 'h', y: 'v', r: 4, fill: function (d) { return d.c; }, stroke: C.paper, strokeWidth: 2 }),
          Plot.text(ends.filter(function (d) { return d.t === 'Winter'; }), { x: 'h', y: 'v', text: 't', textAnchor: 'start', dx: 9, dy: wAbove ? -4 : 12, fill: C.ink, fontWeight: 600 }),
          Plot.text(ends.filter(function (d) { return d.t === 'Monsoon'; }), { x: 'h', y: 'v', text: 't', textAnchor: 'start', dx: 9, dy: wAbove ? 12 : -4, fill: C.ink2 }),
          Plot.dot([pk, lo], { x: 'h', y: 'v', r: 4.5, fill: C.accent, stroke: C.paper, strokeWidth: 2 }),
          Plot.text([pk], { x: 'h', y: 'v', text: function (d) { return 'Worst: ' + F.fmtHour(d.h) + ', AQI ' + fix(d.v); }, dy: -10, lineAnchor: 'bottom', textAnchor: 'middle', fill: C.ink }),
          Plot.text([lo], { x: 'h', y: 'v', text: function (d) { return 'Cleanest: ' + F.fmtHour(d.h) + ', AQI ' + fix(d.v); }, dy: 12, lineAnchor: 'top', fill: C.ink }),
          Plot.ruleX(wide, Plot.pointerX({ x: 'h', stroke: C.ink3, strokeOpacity: 1 })),
          Plot.tip(wide, Plot.pointerX(merge(tipOpts(), { x: 'h', y: function (d) { return d.winter != null ? d.winter : d.monsoon; }, title: function (d) { return F.fmtHour(d.h) + '\nWinter: ' + (d.winter == null ? 'no data' : fix(d.winter)) + '\nMonsoon: ' + (d.monsoon == null ? 'no data' : fix(d.monsoon)); } })))
        ]
      }));
    };
  }

  /* ------------------------------------------------------------------ areas */
  function setupAreas() {
    var ar = V.areas(D.summary, D.meta);
    var hot = (D.insights || []).filter(function (i) { return i.id === 'consistent_hotspot'; })[0];
    var reg = (D.insights || []).filter(function (i) { return i.id === 'regions'; })[0];
    var lede = $('#areas-lede'); clear(lede);
    lede.appendChild(document.createTextNode('To compare areas fairly, every station is measured over the same year: ' + ar.year + '. ' + (hot ? hot.text : '')));
    if (reg) lede.appendChild(h('span', { class: 'fineprint', style: 'display:block;margin-top:10px', text: reg.text + (reg.caveat ? ' ' + reg.caveat : '') }));
    var top = ar.rows[0];
    setFig('areas', {
      title: top.name + ' had the highest average AQI in ' + ar.year + ' (' + fix(top.mean) + ')',
      sub: 'Average daily AQI in ' + ar.year + ' at each station. ' + ar.rows.length + ' of ' + ar.total + ' stations had at least ' + ar.minDays + ' valid days that year, so only those are shown.',
      aria: 'Bar chart of average AQI in ' + ar.year + ' for ' + ar.rows.length + ' stations, from ' + fix(top.mean) + ' at ' + top.name + ' to ' + fix(ar.rows[ar.rows.length - 1].mean) + ' at ' + ar.rows[ar.rows.length - 1].name + '.',
      head: ['Station', 'Average AQI ' + ar.year, 'Category', 'Valid days', '% of days Poor or worse'],
      rows: ar.rows.map(function (r) { return [r.name, Math.round(r.mean * 10) / 10, catName(r.mean), r.days, r.poor]; })
    });
    figs.areas.draw = function (w) {
      var mx = Math.max.apply(null, ar.rows.map(function (r) { return r.mean; }));
      var top2 = Math.max(200, Math.ceil((mx + 30) / 50) * 50);
      var rows = ar.rows.map(function (r) {
        var c = catName(r.mean);
        return { key: r.id, name: r.name, value: r.mean, color: C.cat[c], label: fix(r.mean) + ' · ' + c, tip: r.name + '\nAverage AQI ' + fix(r.mean) + ' · ' + c + '\n' + r.days + ' valid days' };
      });
      return rankBars(w, rows, { domain: [0, top2], ticks: [0, 50, 100, 150, 200, 250, 300].filter(function (t) { return t <= top2; }), rowH: 40, marginRight: 112 });
    };
  }

  /* ------------------------------------------------------------------ trend */
  function setupTrend() {
    var sh = V.shares(D.summary), yt = V.yearTrend(D.summary);
    var ins = (D.insights || []).filter(function (i) { return i.id === 'yearly'; })[0];
    $('#trend-lede').textContent = 'Each bar splits a year into days of Good, Satisfactory, Moderate, Poor, Very Poor and Severe air. A day counts when at least three stations reported. Years with fewer than ' + sh.completeDays + ' such days are only partly covered.';
    var HL = V.headlines(D);
    setFig('shares', {
      title: HL.shares || 'Days in each AQI category, by year',
      sub: 'Share of days in each CPCB category, by year, using the city AQI (median of stations). ' + (sh.first && sh.last ? 'The comparison is between the first and last years with at least ' + sh.completeDays + ' days. ' +
        (function () {
          var cy = D.summary.city_year, a = cy[String(sh.first.year)], b = cy[String(sh.last.year)];
          var na = a && a.stations ? a.stations.length : null, nb = b && b.stations ? b.stations.length : null;
          return na != null && nb != null && na !== nb ? 'Careful: ' + na + ' stations had a full year of data in ' + sh.first.year + ' and ' + nb + ' in ' + sh.last.year + ', so part of the change may reflect which areas are measured, not only the air itself.' : '';
        })() : ''),
      aria: 'Stacked bars showing the share of days in each AQI category for ' + sh.rows.map(function (r) { return r.year; }).join(', ') + '. ' + (HL.shares || '') + '.',
      head: ['Year', 'City days'].concat(A.ORDER.map(function (n) { return n + ' (days)'; })).concat(['Good or Satisfactory (%)']),
      rows: sh.rows.map(function (r) {
        var m = {}; r.parts.forEach(function (p) { m[p.cat] = p.days; });
        return [String(r.year), r.days].concat(A.ORDER.map(function (n) { return m[n] || 0; })).concat([Math.round(r.okShare)]);
      })
    });
    figs.shares.draw = function (w) {
      var rowH = 38, bw = 20, pad = 1 - bw / rowH, ml = w < 480 ? 98 : 118, mr = 18;
      var plotW = w - ml - mr;
      var segs = [];
      sh.rows.forEach(function (r) {
        var key = String(r.year);
        r.parts.forEach(function (p) {
          var col = C.cat[p.cat];
          segs.push({ key: key, x1: p.x1, x2: p.x2, xm: (p.x1 + p.x2) / 2, color: col, tc: A.textOn(A.CATEGORY_COLORS[p.cat]), pct: p.pct, cat: p.cat, days: p.days, total: r.days, year: r.year });
        });
      });
      var wide = segs.filter(function (s) { return (s.x2 - s.x1) * plotW >= 40; });
      var labels = {}; sh.rows.forEach(function (r) { labels[String(r.year)] = r.year + ' (' + r.days + ' days)'; });
      var hgt = Math.round(rowH * (sh.rows.length + pad)) + 8 + 30;
      return Plot.plot(pBase(w, hgt, {
        marginTop: 4, marginBottom: 30, marginLeft: ml, marginRight: mr,
        x: { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], tickFormat: function (d) { return Math.round(d * 100) + '%'; }, label: null, tickSize: 0 },
        y: { domain: sh.rows.map(function (r) { return String(r.year); }), padding: pad, label: null, tickSize: 0, tickFormat: function (k) { return labels[k]; } },
        marks: [
          Plot.rectX(segs, { x1: 'x1', x2: 'x2', y: 'key', fill: 'color', insetLeft: 1, insetRight: 1 }),
          Plot.text(wide, { x: 'xm', y: 'key', text: function (s) { return Math.round(s.pct) + '%'; }, fill: 'tc', fontWeight: 600 }),
          Plot.tip(segs, Plot.pointer(merge(tipOpts(), { x: 'xm', y: 'key', title: function (s) { return s.year + '\n' + s.cat + ': ' + s.days + ' of ' + s.total + ' days (' + fix(s.pct, 1) + '%)'; } })))
        ]
      }));
    };

    // single-series line
    var worstBest = [yt.worst, yt.best];
    setFig('trend', {
      title: HL.trend,
      sub: 'Typical station AQI per year: the middle value of the stations’ yearly averages. Hollow dots rest on fewer than three stations' + (yt.single.length ? ' (a single station in ' + yt.single.join(', ') + ')' : '') + ', so compare them with care.',
      aria: 'Line chart of the typical station AQI per year from ' + yt.rows[0].year + ' to ' + yt.rows[yt.rows.length - 1].year + '. ' + HL.trend + '. A note marks 2024, when the measurement method changed.',
      head: ['Year', 'Typical station AQI', 'Stations'],
      rows: yt.rows.map(function (r) { return [String(r.year), Math.round(r.v * 10) / 10, r.n]; })
    });
    figs.trend.draw = function (w) {
      var rows = yt.rows.map(function (r) { return { year: r.year, v: r.v, n: r.n }; });
      var ymax = Math.ceil(Math.max.apply(null, rows.map(function (r) { return r.v; })) * 1.35 / 25) * 25;
      var ly = [yt.worst.year, yt.best.year, rows[rows.length - 1].year].filter(function (y, i, a) { return a.indexOf(y) === i; });
      var labelled = rows.filter(function (q) { return ly.indexOf(q.year) >= 0; });
      var x0 = rows[0].year, x1 = rows[rows.length - 1].year;
      return Plot.plot(pBase(w, Math.max(250, Math.min(320, w * 0.5)), {
        marginTop: 20, marginBottom: 28, marginLeft: 34, marginRight: 20,
        x: { domain: [x0 - 0.4, x1 + 0.4], ticks: rows.map(function (r) { return r.year; }), tickFormat: function (d) { return String(d); }, label: null, tickSize: 0 },
        y: { domain: [0, ymax], ticks: 5, label: null, tickSize: 0 },
        marks: [
          Plot.gridY({ stroke: C.grid, strokeOpacity: 1 }),
          Plot.ruleX([2024], { stroke: C.ink3, strokeOpacity: 0.6, strokeWidth: 1 }),
          Plot.text([{ x: 2024, y: ymax }], { x: 'x', y: 'y', text: function () { return '2024: measurement method changed'; }, textAnchor: 'end', dx: -6, dy: 4, lineAnchor: 'top', lineWidth: 11, fill: C.ink2 }),
          Plot.lineY(rows, { x: 'year', y: 'v', stroke: C.accent, strokeWidth: 2, strokeLinejoin: 'round' }),
          Plot.dot(rows.filter(function (r) { return r.n >= 3; }), { x: 'year', y: 'v', r: 4.5, fill: C.accent, stroke: C.paper, strokeWidth: 2 }),
          Plot.dot(rows.filter(function (r) { return r.n < 3; }), { x: 'year', y: 'v', r: 4.5, fill: C.paper, stroke: C.accent, strokeWidth: 2 }),
          Plot.text(labelled, { x: 'year', y: 'v', text: function (r) { return fix(r.v); }, dy: -10, lineAnchor: 'bottom', fill: C.ink, fontWeight: 600 }),
          Plot.tip(rows, Plot.pointerX(merge(tipOpts(), { x: 'year', y: 'v', title: function (r) { return r.year + '\nTypical station AQI ' + fix(r.v, 1) + '\nBased on ' + r.n + (r.n === 1 ? ' station' : ' stations'); } })))
        ]
      }));
    };
    $('#trend-caveat').textContent = ins && ins.caveat ? ins.caveat : '';
  }

  /* ------------------------------------------------------------------ diwali */
  function setupDiwali() {
    var dw = V.diwali(D.insights);
    var f = figs.diwali;
    if (!dw) { setFig('diwali', { title: 'Not enough data for Diwali', sub: '', aria: 'No data', head: ['Year'], rows: [] }); f.draw = function () { return msg('Not enough data around Diwali to compare.'); }; return; }
    $('#diwali-lede').textContent = 'Fireworks release a burst of fine particles. The chart compares city AQI over the Diwali days (the day before Lakshmi Puja to two days after) with the same city level two to three weeks earlier.';
    var HL = V.headlines(D);
    setFig('diwali', {
      title: HL.diwali,
      sub: 'City AQI before Diwali and over the Diwali days, for each year with enough data. The figure on the right is the change.',
      aria: 'Dumbbell chart for ' + dw.rows.length + ' years. ' + HL.diwali + '. ' + dw.rows.map(function (r) { return r.year + ': ' + r.before + ' before, ' + r.diwali + ' at Diwali'; }).join('; ') + '.',
      head: ['Year', 'Before Diwali (AQI)', 'Diwali days (AQI)', 'Change (%)'],
      rows: dw.rows.map(function (r) { return [String(r.year), r.before, r.diwali, Math.round(r.pct)]; })
    });
    $('#diwali-caveat').textContent = dw.caveat || '';
    f.draw = function (w) {
      var rowH = 46, bw = 8, pad = 1 - bw / rowH, mt = 30, mb = 28, mr = 62;
      var mx = Math.max.apply(null, dw.rows.map(function (r) { return Math.max(r.before, r.diwali); }));
      var top = Math.ceil(mx * 1.15 / 50) * 50;
      var rows = dw.rows.map(function (r) {
        var up = r.diwali >= r.before;
        return { key: String(r.year), before: r.before, diwali: r.diwali, pct: r.pct, up: up, lowX: Math.min(r.before, r.diwali), hiX: Math.max(r.before, r.diwali) };
      });
      var first = rows[0];
      function sgn(p) { return (p >= 0 ? '+' : '−') + Math.abs(Math.round(p)) + '%'; }
      var hgt = Math.round(rowH * (rows.length + pad)) + mt + mb;
      return Plot.plot(pBase(w, hgt, {
        marginTop: mt, marginBottom: mb, marginLeft: 44, marginRight: mr,
        x: { domain: [0, top], ticks: 5, label: null, tickSize: 0 },
        y: { domain: rows.map(function (r) { return r.key; }), padding: pad, label: null, tickSize: 0 },
        marks: [
          Plot.gridX({ stroke: C.grid, strokeOpacity: 1 }),
          Plot.ruleY(rows, { y: 'key', x1: 'before', x2: 'diwali', stroke: C.mute, strokeWidth: 3, strokeLinecap: 'round' }),
          Plot.dot(rows, { y: 'key', x: 'before', r: 6, fill: C.mute, stroke: C.paper, strokeWidth: 2 }),
          Plot.dot(rows, { y: 'key', x: 'diwali', r: 6, fill: C.accent, stroke: C.paper, strokeWidth: 2 }),
          // value labels sit outside the segment: lower value to the left, higher to the right
          Plot.text(rows, { y: 'key', x: 'lowX', text: function (r) { return String(r.up ? r.before : r.diwali); }, textAnchor: 'end', dx: -11, fill: C.ink }),
          Plot.text(rows, { y: 'key', x: 'hiX', text: function (r) { return String(r.up ? r.diwali : r.before); }, textAnchor: 'start', dx: 11, fill: C.ink }),
          // series names above the first row
          Plot.text([first], { y: 'key', x: first.up ? 'before' : 'diwali', text: function () { return first.up ? 'Weeks before' : 'Diwali'; }, textAnchor: 'end', dx: -4, dy: -22, fill: C.ink2, fontWeight: 600 }),
          Plot.text([first], { y: 'key', x: first.up ? 'diwali' : 'before', text: function () { return first.up ? 'Diwali' : 'Weeks before'; }, textAnchor: 'start', dx: 4, dy: -22, fill: C.ink2, fontWeight: 600 }),
          Plot.text(rows, { y: 'key', x: K(top), text: function (r) { return sgn(r.pct); }, textAnchor: 'start', dx: 12, fill: C.ink, fontWeight: 600 }),
          Plot.tip(rows, Plot.pointerY(merge(tipOpts(), { y: 'key', x: 'hiX', title: function (r) { return 'Diwali ' + r.key + '\nBefore: AQI ' + r.before + '\nDiwali days: AQI ' + r.diwali + '\nChange: ' + sgn(r.pct); } })))
        ]
      }));
    };
  }

  /* ------------------------------------------------------------------ drivers */
  function setupDrivers() {
    var dr = V.drivers(D.insights), f = figs.drivers;
    if (!dr) { setFig('drivers', { title: 'Pollutant data not available', sub: '', aria: 'No data', head: ['Pollutant'], rows: [] }); f.draw = function () { return msg('Pollutant data is not available.'); }; return; }
    var HL = V.headlines(D);
    $('#drivers-caveat').textContent = dr.caveat || '';
    var shown = dr.rows.filter(function (r) { return r.v >= 0.05; });
    setFig('drivers', {
      title: HL.drivers,
      sub: 'How often each pollutant was the one setting the hourly AQI (the dominant pollutant), ' + dr.period + ', all stations together.',
      aria: 'Bar chart of the share of hours each pollutant set the AQI. ' + shown.map(function (r) { return r.name + ' ' + fix(r.v) + ' percent'; }).join(', ') + '.',
      head: ['Pollutant', 'Share of hours (%)'],
      rows: dr.rows.map(function (r) { return [r.name, r.v]; })
    });
    f.draw = function (w) {
      var rows = shown.map(function (r) { return { key: r.key, name: r.name, value: r.v, color: C.accent, label: fix(r.v) + '%', tip: r.name + '\nSet the AQI ' + fix(r.v, 1) + '% of the time' }; });
      return rankBars(w, rows, { domain: [0, 100], ticks: [0, 25, 50, 75, 100], tickFormat: function (d) { return d + '%'; }, rowH: 40, marginRight: 60 });
    };
  }

  /* ------------------------------------------------------------------ explore */
  function seriesFor(key) { return key === CITY ? D.daily.city : D.daily.stations[key]; }
  function stationName(key) {
    if (key === CITY) return 'Pune (city median)';
    var s = (D.meta.stations || []).filter(function (x) { return x.id === key; })[0];
    return s ? s.name : key;
  }
  function yearsOf(key) {
    var set = {};
    A.seriesRows(seriesFor(key)).forEach(function (r) { if (r.v != null) set[r.date.slice(0, 4)] = 1; });
    return Object.keys(set).sort();
  }
  function yearRows(key, year) {
    var s = seriesFor(key), out = [], d0 = year + '-01-01', n = (Date.UTC(+year + 1, 0, 1) - Date.UTC(+year, 0, 1)) / A.DAY;
    var base = s && s.start ? F.parseISO(s.start) : null;
    for (var i = 0; i < n; i++) {
      var iso = F.addDays(d0, i), v = null;
      if (base != null) { var j = Math.round((F.parseISO(iso) - base) / A.DAY); if (j >= 0 && j < s.v.length && F.num(s.v[j])) v = s.v[j]; }
      out.push({ iso: iso, d: new Date(F.parseISO(iso)), v: v, cat: v == null ? null : catName(v) });
    }
    return out;
  }
  function yearLabel(y) { return +y === D.meta.partial_year ? y + ' (partial, to ' + F.fmtDay(D.meta.last) + ')' : y; }

  function setupExploreControls() {
    var sel = $('#x-station');
    sel.appendChild(h('option', { value: CITY, text: 'Pune (city median)' }));
    var og = {};
    ['Pune', 'Pimpri-Chinchwad'].forEach(function (g) { og[g] = h('optgroup', { label: g }); sel.appendChild(og[g]); });
    (D.meta.stations || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (s) {
      if (!D.daily.stations[s.id]) return;
      og[/\(PCMC\)/.test(s.locality) ? 'Pimpri-Chinchwad' : 'Pune'].appendChild(h('option', { value: s.id, text: s.name }));
    });
    sel.value = state.xStation;
    sel.addEventListener('change', function () { state.xStation = sel.value; syncYears(); renderExplore(); });
    $('#x-year').addEventListener('change', function () { state.xYear = this.value; renderExplore(); });
    $('#x-pol').addEventListener('change', function () { state.xPol = this.value; renderExplore(['pollutant']); });
    syncYears();
  }

  function syncYears() {
    var ys = yearsOf(state.xStation), sel = $('#x-year');
    clear(sel);
    ys.forEach(function (y) { sel.appendChild(h('option', { value: y, text: yearLabel(y) })); });
    if (ys.indexOf(String(state.xYear)) < 0) state.xYear = ys[ys.length - 1] || null;
    if (state.xYear) sel.value = state.xYear;
    syncPollutants();
  }
  function syncPollutants() {
    var sel = $('#x-pol'); clear(sel);
    var p = state.xStation === CITY ? null : D.pollutants && D.pollutants[state.xStation];
    if (!p) { sel.disabled = true; sel.appendChild(h('option', { text: state.xStation === CITY ? 'Choose a station first' : 'Not available' })); return; }
    var have = {};
    Object.keys(p).forEach(function (d) { Object.keys(p[d]).forEach(function (k) { have[k] = 1; }); });
    var list = POL_ORDER.filter(function (k) { return have[k]; });
    sel.disabled = !list.length;
    list.forEach(function (k) { sel.appendChild(h('option', { value: k, text: polName(k) })); });
    if (list.indexOf(state.xPol) < 0) state.xPol = list[0];
    if (state.xPol) sel.value = state.xPol;
  }

  function bands(top) {
    var out = [], lo = 0;
    cats().forEach(function (c) {
      var hi = Math.min(c.max, top);
      if (lo < top) out.push({ name: c.name, lo: lo, hi: hi, mid: (lo + hi) / 2, color: C.cat[c.name] });
      lo = c.max;
    });
    return out;
  }

  function setupExplore() {
    figs.daily.draw = function (w) {
      var st = state, rows = yearRows(st.xStation, st.xYear);
      var vs = rows.filter(function (r) { return r.v != null; });
      if (!vs.length) return msg('No data for this selection.');
      var last = vs[vs.length - 1].iso;
      rows = rows.filter(function (r) { return r.iso <= last; });
      var top = Math.min(500, Math.max(200, Math.ceil(Math.max.apply(null, vs.map(function (r) { return r.v; })) * 1.1 / 50) * 50));
      var plotH = Math.max(260, Math.min(360, w * 0.5)), innerH = plotH - 36;
      var bs = bands(top), x0 = rows[0].d, x1 = rows[rows.length - 1].d;
      var iso = rows.map(function (r) { return r.v != null; });
      var lone = rows.filter(function (r, i) { return r.v != null && !(i > 0 && iso[i - 1]) && !(i < rows.length - 1 && iso[i + 1]); });
      var ticks = [50, 100, 200, 300, 400, 500].filter(function (t) { return t <= top; });
      return Plot.plot(pBase(w, plotH, {
        marginTop: 8, marginBottom: 28, marginLeft: 34, marginRight: 12,
        x: { type: 'utc', domain: [x0, x1], label: null, tickSize: 0, ticks: w < 520 ? 4 : 8 },
        y: { domain: [0, top], ticks: ticks, label: null, tickSize: 0 },
        marks: [
          Plot.rectY(bs, { x1: K(x0), x2: K(x1), y1: 'lo', y2: 'hi', fill: 'color', fillOpacity: 0.16 }),
          Plot.text(bs.filter(function (b) { return (b.hi - b.lo) / top * innerH >= 15; }), { x: K(x0), y: 'mid', text: 'name', textAnchor: 'start', dx: 6, fill: C.ink3, fontSize: 11 }),
          Plot.lineY(rows, { x: 'd', y: 'v', stroke: C.ink, strokeWidth: 1.5, strokeLinejoin: 'round' }),
          Plot.dot(lone, { x: 'd', y: 'v', r: 2, fill: C.ink }),
          Plot.ruleX(vs, Plot.pointerX({ x: 'd', stroke: C.ink3, strokeOpacity: 1 })),
          Plot.tip(vs, Plot.pointerX(merge(tipOpts(), { x: 'd', y: 'v', title: function (r) { return F.fmtDate(r.iso) + '\nAQI ' + r.v + ' · ' + r.cat; } })))
        ]
      }));
    };
    figs.calendar.draw = function (w) {
      var rows = yearRows(state.xStation, state.xYear).filter(function (r) { return r.iso <= D.meta.last; });
      if (!rows.some(function (r) { return r.v != null; })) return msg('No data for this selection.');
      var jan1 = F.parseISO(state.xYear + '-01-01'), off = (new Date(jan1).getUTCDay() + 6) % 7;
      var cells = rows.map(function (r, i) {
        return { week: Math.floor((i + off) / 7), wd: (off + i) % 7, iso: r.iso, v: r.v, cat: r.cat, color: r.v == null ? C.nodata : aqiColor(r.v) };
      });
      var nW = cells[cells.length - 1].week + 1, weeks = [];
      for (var i = 0; i < nW; i++) weeks.push(i);
      var monthAt = {};
      for (var m = 0; m < 12; m++) {
        var iso = state.xYear + '-' + (m < 9 ? '0' : '') + (m + 1) + '-01';
        var c = cells.filter(function (q) { return q.iso === iso; })[0];
        if (c) monthAt[c.week] = A.MON3[m];
      }
      var ml = 34, avail = f_w(figs.calendar), cs = Math.max(12, Math.min(22, Math.floor((avail - ml - 6) / nW)));
      var width = ml + cs * nW + 6, hgt = cs * 7 + 26 + 4;
      return Plot.plot(pBase(width, hgt, {
        marginTop: 24, marginBottom: 4, marginLeft: ml, marginRight: 6,
        x: { domain: weeks, axis: 'top', label: null, tickSize: 0, padding: 0, tickFormat: function (k) { return monthAt[k] || ''; } },
        y: { domain: [0, 1, 2, 3, 4, 5, 6], label: null, tickSize: 0, padding: 0, tickFormat: function (d) { return ['Mon', '', 'Wed', '', 'Fri', '', ''][d]; } },
        marks: [
          Plot.cell(cells, { x: 'week', y: 'wd', fill: 'color', inset: 1 }),
          Plot.tip(cells, Plot.pointer(merge(tipOpts(), { x: 'week', y: 'wd', title: function (c) { return F.weekday(c.iso) + ' ' + F.fmtDate(c.iso) + '\n' + (c.v == null ? 'No data' : 'AQI ' + c.v + ' · ' + c.cat); } })))
        ]
      }));
    };
    function f_w(f) { return Math.max(300, f.root.clientWidth || 900); }

    figs.pollutant.draw = function (w) {
      var key = state.xStation, p = state.xPol;
      if (key === CITY) return msg('Pollutant readings are recorded by station. Choose a station above to see them.');
      var pd = D.pollutants && D.pollutants[key];
      if (!pd || !p) return msg('No pollutant readings for this station.');
      var rows = yearRows(key, state.xYear).map(function (r) { var o = pd[r.iso]; return { iso: r.iso, d: r.d, v: o && F.num(o[p]) ? o[p] : null }; });
      var vs = rows.filter(function (r) { return r.v != null; });
      if (!vs.length) return msg('No ' + polName(p) + ' readings at ' + stationName(key) + ' in ' + state.xYear + '. Pollutant detail exists only from 2024.');
      var last = vs[vs.length - 1].iso; rows = rows.filter(function (r) { return r.iso <= last; });
      var lim = POL_LIM[p], vmax = Math.max.apply(null, vs.map(function (r) { return r.v; }));
      var ymax = Math.max(vmax, lim ? lim.ind : 0) * 1.12;
      var ref = lim ? [{ y: lim.ind, t: 'Indian 24-h limit: ' + lim.ind + ' µg/m³', c: C.ink }, { y: lim.who, t: 'WHO guideline: ' + lim.who + ' µg/m³', c: C.ink3 }] : [];
      var x0 = rows[0].d, x1 = rows[rows.length - 1].d;
      var u = unit(p);
      return Plot.plot(pBase(w, Math.max(260, Math.min(340, w * 0.5)), {
        marginTop: 10, marginBottom: 28, marginLeft: 40, marginRight: 12,
        x: { type: 'utc', domain: [x0, x1], label: null, tickSize: 0, ticks: w < 520 ? 4 : 8 },
        y: { domain: [0, ymax], label: null, tickSize: 0, ticks: yTicks(ymax) },
        marks: [
          Plot.gridY({ stroke: C.grid, strokeOpacity: 1, ticks: yTicks(ymax) }),
          Plot.ruleY(ref, { y: 'y', stroke: function (r) { return r.c; }, strokeWidth: 1 }),
          Plot.text(ref, { x: K(x0), y: 'y', text: 't', textAnchor: 'start', dx: 4, dy: -4, lineAnchor: 'bottom', fill: C.ink }),
          Plot.lineY(rows, { x: 'd', y: 'v', stroke: C.accent, strokeWidth: 1.5, strokeLinejoin: 'round' }),
          Plot.dot(rows.filter(function (r, i) { return r.v != null && !(i > 0 && rows[i - 1].v != null) && !(i < rows.length - 1 && rows[i + 1].v != null); }), { x: 'd', y: 'v', r: 2, fill: C.accent }),
          Plot.ruleX(vs, Plot.pointerX({ x: 'd', stroke: C.ink3, strokeOpacity: 1 })),
          Plot.tip(vs, Plot.pointerX(merge(tipOpts(), { x: 'd', y: 'v', title: function (r) { return F.fmtDate(r.iso) + '\n' + polName(p) + ' ' + fix(r.v, p === 'co' ? 2 : 1) + ' ' + u; } })))
        ]
      }));
    };
    renderExplore();
    renderGrid();
  }

  function renderExplore(only) {
    var key = state.xStation, year = state.xYear, nm = stationName(key);
    if (!year) {
      ['daily', 'calendar', 'pollutant'].forEach(function (id) { setFig(id, { title: 'No data for this station', sub: '', aria: 'No data', head: ['Date'], rows: [] }); figs[id].draw = function () { return msg('No data for this selection.'); }; redraw(id); });
      return;
    }
    var rows = yearRows(key, year).filter(function (r) { return r.iso <= D.meta.last; });
    var vs = rows.filter(function (r) { return r.v != null; });
    var avg = vs.length ? F.mean(vs.map(function (r) { return r.v; })) : null;
    var worst = vs.reduce(function (a, b) { return !a || b.v > a.v ? b : a; }, null);
    var ptxt = year === String(D.meta.partial_year) ? ' so far' : '';
    var dailyTbl = rows.map(function (r) { return [F.fmtDate(r.iso), r.v == null ? 'No data' : r.v, r.cat || '']; });
    if (!only) {
      if (vs.length) {
        var ok = vs.filter(function (r) { return r.v <= 100; }).length;
        setFig('daily', {
          title: nm + ' in ' + year + ': ' + Math.round(ok / vs.length * 100) + '% of days with data were Good or Satisfactory' + ptxt,
          sub: 'Daily AQI. The worst day was ' + F.fmtDate(worst.iso) + ' (AQI ' + worst.v + ', ' + worst.cat + '). Average of days with data: ' + fix(avg) + ' (' + catName(avg) + '). Days with data: ' + vs.length + ' of ' + rows.length + '. Breaks in the line are days with no data.',
          aria: 'Line chart of daily AQI at ' + nm + ' in ' + year + '. Average ' + fix(avg) + ', worst day ' + F.fmtDate(worst.iso) + ' at ' + worst.v + '.',
          head: ['Date', 'AQI', 'Category'], rows: dailyTbl
        });
        setFig('calendar', {
          title: 'Every day of ' + year + ' at ' + nm + ', one square per day',
          sub: 'Each column is a week and each row a day of the week. Squares are coloured by that day’s AQI category; grey means no data. Scroll sideways if the chart is wider than your screen.',
          aria: 'Calendar heat map of daily AQI at ' + nm + ' in ' + year + '. ' + vs.length + ' of ' + rows.length + ' days have data. The data table lists every day.',
          head: ['Date', 'Weekday', 'AQI', 'Category'], rows: rows.map(function (r) { return [F.fmtDate(r.iso), F.weekday(r.iso), r.v == null ? 'No data' : r.v, r.cat || '']; })
        });
      } else {
        setFig('daily', { title: nm + ' has no data in ' + year, sub: '', aria: 'No data', head: ['Date'], rows: [] });
        setFig('calendar', { title: nm + ' has no data in ' + year, sub: '', aria: 'No data', head: ['Date'], rows: [] });
      }
    }
    // pollutant
    var pd = key !== CITY && D.pollutants ? D.pollutants[key] : null, p = state.xPol;
    if (!pd || !p) {
      setFig('pollutant', { title: 'Pollutant readings by station', sub: 'Choose a station above. Pollutant detail is available from 2024.', aria: 'No pollutant chart: choose a station.', head: ['Date'], rows: [] });
    } else {
      var prow = rows.map(function (r) { var o = pd[r.iso]; return { iso: r.iso, v: o && F.num(o[p]) ? o[p] : null }; });
      var pv = prow.filter(function (r) { return r.v != null; }), lim = POL_LIM[p], u = unit(p);
      var t = polName(p) + ' at ' + nm + ' in ' + year;
      if (pv.length && lim) {
        var a = pv.filter(function (r) { return r.v > lim.ind; }).length, b = pv.filter(function (r) { return r.v > lim.who; }).length;
        t += ': ' + a + ' of ' + pv.length + ' days above the Indian limit, ' + b + ' above the WHO guideline';
      }
      setFig('pollutant', {
        title: t,
        sub: 'Daily average of ' + polName(p) + ' in ' + u + (lim ? '. Lines mark the Indian 24-hour limit and the WHO guideline.' : '. No standard line is drawn for this pollutant.') + ' Some stations report gases on different scales, so compare particles (PM2.5, PM10) with more confidence than gases.',
        aria: 'Line chart of daily ' + polName(p) + ' at ' + nm + ' in ' + year + (pv.length ? '. ' + pv.length + ' days with data.' : '. No data.'),
        head: ['Date', polName(p) + ' (' + u + ')'], rows: pv.map(function (r) { return [F.fmtDate(r.iso), r.v]; })
      });
    }
    (only || ['daily', 'calendar', 'pollutant']).forEach(redraw);
    if (!only) renderGrid();
  }

  function renderGrid() {
    var f = figs.grid; if (!f) return;
    var sy = D.summary.station_year, years = {};
    Object.keys(sy).forEach(function (k) { Object.keys(sy[k]).forEach(function (y) { years[y] = 1; }); });
    var ys = Object.keys(years).sort();
    var meta = {}; (D.meta.stations || []).forEach(function (s) { meta[s.id] = s; });
    var ids = Object.keys(sy).filter(function (k) { return Object.keys(sy[k]).length; });
    var n = 0; ids.forEach(function (k) { n += Object.keys(sy[k]).length; });
    setFig('grid', {
      title: 'Average AQI by station and year: ' + n + ' station-years have enough data',
      sub: 'Each cell is a station’s average daily AQI for a full year, coloured by CPCB category. A blank cell means the station did not have enough valid days (at least ' + D.meta.rules.min_days_year + ') that year. Compare down a column, not across a row, because stations joined at different times.'
    });
    clear(f.plotEl);
    var table = h('table', { class: 'grid-table' });
    table.appendChild(h('caption', { class: 'sr-only', text: 'Average AQI by station and year' }));
    table.appendChild(h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Station' })].concat(ys.map(function (y) { return h('th', { scope: 'col', class: 'n', text: y }); })))]));
    var tb = h('tbody');
    ['Pune', 'Pimpri-Chinchwad'].forEach(function (g) {
      var members = ids.filter(function (k) { return (/\(PCMC\)/.test((meta[k] || {}).locality || '') ? 'Pimpri-Chinchwad' : 'Pune') === g; })
        .sort(function (a, b) { return (meta[a] ? meta[a].name : a).localeCompare(meta[b] ? meta[b].name : b); });
      if (!members.length) return;
      tb.appendChild(h('tr', { class: 'grp' }, [h('th', { colspan: String(ys.length + 1), text: g })]));
      members.forEach(function (k) {
        var tr = h('tr', { class: k === state.xStation ? 'sel' : '' }, [h('td', null, [stationName(k)])]);
        ys.forEach(function (y) {
          var r = sy[k][y];
          if (!r) { tr.appendChild(h('td', { class: 'cell', 'aria-label': 'No data' })); return; }
          var c = catName(r.mean), col = C.cat[c];
          tr.appendChild(h('td', { class: 'cell', style: 'background:' + col + ';color:' + A.textOn(A.CATEGORY_COLORS[c]), title: stationName(k) + ', ' + y + ': ' + fix(r.mean) + ', ' + c }, [fix(r.mean), h('span', { class: 'sr-only', text: ' ' + c })]));
        });
        tb.appendChild(tr);
      });
    });
    table.appendChild(tb);
    f.plotEl.appendChild(h('div', { class: 'scroll-x' }, [table]));
    f.plotEl.appendChild(legendEl(false));
    f.draw = null; // static table, nothing to redraw on resize
  }

  /* ------------------------------------------------------------------ forecast */
  function setupForecast() {
    var f = figs.forecast;
    f.draw = function (w) {
      if (state.liveError) return msg('The model estimate is unavailable right now because the Open-Meteo service could not be reached. Everything else on this page is unaffected.');
      if (!state.live) return msg('Loading the model estimate…');
      var fc = V.forecast(state.live, istToday());
      if (!fc.all.length) return msg('The model returned too few hourly values to compute an AQI.');
      var dates = fc.all.map(function (d) { return d.date; });
      var rows = fc.all.map(function (d) { return { date: d.date, v: d.aqi, color: aqiColor(d.aqi), fut: d.date > istToday(), cat: catName(d.aqi), dom: d.dominant }; });
      var firstFut = rows.filter(function (r) { return r.fut; })[0];
      var step = (w - 46) / rows.length;
      var lab = rows.filter(function (r, i) {
        var lastPast = i === rows.length - fc.future.length - 1, lastFut = i === rows.length - 1;
        return step >= 26 ? (r.fut || lastPast) : (lastPast || lastFut);
      });
      var ymax = Math.ceil(Math.max.apply(null, rows.map(function (r) { return r.v; })) * 1.3 / 50) * 50;
      return Plot.plot(pBase(w, Math.max(260, Math.min(340, w * 0.5)), {
        marginTop: 34, marginBottom: 28, marginLeft: 34, marginRight: 12,
        x: { domain: dates, label: null, tickSize: 0, padding: 0.3, tickFormat: function (d) { var i = dates.indexOf(d); return (dates.length - 1 - i) % 7 === 0 ? F.fmtDay(d) : ''; } },
        y: { domain: [0, ymax], ticks: 5, label: null, tickSize: 0 },
        marks: [
          Plot.gridY({ stroke: C.grid, strokeOpacity: 1 }),
          Plot.barY(rows, { x: 'date', y: 'v', fill: 'color', fillOpacity: function (r) { return r.fut ? 0.55 : 1; }, rx: 1.5 }),
          Plot.ruleY([0], { stroke: C.ink3 }),
          firstFut ? Plot.ruleX([firstFut.date], { stroke: C.ink3, strokeOpacity: 1, dx: -3 }) : null,
          firstFut ? Plot.text([rows[rows.length - 1]], { x: 'date', y: K(ymax), text: function () { return 'Forecast'; }, textAnchor: 'end', dx: 4, dy: -8, lineAnchor: 'bottom', fill: C.ink2, fontWeight: 600 }) : null,
          Plot.text(lab, { x: 'date', y: 'v', text: function (r) { return String(r.v); }, dy: -6, lineAnchor: 'bottom', fill: C.ink, fontWeight: 600 }),
          Plot.tip(rows, Plot.pointerX(merge(tipOpts(), { x: 'date', y: 'v', title: function (r) { return F.weekday(r.date) + ' ' + F.fmtDate(r.date) + (r.fut ? ' (forecast)' : '') + '\nModel AQI ' + r.v + ' · ' + r.cat + (r.dom ? '\nMain pollutant: ' + A.POLLUTANT_PLAIN[r.dom] : ''); } })))
        ].filter(Boolean)
      }));
    };
    renderForecastMeta();
    fetch(LIVE_URL).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
      if (!j.hourly || !j.hourly.time) throw new Error('unexpected response');
      state.live = A.computeDaily(j.hourly);
      renderForecastMeta(); redraw('forecast');
    }).catch(function (e) {
      if (window.console) console.error("forecast", e); state.liveError = true; renderForecastMeta(); redraw("forecast");
    });
  }
  function renderForecastMeta() {
    var fc = state.live ? V.forecast(state.live, istToday()) : null;
    var title = 'Computer-model estimate of AQI, last 30 days and next three';
    if (fc && fc.future.length) {
      var vs = fc.future.map(function (d) { return d.aqi; }), lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
      var cl = catName(lo), ch = catName(hi);
      title = 'The model expects ' + (lo === hi ? 'AQI ' + lo : 'AQI of ' + lo + '–' + hi) + ' over the next ' + fc.future.length + ' days (' + (cl === ch ? cl : cl + ' to ' + ch) + ')';
    }
    setFig('forecast', {
      title: title,
      sub: 'A model estimate, not a measurement. It can miss local events such as fireworks, and it often differs from the station readings at the top of this page. Lighter bars are forecasts.',
      aria: fc && fc.all.length ? 'Bar chart of model-estimated daily AQI for ' + fc.all.length + ' days, ending with ' + fc.future.length + ' forecast days. ' + title + '.' : 'Model estimate chart is not available.',
      head: ['Date', 'Model AQI', 'Category', 'Type'],
      rows: fc ? fc.all.map(function (d) { return [F.fmtDate(d.date), d.aqi, catName(d.aqi), d.date > istToday() ? 'Forecast' : 'Estimate']; }) : []
    });
  }

  /* ------------------------------------------------------------------ about */
  function renderAbout() {
    var root = $('#about-body'); clear(root);
    var m = D.meta, L = D.latest;
    function det(title, kids) { return h('details', null, [h('summary', { text: title }), h('div', null, kids)]); }
    function link(u, t) { return h('a', { href: u, rel: 'noopener', text: t || u }); }

    var src = [
      h('p', null, ['History: ', m.source.name, ' (', link(m.source.url, 'dataset page'), '). Licence: ' + m.source.license + '.']),
    ];
    if (m.supplement) src.push(h('p', null, ['Recent months: ', m.supplement.name, ' (', link(m.supplement.url, 'openaq.org'), ') from ' + F.fmtDate(m.supplement.from_) + '. Licence: ' + m.supplement.license + '.']));
    if (L) src.push(h('p', { text: 'Right now: ' + (L.source || 'CPCB station readings') + ', refreshed automatically.' }));
    src.push(h('p', { text: 'Model estimate: Copernicus CAMS atmospheric model, served by Open-Meteo.' }));
    src.push(h('p', { text: 'The data was last processed on ' + F.fmtDate(m.generated) + '. History runs from ' + F.fmtDate(m.first) + ' to ' + F.fmtDate(m.last) + '.' }));

    var how = [
      h('p', { text: 'The AQI follows the CPCB National Air Quality Index. Each pollutant is averaged over 24 hours (carbon monoxide and ozone use their highest 8-hour average). Each average is turned into a sub-index from 0 to 500. The AQI is the highest sub-index, and at least three pollutants must be measured, including PM2.5 or PM10.' }),
      h('p', { text: 'The city figure is the median of the stations: half of them read higher and half lower.' })
    ];
    if (L && L.method) how.push(h('p', { class: 'muted', text: 'Method note from the live feed: ' + L.method }));

    var r = m.rules;
    var rules = h('ul', { class: 'prose-list' }, [
      h('li', { text: 'A day counts for a station only if it has at least ' + r.min_hours + ' valid hours.' }),
      h('li', { text: 'A station-year counts only if it has at least ' + r.min_days_year + ' valid days.' }),
      h('li', { text: 'A city-wide daily value needs at least ' + r.min_stations_city + ' stations reporting that day.' }),
      h('li', { text: 'A station-month is excluded if its average is ' + r.qc_ratio + ' times the median of the other stations in the same month or more (likely a faulty sensor).' })
    ]);

    var nm = {}; (m.stations || []).forEach(function (s) { nm[s.id] = s.name; });
    var qc = m.qc_excluded && m.qc_excluded.length
      ? [h('p', { text: 'These station-months were left out because they read implausibly high compared with other stations.' }),
         h('div', { class: 'scroll-x' }, [tableEl(['Station', 'Month', 'Station average', 'Other stations (median)', 'Ratio'], m.qc_excluded.map(function (q) { return [nm[q.station] || q.station, F.fmtMonthYear(q.month), q.mean, q.others_median, q.ratio]; }))])]
      : [h('p', { text: 'No station-months were excluded.' })];

    var partial = m.partial_year
      ? [h('p', { text: m.partial_year + ' is a partial year: data runs only to ' + F.fmtDate(m.last) + '. It is left out of year-level comparisons (the yearly averages and the days-per-category chart). It still appears in the daily charts and the month and hour averages.' })]
      : [h('p', { text: 'The latest year is complete.' })];

    var years = {}; (m.stations || []).forEach(function (s) { Object.keys(s.days_by_year).forEach(function (y) { years[y] = 1; }); });
    var ys = Object.keys(years).sort();
    var cov = h('table', { class: 'grid-table' }, [
      h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Station' })].concat(ys.map(function (y) { return h('th', { scope: 'col', class: 'n', text: y }); })))]),
      h('tbody', null, (m.stations || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (s) {
        return h('tr', null, [h('td', { text: s.name })].concat(ys.map(function (y) {
          var d = s.days_by_year[y];
          return d ? h('td', { class: 'cell cov', style: '--p:' + Math.min(55, Math.round(d / 366 * 55)) + '%', text: String(d) }) : h('td', { class: 'cell', text: '' });
        })));
      }))
    ]);

    var gaps = h('ul', { class: 'prose-list' }, [
      h('li', { text: 'No open data exists before ' + F.fmtMonthYear(m.first.slice(0, 7)) + '.' }),
      h('li', { text: 'A city-wide daily value is available only from ' + (D.daily && D.daily.city.start ? F.fmtDate(D.daily.city.start) : 'late 2020') + ', when enough stations were reporting.' }),
      h('li', { text: 'Stations joined and left at different times, so the set of stations changes from year to year.' }),
      h('li', { text: 'Individual pollutant readings (PM2.5, PM10 and so on) exist only from 2024. Earlier years have the AQI only.' }),
      h('li', { text: 'From 2024 the AQI is calculated from raw pollutant readings; earlier years use the AQI published by the monitoring agency. This is why year-to-year changes are only indicative.' })
    ]);

    [
      det('Sources and licences', src),
      det('How the AQI is calculated', how),
      det('Rules for what counts', [rules]),
      det('Readings left out after quality checks', qc),
      det('The partial year', partial),
      det('How many days of data each station has, by year', [h('p', { class: 'muted', text: 'Number of valid days per station per year. Darker means more days.' }), h('div', { class: 'scroll-x' }, [cov])]),
      det('Known gaps', [gaps])
    ].forEach(function (d) { root.appendChild(d); });
  }

  /* ------------------------------------------------------------------ theme */
  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeBtn() {
    var b = $('#theme-btn'), dark = effectiveTheme() === 'dark';
    b.textContent = dark ? 'Light mode' : 'Dark mode';
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
  function themeChanged() { readColors(); syncThemeBtn(); redrawAll(); }
  function setupTheme() {
    syncThemeBtn();
    $('#theme-btn').addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pune-aqi-theme', next); } catch (e) { /* storage unavailable */ }
      themeChanged();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var fn = function () { if (!document.documentElement.getAttribute('data-theme')) themeChanged(); };
      if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
    }
  }

  /* ------------------------------------------------------------------ boot */
  function load(name, bust) {
    return fetch('data/' + name + '.json' + (bust ? '?t=' + Math.floor(Date.now() / 300000) : '')).then(function (r) {
      if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
      return r.json();
    }).catch(function (e) { if (window.console) console.error(e); return null; });
  }

  var started = false;
  function init() {
    if (started) return; started = true;
    readColors(); mountFigures(); setupTheme();
    Promise.all(['meta', 'daily', 'summary', 'insights', 'pollutants'].map(function (n) { return load(n); }).concat([load('latest', true)])).then(function (r) {
      D.meta = r[0]; D.daily = r[1]; D.summary = r[2]; D.insights = r[3]; D.pollutants = r[4]; D.latest = r[5];
      if (!D.meta || !D.summary) {
        $('#hero-body').appendChild(h('div', { class: 'callout warn' }, [h('p', { text: 'The data files could not be loaded. Please reload the page.' })]));
        return;
      }
      safe(renderHero, 'hero');
      if (D.latest) { safe(setupPicker, 'picker'); safe(setupStations, 'stations'); }
      else { figs.stations.root.hidden = true; $('#sel-station').disabled = true; }
      safe(setupWhen, 'when'); safe(setupAreas, 'areas'); safe(setupTrend, 'trend'); safe(setupDiwali, 'diwali'); safe(setupDrivers, 'drivers');
      if (D.daily) { safe(setupExploreControls, 'explore controls'); safe(setupExplore, 'explore'); }
      safe(setupForecast, 'forecast'); safe(renderAbout, 'about');
      redrawAll();
      setupResize();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.PuneAQI = { redrawAll: redrawAll, figs: figs, state: state, data: D };
})();
