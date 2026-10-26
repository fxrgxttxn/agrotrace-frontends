from django.urls import path

from agrotrace.modules.reports import views

urlpatterns = [
    path("reports/<str:type>", views.ReportView.as_view()),
]
