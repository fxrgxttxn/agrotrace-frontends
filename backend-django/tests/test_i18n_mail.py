"""Letters: subject and text of the password-reset and invitation mails equal @agrotrace/i18n's output for the same
parameters (literals taken from `createT('ru')` run under backend-express)."""

from agrotrace.infra.i18n import t


def test_password_reset_letter():
    assert t("mail.passwordReset.subject") == "AgroTrace: восстановление пароля"
    assert t("mail.passwordReset.body", {"link": "http://localhost:8088/password/reset/TOKEN",
                                         "fullName": "Тестов Тест"}) == (
        "Здравствуйте, Тестов Тест!\n\nМы получили запрос на смену пароля для входа в AgroTrace. Чтобы задать новый "
        "пароль, откройте ссылку:\n\nhttp://localhost:8088/password/reset/TOKEN\n\nСсылка действует 1 час и может "
        "быть использована один раз. Если вы не запрашивали смену пароля, просто проигнорируйте это письмо."
    )


def test_invitation_letter():
    assert t("mail.invite.subject", {"organizationName": "ООО «Ромашка»"}) == (
        "AgroTrace: приглашение в организацию ООО «Ромашка»"
    )
    assert t("mail.invite.body", {"organizationName": "ООО «Ромашка»", "link": "http://localhost:8088/invite/TOKEN"}) == (
        "Здравствуйте!\n\nВас пригласили в организацию ООО «Ромашка» в системе AgroTrace. Чтобы принять приглашение, "
        "укажите ФИО и задайте пароль по ссылке:\n\nhttp://localhost:8088/invite/TOKEN\n\nСсылка действует 7 дней и "
        "может быть использована один раз."
    )


def test_a_missing_key_is_the_key():
    assert t("mail.nope.subject") == "mail.nope.subject"
