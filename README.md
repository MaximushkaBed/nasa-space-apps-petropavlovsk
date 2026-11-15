# Harmonization of MODIS and VIIRS Hot Spots

Project workspace for the NASA International Space Apps Challenge 2026 in Petropavlovsk, Kazakhstan.

Selected challenge: **Harmonization of MODIS and VIIRS Hot Spots**.

Local challenge label supplied by the team: `15 - Harmonization of MODIS and VIIRS Hot Spots_4.3`.

The repository includes a NASA FIRMS downloader, a global historical archive, and an interactive temporal-analysis web application.

The project scope is **global**. North Kazakhstan Region (Северо-Казахстанская область, СКО) is the existing validation case; the USA, Brazil and Canada are planned independent research/validation regions. Large datasets will live on the shared `unik` server.

## Web MVP

The [development goal](docs/development-goal.md) defines the ordered worldwide
study journey. The [study planner](docs/study-planner.md) proposes comparison
conditions before computation and assesses their suitability against the completed
regional result; the existing atlas, calendar, maps and exports remain its tools.

Shared-server deployment, global dataset paths and Komodo autodeploy are documented in [deploy/README.md](deploy/README.md). Large world archives are downloaded on `unik`, not on the laptop.

The application shares a persistent header and study context across Atlas, Area Analysis and Cases. It selects an exact area and dates, builds a years-by-month calendar and weekly seasonal profile, compares years, maps monthly deviations, and exports CSV, JSON and SVG. A bounded asynchronous API queries real archive files on the shared server. See [workbench/API documentation](docs/workbench.md) for setup, units, validation and current scientific limits.

[Global factor matrices](docs/global-matrix.md) calculate numerical weather and landscape relationships for the selected territory using ERA5, WorldCover, GLO-90 and GeoNames. They preserve missing values, pair counts and source provenance; the separate fixed SKO study is retained.

Oksana's full-screen atlas and case studies are integrated into the shared application. Existing `/atlas.html` links redirect to the corresponding view and preserve case anchors. A static local server can preview the interface; live analysis requires the API. See the [atlas documentation](web/README.md).

## Research

[Global data sources and methodology notes (RU)](docs/global-data/README.md) preserves the team's worldwide source inventory, distinctions between detections/events/burned area, and proposed cross-region validation plan. Unverified source versions and archive availability are marked explicitly.

[Full Russian translation of the challenge and explanatory video](docs/challenge/README.md) includes the team's original DOCX and implementation notes.

[MODIS and VIIRS harmonization research and findings (RU)](docs/modis-viirs-research.md) covers FIRMS data access, the June 2023 Semey Ormany case study, and a proposed validation and MVP plan for North Kazakhstan Region.

[North Kazakhstan validation, 2020–2025 (RU)](docs/sko-validation/README.md) reports out-of-sample errors for two VIIRS platforms, the effect of documented outages, and how to reproduce the results.

## Next steps

1. Register each participant on the official Space Apps website and select the local event.
2. Register the team with the selected challenge.
3. Define a focused prototype for harmonizing MODIS and VIIRS hotspot observations.
4. Build the prototype, document data sources and any AI tools used, and prepare the submission.

## Official resources

- [2026 NASA Space Apps Challenge](https://www.spaceappschallenge.org/2026/)
- [2026 challenges](https://www.spaceappschallenge.org/2026/challenges/)
- [Selected challenge](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/)
- [Participant resources](https://www.spaceappschallenge.org/resources/)
- [Participant terms and conditions](https://www.spaceappschallenge.org/legal/)
- [Petropavlovsk event announcement — SKO Hub](https://astanahub.com/ru/event/nasa-space-apps-challenge/)

## Development

The downloader requires Python 3.10 or newer and no external packages.

1. Obtain a free [FIRMS MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
2. Copy `.env.example` to `.env` and fill in `FIRMS_MAP_KEY`. An environment variable with the same name takes precedence.
3. Run a download for North Kazakhstan Region:

```bash
python3 scripts/fetch_firms.py \
  --region sko \
  --start 2024-07-01 \
  --end 2024-07-10 \
  --sources MODIS_SP VIIRS_SNPP_SP
```

Dates are inclusive. The script splits the period into requests of at most five days, then writes one CSV per source into `data/raw/firms/sko/`. It queries the polygon's bounding box and keeps observations whose centre coordinates fall inside or on the boundary of the region. Original NASA columns and values are preserved. The output is input for future harmonization; the downloader does not harmonize sensors.

The region boundary comes from geoBoundaries, with reference year **2017**; it has not been verified against the current official boundary. See [boundary provenance and ODbL attribution](data/boundaries/README.md).

For another rectangle, use `--bbox west,south,east,north` instead of `--region sko`, for example `--bbox 68,54,71,56`. These unfiltered exports are saved directly into `data/raw/firms/`. A custom `--output-dir` overrides either default directory.

For recent observations, select sources such as `MODIS_NRT VIIRS_NOAA20_NRT` and use dates covered by those feeds. Check [current product availability](https://firms.modaps.eosdis.nasa.gov/api/data_availability/) before choosing dates. For large historical exports, use the FIRMS archive download service.

```bash
python3 -m unittest discover -s tests -v
```

Tests cover download contracts, temporal regressions, and real DuckDB spatial queries. Install `requirements-global.txt` and DuckDB's `spatial` extension before running the integration tests. Live FIRMS downloads require a valid MAP_KEY. The optional real-browser check is `python3 tests/e2e_workbench.py --base-url https://nasa.aican.cloud` (Playwright + Chromium).

[Agent workflow](docs/agent-workflow.md) records the coordinator → UI worker hierarchy and independent review gates; [feature acceptance](docs/workbench-features.json) records verified capabilities and unfinished data integrations.

## GitHub monitoring

`scripts/watch_github.py` performs a read-only snapshot of this repository's branches, tags, issues, pull requests, reviews, comments, releases, workflow runs, recent events, and selected repository settings. It compares snapshots and records changes in `data/monitor/github/changes.jsonl`. The first run establishes a baseline. Failed checks preserve the last successful baseline.

```bash
python3 scripts/watch_github.py --sync
systemctl --user status nasa-space-apps-github-monitor.timer
systemctl --user stop nasa-space-apps-github-monitor.timer
```

The user systemd timer in `ops/` checks every **20 seconds** and starts again at login when enabled. With `--sync`, it fetches origin, records changed file paths, saves documentation/research diffs in `data/monitor/github/latest-research.md`, and fast-forwards the current branch when Git can preserve local edits. Conflicting local edits or diverged branches are reported for manual integration; it never resets, discards edits, or pushes. The installed service sends **no desktop notifications**. During active development, the agent reads these local updates to incorporate teammates' research; the service itself does not run an AI agent or update conversation context. This polling monitor is not a complete GitHub audit log: activity created and removed between polls may be missed, and GitHub's recent-event feed has retention limits.

## Complete historical database

```bash
python3 -u -m scripts.build_history --region sko --start 2000-11-01
python3 -m scripts.render_history
```

The default end date is today in UTC. The history builder includes MODIS (Terra and Aqua) and VIIRS (Suomi-NPP, NOAA-20, NOAA-21) over their available date ranges. It downloads published annual Kazakhstan CSVs for the standard archive and clips them to the region. Missing annual files and the recent tail are fetched through the Area API. SP takes precedence over NRT for each sensor so their date ranges do not overlap. All original columns, processing status, satellite, and collection versions are retained.

Each completed part is cached with a SHA-256 checksum in `data/cache/firms-history/sko/`. Rerun the command after an interruption to resume. Recent NRT parts are refreshed; `--refresh` reloads all parts. The manifest is marked complete only after every planned part succeeds.

Local outputs in `data/raw/firms/sko/history/`:

- `observations.csv`: the full clipped observation database with source/processing/platform metadata.
- `monthly.csv` and `yearly.csv`: separate sensor summaries, including zero detections in successfully queried periods and flags for partial periods.
- `summary.json`: aggregates, source availability, collection-version counts, and interpretation notes.
- `manifest.json`: retrieval coverage, checksums, source URLs for public archive files, and completion status. API keys are excluded.

The renderer exports an offline interactive calendar and annual chart to `reports/sko-history.html`, with aggregate JSON and CSV exports alongside it. Add `--plot` to also export `reports/sko-history.png` (requires matplotlib). These are **raw observation summaries**, not a harmonized fire-count or burned-area estimate. Product availability and successful queries do not establish clear-sky satellite coverage; a zero count is not proof that no fire occurred.

### Share the database

The [data snapshot release](https://github.com/MaximushkaBed/nasa-space-apps-petropavlovsk/releases/tag/data-sko-2026-11-14) contains the full observation database and offline report as a ZIP attachment, with a SHA-256 checksum. Teammates with access to this private repository can download the attachment and use the prepared data without an API key. Download the named `sko-history-...zip` asset; GitHub's automatic “Source code” ZIP contains repository code and aggregates only.

To rebuild the data package after downloading and rendering the history:

```bash
python3 -m scripts.package_history
```

## Open data

- [NASA FIRMS archive downloads](https://firms.modaps.eosdis.nasa.gov/download/): hotspot observations in CSV, JSON, and Shapefile formats. Archive access requires Earthdata Login or email authentication.
- [FIRMS API](https://firms.modaps.eosdis.nasa.gov/api/): request hotspot observations by area, date, and sensor.
- [FIRMS API key](https://firms.modaps.eosdis.nasa.gov/api/map_key/): obtain a MAP_KEY for API access.

Keep API keys in a local `.env` file. Credentials and raw data downloads must not be committed.

## Participation and submission

The [Global Organizing Team's clarification](https://github.com/nasa/spaceapps/discussions/1813) says teams may research the topic, review resources, choose a challenge, and form a team before the event, but must wait until the official start to develop their project.

The repository is private during initial setup. Before submission, make the solution accessible to judges and publish original work under terms compatible with the [official participant conditions](https://www.spaceappschallenge.org/legal/), which require unrestricted availability or an OSI-compliant open-source license.
