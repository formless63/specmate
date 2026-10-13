"""Thin HTTP adapter for browser-local session operations."""

from ninja import Router, Schema
from pydantic import Field

from specmate.access.session import session_state
from specmate.operations import Context, OperationResult, execute

router = Router(tags=["session"])


class LoginRequest(Schema):
    request_id: str = Field(min_length=1, max_length=200)
    username: str
    password: str = Field(repr=False)


class LogoutRequest(Schema):
    request_id: str = Field(min_length=1, max_length=200)


def context(request, request_id: str) -> Context:
    return Context(
        user=request.user if request.user.is_authenticated else None,
        via="api",
        request_id=request_id,
        request=request,
    )


@router.get("", auth=None)
def current_session(request):
    return session_state(request)


@router.post("/login", auth=None, response=OperationResult)
def sign_in(request, body: LoginRequest):
    return execute(
        "session.login",
        context(request, body.request_id),
        {
            "username": body.username,
            "password": body.password,
        },
    )


@router.post("/logout", response=OperationResult)
def sign_out(request, body: LogoutRequest):
    return execute("session.logout", context(request, body.request_id), {})
