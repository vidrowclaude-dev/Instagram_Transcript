from datetime import date, datetime, timedelta

import pytest

from app.extractors.base import VideoMeta
from app.extractors.filters import Filters, apply_filters


def make(n=30, start=datetime(2026, 10, 20)):
    """Newest-first stream; every 5th is a non-reel video; views vary."""
    return [
        VideoMeta(shortcode=f"S{i}", handle="b", url="u", posted_at=start - timedelta(days=i),
                  views=(i * 7919) % 100_000, is_reel=(i % 5 != 4))
        for i in range(n)
    ]


class Counting:
    def __init__(self, items):
        self.items, self.read = items, 0

    def __iter__(self):
        for x in self.items:
            self.read += 1
            yield x


def test_reels_only_drops_non_reels_but_keeps_unknown():
    vids = make(10)
    vids[0].is_reel = None
    out, _ = apply_filters(vids, Filters(content_type="reels"))
    assert all(v.is_reel is not False for v in out)
    assert "S0" in [v.shortcode for v in out]
    out_all, _ = apply_filters(make(10), Filters(content_type="all_videos"))
    assert len(out_all) == 10


def test_latest_n_stops_early():
    stream = Counting(make(100))
    out, st = apply_filters(stream, Filters(latest_n=5))
    assert len(out) == 5 and st["stopped"] == "latest_n"
    assert stream.read < 10


def test_most_viewed_scans_everything_then_sorts():
    stream = Counting(make(40))
    out, _ = apply_filters(stream, Filters(content_type="all_videos", sort="most_viewed", latest_n=3))
    assert stream.read == 40
    views = [v.views for v in out]
    assert views == sorted(views, reverse=True) and len(out) == 3
    assert views[0] == max(v.views for v in make(40))


def test_date_range_and_early_stop_after_old_posts():
    stream = Counting(make(200))
    f = Filters(content_type="all_videos", date_from=date(2026, 10, 10), date_to=date(2026, 10, 15))
    out, st = apply_filters(stream, f)
    assert {v.posted_at.day for v in out} == {10, 11, 12, 13, 14, 15}
    assert st["stopped"] == "date_range" and stream.read < 30


def test_pinned_old_post_does_not_stop_scan():
    vids = make(20)
    old_pinned = VideoMeta(shortcode="PIN", handle="b", url="u", posted_at=datetime(2020, 1, 1), is_pinned=True)
    out, _ = apply_filters([old_pinned] * 1 + vids, Filters(content_type="all_videos", date_from=date(2026, 10, 1)))
    assert len(out) == 20


def test_min_views():
    out, _ = apply_filters(make(30), Filters(content_type="all_videos", min_views=50_000))
    assert out and all(v.views >= 50_000 for v in out)


def test_max_scan_cap():
    out, st = apply_filters(make(100), Filters(content_type="all_videos", sort="most_viewed"), max_scan=25)
    assert st["scanned"] == 25 and st["stopped"] == "max_scan"


def test_from_dict_validation():
    f = Filters.from_dict({"content_type": "all_videos", "latest_n": "10", "min_views": "", "date_from": "2026-01-01"})
    assert f.latest_n == 10 and f.min_views is None and f.date_from == date(2026, 1, 1)
    with pytest.raises(ValueError):
        Filters.from_dict({"date_from": "2026-02-01", "date_to": "2026-01-01"})
    with pytest.raises(ValueError):
        Filters.from_dict({"sort": "random"})
