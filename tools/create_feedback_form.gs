/**
 * Tạo Google Form "RedOne Creative — Góp ý & Báo lỗi".
 *
 * ── CÁCH DÙNG (1 lần) ───────────────────────────────────────────────
 * 1. Mở https://script.google.com  →  "New project".
 * 2. Xoá code mẫu, DÁN TOÀN BỘ file này vào, bấm 💾 lưu.
 * 3. Chọn hàm `createRedOneFeedbackForm` ở thanh trên → bấm ▶ Run.
 *    Lần đầu Google xin quyền → "Review permissions" → chọn tài khoản →
 *    "Advanced" → "Go to ... (unsafe)" → "Allow". (An toàn — script chỉ
 *    tạo form trong Drive của BẠN.)
 * 4. Xem Log (Ctrl+Enter hoặc menu View → Logs / Executions). Sẽ in ra:
 *      • PUBLISHED URL  → link gửi phản hồi (đây là link dán vào tool).
 *      • EDIT URL       → link bạn vào sửa form / xem câu hỏi.
 * 5. Copy PUBLISHED URL, dán vào `backend/config.py`:
 *        FEEDBACK_FORM_URL = "https://docs.google.com/forms/d/e/..../viewform"
 *    Lưu rồi restart `run.bat`. Nút "Góp ý / Báo lỗi" trong tool sẽ mở form này.
 * 6. Xem phản hồi: mở form (EDIT URL) → tab "Responses". Muốn xuất ra bảng
 *    tính thì bấm biểu tượng Google Sheets ở tab đó.
 *
 * Chạy lại hàm này sẽ tạo THÊM một form mới (không ghi đè form cũ).
 */

// Apps Script thường để sẵn "myFunction" ở ô chọn hàm. Hàm này gọi thẳng hàm
// tạo form, nên bấm ▶ Run là chạy được ngay dù ô đang chọn hàm nào.
function myFunction() {
  createRedOneFeedbackForm();
}

function createRedOneFeedbackForm() {
  var form = FormApp.create('RedOne Creative — Góp ý & Báo lỗi')
    .setDescription(
      'Cảm ơn bạn đã dùng RedOne Creative! Hãy gửi báo lỗi, góp ý hoặc đề xuất '
      + 'tính năng tại đây. Mọi phản hồi đều được xem xét. 🙏')
    .setCollectEmail(false)          // đổi true nếu muốn bắt đăng nhập + thu email
    .setAllowResponseEdits(false)
    .setLimitOneResponsePerUser(false)
    .setShowLinkToRespondAgain(true);

  // 1) Loại phản hồi
  form.addMultipleChoiceItem()
    .setTitle('Loại phản hồi')
    .setChoiceValues([
      '🐞 Báo lỗi',
      '💡 Góp ý / Đề xuất tính năng',
      '❓ Câu hỏi sử dụng',
      'Khác',
    ])
    .setRequired(true);

  // 2) Tính năng liên quan
  form.addCheckboxItem()
    .setTitle('Tính năng liên quan')
    .setChoiceValues([
      'Tạo ảnh',
      'Tạo video (T2V / I2V)',
      'Storyboard',
      'Ảnh Shakker',
      'Upscale 2K / 4K',
      'Xử lý ảnh / video',
      'Tài khoản / Đăng nhập',
      'Extension',
      'Khác',
    ]);

  // 3) Mức độ nghiêm trọng (cho báo lỗi)
  form.addMultipleChoiceItem()
    .setTitle('Mức độ nghiêm trọng (nếu là lỗi)')
    .setChoiceValues([
      'Nghiêm trọng — không dùng được',
      'Khó chịu nhưng vẫn dùng được',
      'Nhỏ / giao diện',
      'Không áp dụng',
    ]);

  // 4) Mô tả chi tiết
  form.addParagraphTextItem()
    .setTitle('Mô tả chi tiết')
    .setHelpText('Bạn gặp lỗi gì / đề xuất gì? Càng cụ thể càng dễ xử lý.')
    .setRequired(true);

  // 5) Các bước tái hiện lỗi
  form.addParagraphTextItem()
    .setTitle('Các bước tái hiện (nếu là lỗi)')
    .setHelpText('VD: 1) Vào tab Tạo Ảnh → 2) chọn Nano Banana Pro, tỉ lệ 16:9 → '
      + '3) bấm Tạo → kết quả bị ...');

  // 6) Phiên bản tool
  form.addTextItem()
    .setTitle('Phiên bản tool')
    .setHelpText('Xem ở góc dưới sidebar của tool. VD: 1.3.4');

  // 7) Link ảnh / video minh hoạ (giữ form KHÔNG cần đăng nhập)
  form.addTextItem()
    .setTitle('Link ảnh / video minh hoạ (tuỳ chọn)')
    .setHelpText('Tải lên Google Drive / Imgur / Streamable... rồi dán link vào đây.');

  // 8) Email liên hệ (tuỳ chọn)
  form.addTextItem()
    .setTitle('Email liên hệ (tuỳ chọn)')
    .setHelpText('Để chúng tôi liên hệ lại nếu cần thêm thông tin.');

  Logger.log('================ ĐÃ TẠO FORM ================');
  Logger.log('PUBLISHED URL (dán vào FEEDBACK_FORM_URL trong config.py):');
  Logger.log(form.getPublishedUrl());
  Logger.log('');
  Logger.log('EDIT URL (vào sửa form / xem phản hồi ở tab Responses):');
  Logger.log(form.getEditUrl());
  Logger.log('=============================================');
}
