from django.urls import path

from agrotrace.modules.public import views

urlpatterns = [
    path("public/batches/<str:publicCode>", views.PublicBatchView.as_view()),
    path("public/batches/<str:publicCode>/complaints", views.PublicComplaintsView.as_view()),
    path("public/captcha", views.CaptchaView.as_view()),
]
