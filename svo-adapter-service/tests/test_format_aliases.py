"""Format strings reach the planner spelled three ways (adapter short names,
MINT MIME types, CKAN resource formats); comparisons use one canonical name.
Found live on 2026-11-05: the synced WERC output contract said
`image/tiff;application=geotiff` and the STAC publish piece's input said
`geotiff`, so `GET /publishers` planned no path."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.models import DataObjectContract  # noqa: E402
from app.planner import _check_format, find_path, normalize_format  # noqa: E402

SVO = "https://w3id.org/okn/i/mint/land_surface__displacement_rate"


@pytest.mark.parametrize("spelling", [
    "geotiff", "GeoTIFF", "image/tiff", "image/tiff;application=geotiff",
    "image/tiff; application=geotiff", "tif", "COG",
])
def test_geotiff_spellings_are_one_format(spelling):
    assert normalize_format(spelling) == "geotiff"
    src = DataObjectContract(standard_variable_uri=SVO, format=spelling, resource_uri="x")
    tgt = DataObjectContract(standard_variable_uri=SVO, format="geotiff")
    assert _check_format(src, tgt).compatible


def test_unknown_formats_still_compare_case_insensitively():
    assert normalize_format(" Shapefile ") == "shapefile"
    assert normalize_format(None) is None
    src = DataObjectContract(standard_variable_uri=SVO, format="cbc-mf6", resource_uri="x")
    assert not _check_format(src, DataObjectContract(standard_variable_uri=SVO, format="geotiff")).compatible


def test_mime_typed_model_output_reaches_the_publish_piece():
    """The live case: a MIME-typed synced output must plan the STAC piece."""
    registry = [{
        "id": "ts-subside-stac-publish", "name": "stac-publish",
        "transform_type": "catalog_register", "method": "tapis_function",
        "contracts": [
            {"role": "input", "format": "geotiff"},
            {"role": "output", "catalog": "ckan+stac"},
        ],
    }]
    source = DataObjectContract(standard_variable_uri=SVO, unit="mm/yr",
                                format="image/tiff;application=geotiff",
                                resource_uri="deferred-model-output")
    target = source.model_copy(update={"catalog": "ckan+stac"})
    path = find_path(source, target, registry)
    assert path is not None and [s["id"] for s in path] == ["ts-subside-stac-publish"]
