from django.urls import path

from agrotrace.modules.fields import views

urlpatterns = [
    path("fields", views.FieldsView.as_view()),
    path("fields/<str:id>", views.FieldView.as_view()),
    path("fields/<str:id>/treatments", views.FieldTreatmentsView.as_view()),
    path("treatments/<str:id>", views.TreatmentView.as_view()),
]
