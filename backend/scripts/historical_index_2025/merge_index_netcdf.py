"""Unisce i NetCDF giornalieri storici in un unico file locale."""

from __future__ import annotations

import argparse
from pathlib import Path

import netCDF4
import numpy as np
import xarray as xr


def main() -> None:
    parser = argparse.ArgumentParser(description="Unisci funghi_index_YYYY-MM-DD.nc")
    parser.add_argument("--input-dir", type=Path, default=Path("backend/tmp/historical_index_2025"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("backend/outputs/index_nc/funghi_index_2025-07-01_2025-10-31.nc"),
    )
    args = parser.parse_args()

    files = sorted(args.input_dir.glob("funghi_index_*.nc"))
    if not files:
        raise SystemExit(f"Nessun NetCDF trovato in {args.input_dir}")
    dates = [path.stem.removeprefix("funghi_index_") for path in files]
    if len(dates) != len(set(dates)):
        raise SystemExit("Date duplicate: impossibile creare un file unico")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()

    with xr.open_dataset(files[0]) as first:
        lat = first["lat"].values
        lon = first["lon"].values
        data_names = list(first.data_vars)
        dimensions = {name: int(size) for name, size in first.sizes.items() if name not in {"lat", "lon"}}
        if set(dimensions) - {"lag"}:
            raise SystemExit(f"Dimensioni inattese: {dimensions}")

        with netCDF4.Dataset(args.output, "w", format="NETCDF4") as output:
            output.createDimension("date", None)
            output.createDimension("lat", len(lat))
            output.createDimension("lon", len(lon))
            if "lag" in dimensions:
                output.createDimension("lag", dimensions["lag"])
            date_var = output.createVariable("date", str, ("date",))
            lat_var = output.createVariable("lat", "f4", ("lat",))
            lon_var = output.createVariable("lon", "f4", ("lon",))
            lat_var[:] = lat
            lon_var[:] = lon
            lat_var.setncatts(dict(first["lat"].attrs))
            lon_var.setncatts(dict(first["lon"].attrs))
            variables = {}
            for name in data_names:
                source = first[name]
                dims = tuple("date" if dim == "date" else dim for dim in source.dims)
                if dims == ("lat", "lon"):
                    dims = ("date", "lat", "lon")
                elif dims == ("lag", "lat", "lon"):
                    dims = ("date", "lag", "lat", "lon")
                variables[name] = output.createVariable(name, "f4", dims, zlib=True, complevel=4)
                variables[name].setncatts(dict(source.attrs))
            output.setncattr("merged_from", str(args.input_dir))

            for index, (path, date) in enumerate(zip(files, dates)):
                with xr.open_dataset(path) as source:
                    date_var[index] = date
                    for name, target in variables.items():
                        values = np.asarray(source[name].values, dtype=np.float32)
                        target[index, ...] = values
                print(f"Aggiunto {index + 1}/{len(files)}: {date}")

    print(f"Creato: {args.output} ({len(files)} date)")


if __name__ == "__main__":
    main()
