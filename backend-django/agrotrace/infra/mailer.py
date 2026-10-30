"""
Outgoing mail over SMTP (dev: Mailpit), the port of backend-express/src/infra/mailer.ts. Letters are plain UTF-8 text
from @agrotrace/i18n (`mail.*`). Sending never blocks or fails the operation that asks for it (spec 8.9): `send` hands
the letter to a background thread after the response path, which tries 3 times with exponential back-off
(0.5 s, 1 s) and then logs the letter as not delivered — without its body (links in it are secrets). `send_once` is a
single attempt that raises (notification delivery, Task 12). Without SMTP_HOST mail is not configured.
"""

from __future__ import annotations

import logging
import smtplib
import threading
import time
from email.message import EmailMessage

from agrotrace.core import config

log = logging.getLogger("agrotrace.mailer")

#: Socket timeout of one SMTP session (connect, greeting, every command).
EMAIL_TIMEOUT = 10.0
BACKOFF_S = 0.5


class MailNotConfigured(RuntimeError):
    pass


def configured() -> bool:
    return bool(config.get().SMTP_HOST)


def send_once(to: str, subject: str, text: str) -> None:
    """One delivery attempt; raises when the server refuses or is unreachable (or mail is not configured)."""
    c = config.get()
    if not c.SMTP_HOST:
        raise MailNotConfigured("mail is not configured")
    msg = EmailMessage()
    msg["From"] = c.SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text, charset="utf-8")
    with smtplib.SMTP(c.SMTP_HOST, c.SMTP_PORT, timeout=EMAIL_TIMEOUT) as smtp:
        smtp.send_message(msg)


def _deliver(kind: str, to: str, subject: str, text: str) -> None:
    for attempt in range(1, 4):
        try:
            send_once(to, subject, text)
            return
        except MailNotConfigured:
            log.error("mail not delivered: SMTP_HOST is not set", extra={"kind": kind})
            return
        except Exception as e:  # any SMTP or network failure
            if attempt == 3:
                log.error("mail not delivered", extra={"kind": kind, "err": str(e)})
                return
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))


def send(kind: str, to: str, subject: str, text: str) -> threading.Thread:
    """Fire-and-forget on a daemon thread (returned for tests)."""
    th = threading.Thread(target=_deliver, args=(kind, to, subject, text), name=f"mail-{kind}", daemon=True)
    th.start()
    return th
