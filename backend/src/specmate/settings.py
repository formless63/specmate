"""Django settings. Configuration comes from SPECMATE_* environment variables."""

import json
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(f"SPECMATE_{name}", default)


# "development" only relaxes local conveniences (secret fallback, debug pages).
# It never grants authority to reset or delete state.
ENVIRONMENT = env("ENVIRONMENT", "production")
DEVELOPMENT = ENVIRONMENT == "development"
DEBUG = DEVELOPMENT and env("DEBUG", "false") == "true"

SECRET_KEY = env("SECRET_KEY") or ("development-only-insecure-key" if DEVELOPMENT else None)
if not SECRET_KEY:
    raise ImproperlyConfigured("SPECMATE_SECRET_KEY is required outside development.")

ALLOWED_HOSTS = [h for h in (env("ALLOWED_HOSTS", "localhost,127.0.0.1") or "").split(",") if h]

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "specmate.operations",
    "specmate.access",
    "specmate.design",
    "specmate.catalog",
    "specmate.facts",
    "specmate.wire_stock",
    "specmate.workshop_profiles",
    "specmate.inventory",
    "specmate.physical_units",
    "specmate.bom",
    "specmate.assemblies",
    "specmate.interfaces",
    "specmate.sources",
    "specmate.builds",
    "specmate.pcb",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

ROOT_URLCONF = "specmate.urls"
ASGI_APPLICATION = "specmate.asgi.application"
WSGI_APPLICATION = "specmate.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "HOST": env("DB_HOST", "localhost"),
        "PORT": env("DB_PORT", "5432"),
        "NAME": env("DB_NAME", "specmate"),
        "USER": env("DB_USER", "specmate"),
        "PASSWORD": env("DB_PASSWORD", ""),
        "ATOMIC_REQUESTS": False,
        "CONN_MAX_AGE": 60,
        "CONN_HEALTH_CHECKS": True,
    }
}

# Application-owned content-addressed storage for source and artifact bytes.
SPECMATE_ARTIFACT_ROOT = env("ARTIFACT_ROOT", str(BASE_DIR.parents[1] / ".artifacts"))
SPECMATE_MAX_SOURCE_BYTES = int(env("MAX_SOURCE_BYTES", str(256 * 1024 * 1024)) or 0)

# Operator-installed recipes are explicit capabilities; no recipe is enabled by default.
_recipes_file = env("APPROVED_RECIPES_FILE")
SPECMATE_APPROVED_RECIPES = json.loads(
    Path(_recipes_file).read_text() if _recipes_file else (env("APPROVED_RECIPES", "{}") or "{}")
)
SPECMATE_LEASE_SECONDS = int(env("LEASE_SECONDS", "60") or 60)
SPECMATE_TEMPORAL_ADDRESS = env("TEMPORAL_ADDRESS", "temporal:7233")
SPECMATE_TEMPORAL_NAMESPACE = env("TEMPORAL_NAMESPACE", "specmate")
SPECMATE_TEMPORAL_TASK_QUEUE = env("TEMPORAL_TASK_QUEUE", "specmate-builds")

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = env("SECURE_COOKIES", "false" if DEVELOPMENT else "true") == "true"
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
CSRF_TRUSTED_ORIGINS = [o for o in (env("CSRF_TRUSTED_ORIGINS", "") or "").split(",") if o]
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
}
