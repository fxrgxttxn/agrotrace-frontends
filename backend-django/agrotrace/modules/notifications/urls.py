from django.urls import path

from agrotrace.modules.notifications import views
from agrotrace.sse.stream import stream_events

urlpatterns = [
    path("notifications", views.NotificationsView.as_view()),
    path("notifications/read", views.NotificationsReadView.as_view()),
    path("events/stream", stream_events),
]
