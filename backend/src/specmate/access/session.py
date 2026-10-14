"""Request-bound local account sessions through the shared operation layer."""

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.http import HttpRequest
from django.middleware.csrf import CsrfViewMiddleware, get_token
from pydantic import BaseModel, ConfigDict, Field

from specmate.access.account_names import LocalUsername
from specmate.access.models import Installation
from specmate.operations import Context, PermissionDenied, Unauthenticated, operation
from specmate.operations.core import ACCESS_AUTHENTICATED, ACCESS_PUBLIC


def require_browser_request(ctx: Context) -> HttpRequest:
    if ctx.via != "api" or not isinstance(ctx.request, HttpRequest):
        raise PermissionDenied("A browser session request is required.")
    request = ctx.request
    if request.method != "POST" or not hasattr(request, "session") or not hasattr(request, "user"):
        raise PermissionDenied("A browser session request is required.")

    # Public Ninja routes do not automatically run cookie-auth CSRF validation.
    # Check here too so every transport reaching the operation obeys the boundary.
    def protected_view(request):
        return None

    if (
        CsrfViewMiddleware(lambda request: None).process_view(request, protected_view, (), {})
        is not None
    ):
        raise PermissionDenied("CSRF verification failed.")
    return request


def session_state(request: HttpRequest) -> dict:
    user = None
    if request.user.is_authenticated:
        current = get_user_model().objects.filter(pk=request.user.pk, is_active=True).first()
        if current is not None:
            user = {"id": str(current.pk), "username": current.get_username()}
    get_token(request)
    return {
        "user": user,
        "owner_setup_required": not Installation.objects.filter(owner__isnull=False).exists(),
    }


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: LocalUsername
    password: str = Field(min_length=1, max_length=512, repr=False)


class Logout(BaseModel):
    model_config = ConfigDict(extra="forbid")


@operation(
    "session.login",
    Login,
    summary="Sign in to a local browser session.",
    public=True,
    supports_idempotency=False,
    access=ACCESS_PUBLIC,
)
def login_session(ctx: Context, payload: Login) -> dict:
    request = require_browser_request(ctx)
    user = authenticate(request=request, username=payload.username, password=payload.password)
    if user is None or not user.is_active:
        raise Unauthenticated("Invalid username or password.")
    login(request, user)
    return session_state(request)


@operation(
    "session.logout",
    Logout,
    summary="Sign out of the current browser session.",
    supports_idempotency=False,
    access=ACCESS_AUTHENTICATED,
)
def logout_session(ctx: Context, payload: Logout) -> dict:
    request = require_browser_request(ctx)
    # Actor identity must match the session, including for in-process adapters.
    if not request.user.is_authenticated or request.user.pk != ctx.user.pk:
        raise PermissionDenied("A browser session request is required.")
    logout(request)
    return session_state(request)
