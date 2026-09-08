# WikiBookLM — Phân tích PRD & Phương án triển khai (Node.js + React)

> Nguồn: `RAG Workspace - PRD.docx` (Phase 1 MVP). Ngày phân tích: 2026-08-10.

## 1. Tóm tắt sản phẩm

WikiBookLM là workspace nghiên cứu cá nhân theo mô hình RAG (kiểu NotebookLM):

- **Research Space**: mỗi space chứa thư viện nguồn (sources), hội thoại với assistant, notes, và đúng **1 notebook** rich-text.
- **Sources** (3 loại): PDF dạng text, bài viết web (URL), văn bản nhập tay. Phải qua pipeline xử lý: validate → lưu bản gốc → trích xuất (giữ page/paragraph/section) → chia passage → embedding → `ready`.
- **Assistant**: chỉ trả lời có trích dẫn (citation-grounded QA), 2 scope: nguồn hiện tại / toàn space. Không có mode Compare/Summarize/Synthesize riêng.
- **Citations**: mỗi trích dẫn phải trỏ được về đúng passage + vị trí (trang/đoạn/mục) trong Source Reader, highlight passage.
- **Notes**: lưu answer thành note hoặc tạo tay; note KHÔNG phải evidence trừ khi convert thành source (snapshot độc lập, có nhãn nguồn gốc AI-assisted).
- **Notebook**: 1 tài liệu rich-text liên tục, autosave có trạng thái (Saving/Saved/Failed), export Markdown / print-PDF / clipboard kèm danh sách citation.
- **Loại trừ MVP**: reading status, highlight/annotation, tags/folders, collaboration, OCR, DOCX/audio ingestion, knowledge graph, cross-space query…

### Ràng buộc quan trọng rút ra từ PRD

| # | Ràng buộc | Ảnh hưởng thiết kế |
|---|---|---|
| 1 | Passage không bao giờ trộn nội dung 2 source (§6) | Chunking theo từng source, mỗi passage mang `sourceId` + locator |
| 2 | PDF passage giữ số trang; web/manual giữ paragraph/section ref (§6) | Extractor phải bảo toàn ranh giới trang/đoạn ngay từ bước trích xuất |
| 3 | Retry không tạo bản ghi trùng; reprocess thay thế index cũ; citation bị ảnh hưởng → giữ hoặc đánh dấu `stale` (§6, §10) | Pipeline idempotent, transaction xoá-ghi passages, cơ chế citation staleness |
| 4 | Failed/archived source + note chưa convert **không bao giờ** vào retrieval (§6, §9, §17) | Filter cứng ở tầng truy vấn, không dựa vào prompt |
| 5 | Limits cấu hình được không cần sửa code (§5): PDF 25MB/200 trang, manual 100k ký tự, 50 source/space | Bảng config hoặc env vars, đọc runtime |
| 6 | Câu trả lời phải tách evidence vs diễn giải AI, nêu mâu thuẫn, nói rõ khi thiếu bằng chứng (§9) | System prompt + dùng tính năng Citations của Claude API |
| 7 | Scope hiện tại không bao giờ lấy source khác (§9) | Scope lưu theo từng request, filter theo `sourceId` |
| 8 | Autosave notebook: không mất nội dung khi save fail, retry tự động, mở note không reload notebook (§13) | Debounced autosave + optimistic local state, note viewer dạng drawer/modal |
| 9 | Perf: search <500ms, assistant bắt đầu hiển thị <8s p75, PDF xử lý <2 phút p90 (§19) | Streaming SSE cho câu trả lời; queue worker cho ingestion |
| 10 | Bảo mật: ownership mọi request, secret không ra browser, xoá source phải xoá file gốc + text + index + citations (§17) | Middleware authorize theo owner, cascade delete có chủ đích |

## 2. Kiến trúc tổng thể

```
┌──────────────┐   HTTPS/JSON + SSE   ┌────────────────────────┐
│  React SPA   │ ───────────────────▶ │  API server (Fastify)  │
│  (Vite, TS)  │                      │  - Auth (session)      │
└──────────────┘                      │  - CRUD spaces/sources │
                                      │  - Chat (SSE stream)   │
                                      └─────┬────────────┬─────┘
                                            │            │ enqueue
                                     ┌──────▼─────┐ ┌────▼─────────┐
                                     │ PostgreSQL │ │ BullMQ+Redis │
                                     │ + pgvector │ │  Workers      │
                                     │ + FTS      │ │  (ingestion)  │
                                     └──────┬─────┘ └────┬─────────┘
                                            │            │
                                     ┌──────▼─────┐ ┌────▼──────────────┐
                                     │ Object     │ │ External APIs      │
                                     │ storage    │ │ - Claude (answers) │
                                     │ (S3/local) │ │ - Voyage (embed)   │
                                     └────────────┘ └───────────────────┘
```

### Tech stack đề xuất

**Frontend (React + TypeScript)**
- Vite + React 18 + TypeScript
- React Router (routes: home, space, source reader, conversation, notebook)
- TanStack Query (server state, cache, retry) + Zustand (UI state nhẹ)
- **Tiptap** (ProseMirror) cho notebook và note editor — đáp ứng đủ §13 (heading, bold/italic, list, blockquote, link, undo/redo, paste HTML) và dễ nhúng "citation node" tuỳ biến
- Tailwind CSS + shadcn/ui (accessible primitives — dialog focus trap, Escape close, aria-live cho save state → đáp ứng §18)
- SSE (EventSource / fetch stream) cho câu trả lời assistant

**Backend (Node.js + TypeScript)**
- **Fastify** (nhanh, schema validation với zod/typebox) — hoặc NestJS nếu ưu tiên cấu trúc; đề xuất Fastify cho MVP gọn
- **Prisma** ORM + **PostgreSQL 16 + pgvector**
  - 1 DB duy nhất cho: dữ liệu quan hệ, vector search (pgvector HNSW), full-text search (tsvector) → không cần vector DB riêng vì quy mô MVP nhỏ (≤50 source/space)
- **BullMQ + Redis**: hàng đợi xử lý source (async, retry, trạng thái Processing/Ready/Failed)
- **Object storage**: S3-compatible (MinIO local / S3 prod) lưu file PDF gốc; MVP có thể dùng disk local sau interface trừu tượng
- Trích xuất:
  - PDF: `pdfjs-dist` (unpdf) — trích text theo **từng trang** (giữ page boundary §5.1); reject encrypted/corrupted/scanned-rỗng
  - Web: `@mozilla/readability` + `jsdom` (+ `linkedom` nếu cần nhẹ hơn) — lấy article content, metadata (title/author/date), loại nav/ads §5.2
- Auth: session cookie (HttpOnly, Secure) + `argon2` hash password; reset password qua email (Resend/SES). Lỗi auth không tiết lộ email tồn tại (§3)

**AI layer**
- **Trả lời**: Claude API — `claude-opus-5`, streaming, dùng **native Citations** (`document` content blocks với `citations: {enabled: true}`): đưa các passage đã retrieve vào request dưới dạng document blocks; Claude trả về text blocks kèm `citations[]` trỏ đúng block/vị trí → map ngược về passage + locator của mình. Đây là cách đáng tin cậy nhất để thoả §9 "citation đặt cạnh claim, không bịa citation".
- **Embeddings**: Anthropic không có endpoint embeddings → dùng **Voyage AI** (`voyage-3.5`, đối tác Anthropic khuyến nghị) hoặc OpenAI `text-embedding-3-small`. Lưu vector vào pgvector.
- **Retrieval**: hybrid = vector similarity (pgvector) + BM25/FTS (tsvector), lọc cứng theo scope + trạng thái `ready` + không archived. Top-k ~10–15 passages.
- Tiêu đề hội thoại: sinh từ câu hỏi đầu bằng 1 call `claude-haiku-4-5` (rẻ, nhanh) — cho phép vì PRD nói "may be generated".

## 3. Mô hình dữ liệu (Prisma sketch)

```
User(id, name, email unique, passwordHash, createdAt, lastActiveAt)
Space(id, ownerId, name, objective?, archivedAt?, createdAt, updatedAt, lastOpenedAt)
Source(id, spaceId, type[pdf|web|manual], title, author?, url?, fileKey?,
       originNoteId?, content, state[processing|ready|failed], errorMessage?,
       archivedAt?, createdAt, updatedAt)
Passage(id, sourceId, ord, text, page?, paragraphRef?, sectionHeading?,
        embedding vector(1024), tsv tsvector)          -- không bao giờ cross-source
Conversation(id, spaceId, title, scopeType[source|space], scopeSourceId?, createdAt, updatedAt)
Message(id, conversationId, role[user|assistant], content, scopeSnapshot, createdAt)
Citation(id, messageId?, noteId?, sourceId, passageId?, quotedText, locator{page|paragraph|section},
         stale boolean default false, createdAt)
Note(id, spaceId, title, contentRich(json), originType[user|saved_answer],
     originConversationId?, originMessageId?, createdAt, updatedAt)
Notebook(id, spaceId unique, contentRich(json), createdAt, updatedAt)
Activity(id, userId, spaceId, kind, refId, createdAt)
AppConfig(key, value)   -- limits cấu hình runtime (§5)
```

Ghi chú:
- `Citation.stale`: khi source reprocess/xoá → set stale thay vì xoá (đáp ứng §6, §10 "unavailable or stale").
- Xoá source vĩnh viễn: transaction xoá file gốc (storage), passages (kèm vector), citations thuộc source (§17).
- `Message.scopeSnapshot`: lưu scope của từng request assistant (§9).

## 4. Các flow chính

### 4.1 Ingestion pipeline (BullMQ worker)

```
enqueue(sourceId) → validate (limit từ AppConfig)
  → lưu/giữ bản gốc → extract:
      pdf:   text theo trang [{page, text}]
      web:   Readability → paragraphs [{idx, text, heading?}]
      manual: split đoạn ổn định [{idx, text}]
  → chunk (400–600 token, overlap ~15%, không vượt ranh giới trang khi có thể,
     giữ heading gắn với passage)
  → embed batch (Voyage) → transaction: DELETE passages cũ + INSERT mới
  → state = ready (hoặc failed + errorMessage human-readable)
```
- **Idempotent**: job key = sourceId; retry chỉ chạy lại pipeline trên cùng bản ghi, transaction thay thế passages → không trùng (§6).
- Reprocess: cố map lại citation theo quoted text; không map được → `stale = true`.

### 4.2 Hỏi–đáp có trích dẫn

```
POST /spaces/:id/conversations/:cid/messages  (SSE response)
 1. Resolve scope → lấy candidate passages (ready, not archived, đúng scope)
 2. Hybrid retrieval top-k (embed câu hỏi + FTS), kèm ngữ cảnh hội thoại trước
 3. Gọi claude-opus-5 (stream):
    - documents: mỗi passage = 1 document block {title, text, citations:{enabled:true}, metadata: passageId}
    - system prompt: yêu cầu tách evidence/diễn giải, nêu mâu thuẫn,
      trả lời "insufficient evidence" khi không đủ căn cứ (§9)
 4. Stream text về client; citations trong response map về passageId
    → tạo Citation records + render inline chips cạnh câu tương ứng
 5. Không đủ evidence → câu trả lời insufficiency (không citation bịa)
```
- Đạt mục tiêu <8s hiển thị đầu tiên nhờ streaming (§19).
- Prompt caching: system prompt cố định đặt đầu, documents sau (theo hướng dẫn prefix caching).

### 4.3 Save-as-note & Convert-to-source

- Save answer → tạo Note `origin=saved_answer` chứa {question, answer(rich), citationRefs}; cảnh báo nếu message đã có note (unique index `originMessageId`).
- Convert note → confirm + sửa title → tạo Source `type=manual`, `originNoteId`, snapshot content (plain text từ rich), gắn nhãn "AI-assisted note origin" → vào pipeline như source thường. Idempotent: nếu đã có source `originNoteId` ở trạng thái processing/ready thì không tạo thêm (§12).

### 4.4 Notebook autosave & export

- Tiptap → debounce 1–2s → `PUT /notebook` (payload JSON doc); trạng thái Saving/Saved/Failed hiển thị + aria-live; fail → giữ local, exponential retry (§13).
- Export Markdown: serialize Tiptap JSON → MD chuẩn + phần "Nguồn tham khảo" từ citation nodes trong notebook; header = tên space + objective (§14). Print: route `/print` với CSS `@media print` ẩn điều khiển.

## 5. API surface (rút gọn)

```
POST /auth/register|login|logout|forgot|reset
GET/POST/PATCH /spaces, POST /spaces/:id/archive|restore
POST /spaces/:id/sources (multipart pdf | {url} | {title,content})
GET  /spaces/:id/sources?query=&type=&archived=
POST /sources/:id/retry|archive|restore, DELETE /sources/:id
GET  /sources/:id (reader payload: metadata + passages có locator)
GET/POST /spaces/:id/conversations
POST /conversations/:id/messages   (SSE stream)
POST /messages/:id/feedback {useful|not_useful}
POST /messages/:id/save-as-note
GET/POST/PATCH/DELETE /spaces/:id/notes, POST /notes/:id/convert-to-source
GET/PUT /spaces/:id/notebook, GET /spaces/:id/notebook/export.md
GET /home (spaces + counts + activity)
```

Mọi route sau auth đều qua middleware `assertOwnership` (space → owner) — §17.

## 6. Lộ trình triển khai (7 giai đoạn)

| Giai đoạn | Nội dung | Ước lượng |
|---|---|---|
| 0. Nền tảng | Monorepo (pnpm workspaces), Fastify + Prisma + Postgres/pgvector + Redis docker-compose, CI, auth + session + reset password | 1–1.5 tuần |
| 1. Spaces | CRUD space, archive/restore, last-opened, empty states | 0.5 tuần |
| 2. Ingestion | Upload PDF / URL / manual, worker pipeline, states + retry + limits cấu hình, embeddings | 2 tuần |
| 3. Library + Reader | Search/filter (FTS, title-boost), reader theo trang/đoạn, citation deep-link + highlight | 1.5 tuần |
| 4. Assistant | Hybrid retrieval, Claude citations, SSE streaming, conversations, feedback, insufficiency | 2 tuần |
| 5. Notes | Save-as-note (chống trùng), note CRUD + viewer drawer, convert-to-source (idempotent, nhãn AI-origin), citation stale | 1.5 tuần |
| 6. Notebook + Export | Tiptap, autosave states, export MD/print/clipboard | 1.5 tuần |
| 7. Hoàn thiện | Home + activity feed, error/empty states (§16), a11y audit (§18), perf (§19), security review (§17), chạy kịch bản E2E §21 | 1.5 tuần |

Tổng ~11–12 tuần cho 1 dev full-time (có thể nén khi làm song song FE/BE).

> Trạng thái 2026-08-27: cả 7 giai đoạn đã đóng — xem `plan/*/tasks.md` và `log.md`. Riêng giai đoạn 7 còn nợ kiểm tra bằng tay trên browser (a11y, Lighthouse, kịch bản §21 từ bước 8) — ghi trong [[plan/phase-7-home-and-hardening/tasks]].

## 7. Rủi ro & cách giảm thiểu

1. **Độ chính xác locator PDF** — pdfjs cho text theo trang tốt, nhưng đoạn trong trang không có ranh giới chuẩn → dùng heuristic (khoảng cách dòng) và chấp nhận độ phân giải "trang + vị trí passage" cho MVP (PRD chỉ yêu cầu tới page cho PDF).
2. **Citation bịa / lệch** — dùng native Citations của Claude (server-side ràng buộc vào document blocks) thay vì yêu cầu model tự in ID; validate mọi citation trả về phải khớp passageId trước khi lưu.
3. **Web extraction chất lượng thấp** (paywall, SPA) — Readability fail → báo lỗi human-readable + cho retry; không dùng headless browser ở MVP.
4. **Chi phí LLM** — top-k giới hạn, prompt caching, Haiku cho việc phụ (đặt title); theo dõi usage log.
5. **Autosave mất dữ liệu** — giữ bản local (IndexedDB/localStorage) làm buffer đến khi server xác nhận.

## 8. Việc cần quyết định sớm

- Nhà cung cấp embeddings (Voyage vs OpenAI) và email (Resend vs SES).
- Deploy target (VPS đơn + docker-compose là đủ cho MVP; hoặc Fly.io/Render).
- Fastify thuần vs NestJS (đề xuất Fastify cho tốc độ phát triển MVP).
