"""
Routes under /api/v1 — strict and case-sensitive (P8): APPEND_SLASH is off and `path()` matches exactly, so
`/health/live/` and `/Health/live` are not the contract path. Ids are captured as plain `<str:…>` segments (never
`<uuid:…>`): a non-uuid id is the view's 400 `validation.uuid`, not a 404. Anything unmatched is the 404 problem.
"""

from django.urls import include, path

urlpatterns = [
    path("api/v1/", include("agrotrace.modules.health.urls")),
    path("api/v1/", include("agrotrace.modules.docs.urls")),
    path("api/v1/", include("agrotrace.modules.auth.urls")),
    path("api/v1/", include("agrotrace.modules.admin.urls")),
    path("api/v1/", include("agrotrace.modules.me.urls")),
    path("api/v1/", include("agrotrace.modules.users.urls")),
    path("api/v1/", include("agrotrace.modules.organizations.urls")),
    path("api/v1/", include("agrotrace.modules.files.urls")),
    path("api/v1/", include("agrotrace.modules.dictionaries.urls")),
    path("api/v1/", include("agrotrace.modules.audit.urls")),
    path("api/v1/", include("agrotrace.modules.fields.urls")),
    path("api/v1/", include("agrotrace.modules.batches.urls")),
    path("api/v1/", include("agrotrace.modules.waybills.urls")),
    path("api/v1/", include("agrotrace.modules.processing.urls")),
]

handler400 = "agrotrace.core.problem.handler400"
handler403 = "agrotrace.core.problem.handler403"
handler404 = "agrotrace.core.problem.handler404"
handler500 = "agrotrace.core.problem.handler500"
