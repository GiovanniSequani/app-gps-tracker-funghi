from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import xarray as xr

from backend.scripts.run_daily_forecast_pipeline import daily_forecast, score_day, write_json
from backend.src.forecast.publish import cleanup_local, object_inventory, publish
from backend.src.forecast.weather import deaccumulate, hourly_model, local_hours, nearest_indices, relative_humidity
from backend.src.index.features import build_feature_dataset
from backend.src.index.scoring import _mean_window, _sum_window, compute_all_indices
from backend.src.publication.common import sha256_file


@pytest.mark.parametrize("day,count", [("2026-10-07",24),("2026-03-29",23),("2026-10-25",25)])
def test_local_days_end_intervals_and_dst(day, count):
    hours = local_hours(day)
    assert len(hours) == count and hours.is_unique
    assert hours[-1].tz_convert("Europe/Rome").hour == 0
    assert hours[0].tz_convert("Europe/Rome").hour == 1


def test_rain_units_and_reset():
    np.testing.assert_allclose(deaccumulate(np.array([9.]), np.array([3.]), 3), [2])
    with pytest.raises(ValueError):
        deaccumulate(np.array([2.]), np.array([3.]), 1)
    assert relative_humidity(np.array([10.]), np.array([10.]))[0] == 100
    assert 49 < relative_humidity(np.array([20.]), np.array([9.3]))[0] < 51


def model():
    return xr.Dataset({"temperature": (("lead","point"), [[10.],[13.],[16.]]),
                       "humidity": (("lead","point"), [[70.],[80.],[90.]]),
                       "rain": (("lead","point"), [[0.],[6.],[15.]]),
                       "gust": (("lead","point"), [[10.],[30.],[20.]])},
                      coords={"lead":[0,3,6],"latitude":("point",[46.]),"longitude":("point",[11.])},
                      attrs={"run":"2026100700"})


def test_coarse_intervals_preserve_precip_and_gust():
    data = hourly_model(model())
    assert data.rain.sum().item() == 15
    assert data.temperature.values[0,0] == 11
    np.testing.assert_array_equal(data.gust.values[:,0], [30,30,30,20,20,20])
    bad = model().assign_coords(lead=[0,3,9])
    with pytest.raises(ValueError, match="missing leads"):
        hourly_model(bad)


def test_nearest_does_not_invent_spatial_detail():
    got = nearest_indices(np.array([46.,46.]),np.array([11.,11.1]),np.array([46.]),np.array([11.01,11.02,11.09]))
    np.testing.assert_array_equal(got, [[0,0,1]])


def test_partial_gust_hours_are_missing_not_replicated():
    data = model()
    data["gust_start"] = ("lead", [0,2,5])
    hourly = hourly_model(data)
    assert int(hourly.gust.notnull().sum()) == 2
    np.testing.assert_allclose(hourly.gust.values[:,0], [np.nan,np.nan,30,np.nan,np.nan,20], equal_nan=True)


def test_official_forecast_fallback_priority_and_streaming(tmp_path):
    from backend.tests.test_weather_time_series import canonical_dataset
    from backend.src.meteo.time_series import compose_weather_window, save_composite_window, SCORING_WEATHER_VARIABLES
    from backend.src.forecast.weather import archived_weather
    meteo=tmp_path / "meteo"; meteo.mkdir()
    archive=tmp_path / "forecast"; archive.mkdir()
    real=canonical_dataset(["2026-06-01"],2)
    real.to_netcdf(meteo / "icon_ruc_time_series_2026.nc")
    for version,value in [("20260601T000000Z",5),("20260601T120000Z",9)]:
        folder=archive / version; folder.mkdir()
        forecast=canonical_dataset(["2026-06-02"],value)[list(SCORING_WEATHER_VARIABLES)]
        path=folder / "weather_2026-06-02.nc"; forecast.to_netcdf(path)
        write_json(folder / "manifest.json", {"version":version,"issued_at":pd.to_datetime(version,format="%Y%m%dT%H%M%SZ",utc=True).isoformat(),
                   "dates":["2026-06-02"],"local_weather_sha256":{"2026-06-02":sha256_file(path)},"models":{"iconeu":{"run":"2026060100"}},"quality":[{"date":"2026-06-02","gust_partial":True}]})
    result=compose_weather_window("2026-06-03",3,meteo,forecast_root=archive)
    assert result.weather_source.values.tolist() == [1,3,0]
    assert result.precip_sum[1,0,0].item() == 9
    assert result.precip_sum[2].isnull().all()
    assert "20260601T120000Z" in result.attrs["forecast_fallback"]
    output=tmp_path / "composed.nc"
    save_composite_window("2026-06-03",3,output,meteo,forecast_root=archive)
    with xr.open_dataset(output) as stored:
        np.testing.assert_allclose(stored.precip_sum,result.precip_sum,equal_nan=True)
        assert stored.weather_source.values.tolist() == [1,3,0]
    canonical_dataset(["2026-06-02"],7).to_netcdf(meteo / "hrs_time_series_2026.nc")
    result=compose_weather_window("2026-06-02",2,meteo,forecast_root=archive)
    assert result.weather_source.values.tolist() == [1,2]
    assert result.precip_sum[1,0,0].item() == 7
    assert result.attrs["forecast_fallback"] == "{}"
    # Corrupt latest is not trusted; use the preceding verified version.
    (archive / "20260601T120000Z/weather_2026-06-02.nc").write_bytes(b"broken")
    result,_=archived_weather(archive,"2026-06-02")
    assert result.precip_sum[0,0,0].item() == 5


def test_daily_blend_uses_available_ruc_and_does_not_sum_cumulative_rain():
    times = local_hours("2026-10-07").tz_localize(None)
    ds = xr.Dataset({k: (("valid_time","point"), np.full((24,4),v,dtype="float32"))
                     for k,v in {"temperature":10,"humidity":80,"rain":2,"gust":20}.items()},
                    coords={"valid_time":times,"latitude":("point",[46,46,46.003,46.003]),"longitude":("point",[11,11.003,11,11.003])})
    ruc = xr.Dataset({k: (("valid_time","lat","lon"), np.full((2,2,2),v,dtype="float32"))
                      for k,v in {"t2m":15,"rh2m":90,"precip":5,"gust10m":30}.items()},
                     coords={"valid_time":times[:2],"lat":[46,46.003],"lon":[11,11.003]})
    result, quality = daily_forecast("2026-10-07",pd.Timestamp("2026-10-07T12:00Z"),{"icon2i":ds,"iconeu":ds},ruc,ruc.lat.values,ruc.lon.values)
    assert quality["hours_by_source"] == {"ruc":2,"icon2i":22,"iconeu":0,"missing":0}
    assert result.precip_sum.values[0,0,0] == 54
    assert result.gust_max.values[0,0,0] == 30
    assert result.t2m_min.values[0,0,0] == 10
    assert result.t2m_max.values[0,0,0] == 15


def test_skipna_is_biased_not_missing_equals_dry():
    ds = xr.Dataset({"precip_sum":("time",[np.nan,np.nan]),"t2m_mean":("time",[10.,np.nan])})
    assert _sum_window(ds,"precip_sum",0,1).item() == 0  # official behavior, explicitly documented
    assert _mean_window(ds,"t2m_mean",0,1).item() == 10
    assert ds.precip_sum.isnull().all()  # source remains a gap, never rewritten


def test_stripe_scoring_unchanged_and_forecast_history_wins(tmp_path):
    lat,lon = np.array([46.,46.003]),np.array([11.,11.003])
    meteo = xr.Dataset({k:(("time","lat","lon"),np.full((19,2,2),v,dtype="float32")) for k,v in
                        {"t2m_mean":14,"t2m_min":8,"t2m_max":20,"precip_sum":5,"rh_mean":80,"rh_min":50,"gust_max":20}.items()},
                       coords={"time":pd.date_range("2026-09-19",periods=19),"lat":lat,"lon":lon})
    terrain = xr.Dataset({k:(("lat","lon"),np.full((2,2),v,dtype="float32")) for k,v in
                          {"elevation":900,"slope":12,"tpi":0,"aspect_deg":0,"pct_broadleaf":50,"pct_conifer":25,"pct_non_forest":25}.items()},
                         coords={"lat":lat,"lon":lon})
    official,forecast = tmp_path / "official",tmp_path / "forecast"
    official.mkdir(); forecast.mkdir()
    features = build_feature_dataset(meteo,terrain,"2026-10-07",19)
    expected = compute_all_indices(features,["porcini"])
    got,_ = score_day("2026-10-07",meteo,terrain,official,forecast)
    for var in expected:
        assert got[var].values.tobytes() == expected[var].values.tobytes()
    previous = expected.copy(deep=True)
    previous["porcini_score"][:] = 100
    previous.to_netcdf(forecast / "funghi_index_2026-10-06.nc")
    expected.to_netcdf(official / "funghi_index_2026-10-06.nc")
    got,_ = score_day("2026-10-07",meteo,terrain,official,forecast)
    expected = compute_all_indices(features,["porcini"],recovery_history={"porcini":[(1,previous)]})
    np.testing.assert_array_equal(got.porcini_score,expected.porcini_score)
    # Missing whole historical day still calculable, without filling weather.
    for var in meteo:
        meteo[var][10] = np.nan
    gap,_ = score_day("2026-10-07",meteo,terrain,official,forecast)
    assert np.isfinite(gap.porcini_score).all()
    assert meteo.precip_sum[10].isnull().all()


class Fake:
    def __init__(self, fail=False):
        self.fail = fail; self.published=False; self.calls=[]; self.objects={}
    def rpc(self,name,data):
        self.calls.append(name)
        if name == "stage_forecast": return "unchanged" if self.published else "staged"
        if name == "activate_forecast": self.published=True; return "published"
        if name == "expired_forecasts": return []
    def storage_upload(self,bucket,path,data,**kwargs):
        assert bucket in ("forecast-data","forecast-tiles")
        if self.fail: raise RuntimeError("upload interrupted")
        self.objects[bucket,path]=data
    def storage_get(self,bucket,path): return self.objects[bucket,path]


def publication_fixture(tmp_path):
    (tmp_path / "chunks").mkdir()
    p=tmp_path / "chunks/test.bin.zlib"; p.write_bytes(b"fake")
    m={"version":"20261007T120000Z","issued_at":"2026-10-07T12:00:00Z","valid_until":"2026-10-12T00:00:00Z",
       "chunks":[{"path":"chunks/test.bin.zlib","bytes":4,"sha256":sha256_file(p)}],"tiles":[]}
    write_json(tmp_path / "manifest.json",m)
    return m


def test_publication_failure_never_switches_and_retry_is_idempotent(tmp_path):
    publication_fixture(tmp_path)
    client=Fake(fail=True)
    with pytest.raises(RuntimeError): publish(tmp_path,None,client)
    assert "activate_forecast" not in client.calls
    client.fail=False
    assert publish(tmp_path,None,client) == "published"
    assert publish(tmp_path,None,client) == "unchanged"
    assert client.calls.count("activate_forecast") == 1


def test_integrity_and_paths_fail_before_writes(tmp_path):
    m=publication_fixture(tmp_path)
    (tmp_path / "chunks/test.bin.zlib").write_bytes(b"corrupt")
    client=Fake()
    with pytest.raises(ValueError): publish(tmp_path,None,client)
    assert not client.calls
    m["chunks"][0]["path"]="../tiles/official.png"
    with pytest.raises(ValueError): object_inventory(m)


def test_forecast_uses_fresh_connections_without_changing_shared_default(tmp_path, monkeypatch):
    from backend.src.publication.supabase import SupabaseClient
    publication_fixture(tmp_path)
    client = Fake()
    monkeypatch.setattr(SupabaseClient, "from_env", lambda _: client)
    assert publish(tmp_path, None) == "published"
    assert client.max_requests_per_connection == 1
    assert SupabaseClient("https://example.invalid", "test").max_requests_per_connection == 12


def test_retention_only_forecast_roots(tmp_path):
    old=tmp_path / "20260901T000000Z"; old.mkdir()
    preserved=tmp_path / "official"; preserved.mkdir()
    cleanup_local(tmp_path,tmp_path / "missing-cache",pd.Timestamp("2026-10-07T12:00Z"))
    assert not old.exists() and preserved.exists()


def test_sql_cas_and_expiry_are_server_enforced():
    sql=(Path(__file__).parents[1] / "supabase/migrations/202610070001_forecast_publication.sql").read_text()
    assert "for update" in sql
    assert "latest > candidate.issued_at" in sql
    assert "v.valid_until > now()" in sql
    assert "to anon, authenticated, service_role" in sql
    assert "from public,anon,authenticated" in sql
