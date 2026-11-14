# Harmonization of MODIS and VIIRS Hot Spots

Project workspace for the NASA International Space Apps Challenge 2026 in Petropavlovsk, Kazakhstan.

Selected challenge: **Harmonization of MODIS and VIIRS Hot Spots**.

Local challenge label supplied by the team: `15 - Harmonization of MODIS and VIIRS Hot Spots_4.3`.

The repository includes a Python downloader for NASA FIRMS hotspot observations. The application scope, team roster, and web stack are still to be defined.

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
3. Run a regional download. This example requests historical observations for a rectangle around Petropavlovsk, not an administrative boundary:

```bash
python3 scripts/fetch_firms.py \
  --bbox 68,54,71,56 \
  --start 2024-07-01 \
  --end 2024-07-10 \
  --sources MODIS_SP VIIRS_SNPP_SP
```

The bounding box order is **west,south,east,north**. Dates are inclusive. The script splits the period into requests of at most five days, then writes one CSV per source into `data/raw/firms/`. Original NASA columns and values are preserved. The output is raw input for future harmonization; the downloader does not harmonize sensors.

For recent observations, select sources such as `MODIS_NRT VIIRS_NOAA20_NRT` and use dates covered by those feeds. Check [current product availability](https://firms.modaps.eosdis.nasa.gov/api/data_availability/) before choosing dates. For large historical exports, use the FIRMS archive download service.

```bash
python3 -m unittest discover -s tests -v
```

Tests use simulated API responses; live downloads require a valid MAP_KEY.

## Open data

- [NASA FIRMS archive downloads](https://firms.modaps.eosdis.nasa.gov/download/): hotspot observations in CSV, JSON, and Shapefile formats. Archive access requires Earthdata Login or email authentication.
- [FIRMS API](https://firms.modaps.eosdis.nasa.gov/api/): request hotspot observations by area, date, and sensor.
- [FIRMS API key](https://firms.modaps.eosdis.nasa.gov/api/map_key/): obtain a MAP_KEY for API access.

Keep API keys in a local `.env` file. Credentials and raw data downloads must not be committed.

## Participation and submission

The [Global Organizing Team's clarification](https://github.com/nasa/spaceapps/discussions/1813) says teams may research the topic, review resources, choose a challenge, and form a team before the event, but must wait until the official start to develop their project.

The repository is private during initial setup. Before submission, make the solution accessible to judges and publish original work under terms compatible with the [official participant conditions](https://www.spaceappschallenge.org/legal/), which require unrestricted availability or an OSI-compliant open-source license.
