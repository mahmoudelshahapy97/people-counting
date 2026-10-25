# app/utils/image_utils.py
"""Image processing utilities for frame conversion and annotation."""

import base64
import logging
from typing import Optional, Sequence, Tuple

import cv2
import numpy as np

from app.core.config import config
from app.utils.geometry_utils import Box

logger = logging.getLogger(__name__)


def encode_jpeg(frame: np.ndarray, quality: Optional[int] = None) -> Optional[bytes]:
    """Encode a BGR frame as JPEG bytes."""
    if frame is None or frame.size == 0:
        return None
    success, buffer = cv2.imencode(
        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality or config.jpeg_quality]
    )
    if not success:
        logger.error("cv2.imencode failed during JPEG encoding.")
        return None
    return buffer.tobytes()


def decode_jpeg(data: bytes) -> Optional[np.ndarray]:
    """Decode JPEG/PNG bytes into a BGR frame."""
    if not data:
        return None
    try:
        nparr = np.frombuffer(data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error("Error decoding image bytes: %s", e, exc_info=True)
        return None


def frame_to_base64(frame: np.ndarray) -> str:
    """Converts an OpenCV frame (numpy array) to a base64 encoded string."""
    data = encode_jpeg(frame)
    return base64.b64encode(data).decode("utf-8") if data else ""


def base64_to_frame(base64_string: str) -> Optional[np.ndarray]:
    """Converts a base64 encoded string back to an OpenCV frame."""
    if not base64_string:
        return None
    try:
        return decode_jpeg(base64.b64decode(base64_string))
    except Exception as e:
        logger.error("Error decoding base64 string to frame: %s", e, exc_info=True)
        return None


def bytes_to_base64(data: Optional[bytes]) -> Optional[str]:
    """Postgres BYTEA -> base64 string for JSON responses."""
    if not data:
        return None
    return base64.b64encode(bytes(data)).decode("utf-8")


# BGR colours
_COLOR_PERSON = (0, 200, 0)        # green - a counted person
_COLOR_ALERT = (0, 0, 255)         # red - count outside the camera's limits
_COLOR_ROI = (255, 200, 0)         # cyan-ish - counting region
_COLOR_HEADER = (32, 32, 32)


def draw_box(
    frame: np.ndarray,
    box: Box,
    label: str = "",
    color: Tuple[int, int, int] = _COLOR_PERSON,
    thickness: int = 2,
) -> np.ndarray:
    """Draw a labelled rectangle in place and return the frame."""
    x1, y1, x2, y2 = (int(v) for v in box)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)

    if label:
        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        top = max(0, y1 - th - baseline - 4)
        cv2.rectangle(frame, (x1, top), (x1 + tw + 6, top + th + baseline + 4), color, -1)
        cv2.putText(
            frame,
            label,
            (x1 + 3, top + th + 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    return frame


def draw_roi(frame: np.ndarray, polygon: Sequence[Sequence[float]]) -> np.ndarray:
    """Outline the configured counting region."""
    if not polygon or len(polygon) < 3:
        return frame
    points = np.array([[int(p[0]), int(p[1])] for p in polygon], dtype=np.int32)
    cv2.polylines(frame, [points], isClosed=True, color=_COLOR_ROI, thickness=2)
    return frame


def _banner(frame: np.ndarray, text: str, color: Tuple[int, int, int], scale: float) -> int:
    """A full-width text bar at the top; returns its height."""
    (_, th), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
    bar = th + baseline + 12
    cv2.rectangle(frame, (0, 0), (frame.shape[1], bar), color, -1)
    cv2.putText(
        frame, text, (10, th + 6), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 2, cv2.LINE_AA
    )
    return bar


def annotate_count(
    frame: np.ndarray,
    persons: Sequence[Tuple[Box, float]],
    count: int,
    violation: Optional[str] = None,
    roi: Optional[Sequence[Sequence[float]]] = None,
    header: str = "",
) -> np.ndarray:
    """The live view and the alert snapshot: one box per counted person and
    the count on top. Out of range, the count turns red and the whole frame
    takes a red tint (as InsightEye's annotator does). Draws on a copy.

    ``persons`` are (box, confidence) pairs; ``violation`` is the human text
    of the broken limit, e.g. "above 20".
    """
    annotated = frame.copy()
    if violation:
        tint = np.zeros_like(annotated)
        tint[:] = _COLOR_ALERT
        cv2.addWeighted(tint, 0.18, annotated, 0.82, 0, dst=annotated)
    if roi:
        draw_roi(annotated, roi)

    for box, confidence in persons:
        draw_box(annotated, box, f"Person {confidence:.2f}", _COLOR_PERSON, thickness=2)

    text = f"People: {count}"
    if violation:
        text += f"  |  ALERT: {violation}"
    bar = _banner(annotated, text, _COLOR_ALERT if violation else _COLOR_HEADER, 0.8)

    if header:
        (_, th), baseline = cv2.getTextSize(header, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.putText(
            annotated,
            header,
            (10, bar + th + 8),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    return annotated


def placeholder_frame(message: str, width: int = 960, height: int = 540) -> np.ndarray:
    """A dark frame with a message, for live viewers before the first frame."""
    frame = np.full((height, width, 3), 24, dtype=np.uint8)
    (tw, th), _ = cv2.getTextSize(message, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
    cv2.putText(
        frame,
        message,
        ((width - tw) // 2, (height + th) // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (200, 200, 200),
        2,
        cv2.LINE_AA,
    )
    return frame
