"""Translate raw API / network errors into clear, user-facing Vietnamese.

The generator surfaces a lot of low-level error strings to the gallery
(Google JSON blobs, Playwright stack fragments, Vertex gRPC statuses, …).
End users can't act on `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}`.

`friendly_error()` maps the most common failure signatures to a short,
actionable message in Vietnamese. The original string is preserved by the
caller (broadcast as `error_detail`, kept in app.log) so debugging info is
never lost — this only changes what's shown on the card.

Ordering matters: patterns are checked most-specific → most-generic, and the
FIRST match wins. Quota (429) is checked before the generic "permission"
bucket because a quota error often also mentions the project, etc.
"""
from __future__ import annotations


def friendly_error(raw: str) -> str:
    """Return a clear Vietnamese message for a raw error string.

    Falls back to the trimmed raw string when nothing matches, so unusual
    errors are still shown rather than swallowed.
    """
    if not raw:
        return "Lỗi không xác định"
    s = str(raw)
    low = s.lower()

    def has(*subs: str) -> bool:
        return any(sub in low for sub in subs)

    # ── Quota / rate exhausted (free Labs Flow daily cap, Vertex quota) ──
    if has("resource_exhausted", "per_model_daily_quota", "quota", "429",
           "resource has been exhausted"):
        return (
            "Hết lượt tạo của tài khoản/model này hôm nay (Google giới hạn "
            "quota theo ngày). Cách xử lý: đổi sang tài khoản Google khác ở "
            "tab Tài Khoản, hoặc chuyển Auth mode sang Vertex AI (Cài đặt) "
            "để không bị giới hạn, hoặc đợi sang ngày mai quota tự reset."
        )

    # ── reCAPTCHA / bot detection (403 on free Labs Flow) ──
    # Checked before the generic permission bucket; "unusual_activity" and
    # "recaptcha" are unambiguous bot-detection signals.
    if has("recaptcha", "unusual_activity", "unusual traffic", "captcha"):
        return (
            "Google tạm chặn vì nghi ngờ tự động (reCAPTCHA). Thử lại sau "
            "vài phút, đổi tài khoản, hoặc bật chế độ Chrome Extension Bridge "
            "trong Cài đặt để giảm bị chặn."
        )

    # ── Safety / content policy block ──
    if has("safety", "blocked", "prohibited", "violat", "responsible ai",
           "content policy", "finish_reason", "image_safety", "person/face",
           "sensitive"):
        return (
            "Nội dung bị Google chặn do vi phạm chính sách (nhạy cảm / bản "
            "quyền / người thật…). Hãy chỉnh lại prompt rồi gen lại."
        )

    # ── Session / login expired ──
    if has("session", "hết hạn", "expired", "session dead", "unauthorized",
           "401", "đăng nhập", "login lại"):
        return (
            "Phiên đăng nhập của tài khoản đã hết hạn. Vào tab Tài Khoản để "
            "đăng nhập lại, rồi gen lại."
        )

    # ── Vertex AI credential / permission (IAM) issues ──
    if has("permission_denied", "permission denied", "iam", "403",
           "does not have permission", "caller does not have"):
        return (
            "Tài khoản dịch vụ Vertex AI thiếu quyền (IAM) hoặc bị từ chối "
            "(403). Kiểm tra service account / project trong Cài đặt."
        )
    if has("no api key", "credentials", "could not automatically determine",
           "default credentials", "service account"):
        return (
            "Vertex AI chưa cấu hình credentials đúng. Kiểm tra service "
            "account trong Cài đặt (Auth mode = Vertex AI)."
        )

    # ── Model not found / unsupported ──
    if has("not_found", "not found", "404", "không hỗ trợ", "unsupported",
           "is not supported", "no such model", "model not"):
        return (
            "Model không khả dụng hoặc không hỗ trợ cho chế độ này. Đổi model "
            "trong tab tạo, hoặc kiểm tra lại cấu hình ở Cài đặt."
        )

    # ── Timeout ──
    if has("timeout", "timed out", "deadline", "deadline_exceeded", "etimedout"):
        return (
            "Quá thời gian chờ Google phản hồi. Mạng có thể chậm — bấm Gen "
            "lại để thử lại."
        )

    # ── Network / connectivity ──
    if has("failed to fetch", "connection", "connect", "network",
           "getaddrinfo", "econn", "name resolution", "ssl", "max retries",
           "temporary failure", "unreachable"):
        return (
            "Lỗi kết nối mạng tới Google. Kiểm tra Internet/VPN rồi bấm Gen "
            "lại."
        )

    # ── Download / save failure ──
    if has("download failed", "download", "tải", "save", "ghi file",
           "no media_id", "media_id", "permission denied"):
        return (
            "Tạo xong nhưng tải/lưu file kết quả thất bại. Bấm Gen lại để "
            "thử lại."
        )

    # ── Transient Google server errors ──
    if has("internal error", "internal_error", "500", "503", "502",
           "unavailable", "try again", "backend error", "service is currently"):
        return (
            "Google đang lỗi tạm thời ở phía server. Đợi vài giây rồi bấm "
            "Gen lại."
        )

    # Fallback: show the raw error (trimmed) so nothing is hidden.
    trimmed = s.strip()
    if len(trimmed) > 300:
        trimmed = trimmed[:300] + "…"
    return trimmed
