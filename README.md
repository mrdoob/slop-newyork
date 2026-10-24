# Slop Tepic

A Tepic, Nayarit (with Xalisco) GTA-style simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL, forked from [Slop New York](https://github.com/mrdoob/slop-newyork). Explore the city on foot, by car, by bicycle, or by helicopter, starting at the Plaza Principal, and knock over pedestrians, cyclists, lamp posts and hydrants.

## Run it

Serve the folder with any static server and open it in a WebGPU browser:

```bash
python3 -m http.server 8000
```

## Rebuild the city data

`js/city-geodata.js` is generated from OpenStreetMap (Overpass) and Overture Maps:

```bash
tools/data/tepic/fetch.sh
```

```bash
tools/data/tepic/fetch-overture.sh
```

```bash
node --max-old-space-size=12000 tools/build-tepic-geodata.mjs
```

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); building footprints from [Overture Maps](https://overturemaps.org/) (OpenStreetMap, Microsoft ML Buildings and Google Open Buildings; ODbL). Live weather: [Weather data by Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Third-party data and dependencies retain their respective licenses.
