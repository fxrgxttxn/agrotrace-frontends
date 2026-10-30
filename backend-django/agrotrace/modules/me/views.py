"""/me/* (contracts/openapi/paths/me.yaml): HTTP mapping of modules.me.services."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.multipart import read_single_file
from agrotrace.core.views import ContractView
from agrotrace.modules.me import services
from agrotrace.modules.me.serializers import ChannelsUpdate, MeUpdate


class MeView(ContractView):
    operation_ids = {"GET": "getMe", "PATCH": "updateMe"}

    def get(self, request):
        return Response(services.me(self.principal.user_id))  # type: ignore[union-attr]

    def patch(self, request):
        return Response(services.update_me(self.principal, self.body(MeUpdate)))  # type: ignore[arg-type]


class AvatarView(ContractView):
    operation_ids = {"PUT": "uploadMyAvatar", "DELETE": "deleteMyAvatar"}

    def put(self, request):
        upload = read_single_file(request, max_bytes=services.AVATAR_MAX_BYTES)
        return Response(services.upload_avatar(self.principal, upload))  # type: ignore[arg-type]

    def delete(self, request):
        services.delete_avatar(self.principal)  # type: ignore[arg-type]
        return Response(status=204)


class ChannelsView(ContractView):
    operation_ids = {"GET": "getMyChannels", "PUT": "updateMyChannels"}

    def get(self, request):
        return Response(services.channels(self.principal))  # type: ignore[arg-type]

    def put(self, request):
        return Response(services.update_channels(self.principal, self.body(ChannelsUpdate)))  # type: ignore[arg-type]


class TelegramCodeView(ContractView):
    operation_id = "createTelegramCode"

    def post(self, request):
        return Response(services.create_telegram_code(self.principal), status=201)  # type: ignore[arg-type]
