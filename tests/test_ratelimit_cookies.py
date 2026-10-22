import os

import pytest

from app.extractors.base import NotFoundError, PrivateAccountError, RateLimitedError, LoginRequiredError
from app.extractors.cookies import inspect_cookies, parse_cookies_text, save_cookies
from app.extractors.instagram import map_error, meta_from_node
from app.extractors.ratelimit import RateLimiter, backoff_seconds, retry_network


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def test_limiter_spaces_requests():
    c = FakeClock()
    rl = RateLimiter(2, 2, sleep=c.sleep, clock=c.now)
    rl.wait()
    rl.wait()
    rl.wait()
    assert c.slept == [2, 2]


def test_limiter_cooldown_blocks_next_request():
    c = FakeClock()
    rl = RateLimiter(0, 0, sleep=c.sleep, clock=c.now)
    rl.cooldown(30)
    assert rl.cooling_down_for == 30
    rl.wait()
    assert c.slept == [30]


def test_backoff_grows_and_caps():
    a = [backoff_seconds(i, 60, 900) for i in range(1, 8)]
    assert 48 <= a[0] <= 72
    assert a[2] > a[0]
    assert max(a) <= 900 * 1.2


def test_retry_network():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise OSError("boom")
        return "ok"

    assert retry_network(flaky, attempts=3, sleep=lambda s: None) == "ok"
    with pytest.raises(OSError):
        retry_network(lambda: (_ for _ in ()).throw(OSError("x")), attempts=2, sleep=lambda s: None)


def test_error_mapping():
    from instaloader import exceptions as ilx
    assert isinstance(map_error(ilx.ProfileNotExistsException("x")), NotFoundError)
    assert isinstance(map_error(ilx.PrivateProfileNotFollowedException("x")), PrivateAccountError)
    assert isinstance(map_error(ilx.TooManyRequestsException("429")), RateLimitedError)
    assert isinstance(map_error(ilx.ConnectionException("Please wait a few minutes before you try again.")),
                      RateLimitedError)
    assert isinstance(map_error(ilx.LoginRequiredException("login required")), LoginRequiredError)


def test_meta_from_graphql_node():
    node = {
        "shortcode": "Cabc123", "is_video": True, "product_type": "clips", "taken_at_timestamp": 1760000000,
        "edge_media_to_caption": {"edges": [{"node": {"text": "Big sale #diwali #offer"}}]},
        "video_view_count": 1200, "video_play_count": 5400,
        "edge_media_preview_like": {"count": 321}, "edge_media_to_comment": {"count": 12},
        "video_duration": 14.5, "display_url": "https://cdn/x.jpg", "owner": {"username": "Brand"},
        "clips_music_attribution_info": {"song_name": "Original audio", "artist_name": "brand"},
    }
    m = meta_from_node(node, None)
    assert m.shortcode == "Cabc123" and m.handle == "brand" and m.is_reel is True
    assert m.views == 5400 and m.likes == 321 and m.comments == 12 and m.duration == 14.5
    assert m.hashtags == ["diwali", "offer"] and m.audio_name == "Original audio - brand"
    assert m.url.endswith("/reel/Cabc123/")


COOKIES = """# Netscape HTTP Cookie File
.instagram.com\tTRUE\t/\tTRUE\t4102444800\tcsrftoken\tCSRF123
#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\t999%3Aabc
.instagram.com\tTRUE\t/\tTRUE\t4102444800\tds_user_id\t999
.google.com\tTRUE\t/\tTRUE\t4102444800\tSID\tsecret-google
"""


def test_cookies_parse_and_save_only_keeps_instagram(tmp_path):
    assert parse_cookies_text(COOKIES) == {"csrftoken": "CSRF123", "sessionid": "999%3Aabc", "ds_user_id": "999"}
    p = tmp_path / "secrets" / "cookies.txt"
    info = save_cookies(p, COOKIES)
    assert info.valid and info.user_id == "999"
    text = p.read_text()
    assert "google" not in text and "secret-google" not in text
    assert oct(os.stat(p).st_mode & 0o777) == "0o600"


def test_cookies_missing_session(tmp_path):
    p = tmp_path / "c.txt"
    save_cookies(p, ".instagram.com\tTRUE\t/\tTRUE\t4102444800\tcsrftoken\tX\n")
    info = inspect_cookies(p)
    assert info.present and not info.valid and "sessionid" in info.message
    with pytest.raises(ValueError):
        save_cookies(p, ".google.com\tTRUE\t/\tTRUE\t0\tSID\tx\n")
