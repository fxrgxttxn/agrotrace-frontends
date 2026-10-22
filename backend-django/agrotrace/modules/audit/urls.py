from django.urls import path

from agrotrace.modules.audit import views

urlpatterns = [path("audit-log", views.AuditLogView.as_view())]
