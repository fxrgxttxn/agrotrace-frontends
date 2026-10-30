from django.urls import path

from agrotrace.modules.processing import views

urlpatterns = [
    path("processing", views.ProcessingView.as_view()),
]
