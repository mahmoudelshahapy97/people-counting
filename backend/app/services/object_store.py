# app/services/object_store.py
"""Alert snapshots in MinIO (S3-compatible); Postgres keeps the records and keys.

Every key is namespaced by camera, so removing a camera removes its media with
one prefix delete:

    alerts/<camera_id>/<alert_id>.jpg    annotated frame of an occupancy alert

Nothing here raises: a failed call logs and returns None/False, and callers fall
back to bytes in Postgres so an outage of the store never costs an alert. The
SDK is blocking, so calls run in threads.
"""

import asyncio
import io
import logging
import threading
from datetime import datetime, timezone
from typing import List, Optional, Tuple
from uuid import UUID

from app.core.config import config

logger = logging.getLogger(__name__)


def alert_key(camera_id: UUID, alert_id: UUID) -> str:
    return f"alerts/{camera_id}/{alert_id}.jpg"


def camera_prefix(camera_id: UUID) -> str:
    """Everything stored for one camera."""
    return f"alerts/{camera_id}/"


class ObjectStore:
    def __init__(self) -> None:
        self._client = None
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return bool(config.minio_endpoint)

    @property
    def bucket(self) -> str:
        return config.minio_bucket

    # ---------------------------------------------------------------- client
    def _connect(self):
        """The client, created (and the bucket ensured) on first use."""
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is None:
                from minio import Minio

                client = Minio(
                    config.minio_endpoint,
                    access_key=config.minio_access_key,
                    secret_key=config.minio_secret_key,
                    secure=config.minio_secure,
                )
                if not client.bucket_exists(self.bucket):
                    client.make_bucket(self.bucket)
                self._client = client
        return self._client

    async def _run(self, what: str, fn, *args):
        if not self.enabled:
            return None
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception as e:
            logger.warning("Object store %s failed: %s", what, e)
            return None

    # ------------------------------------------------------------------ write
    async def put_bytes(self, key: str, data: bytes, content_type: str) -> bool:
        def put():
            self._connect().put_object(
                self.bucket, key, io.BytesIO(data), len(data), content_type=content_type
            )
            return True

        return bool(await self._run(f"put {key}", put))

    # ------------------------------------------------------------------- read
    async def get_bytes(self, key: str) -> Optional[bytes]:
        def get():
            response = self._connect().get_object(self.bucket, key)
            try:
                return response.read()
            finally:
                response.close()
                response.release_conn()

        return await self._run(f"get {key}", get)

    async def size(self, key: str) -> Optional[int]:
        return await self._run(f"stat {key}", lambda: self._connect().stat_object(self.bucket, key).size)

    async def list(self, prefix: str) -> List[Tuple[float, int, str]]:
        """(mtime, size, key) under ``prefix``, oldest first; [] when unavailable."""

        def scan():
            entries = []
            for obj in self._connect().list_objects(self.bucket, prefix=prefix, recursive=True):
                modified = obj.last_modified or datetime.now(timezone.utc)
                entries.append((modified.timestamp(), obj.size or 0, obj.object_name))
            entries.sort()
            return entries

        return await self._run(f"list {prefix}", scan) or []

    # ----------------------------------------------------------------- delete
    async def remove(self, keys: List[str]) -> List[str]:
        """Delete ``keys``; returns the ones actually removed."""
        if not keys:
            return []

        def delete():
            from minio.deleteobjects import DeleteObject

            failed = {
                error.name
                for error in self._connect().remove_objects(
                    self.bucket, [DeleteObject(k) for k in keys]
                )
            }
            return [k for k in keys if k not in failed]

        return await self._run(f"remove {len(keys)} objects", delete) or []

    async def remove_prefix(self, prefix: str) -> int:
        keys = [key for _, _, key in await self.list(prefix)]
        return len(await self.remove(keys))

    async def healthy(self) -> bool:
        return bool(await self._run("health", lambda: self._connect().bucket_exists(self.bucket)))


object_store = ObjectStore()
