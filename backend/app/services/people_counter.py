# app/services/people_counter.py
"""Head counts and occupancy limits: the logic of InsightEye's people counting.

InsightEye runs one YOLO people detector per sampled frame, keeps class 0 and
counts the boxes (stream_processing_service.detect_objects_with_threshold).
The count is compared with the camera's ``count_threshold_greater`` and
``count_threshold_less``; a count above the first or below the second is a
violation, and a violation raises at most one alert per camera per cooldown
(_handle_people_count_alert). There is no tracking: a count is a snapshot.

Everything here except PeopleDetector is pure, so it is tested without a
model or a camera.
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from app.core.config import config
from app.utils.geometry_utils import Box, person_in_polygon

logger = logging.getLogger(__name__)

GREATER_THAN = "greater_than"
LESS_THAN = "less_than"


@dataclass(frozen=True)
class Person:
    box: Box
    confidence: float


@dataclass(frozen=True)
class Violation:
    threshold_type: str  # GREATER_THAN | LESS_THAN
    threshold_value: int
    count: int

    @property
    def describe(self) -> str:
        """Short human text: "above 20" / "below 2"."""
        word = "above" if self.threshold_type == GREATER_THAN else "below"
        return f"{word} {self.threshold_value}"


@dataclass(frozen=True)
class Thresholds:
    """A camera's occupancy limits; None leaves that side open."""

    greater_than: Optional[int] = None
    less_than: Optional[int] = None
    enabled: bool = True

    @classmethod
    def from_camera(cls, camera: Dict[str, Any]) -> "Thresholds":
        return cls(
            greater_than=camera.get("count_threshold_greater"),
            less_than=camera.get("count_threshold_less"),
            enabled=bool(camera.get("alert_enabled", True)),
        )

    @property
    def configured(self) -> bool:
        return self.greater_than is not None or self.less_than is not None

    def evaluate(self, count: int) -> Optional[Violation]:
        """The broken limit, or None. Over the top limit wins, as in InsightEye.

        Limits are checked whether or not alerts are enabled: the analytics
        report every violation, ``enabled`` only gates raising an alert.
        """
        if self.greater_than is not None and count > self.greater_than:
            return Violation(GREATER_THAN, self.greater_than, count)
        if self.less_than is not None and count < self.less_than:
            return Violation(LESS_THAN, self.less_than, count)
        return None


@dataclass(frozen=True)
class CountParams:
    """The counting knobs for one camera: .env values, overridden by the
    camera's ``settings`` JSON key by key."""

    confidence: float
    input_size: int
    sample_interval_s: float
    alert_cooldown_s: float

    OVERRIDES = {
        "confidence": float,
        "input_size": int,
        "sample_interval_s": float,
        "alert_cooldown_s": float,
    }

    @classmethod
    def defaults(cls) -> "CountParams":
        return cls(
            confidence=config.people_confidence,
            input_size=config.people_input_size,
            sample_interval_s=config.sample_interval_s,
            alert_cooldown_s=config.alert_cooldown_seconds,
        )

    @classmethod
    def from_settings(cls, settings: Optional[Dict[str, Any]]) -> "CountParams":
        values = cls.defaults().__dict__.copy()
        for key, cast in cls.OVERRIDES.items():
            raw = (settings or {}).get(key)
            if raw is None:
                continue
            try:
                values[key] = cast(raw)
            except (TypeError, ValueError):
                logger.warning("Ignoring camera setting %s=%r (not a number).", key, raw)
        return cls(**values)


def count_in_region(persons: Sequence[Person], roi: Optional[Sequence[Sequence[float]]]) -> List[Person]:
    """The people standing inside the counting region (everyone without one)."""
    if not roi:
        return list(persons)
    return [p for p in persons if person_in_polygon(p.box, roi)]


class CooldownGate:
    """At most one alert per ``cooldown_s``, per camera.

    Seeded with the camera's latest alert time when the worker starts, so a
    restart does not re-alert a crowd that was reported a minute ago.
    """

    def __init__(self, cooldown_s: float, last_alert_at: Optional[float] = None) -> None:
        self.cooldown_s = max(0.0, cooldown_s)
        self.last_alert_at = last_alert_at

    def ready(self, now: float) -> bool:
        return self.last_alert_at is None or now - self.last_alert_at >= self.cooldown_s

    def remaining(self, now: float) -> float:
        if self.last_alert_at is None:
            return 0.0
        return max(0.0, self.cooldown_s - (now - self.last_alert_at))

    def mark(self, now: float) -> None:
        self.last_alert_at = now


class PeopleDetector:
    """The YOLO people model of one camera worker.

    ``predict`` is stateless, so the instance only has to be per worker for
    thread safety: workers run their forward passes on separate threads.
    """

    def __init__(self, params: CountParams) -> None:
        from app.services.model_registry import model_registry

        self.params = params
        self.device = model_registry.device
        self.model = model_registry.create_yolo()
        # FP16 on CUDA; ultralytics 8.4 spells it quantize=16 (half= is deprecated).
        self.quantize = 16 if config.people_half and self.device.startswith("cuda") else None

    def detect(self, frame: np.ndarray) -> List[Person]:
        results = self.model.predict(
            frame,
            conf=self.params.confidence,
            classes=[config.person_class_id],
            imgsz=self.params.input_size,
            device=self.device,
            quantize=self.quantize,
            verbose=False,
        )
        persons: List[Person] = []
        for result in results:
            boxes = getattr(result, "boxes", None)
            if boxes is None or len(boxes) == 0:
                continue
            xyxy = boxes.xyxy.cpu().numpy()
            confs = boxes.conf.cpu().numpy()
            classes = boxes.cls.cpu().numpy().astype(int)
            for box, conf, cls in zip(xyxy, confs, classes):
                if cls != config.person_class_id:
                    continue
                persons.append(Person(tuple(float(v) for v in box), float(conf)))
        return persons
