"""RQ worker entrypoint: `python -m app.worker`.

On boot it resumes any job a previous worker was running when it died,
then keeps sweeping for stale jobs once a minute.
"""
from __future__ import annotations

from app.config import get_settings
from app.db import get_engine
from app.jobs import queue
from app.logging_setup import get_logger, setup_logging

log = get_logger("app.worker")


def main() -> None:
    setup_logging()
    get_settings()
    get_engine()
    from rq import Queue, Worker

    conn = queue._redis()
    conn.ping()
    resumed = queue.resume_stale()
    if resumed:
        log.info("resumed jobs on boot", extra={"jobs": resumed})
    queue.StaleSweeper().start()
    Worker([Queue(queue.QUEUE_NAME, connection=conn)], connection=conn).work(with_scheduler=False)


if __name__ == "__main__":
    main()
