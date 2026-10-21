from django.urls import path

from agrotrace.modules.me import views

urlpatterns = [
    path("me", views.MeView.as_view()),
    path("me/avatar", views.AvatarView.as_view()),
    path("me/channels", views.ChannelsView.as_view()),
    path("me/telegram-code", views.TelegramCodeView.as_view()),
]
