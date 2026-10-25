# app/utils/mailer.py
"""Blocking SMTP send, shared by password-reset codes and occupancy alerts.

Callers run it on a thread (asyncio.to_thread) and only log a failure: a mail
server that is down must never take a request or a camera worker with it.
"""

import smtplib
from email.message import EmailMessage

from app.core.config import config


def send_blocking(message: EmailMessage) -> None:
    smtp_cls = smtplib.SMTP_SSL if config.smtp_ssl else smtplib.SMTP
    with smtp_cls(config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds) as smtp:
        if config.smtp_starttls and not config.smtp_ssl:
            smtp.starttls()
        if config.smtp_username:
            smtp.login(config.smtp_username, config.smtp_password)
        smtp.send_message(message)
