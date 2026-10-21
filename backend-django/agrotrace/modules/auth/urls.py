from django.urls import path

from agrotrace.modules.auth import views

urlpatterns = [
    path("auth/login", views.LoginView.as_view()),
    path("auth/refresh", views.RefreshView.as_view()),
    path("auth/logout", views.LogoutView.as_view()),
    path("auth/2fa/verify", views.VerifyTwoFactorView.as_view()),
    path("auth/2fa/setup", views.SetupTwoFactorView.as_view()),
    path("auth/password/forgot", views.ForgotPasswordView.as_view()),
    path("auth/password/reset", views.ResetPasswordView.as_view()),
    path("auth/register-organization", views.RegisterOrganizationView.as_view()),
    path("auth/accept-invite", views.AcceptInviteView.as_view()),
]
