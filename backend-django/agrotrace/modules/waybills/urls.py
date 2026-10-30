from django.urls import path

from agrotrace.modules.waybills import views

urlpatterns = [
    path("waybills", views.WaybillsView.as_view()),
    path("waybills/<str:id>", views.WaybillView.as_view()),
    path("waybills/<str:id>/send", views.WaybillSendView.as_view()),
    path("waybills/<str:id>/accept", views.WaybillAcceptView.as_view()),
    path("waybills/<str:id>/reject", views.WaybillRejectView.as_view()),
]
