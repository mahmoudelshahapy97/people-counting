# app/services/model_registry.py
"""Thread-safe loading of the YOLO people detector and resolution of the model device.

Each camera worker gets its own detector instance: forward passes run on the
workers' threads, and one model object shared between threads is not safe.
"""

import logging
import os
import threading
from typing import Any, Optional

from app.core.config import config

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self) -> None:
        self._yolo_lock = threading.Lock()
        self._device: Optional[str] = None

    # ------------------------------------------------------------------ device
    @property
    def device(self) -> str:
        """Resolve the configured device once, falling back to CPU when CUDA is absent."""
        if self._device is not None:
            return self._device

        requested = (config.model_device or "cpu").lower()
        if requested.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    logger.warning("MODEL_DEVICE=%s but CUDA is unavailable; using cpu.", requested)
                    requested = "cpu"
            except Exception as e:
                logger.warning("Could not probe CUDA (%s); using cpu.", e)
                requested = "cpu"

        self._device = requested
        return self._device

    # -------------------------------------------------------------------- yolo
    def create_yolo(self) -> Any:
        """Build a fresh YOLO instance. One per camera worker."""
        from ultralytics import YOLO

        weights = config.people_model_path

        # people.pt is InsightEye's own checkpoint, not an Ultralytics release,
        # so a missing file cannot be downloaded -- say so plainly.
        if not os.path.exists(weights):
            raise FileNotFoundError(
                f"People model {weights} not found; see backend/models/README.md."
            )
        with self._yolo_lock:  # serialise loads across workers
            model = YOLO(weights)

        logger.info("People detector loaded (%s) on %s", weights, self.device)
        return model


model_registry = ModelRegistry()
