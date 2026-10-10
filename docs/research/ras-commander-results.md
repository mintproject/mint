# RAS Commander: results and HDF output

Answers [#333](https://github.com/mintproject/monorepo/issues/333). Part of #330.
Researched 2026-10-10.

## Answer

1. Use `ras_commander.hdf` (`HdfResultsMesh`, `HdfResultsXsec`, `HdfResultsPlan`). They read the plan result file `<project>.p##.hdf` with h5py. No GUI is needed.
2. Use `HdfResultsProducts.export` to write a package that MINT can store. It makes Cloud Optimized GeoTIFFs, a Parquet hydrograph table, JSON and a GeoJSON footprint. The docs do not say it needs HEC-RAS or Windows. It reads only the HDF file.
3. Stored-map rasters (`RasProcess.store_maps`) need Windows and an installed HEC-RAS. They do not need the GUI. Do not plan on them for a Linux job.

## Sources

- Site: [rascommander.info/ras](https://rascommander.info/ras/)
- Repo: [gpt-cmdr/ras-commander](https://github.com/gpt-cmdr/ras-commander) (MIT licence)
- `https://ras-commander.readthedocs.io` returned HTTP 404 on 2026-10-10. The docs now live at rascommander.info. All claims below come from rascommander.info and the repo README.
- Python version: the repo page does not state it. Check `pyproject.toml` before you pin an image.

## Input file format

- Results are HDF5 files named `.p##.hdf` (HEC-RAS 5.x and later). The modern HDF features target HEC-RAS 6.2 and later.
- `ras.plan_df['HDF_Results_Path']` gives the path. `RasPlan.get_results_path("01")` returns the path or `None`.
- Core dependencies are h5py, numpy and pandas. The geospatial stack comes with the `full` or `all` extra. `pyarrow>=14.0` is needed for the export package.
- Install: `pip install ras-commander` (or `ras-commander[all]`).

Sources: [HDF data extraction](https://rascommander.info/user-guide/hdf-data-extraction/), [repo README](https://github.com/gpt-cmdr/ras-commander).

## Reader API

| Class | Method | Returns |
|---|---|---|
| `HdfResultsMesh` | `get_mesh_timeseries(hdf, mesh, var)` | `xarray.DataArray` (`time`, `cell_id` or `face_id`) |
| `HdfResultsMesh` | `get_mesh_cells_timeseries` | `dict[str, xarray.Dataset]` |
| `HdfResultsMesh` | `get_mesh_faces_timeseries` | `xarray.Dataset` |
| `HdfResultsMesh` | `get_mesh_max_ws`, `get_mesh_max_face_v`, `get_mesh_max_depth` | `GeoDataFrame` for max WSE; others not stated |
| `HdfResultsMesh` | `get_profile_line_flow_timeseries`, `get_profile_line_peak_flow` | table (needs pythonnet and RasMapperLib) |
| `HdfResultsXsec` | `get_xsec_timeseries` | `xarray.Dataset` (`time`, `cross_section`) |
| `HdfResultsXsec` | `get_ref_lines_timeseries`, `get_ref_points_timeseries` | reference-line and point series |
| `HdfResultsPlan` | `get_compute_messages` | `str` |
| `HdfResultsPlan` | `get_volume_accounting`, `get_runtime_data`, `get_unsteady_summary` | `DataFrame` |
| `HdfResultsPlan` | `get_steady_results`, `get_steady_wse` | steady-profile results |
| `HdfResultsQuery` | `query_point(s)`, `query_profile`, `query_polyline_{wse,velocity,flow}_{profile,timeseries}` | `dict` or `DataFrame` |
| `HdfResultView` | `to_pandas`, `to_numpy`, `to_xarray`, `to_arrow` | lazy bounded views |

Sources: [HDF user guide](https://rascommander.info/user-guide/hdf-data-extraction/), [HDF modules API](https://rascommander.info/api/hdf/), [results queries API](https://rascommander.info/api/results-queries/).

## Output variables

2D mesh (per mesh area):

- Time series: `Water Surface` (time x cell), `Face Velocity` (time x face), `Cell Cumulative Precipitation`, `Depth` (optional).
- If `Depth` is absent, `get_mesh_max_depth` derives it. It subtracts `Water Surface - Cells Minimum Elevation` and clips below zero.
- Summary maxima: `Maximum Water Surface`, `Maximum Water Surface Time`, `Maximum Face Velocity`.

1D cross sections: `Water_Surface`, `Flow`, `Velocity_Channel`, `Velocity_Total`. Steady plans store `Water Surface` per profile.

Plan level: compute messages, volume accounting, runtime data, unsteady info.

`results_df` has one row per plan. Columns include `plan_number`, `flow_type`, `hdf_path`, `completed`, `has_errors`, `error_count`, `runtime_*` and `vol_*` (including `vol_error_percent`). Refresh it with `ras.update_results_df(["01"])`.

Caveats from the docs:

- HDF paths: `/Results/Unsteady/Output/Output Blocks/Base Output/...` ([HDF structure](https://rascommander.info/reference/hdf-structure/)). That page gives no units. Units are in `.attrs['units']` and can be empty.
- Cell and face IDs are local to each mesh.
- A missing optional output is not zero.
- A keyword scan of compute messages does not prove a good run. Use `completed` and `error_count` too.
- Take datum and time reference from the source model.

Sources: [DataFrame reference](https://rascommander.info/reference/dataframe-reference/), [HDF structure](https://rascommander.info/reference/hdf-structure/).

## Export to files MINT can store

### Option A: `HdfResultsProducts.export`

Signature: `export(hdf_path, output_directory, *, resolution=None, max_dimension=2048, nodata=-9999.0, include_preview=True)`

It writes:

- Three Cloud Optimized GeoTIFFs on one grid: max WSE, max depth, max adjacent-face velocity.
- A Parquet (Arrow) table of boundary hydrographs.
- Result metadata and `numerical-qaqc.json`.
- A WGS84 GeoJSON footprint and a depth preview.
- `hydraulic-products.json`, written last. It marks the package complete.

Limits:

- Input must be an unsteady 2D result.
- The output directory must not exist.
- The destination filesystem must support hard links, or the export fails.
- Each raster side is at most `max_dimension`. The raster has at most 16,777,216 cells.

Source: [HDF modules API](https://rascommander.info/api/hdf/), notebook [417](https://rascommander.info/notebooks/417_inspect_results_and_generate_hydraulic_products/).

### Option B: DataFrames and xarray to files

`GeoDataFrame.to_file(..., driver="GeoJSON")` is documented. Other writers (`DataFrame.to_csv`, `to_parquet`, `xarray.to_netcdf`) are standard pandas and xarray calls. The ras-commander docs do not describe them. Keep `.attrs` (units, variable, face IDs) separate when you write CSV. The docs say to do this.

### Option C: stored maps through RASMapper

- `RasProcess.store_maps(plan_number, profile="Max", wse=True, depth=True, velocity=False, fix_georef=True, ras_version=..., timeout=1800)` returns a dict of raster paths by map type.
- Depth rasters are `.tif`. Inundation boundaries are `.shp` and optionally `.gpkg`.
- Other methods: `store_maps_at_timesteps`, `store_maps_at_steady_profiles`, `store_all_maps`, `batch_export_rasters`, `composite_rasters`.
- The notebook states: Windows, HEC-RAS 6.x or 7.x with RAS Mapper, "GUI Required: No", "Cloud-Compatible: No".
- The API page says the native export needs HEC-RAS components on Windows or a configured Wine setup.
- Arrival time, duration and percent-time-inundated maps appear only as titles of notebook 125. We did not read that notebook. Treat them as unverified.

Sources: [stored maps API](https://rascommander.info/api/stored-maps/), [notebook 601](https://rascommander.info/notebooks/601_headless_stored_map_generation_rasmapper/).

## Fit for MINT

- Reading results from HDF is portable. The docs do not say it needs HEC-RAS. Test it on Linux.
- Running HEC-RAS on Linux: the repo says Docker, Apptainer and Slurm backends exist. Images cover HEC-RAS 6.5, 6.6 and 7.0.1 on linux/amd64.
- Best output set for MINT storage: the Option A package. It is a small set of open formats (COG, Parquet, GeoJSON, JSON) with a manifest.
- Use `results_df` as the run-quality check before you publish.

## Open points

- Python version and release number are not stated on the repo page.
- Return types are "not stated" for `get_mesh_max_face_v`, `get_mesh_max_depth`, pipe and pump readers.
- Signatures of `export_max_depth_raster` and `get_flood_extent_polygon` are not on the pages we read.
- The results-queries, stored-maps and HDF API pages are long. We read only part of each (the first 100,000 characters, plus one later slice of the HDF page).
- Unread: [HDF writing guide](https://rascommander.info/reference/hdf-writing-guide/), [query architecture](https://rascommander.info/development/hdf-results-query-architecture/), source files in the repo.
- Facts come from page summaries made by a fetch tool. Check key claims (export package contents, Windows need) against the repo source before you build on them.
