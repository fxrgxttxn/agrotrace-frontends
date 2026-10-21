from django.urls import path

from agrotrace.modules.users import views

urlpatterns = [
    path("users", views.UsersView.as_view()),
    path("users/<str:id>", views.UserView.as_view()),
    path("users/<str:id>/avatar", views.UserAvatarView.as_view()),
]
