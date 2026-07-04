# Photoshop Generative Fill: Logic chuẩn hóa Input & Căn chỉnh Output khớp Canvas gốc

Tài liệu này giải thích chi tiết về thuật toán toán học và luồng xử lý (ExtendScript & CEP JavaScript) nhằm đảm bảo ảnh đầu ra từ mô hình AI (Google Flow) khớp pixel-perfect 100% với ảnh gốc trong Adobe Photoshop, giải quyết triệt để lỗi lệch tọa độ, lệch mask và méo hình do sai lệch tỷ lệ.

---

## 1. Vấn đề gốc rễ (The Problem)

1. **Giới hạn tỷ lệ của AI**: Mô hình tạo ảnh của Google Flow có tỷ lệ khung hình cố định (Landscape mặc định là `1376x768`, tỷ lệ `~1.7917`).
2. **AI tự ý xén (Internal Cropping)**: Nếu gửi một vùng chọn hoặc ảnh gốc có tỷ lệ khác (ví dụ: `1.79188` hoặc tỷ lệ bất kỳ), AI của Google sẽ tự động co giãn và xén bớt (crop) các cạnh để khớp với tỷ lệ chuẩn của nó. Điều này làm thay đổi nội dung ảnh bên trong trước khi vẽ, dẫn đến lệch chi tiết so với ảnh nền Photoshop.
3. **Lệch vị trí mặc định**: Khi chèn một Smart Object vào Photoshop bằng lệnh `Place`, Photoshop mặc định đặt ảnh ở chính giữa canvas (hoặc tâm vùng chọn). Nếu ảnh chèn vào có kích thước khác (ảnh gốc 4K, ảnh trả về 1376x768 hoặc 4K upscaled), nó sẽ bị lệch và thu nhỏ, không khớp với vị trí bôi chọn ban đầu.

---

## 2. Giải pháp: Quy trình 3 bước chuẩn hóa & căn chỉnh

```mermaid
graph TD
    subgraph 1. Chuẩn hóa & Export (Input)
        A[Canvas Photoshop & Vùng chọn] --> B{So khớp tỷ lệ với 1376:768}
        B -->|Lệch tỷ lệ| C[Tính toán khung Crop rộng nhất ở tâm]
        B -->|Đúng tỷ lệ| D[Giữ nguyên khung Crop]
        C & D --> E[Duplicate, Crop ảnh gốc & Mask]
        E --> F[Resize cứng về 1376x768]
        F --> G[Lưu file tạm & Ghi nhớ tọa độ cropX, cropY, cropW, cropH]
    end

    subgraph 2. Xử lý AI (Google Flow)
        G --> H[Google Flow API: Gen 1376x768]
        H --> I[Upscale 4K API: flow/upsampleImage]
        I --> J[Tải ảnh kết quả 4K về máy]
    end

    subgraph 3. Đặt & Căn chỉnh (Output)
        J --> K[Lưu Vùng chọn vào Alpha Channel ẩn]
        K --> L[Place ảnh kết quả làm Smart Object]
        L --> M[Resize theo tỷ lệ: cropW / layerWidth]
        M --> N[Translate dịch chuyển góc TopLeft về cropX, cropY]
        N --> O[Nạp lại Vùng chọn từ Alpha Channel]
        O --> P[Tạo Layer Mask & Xóa Alpha Channel ẩn]
    end
```

---

## 3. Chi tiết Thuật toán & Mã nguồn

### Bước 1: Chuẩn hóa và Trích xuất Input (ExtendScript `normalizeAndExport`)

Hàm này chạy trên Photoshop để tìm khung hình tỷ lệ `1376:768` bao phủ vùng chọn lớn nhất có thể, crop và resize về đúng `1376x768` trước khi gửi đi.

#### Toán học xác định vùng Crop:
* **Tỷ lệ mục tiêu**: $R_{target} = \frac{1376}{768} \approx 1.7916667$
* **Tỷ lệ hiện tại**: $R_{current} = \frac{Width_{doc}}{Height_{doc}}$
* **Trường hợp ảnh rộng hơn tỉ lệ chuẩn ($R_{current} > R_{target}$)**:
  * Crop chiều rộng, giữ nguyên chiều cao:
    $$Crop_H = Height_{doc}$$
    $$Crop_W = \text{round}(Height_{doc} \times R_{target})$$
    $$Crop_X = \text{round}\left(\frac{Width_{doc} - Crop_W}{2}\right)$$
    $$Crop_Y = 0$$
* **Trường hợp ảnh dọc/cao hơn tỉ lệ chuẩn ($R_{current} < R_{target}$)**:
  * Crop chiều cao, giữ nguyên chiều rộng:
    $$Crop_W = Width_{doc}$$
    $$Crop_H = \text{round}\left(\frac{Width_{doc}}{R_{target}}\right)$$
    $$Crop_X = 0$$
    $$Crop_Y = \text{round}\left(\frac{Height_{doc} - Crop_H}{2}\right)$$

#### Code triển khai:
```javascript
// Đoạn trích từ photoshop.jsx -> normalizeAndExport()
var docW = Math.round(doc.width.as("px"));
var docH = Math.round(doc.height.as("px"));

var TARGET_W = 1376;
var TARGET_H = 768;
var targetRatio = TARGET_W / TARGET_H;
var currentRatio = docW / docH;

var cropW, cropH, cropX, cropY;

if (Math.abs(currentRatio - targetRatio) < 0.01) {
    cropW = docW;
    cropH = docH;
    cropX = 0;
    cropY = 0;
} else if (currentRatio > targetRatio) {
    cropH = docH;
    cropW = Math.round(docH * targetRatio);
    cropX = Math.round((docW - cropW) / 2);
    cropY = 0;
} else {
    cropW = docW;
    cropH = Math.round(docW / targetRatio);
    cropX = 0;
    cropY = Math.round((docH - cropH) / 2);
}

// Thực hiện nhân bản tài liệu để thao tác ngầm
var dupDoc = doc.duplicate("_redone_norm_", false);
dupDoc.flatten();

// Cắt theo tọa độ chuẩn hóa
if (cropX > 0 || cropY > 0 || cropW < docW || cropH < docH) {
    dupDoc.crop([
        new UnitValue(cropX, "px"),
        new UnitValue(cropY, "px"),
        new UnitValue(cropX + cropW, "px"),
        new UnitValue(cropY + cropH, "px")
    ]);
}

// RESIZE về đúng kích thước mô hình AI yêu cầu để triệt tiêu việc AI tự crop lệch hình
dupDoc.resizeImage(new UnitValue(TARGET_W, "px"), new UnitValue(TARGET_H, "px"), null, ResampleMethod.BICUBIC);
```

*Lưu ý: Quá trình tương tự được áp dụng cho việc export file mặt nạ (Mask PNG) tại hàm `exportNormalizedMask()` để đảm bảo ảnh gốc và mask gửi lên Google Flow khớp hoàn hảo từng pixel.*

---

### Bước 2: Đặt ảnh, Khôi phục kích thước và Dịch chuyển (ExtendScript `applyResultAsLayer`)

Khi kết quả 4K trả về, Photoshop sẽ chèn ảnh đó vào làm một Smart Object mới. Lúc này, ảnh nằm ở chính giữa canvas và có kích thước chưa chuẩn. Thuật toán sẽ khôi phục lại tỷ lệ và dịch về vị trí gốc.

#### 1. Vùng chọn được khôi phục sau khi chèn ảnh:
Lệnh `Place` của Photoshop sẽ tự hủy vùng chọn hiện tại. Vì vậy, ta phải lưu vùng chọn vào một kênh Alpha tạm thời trước, sau đó xóa vùng chọn hiện tại đi để tránh lỗi chèn đè mask.
```javascript
var savedChannel = null;
try {
    var tempBounds = doc.selection.bounds; // Ném lỗi nếu không có vùng chọn
    savedChannel = doc.channels.add();
    savedChannel.name = "_temp_redone_mask_";
    doc.selection.store(savedChannel);
    doc.selection.deselect();
} catch (selErr) {
    // Không có vùng chọn hoạt động
}
```

#### 2. Tính toán tỉ lệ co giãn (Scale):
Tính toán phần trăm co giãn dựa trên kích thước thật của layer vừa được chèn và kích thước vùng crop gốc (`cropW`, `cropH`):
$$\text{Scale}_X = \left(\frac{Crop_W}{Width_{layer}}\right) \times 100$$
$$\text{Scale}_Y = \left(\frac{Crop_H}{Height_{layer}}\right) \times 100$$

Sử dụng điểm neo góc trên bên trái (`AnchorPosition.TOPLEFT`) để phóng to layer:
```javascript
var bounds = layer.bounds;
var layerWidth = bounds[2].as("px") - bounds[0].as("px");
var layerHeight = bounds[3].as("px") - bounds[1].as("px");

// Phóng to layer tương thích với vùng crop ban đầu
var scaleX = (cropW / layerWidth) * 100;
var scaleY = (cropH / layerHeight) * 100;
layer.resize(scaleX, scaleY, AnchorPosition.TOPLEFT);
```

#### 3. Dịch chuyển tọa độ (Translate):
Do điểm neo hoặc vị trí chèn ban đầu có thể bị xê dịch sau khi co giãn, ta lấy tọa độ góc trên-trái thực tế mới (`newLeft`, `newTop`) và tính khoảng cách cần di chuyển ($\Delta X, \Delta Y$) để đưa layer về chính xác tọa độ gốc (`cropX`, `cropY`):
$$\Delta X = Crop_X - Left_{new}$$
$$\Delta Y = Crop_Y - Top_{new}$$

```javascript
var newBounds = layer.bounds;
var newLeft = newBounds[0].as("px");
var newTop = newBounds[1].as("px");

var deltaX = cropX - newLeft;
var deltaY = cropY - newTop;

// Di chuyển layer vào đúng vị trí pixel gốc
layer.translate(deltaX, deltaY);
```

#### 4. Khôi phục vùng chọn & Tạo Layer Mask:
Sau khi di chuyển layer khớp 100%, nạp lại vùng chọn từ Alpha Channel tạm thời, thực thi lệnh tạo Layer Mask dạng **Reveal Selection** (chỉ hiển thị phần bên trong vùng chọn) và dọn dẹp Alpha Channel ẩn.
```javascript
if (savedChannel !== null) {
    doc.selection.load(savedChannel);

    // Lệnh Action Manager tạo Layer Mask từ vùng chọn hiện tại
    var idMk = charIDToTypeID("Mk  ");
    var descMk = new ActionDescriptor();
    var idNw = charIDToTypeID("Nw  ");
    var idChnl = charIDToTypeID("Chnl");
    descMk.putClass(idNw, idChnl);
    var idAt = charIDToTypeID("At  ");
    var refMsk = new ActionReference();
    refMsk.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
    descMk.putReference(idAt, refMsk);
    var idUsng = charIDToTypeID("Usng");
    var idUsrM = charIDToTypeID("UsrM");
    var idRvlS = charIDToTypeID("RvlS");
    descMk.putEnumerated(idUsng, idUsrM, idRvlS);
    executeAction(idMk, descMk, DialogModes.NO);

    // Xóa Alpha Channel tạm thời
    savedChannel.remove();
}
```

---

## 4. Tổng kết hiệu quả

Bằng việc ép co giãn không đồng đều (non-uniform scaling) ở bước gửi đi và đảo ngược chính xác tỷ lệ co giãn đó ở bước chèn về, mọi sai lệch vị trí do sự khác biệt giữa khung canvas Photoshop và mô hình AI của Google Flow đã được triệt tiêu hoàn toàn. Layer kết quả tự động khớp khít 100% với các chi tiết cũ trên ảnh nền, tạo ra trải nghiệm Generative Fill mượt mà và chính xác.
