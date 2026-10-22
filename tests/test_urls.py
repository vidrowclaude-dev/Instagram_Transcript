import pytest

from app.extractors.urls import parse_inputs, parse_one


@pytest.mark.parametrize("raw, handle", [
    ("https://www.instagram.com/vidrow.in/", "vidrow.in"),
    ("https://instagram.com/Some_Brand", "some_brand"),
    ("instagram.com/brand?igsh=abc123", "brand"),
    ("www.instagram.com/brand/reels/", "brand"),
    ("https://m.instagram.com/brand/tagged/", "brand"),
    ("@brand_name", "brand_name"),
    ("brand.name", "brand.name"),
    ("http://instagr.am/brand", "brand"),
])
def test_profiles(raw, handle):
    t = parse_one(raw)
    assert t.kind == "profile" and t.handle == handle


@pytest.mark.parametrize("raw, sc", [
    ("https://www.instagram.com/reel/C9xYzAbCdEf/", "C9xYzAbCdEf"),
    ("https://www.instagram.com/reels/C9xYzAbCdEf/?utm_source=ig_web_copy_link", "C9xYzAbCdEf"),
    ("instagram.com/p/Cabc_12-3x/", "Cabc_12-3x"),
    ("https://www.instagram.com/tv/B1234567890/", "B1234567890"),
    ("https://www.instagram.com/brand/reel/C9xYzAbCdEf/", "C9xYzAbCdEf"),
])
def test_posts(raw, sc):
    t = parse_one(raw)
    assert t.kind == "post" and t.shortcode == sc


@pytest.mark.parametrize("raw", [
    "https://twitter.com/brand",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/stories/brand/123/",
    "https://www.instagram.com/reel/",
    "@bad..handle",
    "has space!",
    "@",
])
def test_invalid(raw):
    with pytest.raises(ValueError):
        parse_one(raw)


def test_story_message_is_specific():
    with pytest.raises(ValueError, match="Stories aren't supported"):
        parse_one("https://www.instagram.com/stories/brand/1/")


def test_parse_blob_dedupes_and_collects_errors():
    targets, errors = parse_inputs("""
        https://www.instagram.com/brand/
        @brand
        https://www.instagram.com/reel/C9xYzAbCdEf/, https://www.instagram.com/p/C9xYzAbCdEf/
        https://example.com/nope
    """)
    assert [(t.kind, t.handle or t.shortcode) for t in targets] == [("profile", "brand"), ("post", "C9xYzAbCdEf")]
    assert len(errors) == 1 and "not an Instagram link" in errors[0].message
