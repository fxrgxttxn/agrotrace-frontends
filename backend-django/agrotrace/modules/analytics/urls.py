from django.urls import path

from agrotrace.modules.analytics import views

urlpatterns = [
    path("analytics/dashboard", views.DashboardView.as_view()),
]
