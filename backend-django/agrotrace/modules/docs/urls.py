from django.urls import path

from agrotrace.modules.docs import views

# `/api/v1/docs` and `/api/v1/docs/` both serve the page (as Express); asset URLs are absolute.
urlpatterns = [
    path("docs", views.page),
    path("docs/", views.page),
    path("docs/init.js", views.init_js),
    path("docs/openapi.json", views.openapi_json),
    path("docs/<str:name>", views.asset),
]
