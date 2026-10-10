from pytest_app import greet


def test_greet():
    assert greet("nexus") == "hello, nexus"
