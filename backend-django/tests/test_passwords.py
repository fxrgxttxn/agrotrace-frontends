"""Argon2id PHC interop (§8.3): a hash made by Node `argon2.hash` with the seed's parameters verifies here, a new hash
has the shared prefix, an invited user's '!' is False (never an exception)."""

from agrotrace.security.passwords import dummy_verify, hash_password, verify_password

#: Made once with backend-express's argon2 (`argon2.hash('Ozimaya-2026!', {argon2id, m 65536, t 3, p 1})`).
NODE_PHC = "$argon2id$v=19$m=65536,t=3,p=1$Odp49aS40GhbOpOOQiri4w$cX6bIBmjqs6O12djJs7B4yfSN3W8bs64U1h1C09ajBY"


def test_a_node_hash_verifies():
    assert verify_password(NODE_PHC, "Ozimaya-2026!") is True
    assert verify_password(NODE_PHC, "Ozimaya-2026! ") is False  # byte-exact, never trimmed


def test_new_hashes_use_the_shared_parameters():
    h = hash_password("Ozimaya-2026!")
    assert h.startswith("$argon2id$v=19$m=65536,t=3,p=1$")
    salt, digest = h.split("$")[4:]
    assert len(salt) == 22 and len(digest) == 43  # 16-byte salt, 32-byte hash (unpadded base64)
    assert verify_password(h, "Ozimaya-2026!")


def test_not_a_phc_string_is_false():
    assert verify_password("!", "anything") is False
    assert verify_password("", "anything") is False
    dummy_verify("whatever")  # never raises
