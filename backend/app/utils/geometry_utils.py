# app/utils/geometry_utils.py
"""Pure-geometry helpers for the counting region.

Boxes are ``(x1, y1, x2, y2)`` in pixel coordinates. Nothing here touches
OpenCV or torch, which keeps the counter unit-testable without a camera.
"""

from typing import Sequence, Tuple

Box = Tuple[float, float, float, float]
Point = Tuple[float, float]


def centroid(box: Box) -> Point:
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def foot_point(box: Box) -> Point:
    """Bottom-centre of a person box: where they stand on the floor.

    Better than the centroid for a region drawn on the floor -- someone whose
    head is over the line but who stands outside it is outside.
    """
    x1, _, x2, y2 = box
    return ((x1 + x2) / 2.0, y2)


def point_in_polygon(point: Point, polygon: Sequence[Point]) -> bool:
    """Ray-casting point-in-polygon test. Empty/degenerate polygon accepts everything."""
    if not polygon or len(polygon) < 3:
        return True

    x, y = point
    inside = False
    n = len(polygon)

    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_at_y = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < x_at_y:
                inside = not inside

    return inside


def person_in_polygon(box: Box, polygon: Sequence[Point]) -> bool:
    """A person counts as inside the region when their feet are."""
    return point_in_polygon(foot_point(box), polygon)


def clamp_box(box: Box, width: int, height: int) -> Box:
    """Clip a box to the frame."""
    x1, y1, x2, y2 = box
    x1 = max(0.0, min(float(width - 1), x1))
    y1 = max(0.0, min(float(height - 1), y1))
    x2 = max(0.0, min(float(width), x2))
    y2 = max(0.0, min(float(height), y2))
    if x2 <= x1:
        x2 = min(float(width), x1 + 1.0)
    if y2 <= y1:
        y2 = min(float(height), y1 + 1.0)
    return (x1, y1, x2, y2)
