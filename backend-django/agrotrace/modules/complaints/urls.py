from django.urls import path

from agrotrace.modules.complaints import views

urlpatterns = [
    path("complaints", views.ComplaintsView.as_view()),
    path("complaints/<str:id>", views.ComplaintView.as_view()),
    path("complaints/<str:id>/review", views.ComplaintReviewView.as_view()),
    path("complaints/<str:id>/decision", views.ComplaintDecisionView.as_view()),
]
