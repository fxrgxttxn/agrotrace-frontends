"""/users/* (contracts/openapi/paths/users.yaml): HTTP mapping of modules.users.services and getUserAvatar."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.params import variant_param
from agrotrace.core.views import ContractView
from agrotrace.modules.files.services import CACHE_PRIVATE, serve
from agrotrace.modules.users import services
from agrotrace.modules.users.serializers import UserInvite, UserPatch


class UsersView(ContractView):
    operation_ids = {"GET": "listUsers", "POST": "inviteUser"}

    def get(self, request):
        return Response(services.list_users(self.principal, request))  # type: ignore[arg-type]

    def post(self, request):
        return Response(services.invite(self.principal, self.body(UserInvite)), status=201)  # type: ignore[arg-type]


class UserView(ContractView):
    operation_ids = {"PATCH": "updateUser"}

    def patch(self, request, id):
        user_id = self.path_uuid()
        return Response(services.update(self.principal, user_id, self.body(UserPatch)))  # type: ignore[arg-type]


class UserAvatarView(ContractView):
    operation_id = "getUserAvatar"

    def get(self, request, id):
        user_id = self.path_uuid()
        variant = variant_param(request)
        return serve(request, services.avatar_file(user_id), variant, CACHE_PRIVATE)
