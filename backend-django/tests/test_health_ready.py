"""health/ready: the probes share ONE deadline (Express routes.ts probe()), so hung dependencies never add up."""

import time

from agrotrace.modules.health.views import run_checks


def _hang(seconds: float):
    def fn():
        time.sleep(seconds)

    return fn


def _ok():
    return None


def _boom():
    raise RuntimeError("down")


def test_hung_probes_share_one_deadline():
    started = time.monotonic()
    out = run_checks({"db": _hang(3), "redis": _hang(3), "rabbitmq": _ok, "s3": _hang(3)}, 0.4)
    elapsed = time.monotonic() - started
    assert out == {"db": "fail", "redis": "fail", "rabbitmq": "ok", "s3": "fail"}
    assert elapsed < 0.8, elapsed  # serial waits would take ≥ 1.2 s


def test_a_late_probe_that_finishes_before_the_deadline_is_ok_and_errors_fail():
    out = run_checks({"db": _hang(0.1), "redis": _boom}, 1.0)
    assert out == {"db": "ok", "redis": "fail"}


def test_a_probe_finishing_after_an_earlier_probes_timeout_is_still_fail():
    # The review's case: db hangs past the deadline, redis finishes after it — redis must not be reported ok.
    out = run_checks({"db": _hang(2), "redis": _hang(0.6)}, 0.3)
    assert out == {"db": "fail", "redis": "fail"}
