from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import Client
from django.utils import timezone

from specmate.access.models import Installation, OwnerSetupToken
from specmate.access.operations import issue_owner_setup_token
from specmate.operations import Conflict

pytestmark = pytest.mark.django_db
PASSWORD = "correct horse battery staple"


def claim(client, token, username="first-owner", password=PASSWORD):
    body = {"request_id": "r1", "token": token, "username": username, "password": password}
    return client.post("/api/v0/setup/owner", body, content_type="application/json")


def test_claim_creates_owner_and_signs_in():
    token, _ = issue_owner_setup_token()
    client = Client()
    response = claim(client, token)
    assert response.status_code == 200, response.content
    assert Installation.objects.get().owner.username == "first-owner"
    assert client.get("/api/v0/projects").status_code == 200  # session established


def test_token_is_single_use_and_ownership_is_final():
    token, _ = issue_owner_setup_token()
    assert claim(Client(), token).status_code == 200
    second = claim(Client(), token, username="intruder")
    assert second.status_code == 422
    assert not get_user_model().objects.filter(username="intruder").exists()
    with pytest.raises(Conflict):
        issue_owner_setup_token()


def test_expired_revoked_and_unknown_tokens_fail_identically():
    old, record = issue_owner_setup_token()
    OwnerSetupToken.objects.filter(pk=record.pk).update(expires_at=timezone.now())
    expired = claim(Client(), old)
    newer, _ = issue_owner_setup_token()  # revokes nothing usable, issues a fresh token
    unknown = claim(Client(), "x" * 43)
    assert expired.status_code == unknown.status_code == 422
    assert expired.json()["error"]["message"] == unknown.json()["error"]["message"]
    assert claim(Client(), newer).status_code == 200


def test_issuing_revokes_previous_unused_token():
    first, _ = issue_owner_setup_token()
    issue_owner_setup_token()
    assert claim(Client(), first).status_code == 422


def test_weak_password_does_not_consume_token():
    token, _ = issue_owner_setup_token()
    assert claim(Client(), token, password="short").status_code == 422
    assert claim(Client(), token).status_code == 200


def test_token_lifetime_is_short():
    _, record = issue_owner_setup_token()
    assert record.expires_at - timezone.now() <= timedelta(minutes=30)


def test_management_command_prints_token_once(capsys):
    call_command("owner_setup_token")
    token = capsys.readouterr().out.strip().splitlines()[-1]
    assert claim(Client(), token).status_code == 200
