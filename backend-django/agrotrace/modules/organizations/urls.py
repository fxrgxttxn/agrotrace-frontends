from django.urls import path

from agrotrace.modules.organizations import views

urlpatterns = [
    path("organizations", views.OrganizationsView.as_view()),
    path("organizations/<str:id>", views.OrganizationView.as_view()),
    path("organizations/<str:id>/logo", views.OrganizationLogoView.as_view()),
]
