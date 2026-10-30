from django.urls import path

from agrotrace.modules.recalls import views

urlpatterns = [
    path("recalls", views.RecallsView.as_view()),
    path("recalls/<str:id>", views.RecallView.as_view()),
    path("recalls/<str:id>/graph", views.RecallGraphView.as_view()),
    path("recall-tasks", views.RecallTasksView.as_view()),
    path("recall-tasks/<str:id>/confirm", views.RecallTaskConfirmView.as_view()),
]
