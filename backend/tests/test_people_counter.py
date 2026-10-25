"""The counting rules - no model, no camera, no database."""

import pytest

from app.core.config import config
from app.services.filters import CountFilters, split_values
from app.services.people_counter import (
    GREATER_THAN,
    LESS_THAN,
    CooldownGate,
    CountParams,
    Person,
    Thresholds,
    count_in_region,
)


# ---------------------------------------------------------------- thresholds
@pytest.mark.parametrize(
    "count, expected",
    [(0, LESS_THAN), (1, LESS_THAN), (2, None), (10, None), (11, GREATER_THAN), (50, GREATER_THAN)],
)
def test_band_between_less_and_greater(count, expected):
    # InsightEye: count > greater_than or count < less_than; the limits themselves are fine.
    t = Thresholds(greater_than=10, less_than=2)
    violation = t.evaluate(count)
    assert (violation.threshold_type if violation else None) == expected


def test_violation_carries_the_limit_it_broke():
    over = Thresholds(greater_than=10, less_than=2).evaluate(14)
    assert (over.threshold_type, over.threshold_value, over.count) == (GREATER_THAN, 10, 14)
    assert over.describe == "above 10"
    under = Thresholds(less_than=2).evaluate(0)
    assert under.describe == "below 2"


def test_open_sides_never_trigger():
    assert Thresholds().evaluate(10_000) is None
    assert not Thresholds().configured
    assert Thresholds(greater_than=5).evaluate(0) is None
    assert Thresholds(less_than=5).evaluate(10_000) is None


def test_zero_is_a_real_limit():
    # "Nobody may be here": greater_than=0 alerts on one person.
    assert Thresholds(greater_than=0).evaluate(1).threshold_type == GREATER_THAN
    assert Thresholds(greater_than=0).evaluate(0) is None


def test_disabled_alerts_still_evaluate():
    """Violations are recorded either way; ``enabled`` only gates raising alerts."""
    t = Thresholds(greater_than=3, enabled=False)
    assert t.evaluate(4) is not None
    assert not t.enabled


def test_thresholds_from_a_camera_row():
    t = Thresholds.from_camera(
        {"count_threshold_greater": 20, "count_threshold_less": None, "alert_enabled": False}
    )
    assert t == Thresholds(greater_than=20, less_than=None, enabled=False)


# ------------------------------------------------------------------ cooldown
def test_cooldown_lets_the_first_alert_through_then_waits():
    gate = CooldownGate(600)
    assert gate.ready(1000.0)
    gate.mark(1000.0)
    assert not gate.ready(1000.0 + 599)
    assert gate.remaining(1000.0 + 599) == pytest.approx(1.0)
    assert gate.ready(1000.0 + 600)


def test_cooldown_seeded_from_the_last_stored_alert():
    gate = CooldownGate(600, last_alert_at=1000.0)
    assert not gate.ready(1300.0)
    assert gate.ready(1700.0)


def test_zero_cooldown_alerts_every_time():
    gate = CooldownGate(0)
    gate.mark(5.0)
    assert gate.ready(5.0)


# -------------------------------------------------------------------- region
def test_everyone_counts_without_a_region():
    people = [Person((0, 0, 10, 10), 0.9), Person((500, 500, 510, 600), 0.8)]
    assert count_in_region(people, None) == people


def test_region_keeps_only_the_people_standing_in_it():
    inside = Person((10, 10, 30, 90), 0.9)     # feet at (20, 90)
    outside = Person((200, 10, 220, 90), 0.9)  # feet at (210, 90)
    roi = [[0, 50], [100, 50], [100, 100], [0, 100]]
    assert count_in_region([inside, outside], roi) == [inside]


# -------------------------------------------------------------------- params
def test_params_default_to_the_env_values():
    params = CountParams.from_settings({})
    assert params.confidence == config.people_confidence
    assert params.sample_interval_s == config.sample_interval_s
    assert params.alert_cooldown_s == config.alert_cooldown_seconds


def test_camera_settings_override_key_by_key():
    params = CountParams.from_settings({"confidence": "0.7", "sample_interval_s": 30, "other": 1})
    assert params.confidence == 0.7
    assert params.sample_interval_s == 30.0
    assert params.input_size == config.people_input_size


def test_bad_override_is_ignored():
    assert CountParams.from_settings({"confidence": "high"}).confidence == config.people_confidence


# ------------------------------------------------------------------- filters
def test_location_values_accept_lists_and_comma_joined():
    assert split_values(["Main", "Annex, Depot ", ""]) == ["Main", "Annex", "Depot"]
    assert split_values(None) is None
    assert split_values([" , "]) is None


def test_filters_reject_a_reversed_or_huge_range():
    from datetime import date
    from uuid import uuid4

    with pytest.raises(ValueError):
        CountFilters(uuid4(), start_date=date(2026, 5, 2), end_date=date(2026, 5, 1)).validate()
    with pytest.raises(ValueError):
        CountFilters(uuid4(), start_date=date(2024, 1, 1), end_date=date(2026, 1, 1)).validate()
    CountFilters(uuid4(), start_date=date(2026, 5, 1), end_date=date(2026, 5, 1)).validate()


# ---------------------------------------------------------------------- mail
def test_alert_mail_reads_like_insighteye():
    from datetime import datetime, timezone
    from uuid import uuid4

    from app.services.alert_service import alert_service
    from app.services.people_counter import Violation

    camera = {"camera_id": uuid4(), "name": "Lobby", "building": "HQ", "floor_level": "2", "zone": "East"}
    at = datetime(2026, 5, 1, 9, 30, tzinfo=timezone.utc)
    high = alert_service._message(camera, Violation(GREATER_THAN, 20, 27), at, ["a@example.com"])
    assert high["Subject"] == "HIGH OCCUPANCY ALERT - Lobby"
    text = high.get_body(("plain",)).get_content()
    assert "HQ - Floor 2 - East" in text and "27" in text and "more than 20" in text

    low = alert_service._message(camera, Violation(LESS_THAN, 1, 0), at, ["a@example.com", "b@example.com"])
    assert low["Subject"].startswith("LOW OCCUPANCY ALERT")
    assert low["To"] == "a@example.com, b@example.com"
