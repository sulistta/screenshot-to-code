import pytest


@pytest.fixture(autouse=True)
def isolate_application_services(monkeypatch: pytest.MonkeyPatch) -> None:
    """HTTP unit tests must not start persistent app supervisors on a shared port."""
    monkeypatch.setenv("STUDIO_RUNTIME_DISABLED", "1")
