/**
 * A throwaway self-signed certificate for the fake SQL Server, so the tests can exercise
 * login-packet encryption without a real server and without a dependency.
 *
 * It is TEST FIXTURE DATA, not a secret: CN=fake-sqlserver, valid for ten years, and it is
 * only ever presented by a server that listens on 127.0.0.1 for the length of one test.
 * Regenerate with:
 *
 *   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
 *     -subj "/CN=fake-sqlserver" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
 *     -addext "basicConstraints=critical,CA:FALSE" \
 *     -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
 *     -addext "extendedKeyUsage=serverAuth"
 */
export const FAKE_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCwhSbwMutND3lq
E+UwgXgUZ8cyOzqw6cspsgiiwFjkasSjUZU8g9tqW29eKxz+pBls6Hp/kgKaia8Q
TxshSeMJaWiEjIz5hlOA+wxkxBNOa0F7x1AERhvfRaQhkrfCGIAlfaR9lLQyLv0b
FTbJu1dZF6aH70TchRNOgHsBmg6+++vBGELfI24HJE/0t3gLa1U0hyqa6yHZUuGU
PLXfy9anXvB2x7Z9NerqJYL6EJQ8nBSZCLjY4qxgVLzFqG0Av+eecW3a08303nB3
8QeuguVEVrXgdILO1KClb9YjMYnEaSTftSU0pUbxib1/544C4LtxlMSyTfOiqlYe
P0Tpel4/AgMBAAECggEAJMfBysfZVoe0ZUF6/mXjtuC+1T0ZKBa24du6R+srOoDy
sxMDNQZGeD1QEb+K/ZYExDgWmjE6wKeSpiPNg9yo5WOkxwWgNDfke1oUBYUDftID
ZX6ssg9HrHiOz/4JsvQ281jgJtiOyWwYCgYcEeGqvCIc7XMSFp7V3IQR3U4T54Au
MQENX3C4BRancwfe+LYYVv6ikcz6ZmmUpxJGlsKqUPXjYW5WTminTlGreIbJgYMu
32tBn/wzgcHWega/Lc3W8+BKO0aNTcacq59qAw5Wz7VdbYIiKgvVIgalD8xFCzsg
gViBwMI0ExA/b6kaJNAVsE703hFHZfhL42bSHh/8KQKBgQDvlLRLBPaiK6/U/lMO
m5IL5sJjEfr+8+R4KYJvP+p3qcFXCxLl2YpxWppILyNV8krJ/AZKUwE3Vyb5uK0I
SO0Jrn2O7LGz+DMBYTJv8NJU9407fFx/XRImTEp8gvcqJMfTWkxtp+CLFvX8cO28
8+RvDItpdft7oWmWRqX/mz+NyQKBgQC8nhYuAM+WPCiERFO1Tfi+LjCVP0oZelba
3JbLS+rDCowXsdge3bYcGRKPGo8rjnDRFXTrQtqdWiQEuV23vQHEZlqyPG8o4Bdm
KS489YVpFvOebNaQeZFgSHvk46U+cPmYAEbeDSFUF+lQyMbid3yOYHgLfqV4zAbG
4MMYUFFvxwKBgH3vC6pXbJEoJ5/tI5mNGwLYhJtw6x+y8ghbwW1bCpNmDvQDJSbe
58/X0TtaU9esqbVsnZ3Z7cy6KgmgEoxFURwCtYs4TdyM/bqe7dU7oEP7cCixoSlt
scmh1pGGggeMF+G4GG6XjQdvxVOxxLXK+euJi4qe8tc0rHzKnB007P5JAoGAHDRn
jKmCYSzNwjmVat8l+wpdKXQ1WGn64u9pfSz1BgVlvYVSlAsDWGBHbi7Cifja1ekn
eqacmjsId8xgP0F8KipEFbMDzFD2LsipqWPtdzF/bIlJ7IDBRGySWj/QTe4G5Lvl
3P6JpVGOCg577xF/BqtWSCHADLg1qzeg9NnN07ECgYBmf87IbyUCzdqLFXJKub/h
f25F7tiktzb8jNLfsn6mJeN1oC1B+QtvveM7jD4AGAKRVFbz/GDf/UbRBEiu5bJJ
lxk/5htrjXHgW1WaX8IogKR1TYF+ceBiHVRo1zdcderNCQzwedIDOzV17HcTXny/
ctiw5bzdhiSMojMZjvwh+Q==
-----END PRIVATE KEY-----`

export const FAKE_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDUzCCAjugAwIBAgIUd4TJeCg4DXuKhMJwlxjgNKoKkAkwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOZmFrZS1zcWxzZXJ2ZXIwHhcNMjYxMDAyMDkzODQ5WhcN
MzYwOTI5MDkzODQ5WjAZMRcwFQYDVQQDDA5mYWtlLXNxbHNlcnZlcjCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALCFJvAy600PeWoT5TCBeBRnxzI7OrDp
yymyCKLAWORqxKNRlTyD22pbb14rHP6kGWzoen+SApqJrxBPGyFJ4wlpaISMjPmG
U4D7DGTEE05rQXvHUARGG99FpCGSt8IYgCV9pH2UtDIu/RsVNsm7V1kXpofvRNyF
E06AewGaDr7768EYQt8jbgckT/S3eAtrVTSHKprrIdlS4ZQ8td/L1qde8HbHtn01
6uolgvoQlDycFJkIuNjirGBUvMWobQC/555xbdrTzfTecHfxB66C5URWteB0gs7U
oKVv1iMxicRpJN+1JTSlRvGJvX/njgLgu3GUxLJN86KqVh4/ROl6Xj8CAwEAAaOB
kjCBjzAdBgNVHQ4EFgQUjV0vWxjaUuJ1Et3HkUAegBf2uZowHwYDVR0jBBgwFoAU
jV0vWxjaUuJ1Et3HkUAegBf2uZowGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAAB
MAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUF
BwMBMA0GCSqGSIb3DQEBCwUAA4IBAQCwB0kgRdoeUp5IZaEwR6QB91oCsfjoGFoa
j2wc9wUCZuhw+YcF8foWE3Ir+/Qc5kMTeIL2w4eatPGUeDgn+xpp4k6dPOCTUs/3
tUwSwBDICkz8nLDlLxKJaCSyjBs9ATfpjuHIzueIkCs9FjKGp6bjcFL6tJa4GpXQ
RZ/2tllu8l1lG5/6rPa8JsG5gvrsqJArN857PJpEVfz290keoJGo6vxDMQAA1IPa
1rNu+079jQsWISuJ90YakQxVSWzeUyQlzGr3DJdaLMys25PD1T4a78T0ngvmlkHH
FsCueoDJnPUu9MD5zFR1Op+uU1jhtYeEBbpMz3PZvza+dOgbVhkz
-----END CERTIFICATE-----`
