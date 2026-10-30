from django.urls import path

from agrotrace.modules.health import views

urlpatterns = [
    path("health/live", views.LiveView.as_view()),
    path("health/ready", views.ReadyView.as_view()),
]
