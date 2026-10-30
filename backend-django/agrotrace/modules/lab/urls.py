from django.urls import path

from agrotrace.modules.lab import views

urlpatterns = [
    path("lab-tests", views.LabTestsView.as_view()),
    path("lab-tests/<str:id>", views.LabTestView.as_view()),
    path("lab-tests/<str:id>/sample", views.LabSampleView.as_view()),
    path("lab-tests/<str:id>/results", views.LabResultsView.as_view()),
    path("lab-tests/<str:id>/protocol", views.LabProtocolView.as_view()),
]
