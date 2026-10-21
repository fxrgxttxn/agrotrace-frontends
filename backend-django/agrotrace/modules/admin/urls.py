from django.urls import path

from agrotrace.modules.admin import views

urlpatterns = [
    path("admin/organizations/<str:id>", views.AdminOrganizationView.as_view()),
    path("admin/organizations/<str:id>/approve", views.ApproveOrganizationView.as_view()),
]
