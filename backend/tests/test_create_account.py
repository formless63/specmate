"""The operator create_account command shares the access operations."""

from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from specmate.access.models import Installation, WorkspaceMember

PASSWORD = "Demo-Account-Pass-12345"


def test_create_account_generates_a_password_once_and_sets_the_role(db):
    out = StringIO()
    call_command("create_account", username="first", role="admin", stdout=out)
    text = out.getvalue()
    assert "Created first as admin" in text and "Generated password (shown once):" in text
    password = text.rsplit(": ", 1)[1].strip()
    from django.contrib.auth import authenticate

    assert authenticate(username="first", password=password) is not None
    assert Installation.objects.get().owner.get_username() == "first"

    call_command("create_account", username="bench", role="editor", stdout=StringIO())
    member = WorkspaceMember.objects.get(user__username="bench")
    assert member.role == "editor"
    with pytest.raises(CommandError, match="not available"):
        call_command("create_account", username="bench", role="viewer", stdout=StringIO())


def test_create_account_reads_a_password_from_stdin_and_prints_none(db, monkeypatch):
    monkeypatch.setattr("sys.stdin", StringIO(PASSWORD + "\n"))
    out = StringIO()
    call_command("create_account", username="piped", role="admin", password_stdin=True, stdout=out)
    assert PASSWORD not in out.getvalue() and "Generated" not in out.getvalue()
    from django.contrib.auth import authenticate

    assert authenticate(username="piped", password=PASSWORD) is not None


def test_create_account_first_account_must_be_admin_and_weak_password_is_rejected(db, monkeypatch):
    with pytest.raises(CommandError, match="admin"):
        call_command("create_account", username="a", role="viewer", stdout=StringIO())
    monkeypatch.setattr("sys.stdin", StringIO("123\n"))
    with pytest.raises(CommandError, match="Password rejected"):
        call_command(
            "create_account", username="a", role="admin", password_stdin=True, stdout=StringIO()
        )
    assert not Installation.objects.filter(owner__isnull=False).exists()
