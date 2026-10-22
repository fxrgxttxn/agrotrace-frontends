from django.urls import path

from agrotrace.modules.batches import views

urlpatterns = [
    path("batches", views.BatchesView.as_view()),
    path("batches/<str:id>", views.BatchView.as_view()),
    path("batches/<str:id>/graph", views.BatchGraphView.as_view()),
    path("batches/<str:id>/history", views.BatchHistoryView.as_view()),
    path("batches/<str:id>/path", views.BatchPathView.as_view()),
    path("batches/<str:id>/qr", views.BatchQrView.as_view()),
    path("batches/<str:id>/documents", views.BatchDocumentsView.as_view()),
    path("batches/<str:id>/documents/vsd/retry", views.BatchVsdRetryView.as_view()),
    path("batches/<str:id>/on-sale", views.BatchOnSaleView.as_view()),
    path("batches/<str:id>/sold", views.BatchSoldView.as_view()),
]
