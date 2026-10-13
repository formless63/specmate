from django.urls import path

from specmate.api import api

urlpatterns = [
    path("api/", api.urls),
]
