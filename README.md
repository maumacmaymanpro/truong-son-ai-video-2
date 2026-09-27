# TRƯỜNG SƠN AI VIDEO 2.0

Bản full-stack đầu tiên chuyển xử lý video ra máy chủ để giải quyết đúng vấn đề của các bản V16–V19: video đầu ra không còn phụ thuộc Blob/Service Worker của Android.

## Quy trình

Video → upload server → AI nghe → transcript có timestamp → AI hiểu nội dung → chọn section/đoạn → anh duyệt GIỮ/BỎ → sửa hook/phụ đề → AI background theo bối cảnh → FFmpeg render server-side → MP4 lưu trên server → nút tải HTTP thật.

## Những gì đã có

- Upload video MP4/MOV/WebM/AVI/MKV.
- Job chạy nền trên server; điện thoại có thể tắt màn hình sau khi upload.
- Speech-to-Text server-side với `whisper-1` để có segment timestamps cho biên tập video.
- Phân tích transcript bằng `gpt-5.6-luna` (có thể đổi model bằng biến môi trường).
- AI chia video thành các section, chọn đoạn giữ lại, tạo hook riêng cho từng section và prompt background theo bối cảnh.
- Màn hình duyệt: bật/tắt từng đoạn, sửa text phụ đề, sửa hook, sửa background prompt.
- Phụ đề có thể chỉnh font, cỡ chữ, màu, màu viền, độ dày viền, vị trí.
- Background AI bằng `gpt-image-2`, có fallback gradient.
- Render MP4 1080×1920, giữ giọng nói gốc.
- Download bằng route HTTP `/api/jobs/:id/download` với `Content-Disposition: attachment` — không dùng Blob để tải xuống máy.
- Preview hỗ trợ HTTP Range.
- `DEMO_MODE=true` để chạy thử UI/render server mà không cần OpenAI API key.

## Chạy local

1. Cài Node.js 22+ và FFmpeg. Docker là cách dễ nhất.
2. Sao chép `.env.example` thành `.env` và điền `OPENAI_API_KEY`.
3. `npm install`
4. `npm start`
5. Mở `http://localhost:8787`

### Test không cần API key

Đặt `DEMO_MODE=true`. App sẽ dùng transcript mẫu, nhưng pipeline upload → review → FFmpeg → lưu file → download vẫn chạy thật.

## Deploy server

Đây là app cần máy chủ chạy liên tục vì job render chạy nền. Không deploy phần render vào Netlify Functions/serverless ngắn hạn.

Có sẵn `Dockerfile` và `render.yaml`. Trên dịch vụ host Docker, khai báo `OPENAI_API_KEY` là secret. Nên dùng ổ đĩa persistent nếu muốn giữ video lâu; app hiện tự dọn job cũ theo `JOB_RETENTION_HOURS`.

## Cấu hình

- `OPENAI_API_KEY`: bắt buộc ở chế độ AI thật.
- `OPENAI_TEXT_MODEL`: mặc định `gpt-5.6-luna`.
- `OPENAI_TRANSCRIBE_MODEL`: mặc định `whisper-1` vì timestamp segment là dữ liệu quan trọng cho cắt video.
- `OPENAI_IMAGE_MODEL`: mặc định `gpt-image-2`.
- `AI_BG_MAX`: số background AI tối đa cho một job.
- `MAX_UPLOAD_MB`: giới hạn upload.
- `JOB_RETENTION_HOURS`: thời gian giữ job/output.

## Kiến trúc

`public/` là giao diện.

`server.js` nhận upload, quản lý job, gọi AI, chạy FFmpeg và cung cấp file MP4 qua HTTP.

## Giới hạn hiện tại

- AI chọn section dựa trên transcript/timestamp; đây là biên tập nội dung tự động, không phải hiểu video hình ảnh ở mức thị giác.
- Background AI được dùng làm nền điện ảnh phía sau video và hook. Có thể mở rộng để AI phân tích cả hình ảnh/video ở bản sau.
- Chưa có đăng nhập người dùng, thanh toán, lưu project lâu dài hoặc hàng đợi Redis.
- Nếu host ngủ hoặc restart giữa job, job đang chạy sẽ không tự resume. Production nên dùng worker/persistent disk/queue.
