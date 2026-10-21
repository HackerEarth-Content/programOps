"""One exception for every business-rule refusal. The frontend branches on `code`,
never on the wording of `detail`."""

from __future__ import annotations


class DomainError(Exception):
    def __init__(self, code: str, detail: str, status_code: int = 409, **extra: object) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code
        self.extra = extra  # more fields for the response body, e.g. the current value in a conflict
