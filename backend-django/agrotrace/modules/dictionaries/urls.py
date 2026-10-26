from django.urls import path

from agrotrace.modules.dictionaries import views

urlpatterns = [
    path("dictionaries/products/<str:id>/image", views.ProductImageView.as_view()),
    path("dictionaries/<str:name>", views.DictionaryView.as_view()),
    path("dictionaries/<str:name>/import", views.DictionaryImportView.as_view()),
    path("dictionaries/<str:name>/<str:id>", views.DictionaryEntryView.as_view()),
    path("public/regions", views.PublicRegionsView.as_view()),
]
