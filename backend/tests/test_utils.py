"""Geometry and image annotation tests."""

import numpy as np
import pytest

from app.utils.geometry_utils import (
    centroid,
    clamp_box,
    foot_point,
    person_in_polygon,
    point_in_polygon,
)
from app.utils.image_utils import annotate_count, decode_jpeg, encode_jpeg


# ------------------------------------------------------------------- geometry
def test_centroid():
    assert centroid((0.0, 0.0, 10.0, 20.0)) == (5.0, 10.0)


def test_foot_point_is_the_bottom_centre():
    assert foot_point((0.0, 0.0, 10.0, 20.0)) == (5.0, 20.0)


def test_point_in_polygon():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert point_in_polygon((5.0, 5.0), square)
    assert not point_in_polygon((15.0, 5.0), square)


def test_degenerate_polygon_accepts_everything():
    assert point_in_polygon((999.0, 999.0), [])
    assert point_in_polygon((999.0, 999.0), [(0.0, 0.0), (1.0, 1.0)])


def test_person_counts_by_where_they_stand():
    floor = [(0.0, 50.0), (100.0, 50.0), (100.0, 100.0), (0.0, 100.0)]
    # Head above the region, feet inside it: inside.
    assert person_in_polygon((40.0, 0.0, 60.0, 80.0), floor)
    # Body overlapping the region, feet outside it: outside.
    assert not person_in_polygon((40.0, 60.0, 60.0, 120.0), floor)


def test_clamp_box_keeps_boxes_inside_the_frame():
    x1, y1, x2, y2 = clamp_box((-20.0, -30.0, 900.0, 900.0), 640, 480)
    assert (x1, y1) == (0.0, 0.0)
    assert x2 <= 640 and y2 <= 480


def test_clamp_box_never_returns_an_empty_box():
    x1, y1, x2, y2 = clamp_box((100.0, 100.0, 100.0, 100.0), 640, 480)
    assert x2 > x1 and y2 > y1


# ----------------------------------------------------------------- annotation
def _frame():
    return np.full((240, 320, 3), 100, dtype=np.uint8)


def test_annotate_draws_on_a_copy():
    frame = _frame()
    out = annotate_count(frame, [((10.0, 40.0, 60.0, 200.0), 0.9)], 1)
    assert out is not frame
    assert (frame == 100).all()
    assert not (out == 100).all()


def test_violation_tints_the_frame_red():
    frame = _frame()
    calm = annotate_count(frame, [], 0)
    alarmed = annotate_count(frame, [], 0, violation="above 0")
    # Below the banner: plain grey vs. grey blended toward red (BGR).
    assert calm[200, 200].tolist() == [100, 100, 100]
    b, g, r = alarmed[200, 200].tolist()
    assert r > 100 and b < 100 and g < 100


def test_annotated_frame_round_trips_as_jpeg():
    jpeg = encode_jpeg(annotate_count(_frame(), [], 3, roi=[[0, 0], [100, 0], [100, 100]]))
    assert jpeg and jpeg[:2] == b"\xff\xd8"
    assert decode_jpeg(jpeg).shape == (240, 320, 3)


def test_empty_frame_does_not_encode():
    assert encode_jpeg(np.zeros((0, 0, 3), dtype=np.uint8)) is None


@pytest.mark.parametrize("count", [0, 7, 120])
def test_any_count_annotates(count):
    assert annotate_count(_frame(), [], count).shape == (240, 320, 3)
