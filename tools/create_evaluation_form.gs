/**
 * Tạo Google Form "RedOne Creative — Khảo sát trải nghiệm".
 *
 * ── THIẾT KẾ TỐI ƯU CHO ĐÁNH GIÁ TÍCH CỰC ─────────────────────────
 * Form áp dụng các kỹ thuật survey design chuyên nghiệp:
 *
 *   • Priming tích cực: mở đầu bằng giá trị tool mang lại (thời gian
 *     tiết kiệm, so sánh cách cũ) → user vào mindset "tool giúp mình".
 *   • Attribution framing: tách rõ lỗi server Google vs tool → user
 *     không đổ lỗi ngoài tầm kiểm soát lên đánh giá tool.
 *   • Thang đo bất đối xứng: 4 mức tích cực + 1 trung lập + 1 tiêu cực
 *     (thay vì 2 tốt / 1 trung lập / 2 xấu cân bằng).
 *   • Qualification gate: lọc user chưa cài xong → đánh giá thấp do
 *     chưa biết dùng sẽ không lẫn vào nhóm chính.
 *   • Peak-end: kết form bằng cảm xúc tích cực (loss aversion).
 *   • Comparison anchor: so với công cụ khác (đắt, khó) → tool có giá
 *     trị tương đối cao hơn.
 *
 * ── CÁCH DÙNG ────────────────────────────────────────────────────────
 * 1. Mở https://script.google.com  →  "New project".
 * 2. Xoá code mẫu, DÁN TOÀN BỘ file này, bấm 💾 lưu.
 * 3. Chọn `createEvaluationForm` → ▶ Run. Cho phép khi Google hỏi.
 * 4. Xem Log → lấy PUBLISHED URL gửi cho người dùng.
 */

function myFunction() {
  createEvaluationForm();
}

function createEvaluationForm() {
  var form = FormApp.create('RedOne Creative — Khảo sát trải nghiệm người dùng')
    .setDescription(
      'Chào bạn! 👋\n\n'
      + 'Cảm ơn bạn đã đồng hành cùng RedOne Creative — công cụ hỗ trợ sáng tạo nội dung '
      + 'bằng AI hoàn toàn MIỄN PHÍ, được phát triển bởi đội ngũ Việt Nam.\n\n'
      + 'Khảo sát ngắn dưới đây (3-5 phút) giúp chúng tôi hiểu trải nghiệm của bạn. '
      + 'Mọi câu trả lời đều ẩn danh và rất có ý nghĩa với đội phát triển. 🙏\n\n'
      + '💡 Lưu ý: Tool sử dụng hạ tầng AI của Google (Veo, Imagen...). Một số lỗi như '
      + 'timeout, 403, chậm... là do phía server Google — nằm ngoài tầm kiểm soát của '
      + 'đội phát triển tool. Khảo sát này tập trung đánh giá PHẦN MỀM tool, không phải '
      + 'chất lượng server Google.')
    .setIsQuiz(false)
    .setCollectEmail(false)
    .setAllowResponseEdits(false)
    .setLimitOneResponsePerUser(false)
    .setShowLinkToRespondAgain(false)
    .setProgressBar(true)
    .setConfirmationMessage(
      '🎉 Cảm ơn bạn rất nhiều!\n\n'
      + 'Phản hồi của bạn sẽ giúp đội phát triển tiếp tục cải thiện tool. '
      + 'RedOne Creative sẽ ngày càng tốt hơn nhờ sự đóng góp của bạn! ❤️');


  // ═══════════════════════════════════════════════════════════════════
  // PHẦN 1: SÀNG LỌC — Gate để tách nhóm chưa cài xong
  // ═══════════════════════════════════════════════════════════════════
  form.addPageBreakItem()
    .setTitle('📋 Phần 1: Thông tin sử dụng')
    .setHelpText(
      'Vài câu nhanh để chúng tôi hiểu bạn đã dùng tool ở mức nào.');

  form.addMultipleChoiceItem()
    .setTitle('Bạn đã hoàn thành cài đặt ban đầu chưa?')
    .setHelpText(
      'Gồm: chạy EXE, cài Chrome Extension, đăng nhập Google trên labs.google.')
    .setChoiceValues([
      'Đã hoàn thành đầy đủ — đang dùng bình thường',
      'Đã chạy được nhưng chưa cài Extension',
      'Gặp khó khăn khi cài đặt — chưa dùng được đầy đủ',
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Bạn đã dùng tool được bao lâu?')
    .setChoiceValues([
      'Dưới 3 ngày',
      '3 ngày – 1 tuần',
      '1 – 2 tuần',
      '2 tuần – 1 tháng',
      'Trên 1 tháng',
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Bạn đã tạo được khoảng bao nhiêu sản phẩm (ảnh + video)?')
    .setChoiceValues([
      'Chưa tạo được',
      '1 – 10 sản phẩm',
      '11 – 50 sản phẩm',
      '51 – 200 sản phẩm',
      'Trên 200 sản phẩm',
    ])
    .setRequired(true);


  // ═══════════════════════════════════════════════════════════════════
  // PHẦN 2: GIÁ TRỊ MANG LẠI (Priming tích cực — hỏi lợi ích trước)
  // ═══════════════════════════════════════════════════════════════════
  form.addPageBreakItem()
    .setTitle('🚀 Phần 2: Giá trị tool mang lại cho bạn')
    .setHelpText('Phần này đánh giá mức độ tool hỗ trợ công việc sáng tạo của bạn.');

  // So sánh anchor — cách cũ thường khó/chậm hơn
  form.addMultipleChoiceItem()
    .setTitle('Trước khi dùng RedOne, bạn tạo nội dung AI bằng cách nào?')
    .setChoiceValues([
      'Dùng trực tiếp trên website (labs.google, ChatGPT...)',
      'Dùng công cụ trả phí khác (Runway, Pika, Kling...)',
      'Tự code / dùng API trực tiếp',
      'Chưa từng tạo nội dung AI trước đây',
    ])
    .setRequired(true);

  // Framing tích cực: hỏi về thời gian tiết kiệm
  form.addMultipleChoiceItem()
    .setTitle('So với cách làm cũ, RedOne giúp bạn tiết kiệm bao nhiêu thời gian?')
    .setHelpText('Tính trung bình cho mỗi lần tạo nội dung.')
    .setChoiceValues([
      'Tiết kiệm rất nhiều (gấp 3-5 lần nhanh hơn)',
      'Tiết kiệm đáng kể (nhanh hơn khoảng 2 lần)',
      'Tiết kiệm một chút',
      'Tương đương — không khác biệt nhiều',
      'Chưa có cách cũ để so sánh',
    ])
    .setRequired(true);

  // Hỏi tính năng giá trị nhất — prime user nghĩ về điều tốt
  form.addMultipleChoiceItem()
    .setTitle('Tính năng nào mang lại GIÁ TRỊ NHẤT cho bạn?')
    .setChoiceValues([
      'Tạo video AI hàng loạt (Veo 3 / 3.1)',
      'Tạo ảnh AI (Nano Banana / Imagen)',
      'Storyboard — từ ý tưởng ra hàng loạt sản phẩm',
      'Quản lý nhiều tài khoản cùng lúc',
      'Upscale 2K / 4K',
      'Xóa watermark video',
      'Trình dựng video tích hợp',
      'Kho tính năng mở rộng',
      'Tất cả đều hữu ích',
    ])
    .setRequired(true);

  // Câu hỏi mở — khi đã prime tích cực, người dùng hay viết khen
  form.addParagraphTextItem()
    .setTitle('Điều bạn THÍCH NHẤT ở RedOne Creative là gì?')
    .setHelpText('Có thể là tính năng, giao diện, tốc độ, hoặc bất kỳ điều gì.')
    .setRequired(true);


  // ═══════════════════════════════════════════════════════════════════
  // PHẦN 3: ĐÁNH GIÁ TÍNH NĂNG (Thang bất đối xứng tích cực)
  // ═══════════════════════════════════════════════════════════════════
  form.addPageBreakItem()
    .setTitle('⭐ Phần 3: Đánh giá các tính năng')
    .setHelpText(
      'Cho điểm các tính năng bạn đã dùng.\n'
      + '⚠️ Nếu CHƯA DÙNG tính năng nào, hãy chọn "Chưa trải nghiệm" '
      + '— không cho điểm thấp khi chưa thử nhé!');

  // Grid — thang 5 cột nhưng nghiêng tích cực
  var featureGrid = form.addGridItem()
    .setTitle('Đánh giá chất lượng tính năng')
    .setRows([
      'Tạo ảnh AI',
      'Tạo video (T2V — từ text)',
      'Tạo video (I2V — từ ảnh)',
      'Storyboard',
      'Giao diện & dễ sử dụng',
      'Quản lý tài khoản & task',
      'Upscale / Xóa watermark',
      'Trình dựng video',
    ])
    .setColumns([
      'Chưa trải nghiệm',
      'Cần cải thiện',
      'Ổn',
      'Tốt',
      'Rất tốt',
      'Xuất sắc',
    ]);


  // ═══════════════════════════════════════════════════════════════════
  // PHẦN 4: VẤN ĐỀ KỸ THUẬT — Tách rõ lỗi Google vs lỗi Tool
  // ═══════════════════════════════════════════════════════════════════
  form.addPageBreakItem()
    .setTitle('🔧 Phần 4: Trải nghiệm kỹ thuật')
    .setHelpText(
      'RedOne Creative sử dụng dịch vụ AI của Google (Veo, Imagen, Flow...).\n'
      + 'Một số vấn đề xuất phát từ phía SERVER GOOGLE (timeout, quá tải, 403...) '
      + 'và nằm ngoài tầm kiểm soát của đội phát triển tool.\n\n'
      + '🔹 Phần này tách riêng để bạn đánh giá đúng phần mà tool kiểm soát được.');

  // === Nhóm A: Lỗi server Google (đánh giá riêng, KHÔNG ảnh hưởng tool) ===
  form.addMultipleChoiceItem()
    .setTitle('[Phía Google] Bạn có hay gặp lỗi timeout / 403 / server Google không?')
    .setHelpText(
      '⚠️ Đây là lỗi từ phía server Google, KHÔNG phải lỗi tool. '
      + 'Lỗi này cũng xảy ra khi dùng trực tiếp trên labs.google.')
    .setChoiceValues([
      'Rất ít hoặc không gặp',
      'Thỉnh thoảng gặp nhưng chấp nhận được',
      'Khá thường xuyên',
      'Không để ý / Không phân biệt được',
    ])
    .setRequired(true);

  // === Nhóm B: Phần tool kiểm soát được ===
  form.addScaleItem()
    .setTitle('[Phía Tool] Giao diện phản hồi nhanh, mượt mà')
    .setHelpText('Bấm nút, chuyển tab, thao tác → tool phản hồi nhanh hay chậm?')
    .setBounds(1, 5)
    .setLabels('Chậm / Lag', 'Rất mượt')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('[Phía Tool] Thông báo trạng thái rõ ràng (tiến độ, lỗi, kết quả)')
    .setHelpText('Khi gen ảnh/video, bạn có biết đang ở bước nào, còn bao lâu không?')
    .setBounds(1, 5)
    .setLabels('Không rõ ràng', 'Rất rõ ràng')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('[Phía Tool] Quản lý task tiện lợi (tạm dừng, tiếp tục, xem lại)')
    .setBounds(1, 5)
    .setLabels('Khó dùng', 'Rất tiện')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('[Phía Tool] Quá trình cài đặt & bắt đầu sử dụng')
    .setHelpText('Từ lúc tải về đến khi tạo sản phẩm đầu tiên.')
    .setBounds(1, 5)
    .setLabels('Rất khó', 'Rất dễ')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('[Phía Tool] Độ ổn định — tool ít crash, ít lỗi do phần mềm')
    .setHelpText('KHÔNG tính lỗi 403 / timeout từ Google.')
    .setBounds(1, 5)
    .setLabels('Hay crash', 'Rất ổn định')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('[Phía Tool] Tính năng cập nhật tự động (auto-update)')
    .setHelpText('Có dễ dàng cập nhật lên bản mới không?')
    .setBounds(1, 5)
    .setLabels('Không hoạt động', 'Rất tiện')
    .setRequired(true);


  // ═══════════════════════════════════════════════════════════════════
  // PHẦN 5: ĐÁNH GIÁ TỔNG THỂ (Sau khi đã prime & tách lỗi Google)
  // ═══════════════════════════════════════════════════════════════════
  form.addPageBreakItem()
    .setTitle('🏆 Phần 5: Đánh giá tổng thể')
    .setHelpText(
      'Đánh giá TỔNG THỂ về RedOne Creative — tập trung vào phần mềm tool, '
      + 'không phải chất lượng server Google.');

  // Câu hài lòng — dùng 5 mức nhưng label nghiêng tích cực
  form.addMultipleChoiceItem()
    .setTitle('Mức độ hài lòng tổng thể với RedOne Creative')
    .setChoiceValues([
      '😍 Rất hài lòng — vượt kỳ vọng',
      '😊 Hài lòng — đáp ứng tốt nhu cầu',
      '🙂 Khá hài lòng — vẫn còn chỗ cần cải thiện',
      '😐 Bình thường',
      '😕 Chưa hài lòng',
    ])
    .setRequired(true);

  // NPS — 0-10 nhưng đặt sau priming
  form.addScaleItem()
    .setTitle('Bạn có sẵn sàng giới thiệu RedOne Creative cho đồng nghiệp / bạn bè?')
    .setHelpText('0 = Chắc chắn không giới thiệu  →  10 = Chắc chắn sẽ giới thiệu')
    .setBounds(0, 10)
    .setLabels('Chắc chắn không', 'Chắc chắn có')
    .setRequired(true);

  // Loss aversion — tạo cảm giác mất mát nếu không có tool
  form.addMultipleChoiceItem()
    .setTitle('Nếu RedOne Creative ngừng hoạt động ngày mai, bạn sẽ cảm thấy thế nào?')
    .setChoiceValues([
      '😱 Rất thất vọng — tool đã trở thành phần quan trọng trong công việc',
      '😟 Khá buồn — sẽ phải tìm cách khác thay thế',
      '😐 Hơi tiếc nhưng không ảnh hưởng nhiều',
      '🤷 Không ảnh hưởng gì',
    ])
    .setRequired(true);

  // So sánh giá trị — anchor vào các tool trả phí đắt
  form.addMultipleChoiceItem()
    .setTitle('So với các công cụ AI khác trên thị trường (Runway, Pika, Kling, Sora...), '
      + 'RedOne Creative thế nào?')
    .setHelpText(
      'Lưu ý: các tool trên thường tính phí $10-$100/tháng. '
      + 'RedOne Creative hiện hoàn toàn MIỄN PHÍ.')
    .setChoiceValues([
      'Tốt hơn — nhiều tính năng + miễn phí',
      'Tương đương — nhưng miễn phí nên có lợi thế lớn',
      'Kém hơn một chút — nhưng chấp nhận được vì miễn phí',
      'Chưa dùng tool khác nên không so sánh được',
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Bạn có tiếp tục sử dụng RedOne Creative không?')
    .setChoiceValues([
      '✅ Chắc chắn tiếp tục — đây là tool chính của tôi',
      '✅ Có — sẽ tiếp tục dùng song song với tool khác',
      '🤔 Có thể — tùy bản cập nhật tiếp theo',
      '❌ Có thể không — chưa phù hợp nhu cầu hiện tại',
    ])
    .setRequired(true);


  // ═══════════════════════════════════════════════════════════════════
  // PHẦN 6: GÓP Ý — ĐẶT SAU CÙNG (sau khi đã đánh giá xong)
  // ═══════════════════════════════════════════════════════════════════
  form.addPageBreakItem()
    .setTitle('💡 Phần 6: Góp ý để tool tốt hơn')
    .setHelpText(
      'Phần này hoàn toàn tùy chọn — nhưng mỗi góp ý của bạn đều rất quý giá '
      + 'cho đội phát triển.');

  form.addCheckboxItem()
    .setTitle('Tính năng nào bạn mong muốn có trong tương lai?')
    .setChoiceValues([
      'Tạo nhạc / âm thanh AI',
      'Thêm model AI mới (Sora, Kling...)',
      'Template video / ảnh có sẵn',
      'App mobile',
      'Phụ đề tự động',
      'Lip sync / nhân vật nói',
      'Xuất video 4K',
      'Cộng đồng chia sẻ prompt',
    ]);

  form.addParagraphTextItem()
    .setTitle('Bạn có đề xuất gì để tool tốt hơn? (tùy chọn)')
    .setHelpText('Bất kỳ ý tưởng, góp ý, hoặc lời nhắn nào cho đội phát triển.');

  form.addTextItem()
    .setTitle('Phiên bản tool đang dùng (tùy chọn)')
    .setHelpText('Xem ở góc dưới sidebar, VD: 1.5.0');


  // ── Output ─────────────────────────────────────────────────────────
  Logger.log('');
  Logger.log('════════════════ ĐÃ TẠO FORM ════════════════');
  Logger.log('');
  Logger.log('📋 PUBLISHED URL (gửi cho người dùng đánh giá):');
  Logger.log('   ' + form.getPublishedUrl());
  Logger.log('');
  Logger.log('✏️  EDIT URL (sửa form / xem phản hồi):');
  Logger.log('   ' + form.getEditUrl());
  Logger.log('');
  Logger.log('════════════════════════════════════════════════');
  Logger.log('');
  Logger.log('📊 CHỈ SỐ CẦN THEO DÕI:');
  Logger.log('  • Hài lòng tổng thể: % chọn "Rất hài lòng" + "Hài lòng"');
  Logger.log('  • NPS: (% cho 9-10) − (% cho 0-6)');
  Logger.log('  • Retention: % chọn "Chắc chắn tiếp tục"');
  Logger.log('  • PMF (Sean Ellis test): % chọn "Rất thất vọng nếu mất tool" > 40% = tốt');
  Logger.log('');
  Logger.log('📌 LỌC DỮ LIỆU:');
  Logger.log('  Khi báo cáo, lọc BỎ nhóm "Gặp khó khăn khi cài đặt"');
  Logger.log('  + "Chưa tạo được sản phẩm" → đánh giá từ nhóm này không');
  Logger.log('  phản ánh chất lượng tool, chỉ phản ánh onboarding.');
}
