# Pune Air Quality Explorer

A static, no-login website exploring Pune's air quality:

- **Live now:** the official CPCB AQI from 17 Pune / Pimpri-Chinchwad monitoring stations, refreshed hourly, plus a model trend and 3-day forecast (Open-Meteo / Copernicus CAMS);
- station-level daily AQI from Dec 2017 to a few days ago, a city median series, calendar heatmaps;
- year-over-year trends, region comparisons, seasonal and time-of-day patterns, pollutant concentrations since 2024, and insights computed from the data.

Plain HTML/CSS/JavaScript, no build step. The only external library is Chart.js 4.4.1 (from cdnjs). Every number shown comes from `site/data/*.json` or the Open-Meteo API. Data scripts use only the Python standard library.

## Run locally

```
cd site
python -m http.server 8000
```

Then open http://localhost:8000 (opening `index.html` from disk will not work).

## Data pipeline

| Script | What it does |
|---|---|
| `tools/download_cpcb.py raw` | Downloads the CPCB station CSVs 2017–2025 from [data.opencity.in](https://data.opencity.in/dataset/pune-hourly-air-quality-reports) |
| `tools/fetch_openaq.py raw` | Adds 2026+ readings (and the 4 PCMC stations) from OpenAQ's public archive |
| `tools/process.py raw site/data` | Builds all history JSON and the insights |
| `tools/fetch_latest.py site/data` | Writes `latest.json`: current official AQI per station (run hourly) |

`fetch_openaq.py` and `fetch_latest.py` need a free OpenAQ API key (https://explore.openaq.org/register) in the env var `OPENAQ_API_KEY` or a file `openaq.key` (git-ignored). The key is never sent to the browser.

Refresh everything by hand:

```
python tools/download_cpcb.py raw
python tools/fetch_openaq.py raw
python tools/process.py raw site/data
python tools/fetch_latest.py site/data
```

## Publish on GitHub Pages (automatic hourly updates)

`.github/workflows/update.yml` runs every hour: it fetches the latest station AQI and deploys `site/` to GitHub Pages. Once a day (02:xx UTC) it also rebuilds the history and commits the updated JSON.

1. Create a GitHub repository and push this folder (`raw/` and `openaq.key` are git-ignored).
2. Repository **Settings → Secrets and variables → Actions → New repository secret**: name `OPENAQ_API_KEY`, value = your key.
3. **Settings → Pages → Source: GitHub Actions**.
4. **Actions → Update data and deploy → Run workflow** (tick "full refresh" the first time).

Note: GitHub may delay scheduled runs at busy times, and pauses schedules in repositories with no activity for 60 days (the daily data commit counts as activity). The site shows when the station data was last updated and warns if it is more than 3 hours old.

## Caveats

- **Live AQI is a 24-hour average** (CPCB method). After a short spike such as Diwali fireworks it stays high for up to a day, even when the air now is cleaner; the last-hour PM2.5 is shown per station. Sites showing an instant or US-scale AQI give different numbers.
- **Method change in 2024:** 2017–23 files publish hourly AQI; from 2024 the AQI is computed from pollutant concentrations.
- **OpenAQ values** are CPCB's own numbers (verified hour-by-hour against the CPCB 2025 files); OpenAQ's unit labels for gases are wrong and are ignored.
- **Quality check:** station-months ≥2.5× the other stations' median are excluded as likely sensor faults (listed on the site).
- **City median** needs at least 3 stations, so it starts in late 2020. No open station data exists for 2016 or earlier. The current, incomplete year is left out of yearly rankings.

## Credits

Data: CPCB, MPCB, IITM (via data.opencity.in, public domain; and OpenAQ, CC BY 4.0). Model estimates: Open-Meteo and Copernicus Atmosphere Monitoring Service (CAMS).
