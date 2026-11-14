# Harmonization of MODIS and VIIRS Hot Spots

Project workspace for the NASA International Space Apps Challenge 2026 in Petropavlovsk, Kazakhstan.

Selected challenge: **Harmonization of MODIS and VIIRS Hot Spots**.

Local challenge label supplied by the team: `15 - Harmonization of MODIS and VIIRS Hot Spots_4.3`.

This repository currently contains project setup only. The implementation scope, team roster, and application stack are still to be defined.

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

The application stack and setup commands will be added after the prototype scope is chosen.

## Open data

- [NASA FIRMS archive downloads](https://firms.modaps.eosdis.nasa.gov/download/): hotspot observations in CSV, JSON, and Shapefile formats. Archive access requires Earthdata Login or email authentication.
- [FIRMS API](https://firms.modaps.eosdis.nasa.gov/api/): request hotspot observations by area, date, and sensor.
- [FIRMS API key](https://firms.modaps.eosdis.nasa.gov/api/map_key/): obtain a MAP_KEY for API access.

Keep API keys in a local `.env` file. Credentials and raw data downloads must not be committed.

## Participation and submission

The [Global Organizing Team's clarification](https://github.com/nasa/spaceapps/discussions/1813) says teams may research the topic, review resources, choose a challenge, and form a team before the event, but must wait until the official start to develop their project.

The repository is private during initial setup. Before submission, make the solution accessible to judges and publish original work under terms compatible with the [official participant conditions](https://www.spaceappschallenge.org/legal/), which require unrestricted availability or an OSI-compliant open-source license.
