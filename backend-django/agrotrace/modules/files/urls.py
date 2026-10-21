from django.urls import path

from agrotrace.modules.files import views

urlpatterns = [
    path("files/<str:id>", views.DownloadFileView.as_view()),
    path("public/files/<str:id>", views.DownloadPublicFileView.as_view()),
]
