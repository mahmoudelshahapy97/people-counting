# app/core/config.py
"""Central application configuration loaded from environment variables and .env."""

from typing import List, Literal

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()


class Settings(BaseSettings):
    """
    Central application configuration.
    Loaded from:
    - Environment variables
    - .env
    - Defaults below
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # =========================================================================
    # APPLICATION
    # =========================================================================
    app_name: str = "People Counting API"
    app_description: str = "Per-camera head counts, occupancy alerts and footfall analytics"
    app_version: str = "1.0.0"
    app_api_prefix: str = "/api/v1"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = True
    environment: Literal["development", "staging", "production"] = "development"

    # =========================================================================
    # CORS
    # =========================================================================
    cors_origins: List[str] = ["http://localhost:3000", "http://localhost:8000"]
    cors_allow_credentials: bool = True
    cors_allow_methods: List[str] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    cors_allow_headers: List[str] = ["Content-Type", "Authorization", "X-Request-ID", "X-Workspace-Id"]

    # =========================================================================
    # AUTH
    # =========================================================================
    # No default: pydantic-settings refuses to build Settings without this set,
    # which is the right failure mode for a signing key. Generate one with:
    #   python -c "import secrets; print(secrets.token_urlsafe(48))"
    secret_key: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # Sent alongside the bearer token so <img src="..."> endpoints (camera
    # snapshots, the live view, alert frames) can authenticate without a
    # header. Never accepted on a route that changes state -- see
    # app/api/deps.py.
    auth_cookie_name: str = "pc_access"
    auth_cookie_secure: bool = False
    auth_cookie_samesite: str = "lax"

    # There is no public signup. If app_user is empty at startup, one admin is
    # created from these three values -- see ensure_bootstrap_admin() in
    # app/services/user_service.py. Change the password immediately after.
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_email: str = "admin@insighteye.local"
    bootstrap_admin_password: str = "ChangeMe!123"

    # "Forgot your password?": a one-time code mailed to the account's email
    # (app/services/otp_service.py). Off while SMTP_HOST is empty.
    otp_ttl_seconds: int = 600
    otp_resend_seconds: int = 60
    otp_max_attempts: int = 5

    # =========================================================================
    # EMAIL (SMTP)
    # =========================================================================
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "People Counting <no-reply@insighteye.local>"
    smtp_starttls: bool = True   # STARTTLS on smtp_port (587)
    smtp_ssl: bool = False       # implicit TLS instead (465)
    smtp_timeout_seconds: float = 20.0

    @property
    def password_reset_enabled(self) -> bool:
        return bool(self.smtp_host)

    # =========================================================================
    # LOGGING
    # =========================================================================
    log_level: str = "INFO"
    log_format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    log_file_path: str = "logs/peoplecount.log"

    # =========================================================================
    # DATABASE
    # =========================================================================
    postgres_db: str = "peoplecount_db"
    postgres_user: str = "peoplecount"
    postgres_password: str = "peoplecount_pass"
    db_host: str = "db"
    db_port: int = 5432

    db_min_pool_size: int = 2
    db_max_pool_size: int = 10
    db_timeout: float = 30.0
    db_command_timeout: float = 60.0
    db_max_retries: int = 10
    db_retry_delay_base: int = 2
    db_retry_delay_max: int = 30

    # database/migrations, mounted read-only by docker-compose.yml. When this
    # path is missing (a checkout run outside Docker) the repo's own folder is
    # used -- see app/core/migrations.py.
    migrations_dir: str = "/app/migrations"

    @property
    def database_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.db_host}:{self.db_port}/{self.postgres_db}"
        )

    # =========================================================================
    # MODELS
    # =========================================================================
    model_device: str = "cpu"

    # The InsightEye people detector: single-class YOLO, class 0 = person.
    people_model_path: str = "models/people.pt"
    people_confidence: float = 0.5
    people_input_size: int = 640
    person_class_id: int = 0
    # FP16 inference on CUDA; ignored on CPU.
    people_half: bool = True

    # =========================================================================
    # RTSP / STREAM
    # =========================================================================
    rtsp_transport: str = "tcp"
    rtsp_buffer_size: int = 1
    rtsp_open_timeout: float = 15.0
    rtsp_read_failure_limit: int = 30
    rtsp_reconnect_delay_base: float = 2.0
    rtsp_reconnect_delay_max: float = 30.0

    frame_skip: int = 5
    # Counting runs on every processed frame so the live view stays current;
    # only every sample_interval_s-th second is stored.
    target_process_fps: float = 2.0
    jpeg_quality: int = 85

    stream_start_stagger_delay: float = 2.0
    stream_worker_restart_delay: float = 5.0

    # Every live viewer costs one JPEG encode per frame; cap them so a wall of
    # open browser tabs cannot starve detection.
    max_mjpeg_clients: int = 4

    # =========================================================================
    # WORKER SUPERVISION
    # =========================================================================
    # Restarts workers that died, errored, or wedged inside a blocking read,
    # and starts enabled cameras that have no worker. Without it a camera whose
    # model load failed stays dark until someone notices by hand.
    worker_supervision_enabled: bool = True
    worker_supervision_interval_s: float = 15.0
    worker_restart_backoff_base_s: float = 5.0
    worker_restart_backoff_max_s: float = 300.0

    # =========================================================================
    # COUNTING
    # =========================================================================
    # One stored sample per camera this often (InsightEye: every 300th frame,
    # ~10 s at 30 fps). Each one is checked against the camera's limits.
    sample_interval_s: float = 10.0
    # A camera raises at most one alert per this window, however long it stays
    # out of range; every violating sample is still recorded.
    alert_cooldown_seconds: float = 600.0
    # Mail each alert to the workspace's operators and admins. Needs SMTP_HOST.
    alert_email_enabled: bool = False

    @property
    def alert_email_active(self) -> bool:
        return self.alert_email_enabled and bool(self.smtp_host)

    # =========================================================================
    # OBJECT STORAGE (MinIO)
    # =========================================================================
    # Alert snapshots go to MinIO; Postgres keeps the records and object keys.
    # Empty endpoint = disabled: snapshots stay in Postgres bytes.
    minio_endpoint: str = ""
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "peoplecount"
    minio_secure: bool = False

    # =========================================================================
    # RETENTION
    # =========================================================================
    retention_enabled: bool = True
    retention_interval_s: float = 21600.0  # 6 hours
    # Samples and violations older than this are deleted; the charts only
    # ever look back 90 days.
    sample_retention_days: int = 90
    # Alerts (and their snapshots) older than this are deleted.
    alert_retention_days: int = 90


config = Settings()
