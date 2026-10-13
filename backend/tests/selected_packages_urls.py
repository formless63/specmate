"""Isolated router harness, also used before the application integration hooks land."""

from django.urls import path
from ninja import NinjaAPI
from ninja.security import django_auth

from specmate.operations import OperationError
from specmate.selected_packages.api import router

api = NinjaAPI(urls_namespace="selected-package-tests", auth=django_auth)
api.add_router("/v0/selected-packages", router)


@api.exception_handler(OperationError)
def operation_error(request, exc):
    return api.create_response(request, {"error": exc.as_dict()}, status=exc.http_status)


urlpatterns = [path("api/", api.urls)]
