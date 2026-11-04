"""SUBSIDE displacement products must map to the w3id standard variables the
planner uses; without these entries ckan_sync skips every SUBSIDE resource."""
from app.ckan_sync import STDVAR_TO_SVO, SVO_NS


def test_subside_displacement_variables_are_mapped():
    assert STDVAR_TO_SVO["land_surface__displacement"] == f"{SVO_NS}land_surface__displacement"
    assert STDVAR_TO_SVO["land_surface__displacement_rate"] == f"{SVO_NS}land_surface__displacement_rate"
